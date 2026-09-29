/**
 * Ava's chat (POST /api/mc/ava/chat, docs/HUB-API.md "Ava (AI helper)").
 *
 * One question: the hub sends the talk so far + the page the user is on; the
 * machine builds a small prompt (who is asking, the page, the date, the best
 * parts of the guide and the owner's Business facts for this question — BM25,
 * lib/ava/kb.js). A local planner (lib/ava/plan.js, no AI call) decides first:
 * a general question is answered in ONE streamed call with no tools; a
 * live-data one gets its obvious look-ups run side by side before the first
 * call, and the brain may call more tools (≤ 4 rounds, OpenAI-compatible
 * function calling, or a JSON fallback for a brain without tools). Returns
 * { reply, actions, suggestions, brain, model, tried, ms } — or streams it
 * (Server-Sent Events: `delta` pieces of the answer as it is written, then
 * `actions`, then `done`; `error` instead when it fails).
 *
 * Ava answers ANY question — the hub and its clients, and general things
 * (facts, how-tos, advice, writing). For current things she uses web_search
 * when a search key (Tavily / Exa) exists; otherwise she answers from what she
 * knows and says it may be out of date.
 *
 * Each request is kept small (Groq's free plan allows ~8,000 tokens a minute
 * per model): older turns become a short running summary, tool outputs are
 * compact and capped.
 *
 * Privacy: the tools only ever return company names, counts, stages, dates
 * and rates (lib/ava/tools.js). The user's own words go as they typed or
 * said them (their choice); web searches carry only the question's words with
 * emails, phones and contact names taken out.
 *
 * Ava never does a write: she proposes actions the hub shows as buttons
 * (navigate and read at once; `confirm` only on the user's click; `draft` to
 * copy). `read` makes the hub read its own screen aloud — no page data comes here.
 * Team members get no money and only their own status / a change request.
 *
 * Limits: 20 questions a minute per user (memory) and AVA_DAILY_CAP a day for
 * everyone together (Redis counter, config).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { AVA_IO, AVA_TIMING, ask, isSmart, keyedBrains, planSlots, usesTools } from '@/lib/ava/brains';
import { OWNER_TZ, runTool, toolContext, toolDefs, toolsFor } from '@/lib/ava/tools';
import { cleanActions, placesMap, VIEWS, CLIENT_TABS, SETTINGS_SECTIONS, CONFIRMS, ID_RE, PLACES } from '@/lib/ava/actions';
import { retrieve } from '@/lib/ava/kb';
import { factsForQuestion } from '@/lib/ava/facts';
import { searchProviders } from '@/lib/ava/search';
import { cleanText, personNamesOf } from '@/lib/ava/text';
import { getAllClients } from '@/lib/db/client';
import { planQuestion } from '@/lib/ava/plan';

export { cleanActions, VIEWS, CLIENT_TABS, SETTINGS_SECTIONS, CONFIRMS };

export const MAX_ROUNDS = 4;
export const PER_MINUTE = 20;
const MAX_IN = 40;          // messages read from the request
const KEEP_RECENT = 8;      // messages kept word for word; older ones → a running summary
const SUMMARY_AFTER = 10;   // messages before the summary starts
const MAX_MSG = 4000;
export const BUDGET = { tokens: 2500, guideTokens: 1000, voiceGuideTokens: 600, voiceChunks: 4, toolChars: 3200 };
export const MAX_TOKENS = { text: 900, voice: 250 };

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

function nowWords(now) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: OWNER_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
}

export const SUGGEST_RE = /<<\s*next\s*:([\s\S]*?)(?:>>|$)/i;

/**
 * The system prompt. `guide` = retrieved chunks; `search` = a web search key
 * exists; `voice` = the answer will be spoken; `jsonTools` = tool defs for a
 * brain without function calling.
 */
export function systemPrompt({ user, page, now, guide = [], search = false, voice = false, summary = '', jsonTools = null, mode = 'tools', opening = null, read = false }) {
  const owner = user.role === 'admin';
  const L = [
    'You are Ava, the helper inside the Aviance Hub, and a capable general assistant. Aviance does cold-email outreach for small US businesses: a free 30-day trial, then paid plans (Starter, Growth, Scale). The owner runs it from Sri Lanka.',
    'Answer ANY question: about the hub, the clients and the process, AND general things — facts, explanations, how-tos, advice, maths, and writing or improving emails and messages. Never say you can only help with the hub.',
    `Now: ${nowWords(now)} (Sri Lanka time). Times you mention are Sri Lanka time unless you say otherwise.`,
    `You are talking to ${user.name || 'someone'} — ${owner ? 'the owner (can do everything)' : 'a team member (read-only: sees but changes nothing, never sees money)'}. They are on: view=${page.view || 'unknown'}${page.clientId ? `, client id=${page.clientId}` : ''}${page.clientName ? ` (${page.clientName})` : ''}${page.tab ? `, tab=${page.tab}` : ''} ("this client" = that one).`,
    'How to answer:',
    mode === 'tools'
      ? '- Clients, numbers, calls, the team, what needs attention: look it up with the tools (results already given below count); never guess or invent numbers or names.'
      : '- Never guess or invent numbers or client names; for live numbers they can ask you to check.',
    `- How the hub or the process works: use the guide below${mode === 'tools' ? ' (search_hub finds more)' : ''}; name the place, like "Settings › Keys".`,
    search
      ? '- General knowledge: answer directly. For anything current or time-sensitive (news, prices, laws, weather, recent events, other companies) call web_search first and mention the sites you used.'
      : '- General knowledge: answer directly. You have no web search, so for current or time-sensitive things answer from what you know and say it may be out of date.',
    '- If the question is unclear, ask one short question back.',
    'Privacy: tool results never contain prospects\' names, email addresses, phone numbers or message text; do not ask for them or repeat personal data the user types.',
    mode === 'tools'
      ? 'You cannot change anything yourself and must never claim you did. To help them act, call propose_action (navigate to open a page, read to have the hub read the screen out loud, draft for text to copy, or a confirm button they press). For a wish to change how the hub or system works, propose add_change_request.'
      : 'You cannot change anything yourself and must never claim you did.',
    owner ? 'Money: the owner may ask about money (get_numbers scope money).' : 'Money: never mention invoices, prices or amounts to a team member; say it is only for the owner.',
    voice
      ? 'Style: this will be SPOKEN. Answer in 1–3 short, natural sentences. No lists, no markdown, no symbols or links. Offer to show details on screen if there is more.'
      : 'Style: warm, clear and brief. Plain text; a short dash list is fine; no tables, no headings. Longer only when asked (e.g. writing an email).',
    'After your answer, on its own last line, write <<next: q1 | q2 | q3>> with three short follow-up questions they might ask next (≤ 8 words each).',
  ];
  if (opening) L.push(`The hub is opening ${opening} for them right now — say so in a few words (do not describe how to get there).`);
  if (read) L.push('They want to hear what is on the screen: the hub reads the page out loud itself on their device (in tools mode propose_action read after navigate). Keep your answer to one short line and do not invent what is on the page; give numbers only from tool results.');
  if (mode === 'tools') L.push(placesMap(user.role));
  if (summary) L.push('', `Earlier in this conversation (summary): ${summary}`);
  if (guide.length) {
    L.push('', '<guide>');
    for (const g of guide) L.push(`## ${g.title}\n${g.text}`);
    L.push('</guide>');
  }
  if (jsonTools) {
    L.push('', 'Tools: to use one, reply with ONLY {"tool": "name", "args": {...}} and wait for the result; otherwise reply with your answer. Tools:');
    for (const t of jsonTools) L.push(`- ${t.function.name}: ${t.function.description.slice(0, 260)} args: ${JSON.stringify(t.function.parameters.properties || {})}`);
  }
  return L.join('\n');
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
const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');

/** The brain's final text → { reply, actions, suggestions } (JSON answers of older prompts still work). */
export function parseFinal(content, role) {
  let text = stripThink(content);
  let suggestions = [];
  const m = SUGGEST_RE.exec(text);
  if (m) {
    suggestions = m[1].split('|').map((x) => str(x.replace(/^[\s"'-]+|[\s"']+$/g, ''), 80)).filter((x) => x.length > 2).slice(0, 3);
    text = text.slice(0, m.index);
  }
  const trimmed = text.trim();
  let actions = [];
  if (/^(```|\{)/.test(trimmed)) {
    const obj = parseJsonObject(trimmed);
    if (obj && typeof obj.reply === 'string') {
      text = obj.reply;
      actions = cleanActions(obj.actions, role);
      if (Array.isArray(obj.suggestions)) suggestions = obj.suggestions.map((x) => str(x, 80)).filter(Boolean).slice(0, 3);
    }
  }
  return { reply: text.trim(), actions, suggestions };
}

/**
 * What goes to the user while an answer streams: no <think> blocks, nothing
 * from the "<<next:" line on, and nothing of a JSON-shaped answer (that is
 * parsed at the end). push(piece) → true when text went out.
 */
export class StreamFilter {
  constructor(emit) { this.emit = emit; this.buf = ''; this.out = ''; this.mode = 'start'; this.inThink = false; this.stopped = false; }
  push(piece) {
    this.buf += piece;
    if (this.stopped || this.mode === 'json') return false;
    if (this.mode === 'start') {
      const t = this.buf.replace(/^\s+/, '');
      if (!t) return false;
      if (t[0] === '{' || t.startsWith('```')) { this.mode = 'json'; return false; }
      if (t.length < 3 && '```'.startsWith(t)) return false;
      if (t.length < 7 && '<think>'.startsWith(t.toLowerCase())) return false;
      this.mode = 'text';
    }
    return this.process(false);
  }
  process(final) {
    let sent = false;
    for (;;) {
      if (this.inThink) {
        const e = this.buf.search(/<\/think>/i);
        if (e < 0) { if (final) this.buf = ''; break; }
        this.buf = this.buf.slice(e + 8);
        this.inThink = false;
        continue;
      }
      const i = this.buf.search(/<think>/i);
      const j = this.buf.indexOf('<<');
      if (i < 0 && j < 0) {
        const hold = final ? 0 : (this.buf.match(/<[a-z<]{0,6}$/i)?.[0].length || 0);
        sent = this.say(this.buf.slice(0, this.buf.length - hold)) || sent;
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      if (i >= 0 && (j < 0 || i < j)) {
        sent = this.say(this.buf.slice(0, i)) || sent;
        this.buf = this.buf.slice(i + 7);
        this.inThink = true;
        continue;
      }
      const rest = this.buf.slice(j);
      const flat = rest.replace(/\s+/g, '').toLowerCase();
      if (final || /^<<\s*next/i.test(rest)) { sent = this.say(this.buf.slice(0, j)) || sent; this.stopped = true; this.buf = rest; break; }
      if (flat.length < 6 && '<<next'.startsWith(flat)) { sent = this.say(this.buf.slice(0, j)) || sent; this.buf = rest; break; }
      sent = this.say(this.buf.slice(0, j + 2)) || sent;
      this.buf = this.buf.slice(j + 2);
    }
    return sent;
  }
  say(text) {
    if (!text) return false;
    const t = this.out ? text : text.replace(/^\s+/, '');
    if (!t) return false;
    this.out += t;
    this.emit(t);
    return true;
  }
  /** End of the answer: let out what was held (never a marker or a JSON answer). */
  end() { if (this.mode === 'text' && !this.stopped) this.process(true); }
}

// ─── the talk ────────────────────────────────────────────────────────────────

const approx = (s) => Math.ceil(String(s || '').length / 4);

function cleanHistory(messages) {
  if (!Array.isArray(messages)) throw new AvaError('messages must be a list of {role, content}.');
  const out = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_MSG) })).slice(-MAX_IN);
  if (!out.length || out[out.length - 1].role !== 'user') throw new AvaError('The last message must be from the user.');
  return out;
}

/** A short running summary of older turns (no AI call: their first words). */
export function summarize(older, maxChars = 900) {
  const parts = older.map((m) => {
    const t = str(m.content.replace(SUGGEST_RE, ''), m.role === 'user' ? 110 : 80);
    return m.role === 'user' ? `they asked "${t}"` : `Ava said "${t}"`;
  });
  const all = parts.join('; ');
  if (all.length <= maxChars) return all;
  // The first question (what the talk is about) and the most recent ones.
  const head = parts[0];
  const tail = [];
  let n = head.length + 5;
  for (let i = parts.length - 1; i > 0; i--) { if (n + parts[i].length + 2 > maxChars) break; tail.unshift(parts[i]); n += parts[i].length + 2; }
  return `${head}; …; ${tail.join('; ')}`;
}

/**
 * The talk that goes to the brain: the last messages word for word (long ones
 * cut), older ones as a running summary, trimmed until it fits the budget.
 */
export function compactHistory(history, { budgetTokens = 700 } = {}) {
  let keep = history.length > SUMMARY_AFTER ? history.slice(-KEEP_RECENT) : history.slice();
  let older = history.length > SUMMARY_AFTER ? history.slice(0, -KEEP_RECENT) : [];
  const cut = (m, i, arr) => (i === arr.length - 1 ? m : { role: m.role, content: m.content.length > (m.role === 'user' ? 1200 : 900) ? `${m.content.slice(0, m.role === 'user' ? 1200 : 900)}…` : m.content });
  keep = keep.map(cut);
  // A history that must start with a user turn for some services.
  while (keep.length > 1 && keep[0].role !== 'user') { older.push(keep.shift()); older = older.slice(); }
  const size = () => keep.reduce((n, m) => n + approx(m.content), 0);
  while (size() > budgetTokens && keep.length > 2) { older = [...older, keep.shift()]; while (keep.length > 1 && keep[0].role !== 'user') older.push(keep.shift()); }
  return { talk: keep, summary: older.length ? summarize(older) : '' };
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

/** Tool results already in the talk: the older ones are cut shorter as the talk grows. */
function squeezeTools(talk) {
  const tools = talk.filter((m) => m.role === 'tool');
  const total = tools.reduce((n, m) => n + m.content.length, 0);
  if (total <= BUDGET.toolChars * 1.5) return;
  for (const m of tools.slice(0, -1)) if (m.content.length > 700) m.content = `${m.content.slice(0, 700)}…(cut)`;
}

/** Follow-up questions when the brain gave none. */
function fallbackSuggestions(page, usedTools, owner) {
  if (usedTools.includes('get_client')) return ['What should I do next for them?', 'How many replies so far?', 'Open their email system'];
  if (page.view === 'calendar' || usedTools.includes('get_calendar')) return ["What's on tomorrow?", 'Any call times waiting for me?', 'How do I add a Meet link?'];
  if (page.view === 'settings') return ['Which keys are missing?', 'Is everything running?', 'How do warm-up helpers work?'];
  return owner ? ['What needs me today?', 'How are the trials doing?', "What's on my calendar this week?"] : ['What needs attention today?', 'How are the trials doing?', "What's on the calendar this week?"];
}

// ─── the question ────────────────────────────────────────────────────────────

/**
 * Check the request and the limits (before anything streams) → the prepared question.
 * Throws AvaError (400 bad body, 503 { needsKeys }, 429 limits).
 */
export async function prepareChat({ messages, page = {}, voice = false, user: said = null } = {}, verified) {
  const t0 = AVA_IO.now();
  const history = cleanHistory(messages);
  const pg = { view: str(page?.view, 40) || null, clientId: page?.clientId && ID_RE.test(String(page.clientId)) ? String(page.clientId) : null, clientName: str(page?.clientName, 80) || null, tab: str(page?.tab, 40) || null };
  // The role only ever comes from the verified request; the hub's own `user.firstName` only fills a missing name.
  const user = { ...verified, name: verified.name || str(said?.firstName, 40).split(' ')[0] || '' };
  const brains = await keyedBrains();
  if (!brains.length) throw new AvaError('Ava has no AI key yet. The owner adds a free Groq key (or Cloudflare, Mistral or Ollama) in Settings › Keys.', 503, { needsKeys: true });
  if (!perMinute(user.id)) throw new AvaError('That is a lot of questions in one minute — give me a moment.', 429);
  const now = new Date(AVA_IO.now());
  if (!(await underDailyCap(now))) throw new AvaError("Ava has answered today's limit of questions. She's back tomorrow (the owner can raise AVA_DAILY_CAP).", 429);
  return { history, page: pg, brains, now, voice: voice === true, user, t0 };
}

/** A tool-call id every service accepts (Mistral wants 9 letters and digits). */
const callId = (tag, n) => { const t = String(tag).replace(/[^A-Za-z0-9]/g, '').slice(0, 4); return `${t}${String(n).padStart(9 - t.length, '0')}`.slice(-9); };
const labelOf = (nav, clientName) => {
  if (!nav) return null;
  if (nav.view === 'client') return `${clientName || 'the client'}${nav.tab ? ` › ${PLACES.tabs[nav.tab]?.split(' (')[0] || nav.tab}` : ''}`;
  if (nav.view === 'settings') return `Settings${nav.section ? ` › ${PLACES.sections[nav.section]?.split(' — ')[0] || nav.section}` : ''}`;
  return PLACES.views[nav.view]?.split(' — ')[0] || nav.view;
};

/**
 * Answer a prepared question. `onDelta(text)` streams the answer's text as it
 * comes (from the first call; tool rounds in between are not streamed).
 * → { reply, actions, suggestions, brain, model, tried, ms, plan, timing } · throws AvaError 502.
 * timing = { firstTokenMs, toolMs, modelMs, totalMs } (from the start of the request).
 */
export async function answerChat(q, { onDelta = null } = {}) {
  const { history, page, brains, now, voice, user } = q;
  const t0 = q.t0 ?? AVA_IO.now();
  let firstTokenAt = null;
  let toolMs = 0;
  const [facts, providers, clients] = await Promise.all([
    factsForQuestion().then((f) => f.text).catch(() => ''),
    searchProviders().catch(() => []),
    getAllClients(null, { includeDemo: true }).catch(() => []),
  ]);
  const names = personNamesOf(clients);
  const search = providers.length > 0;
  const lastUser = history[history.length - 1].content;
  const smart = isSmart(history) && !(voice && lastUser.length < 160);
  const plan = planQuestion(lastUser, { page, role: user.role, voice, smart, search, clients: clients.map((c) => ({ id: c.id, name: c.name })) });
  const tools = plan.mode === 'tools';
  const guide = retrieve(lastUser, { page, facts: cleanText(facts, names), maxTokens: voice ? BUDGET.voiceGuideTokens : BUDGET.guideTokens, limit: voice ? BUDGET.voiceChunks : 6 })
    .map((g) => ({ title: g.title, text: cleanText(g.text, names) }));
  const { talk: recentTalk, summary } = compactHistory(history);
  const tctx = toolContext({ role: user.role, now: () => new Date(AVA_IO.now()), page, facts });
  const defs = tools ? toolDefs(user.role, { search }) : [];
  const deadline = t0 + AVA_TIMING.totalMs;
  const tried = [];
  const talk = recentTalk.slice();   // + assistant tool calls and tool results
  const used = [];

  // The navigation the planner placed goes first (the model need not spend a round on it).
  const pre = [];
  if (plan.nav) pre.push({ type: 'navigate', ...plan.nav });
  if (plan.read) pre.push({ type: 'read', what: 'page' });
  const preClean = cleanActions(pre, user.role);
  const opening = preClean.find((a) => a.type === 'navigate') ? labelOf(preClean.find((a) => a.type === 'navigate'), plan.client?.name || (plan.nav?.id === page.clientId ? page.clientName : null)) : null;

  // The obvious look-ups, side by side, before the first call; the model gets their results with the question.
  const [order0] = await Promise.all([
    planSlots(brains, { smart, quick: plan.quick }),
    (async () => {
      if (!plan.prefetch.length) return;
      const ts = AVA_IO.now();
      const outs = await Promise.all(plan.prefetch.map((p) => runTool(p.name, p.args, tctx).catch(() => ({ error: 'could not look that up' }))));
      toolMs += AVA_IO.now() - ts;
      const calls = plan.prefetch.map((p, i) => ({ id: callId('pf', i + 1), type: 'function', function: { name: p.name, arguments: cleanText(JSON.stringify(p.args), names) } }));
      talk.push({ role: 'assistant', content: '', tool_calls: calls });
      calls.forEach((c, i) => { used.push(c.function.name); talk.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(outs[i]).slice(0, BUDGET.toolChars) }); });
    })(),
  ]);
  let order = order0;

  let streamedAny = false;
  let filter = null;
  const relay = onDelta ? (piece) => { if (!filter) return false; const sent = filter.push(piece); if (sent) streamedAny = true; return sent; } : null;
  const emit = onDelta ? (t) => { if (firstTokenAt === null) firstTokenAt = AVA_IO.now(); onDelta(t); } : null;
  const rounds = tools ? MAX_ROUNDS : 1;

  for (let round = 0; round < rounds; round++) {
    const last = round === rounds - 1;
    const build = (slot) => {
      if (emit) {
        // Text already shown in an earlier round (e.g. "Let me check.") stays; the answer starts on a new line.
        let lead = streamedAny ? '\n\n' : '';
        filter = new StreamFilter((t) => { emit(lead + t); lead = ''; });
      }
      const fnTools = tools && usesTools(slot.brain);
      const sys = { role: 'system', content: systemPrompt({ user, page, now, guide, search, voice, summary, mode: plan.mode, opening, read: plan.read, jsonTools: tools && !fnTools && !last ? defs : null }) + (tools && last ? '\n\nAnswer now; no more tools.' : '') };
      const base = { temperature: 0.3, max_tokens: voice ? MAX_TOKENS.voice : MAX_TOKENS.text };
      if (fnTools) return { messages: [sys, ...talk.map((m) => (m.role === 'tool' ? { role: 'tool', tool_call_id: m.tool_call_id, content: m.content } : m))], ...base, ...(fnTools && !last ? { tools: defs, tool_choice: 'auto' } : {}) };
      return { messages: [sys, ...plainify(talk)], ...base };
    };
    const got = await ask(order, build, { deadline, tried, onDelta: relay, smart });
    if (!got) break;
    order = [got.slot, ...order.filter((x) => x !== got.slot)];
    const msg = got.message;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => c?.function?.name) : [];
    if (tools && calls.length && !last) {
      talk.push({ role: 'assistant', content: msg.content || '', tool_calls: calls.slice(0, 4).map((c, i) => ({ id: c.id || callId(`c${round}`, i), type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) } })) });
      // What goes back to the service carries no contact names (the tools get the args as the brain wrote them).
      const echo = talk[talk.length - 1];
      const ts = AVA_IO.now();
      const outs = await Promise.all(echo.tool_calls.map((c) => runTool(c.function.name, safeArgs(c.function.arguments), tctx)));
      toolMs += AVA_IO.now() - ts;
      echo.tool_calls.forEach((c, i) => {
        used.push(c.function.name);
        c.function.arguments = cleanText(c.function.arguments, names);
        talk.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(outs[i]).slice(0, BUDGET.toolChars) });
      });
      squeezeTools(talk);
      continue;
    }
    const obj = tools && !got.cut ? parseJsonObject(stripThink(msg.content)) : null;
    if (obj && typeof obj.tool === 'string' && !last && /^\s*(```|\{)/.test(stripThink(msg.content))) {
      const id = callId(`j${round}`, 0);
      used.push(obj.tool);
      talk.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: obj.tool, arguments: JSON.stringify(obj.args || {}) } }] });
      const ts = AVA_IO.now();
      const out = await runTool(obj.tool, obj.args || {}, tctx);
      toolMs += AVA_IO.now() - ts;
      talk.push({ role: 'tool', tool_call_id: id, name: obj.tool, content: JSON.stringify(out).slice(0, BUDGET.toolChars) });
      continue;
    }
    if (filter) filter.end();
    const raw = got.cut ? (filter?.out || '') : msg.content;
    const fin = parseFinal(raw, user.role);
    let reply = fin.reply.slice(0, 6000);
    if (!reply) reply = opening ? `Opening ${opening}.` : "Sorry, I didn't catch that — could you say it another way?";
    // A JSON-shaped answer was held back while streaming: send its words now.
    if (emit && !filter?.out) { emit(streamedAny ? `\n\n${reply}` : reply); streamedAny = true; }
    const end = AVA_IO.now();
    // The model's own navigate wins over the planner's guess; `read` is added when they asked for it.
    const modelNav = [...tctx.actions, ...fin.actions].some((a) => a.type === 'navigate');
    const actions = cleanActions([...(modelNav ? [] : preClean.filter((a) => a.type === 'navigate')), ...tctx.actions, ...fin.actions, ...preClean.filter((a) => a.type === 'read')], user.role)
      .filter((a, i, arr) => arr.findIndex((b) => JSON.stringify(b) === JSON.stringify(a)) === i);
    return {
      reply,
      actions,
      suggestions: fin.suggestions.length ? fin.suggestions : fallbackSuggestions(page, used, user.role === 'admin'),
      brain: got.brain.id,
      model: got.model,
      tried,
      ms: end - t0,
      plan: { mode: plan.mode, why: plan.why, prefetch: plan.prefetch.map((p) => p.name), quick: plan.quick },
      timing: { firstTokenMs: firstTokenAt === null ? end - t0 : firstTokenAt - t0, toolMs, modelMs: tried.reduce((n, x) => n + (x.ms || 0), 0), totalMs: end - t0 },
      ...(got.cut ? { cut: true } : {}),
    };
  }
  throw new AvaError('Ava could not get an answer just now — try again in a minute.', 502, { tried });
}

/**
 * POST /api/mc/ava/chat (JSON). `user` = { id, name, role } from the verified
 * request. → { reply, actions, suggestions, brain, model, tried, ms } ·
 * throws AvaError (400 bad body, 429 limits, 503 { needsKeys }, 502 every brain failed).
 */
export async function avaChat(body = {}, user) {
  return answerChat(await prepareChat(body, user));
}

export { toolsFor };
