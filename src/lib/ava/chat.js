/**
 * Ava's chat (POST /api/mc/ava/chat, docs/HUB-API.md "Ava (AI helper)").
 *
 * One question: the hub sends the talk so far + the page the user is on; the
 * machine builds the system prompt, lets the brain call the tools (≤ 4
 * rounds, OpenAI-compatible function calling, or a JSON fallback for a brain
 * without tools) and returns { reply, actions, brain, tried }.
 *
 * Privacy: the tools only ever return company names, counts, stages, dates
 * and rates (lib/ava/tools.js). The user's own words go as they typed or
 * said them (their choice); the prompt tells the brain not to repeat
 * personal data.
 *
 * Ava never does a write: she proposes actions the hub shows as buttons
 * (navigate at once; `confirm` only on the user's click; `draft` to copy).
 * Team members get no money and only their own status / a change request.
 *
 * Limits: 20 questions a minute per user (memory) and AVA_DAILY_CAP a day for
 * everyone together (Redis counter, config).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { AVA_IO, AVA_TIMING, ask, isShort, keyedBrains, orderBrains, usesTools } from '@/lib/ava/brains';
import { OWNER_TZ, runTool, toolContext, toolDefs, toolsFor } from '@/lib/ava/tools';

export const MAX_ROUNDS = 4;
export const PER_MINUTE = 20;
const MAX_HISTORY = 16;
const MAX_MSG = 4000;

export class AvaError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ─── limits ──────────────────────────────────────────────────────────────────

const recent = new Map();   // user → [epoch ms]
export const __resetAvaLimits = () => recent.clear();

function perMinute(user) {
  const now = AVA_IO.now();
  const list = (recent.get(user) || []).filter((t) => now - t < 60_000);
  if (list.length >= PER_MINUTE) { recent.set(user, list); return false; }
  list.push(now);
  recent.set(user, list);
  return true;
}

const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TZ }).format(d);

/** Count one question against today's cap → false when the cap is reached. */
async function underDailyCap(now) {
  const cap = Number(await cfg(null, 'AVA_DAILY_CAP'));
  if (!Number.isFinite(cap) || cap <= 0) return true;
  const key = K.avaDay(dayKey(now));
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, 2 * 86400).catch(() => {});
  return n <= cap;
}

// ─── the prompt ──────────────────────────────────────────────────────────────

export const VIEWS = ['trials', 'paying', 'calendar', 'team', 'mystats', 'activity', 'inquiries', 'behind', 'settings', 'client'];
const OWNER_VIEWS = new Set(['activity', 'settings']);
export const CLIENT_TABS = ['overview', 'conversations', 'emails', 'calls', 'messages', 'money', 'health', 'leads', 'setup', 'history'];
const OWNER_TABS = new Set(['money', 'health', 'leads', 'setup']);
export const SETTINGS_SECTIONS = ['alerts', 'phone', 'details', 'keys', 'google', 'inboxes', 'warmup', 'replybot', 'demo', 'status', 'behind', 'advanced', 'theme', 'account'];
export const CONFIRMS = ['open_add_trial', 'open_add_paid', 'open_client', 'mark_todo_seen', 'give_access', 'load_test_run', 'remove_test_run', 'set_my_status', 'add_change_request'];
const EMPLOYEE_CONFIRMS = new Set(['open_client', 'set_my_status', 'add_change_request']);

function nowWords(now) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: OWNER_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
}

export function systemPrompt({ user, page, now, jsonTools = null }) {
  const owner = user.role === 'admin';
  const lines = [
    "You are Ava, the helper inside the Aviance Hub. Aviance runs cold-email outreach for small US businesses: a 30-day free trial, then paid plans (Starter, Growth, Scale).",
    'Style: warm, brief, spoken — your answer may be read aloud. Two or three short sentences unless asked for more. No markdown tables, no lists longer than five items.',
    `Now: ${nowWords(now)} (Sri Lanka time). Times you mention are Sri Lanka time unless you say otherwise.`,
    `You are talking to ${user.name || 'someone'} — ${owner ? 'the owner (can do everything)' : 'a team member (read-only: can see but not change things, and never sees money)'}.`,
    `They are on: view=${page.view || 'unknown'}${page.clientId ? `, client id=${page.clientId}` : ''}${page.tab ? `, tab=${page.tab}` : ''}. "This client" means that one.`,
    'Use the tools to look things up; never guess numbers. For how-to questions use search_kb.',
    'Privacy: tool results never contain prospects\' names, email addresses, phone numbers or message text, and you must not ask for them or repeat any personal data the user types. Talk about companies, counts, stages and dates.',
    'You cannot change anything yourself and must never claim you did. To do something, propose an action and let the user press it. You cannot edit the system\'s code: for a wish to change how the hub or machine works, propose add_change_request with a short description.',
    owner ? 'Money: the owner may ask about money (money_summary).' : 'Money: never mention invoices, prices or amounts to a team member; say it is only for the owner.',
    '',
    'When you have the answer, reply with ONLY one JSON object, nothing around it:',
    '{"reply": "what you say", "actions": [ ... ]}   (actions may be empty)',
    'Actions:',
    `- {"type":"navigate","view":one of ${JSON.stringify(VIEWS.filter((v) => owner || !OWNER_VIEWS.has(v)))},"id"?:client id (view "client"),"tab"?:client tab ${JSON.stringify(CLIENT_TABS.filter((t) => owner || !OWNER_TABS.has(t)))}${owner ? ` or settings section ${JSON.stringify(SETTINGS_SECTIONS)}` : ''}} — opens a page at once.`,
    `- {"type":"confirm","label":"button text","name":one of ${JSON.stringify(CONFIRMS.filter((c) => owner || EMPLOYEE_CONFIRMS.has(c)))},"args":{...}} — a button the user must press. args: open_client {id}; mark_todo_seen {id, todoId}; give_access {id} (opens the place, never an email address); set_my_status {text}; add_change_request {text}; the rest none.`,
    '- {"type":"draft","title":"...","text":"..."} — text for the user to copy (for example an email to a client), with no personal data in it.',
  ];
  if (jsonTools) {
    lines.push('', 'Tools: to use one, reply with ONLY {"tool": "name", "args": {...}} and wait for the result. Available tools:');
    for (const t of jsonTools) lines.push(`- ${t.function.name}: ${t.function.description} args: ${JSON.stringify(t.function.parameters.properties || {})}`);
  }
  return lines.join('\n');
}

// ─── parsing the brain's answer ─────────────────────────────────────────────

/** The first JSON object in a text (fences and chatter around it are fine) → object | null. */
export function parseJsonObject(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let escp = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Only the actions the hub knows, with clean args, and only what this role may do. */
export function cleanActions(list, role) {
  const owner = role === 'admin';
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'navigate') {
      const view = String(a.view || '');
      if (!VIEWS.includes(view) || (!owner && OWNER_VIEWS.has(view))) continue;
      const nav = { type: 'navigate', view };
      if (a.id != null && ID_RE.test(String(a.id))) nav.id = String(a.id);
      if (view === 'client' && !nav.id) continue;
      const tab = a.tab == null ? null : String(a.tab);
      if (tab && view === 'client' && CLIENT_TABS.includes(tab) && (owner || !OWNER_TABS.has(tab))) nav.tab = tab;
      if (tab && view === 'settings' && SETTINGS_SECTIONS.includes(tab)) nav.tab = tab;
      out.push(nav);
    } else if (a.type === 'confirm') {
      const name = String(a.name || '');
      if (!CONFIRMS.includes(name) || (!owner && !EMPLOYEE_CONFIRMS.has(name))) continue;
      const src = a.args && typeof a.args === 'object' ? a.args : {};
      const args = {};
      if (['open_client', 'mark_todo_seen', 'give_access'].includes(name)) {
        if (!ID_RE.test(String(src.id || ''))) continue;
        args.id = String(src.id);
      }
      if (name === 'mark_todo_seen') { const t = str(src.todoId, 160); if (!t) continue; args.todoId = t; }
      if (name === 'set_my_status') args.text = str(src.text, 140);
      if (name === 'add_change_request') { args.text = str(src.text, 1000); if (!args.text) continue; }
      out.push({ type: 'confirm', label: str(a.label, 80) || name.replace(/_/g, ' '), name, args });
    } else if (a.type === 'draft') {
      const text = String(a.text ?? '').trim().slice(0, 4000);
      if (!text) continue;
      out.push({ type: 'draft', title: str(a.title, 100) || 'Draft', text });
    }
    if (out.length >= 4) break;
  }
  return out;
}

// ─── the talk ────────────────────────────────────────────────────────────────

function cleanHistory(messages) {
  if (!Array.isArray(messages)) throw new AvaError('messages must be a list of {role, content}.');
  const out = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_MSG) })).slice(-MAX_HISTORY);
  if (!out.length || out[out.length - 1].role !== 'user') throw new AvaError('The last message must be from the user.');
  return out;
}

/** For a brain without tools: tool calls and results become plain turns. */
function plainify(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'user', content: `Result of ${m.name}: ${m.content}` };
    if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.tool_calls.map((c) => JSON.stringify({ tool: c.function.name, args: safeArgs(c.function.arguments) })).join('\n') };
    return m.role === 'system' ? m : { role: m.role, content: m.content ?? '' };
  });
}
function safeArgs(a) { if (a && typeof a === 'object') return a; try { return JSON.parse(a || '{}'); } catch { return {}; } }

/**
 * POST /api/mc/ava/chat. `user` = { id, name, role } from the verified
 * request. → { reply, actions, brain, tried } · throws AvaError (400 bad
 * body, 429 limits, 503 { needsKeys }, 502 every brain failed).
 */
export async function avaChat({ messages, page = {} } = {}, user) {
  const history = cleanHistory(messages);
  const pg = { view: str(page?.view, 40) || null, clientId: page?.clientId && ID_RE.test(String(page.clientId)) ? String(page.clientId) : null, tab: str(page?.tab, 40) || null };
  const brains = await keyedBrains();
  if (!brains.length) throw new AvaError('Ava has no AI key yet. The owner adds a free Groq or Cerebras key in Settings › Keys.', 503, { needsKeys: true });
  if (!perMinute(user.id)) throw new AvaError('That is a lot of questions in one minute — give me a moment.', 429);
  const now = new Date(AVA_IO.now());
  if (!(await underDailyCap(now))) throw new AvaError("Ava has answered today's limit of questions. She's back tomorrow (the owner can raise AVA_DAILY_CAP).", 429);

  const tctx = toolContext({ role: user.role, now: () => new Date(AVA_IO.now()) });
  const defs = toolDefs(user.role);
  const deadline = AVA_IO.now() + AVA_TIMING.totalMs;
  const tried = [];
  let order = orderBrains(brains, { short: isShort(history) });
  const talk = history.slice();   // + assistant tool calls and tool results

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const build = (brain) => {
      const tools = usesTools(brain);
      const sys = { role: 'system', content: systemPrompt({ user, page: pg, now, jsonTools: tools || last ? null : defs }) + (last ? '\n\nAnswer now with the JSON object; no more tools.' : '') };
      if (tools) return { messages: [sys, ...talk.map((m) => (m.role === 'tool' ? { role: 'tool', tool_call_id: m.tool_call_id, content: m.content } : m))], temperature: 0.3, max_tokens: 700, ...(last ? {} : { tools: defs, tool_choice: 'auto' }) };
      return { messages: [sys, ...plainify(talk)], temperature: 0.3, max_tokens: 700 };
    };
    const got = await ask(order, build, { deadline, tried });
    if (!got) break;
    order = [got.brain, ...order.filter((b) => b.id !== got.brain.id)];
    const msg = got.message;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => c?.function?.name) : [];
    if (calls.length && !last) {
      talk.push({ role: 'assistant', content: msg.content || '', tool_calls: calls.map((c, i) => ({ id: c.id || `call_${round}_${i}`, type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) } })) });
      for (const c of talk[talk.length - 1].tool_calls.slice(0, 4)) {
        const out = await runTool(c.function.name, safeArgs(c.function.arguments), tctx);
        talk.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(out).slice(0, 12_000) });
      }
      continue;
    }
    const obj = parseJsonObject(msg.content);
    if (obj && typeof obj.tool === 'string' && !last) {
      const id = `json_${round}`;
      talk.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: obj.tool, arguments: JSON.stringify(obj.args || {}) } }] });
      const out = await runTool(obj.tool, obj.args || {}, tctx);
      talk.push({ role: 'tool', tool_call_id: id, name: obj.tool, content: JSON.stringify(out).slice(0, 12_000) });
      continue;
    }
    const reply = obj && typeof obj.reply === 'string' ? obj.reply : String(msg.content || '').trim();
    return {
      reply: reply.slice(0, 3000) || "Sorry, I didn't catch that — could you say it another way?",
      actions: cleanActions(obj?.actions, user.role),
      brain: got.brain.id,
      tried,
    };
  }
  throw new AvaError('Ava could not get an answer just now — try again in a minute.', 502, { tried });
}

export { toolsFor };
