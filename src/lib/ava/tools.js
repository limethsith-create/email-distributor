/**
 * Ava's tools (docs/HUB-API.md "Ava (AI helper)") — what the brain may look
 * up, run here on the machine. EVERY output is free of personal data:
 * company names, counts, stages, dates, day numbers, rates and plan names
 * only. Never a prospect's name, an email address, a phone number, a message
 * body, the client's contact person's email, a credential, a token, a link,
 * or (for team members) any money.
 *
 * Built from structured fields only (to-dos become their TYPE, never their
 * text), then passed through clean() as a second net: email addresses,
 * phone numbers and links are removed, and the contact people's names
 * become "the client".
 */

import fs from 'node:fs';
import path from 'node:path';
import { hubBoard, hubClient } from '@/lib/systems/hubview';
import { teamView } from '@/lib/systems/team';
import { calendarView } from '@/lib/systems/calendar';
import { getAllClients } from '@/lib/db/client';

export const OWNER_TZ = 'Asia/Colombo';

// ─── the personal-data net ───────────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const AT_RE = /\S*@\S+/g;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words to hide: every client's contact person (whole name, first and last). */
export async function personNames() {
  const clients = await getAllClients(null, { includeDemo: true }).catch(() => []);
  const set = new Set();
  for (const c of clients) {
    const n = String(c.contactName || '').trim();
    if (!n) continue;
    set.add(n);
    for (const part of n.split(/\s+/)) if (part.length >= 3) set.add(part);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/** One string, cleaned. Dates like 2026-10-06 and times survive the phone rule (it needs 8+ digits in a row-ish run). */
export function cleanText(s, names = []) {
  let t = String(s ?? '');
  t = t.replace(URL_RE, '[link]').replace(EMAIL_RE, '[email]').replace(AT_RE, '[email]');
  t = t.replace(PHONE_RE, (m) => ((m.match(/\d/g) || []).length >= 8 && !/^\d{4}-\d{2}-\d{2}/.test(m.trim()) ? '[phone]' : m));
  for (const n of names) t = t.replace(new RegExp(`\\b${esc(n)}\\b(?:'s)?`, 'g'), 'the client');
  return t;
}

/** Deep: every string in an answer goes through cleanText. */
export function clean(v, names = []) {
  if (typeof v === 'string') return cleanText(v, names);
  if (Array.isArray(v)) return v.map((x) => clean(x, names));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, names)]));
  return v;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const HIDDEN_IDS = new Set(['aviance', '_test']);
const pct = (r) => (r === null || r === undefined || r === '' || !Number.isFinite(Number(r)) ? null : Math.round(Number(r) * 100));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : null);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || null;

/** Every client row on the board (trials and paying; not the owner's own outreach or Test Mode), with its stage label. */
function boardRows(board) {
  const out = [];
  for (const s of board.stages || []) for (const r of s.clients || []) if (!HIDDEN_IDS.has(r.id)) out.push({ row: r, stage: s.label });
  return out;
}

/** A to-do → its type in plain words (never its text: that can carry names). */
const TODO_TYPES = [
  [/^review:/, 'application to review'],
  [/^meeting-request:/, 'call time waiting for your yes'],
  [/^(onboard|launch|message)-reply:/, 'reply to read and answer'],
  [/^onboard-overdue:/, 'late onboarding-call booking to chase'],
  [/^launch-overdue:/, 'late launch-call booking to chase'],
  [/^onboard-mark:/, 'onboarding call to mark done or no-show'],
  [/^launch-mark:/, 'launch call to hold and approve'],
  [/^unopened:/, 'important email not opened yet — reach them another way'],
  [/^buy:/, 'domain and inboxes to buy'],
  [/^copy-change:/, 'copy change request to answer'],
  [/^talk:/, '"talk to someone" request — call them'],
  [/^legal:/, 'legal reply to read, then clear the hold'],
  [/^sendhold:/, 'send hold to clear'],
  [/^invoice:/, 'invoice to mark paid when the money lands'],
  [/^cancel-inboxes:/, 'trial inboxes to cancel'],
  [/^warmup-helpers/, 'warm-up helpers to add'],
  [/^booking-test:/, 'booking test the client has not done yet'],
  [/^inquiry:/, 'new plan inquiry to call back'],
  [/^unmatched:/, 'CheapInboxes purchase to match to a trial'],
  [/^promote-/, 'free trial slot — start the next one from the waiting list'],
  [/^machine-heartbeat/, 'machine heartbeat missing — check the cron'],
  [/^machine-/, 'machine setup to finish'],
];
function todoType(todo, alertsById) {
  const id = String(todo.id || '');
  const m = /^alert-([^:]+):/.exec(id);
  if (m) {
    const a = alertsById.get(m[1]);
    return a?.key ? `urgent alert: ${String(a.key).replace(/_/g, ' ')}` : 'urgent alert to read';
  }
  for (const [re, words] of TODO_TYPES) if (re.test(id)) return words;
  return 'thing to do';
}
const where = (todo) => (todo.clientName ? String(todo.clientName) : null);

/** "1 reply to read and answer at Ridgeline IT" lines, most urgent first. */
function needsLines(todos, alertsById) {
  const groups = new Map();
  for (const t of todos || []) {
    const type = todoType(t, alertsById);
    const at = /^(unmatched|machine-)/.test(String(t.id)) ? null : where(t);
    const k = `${type}|${at || ''}`;
    const g = groups.get(k) || { type, at, count: 0, urgent: false };
    g.count += 1; g.urgent = g.urgent || Boolean(t.urgent);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => Number(b.urgent) - Number(a.urgent)).map((g) => ({
    text: `${g.count} ${g.type}${g.at ? ` at ${g.at}` : ''}`, type: g.type, client: g.at, count: g.count, urgent: g.urgent,
  }));
}

// ─── fuzzy client match ──────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function lev(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = t; }
  }
  return prev[b.length];
}
const GENERIC = new Set('it inc llc ltd co company group the and of dental plumbing roofing legal law hvac clinic services service solutions systems tech media marketing studio partners consulting health care home homes'.split(' '));

/** The best client for a name said or typed a bit wrong → { id, name } | null. */
export function matchClient(query, clients) {
  const q = norm(query);
  if (!q) return null;
  let best = null;
  const consider = (c, s) => { if (s > 0 && (!best || s > best.s)) best = { c, s }; };
  for (const c of clients) {
    const full = norm(c.name);
    const id = norm(String(c.id).replace(/^demo-/, ''));
    if (full === q || id === q) { consider(c, 100); continue; }
    if (full.includes(q) || q.includes(full)) consider(c, 60 + Math.min(q.length, full.length));
    const words = full.split(' ').filter((w) => w.length >= 3 && !GENERIC.has(w));
    for (const w of words) {
      for (const qw of q.split(' ')) {
        if (qw === w) consider(c, 40 + w.length);
        else if (qw.length >= 4 && w.length >= 4) { const d = lev(qw, w); if (d <= (w.length >= 8 ? 2 : 1)) consider(c, 30 + w.length - d * 5); }
      }
    }
    const flat = full.replace(/ /g, ''); const qflat = q.replace(/ /g, '');
    if (qflat.length >= 5 && flat.length >= 5) { const d = lev(qflat, flat.slice(0, qflat.length)); if (d <= 1) consider(c, 25); }
  }
  return best ? best.c : null;
}

// ─── the tools ───────────────────────────────────────────────────────────────

async function hub_summary(_args, ctx) {
  const board = await ctx.board();
  const alertsById = new Map((board.alerts || []).map((a) => [String(a.id), a]));
  const rows = boardRows(board);
  const stages = (board.stages || []).filter((s) => (s.clients || []).some((r) => !HIDDEN_IDS.has(r.id))).map((s) => ({
    stage: s.label,
    count: s.clients.filter((r) => !HIDDEN_IDS.has(r.id)).length,
    clients: s.clients.filter((r) => !HIDDEN_IDS.has(r.id)).map((r) => ({
      name: r.name, plan: r.plan || 'trial', step: r.simple?.step || null,
      day: num(r.simple?.dayOf30) ?? num(r.trialDay), needsYou: Boolean(r.simple?.needsYou), ...(r.demo ? { testRun: true } : {}),
    })),
  }));
  return {
    totalClients: rows.length,
    trials: rows.filter((x) => (x.row.plan || 'trial') === 'trial').length,
    paying: rows.filter((x) => ['starter', 'growth', 'scale'].includes(x.row.plan)).length,
    needYouNow: rows.filter((x) => x.row.simple?.needsYou).map((x) => x.row.name),
    stages,
    needsTheOwner: needsLines(board.todos, alertsById),
    openAlerts: num(board.machine?.openAlerts) ?? 0,
    activeTrials: num(board.machine?.activeTrials), maxActiveTrials: num(board.machine?.maxActiveTrials),
    waitingList: (board.machine?.queue || []).map((q) => q.name || q.id),
    newPlanInquiries: (board.inquiries?.latest || []).filter((q) => q.status === 'new').length,
  };
}

async function client_overview(args, ctx) {
  const board = await ctx.board();
  const rows = boardRows(board);
  const hit = matchClient(args?.name, rows.map((x) => ({ id: x.row.id, name: x.row.name })));
  if (!hit) return { found: false, message: 'No client by that name.', clients: rows.map((x) => x.row.name) };
  const { row, stage } = rows.find((x) => x.row.id === hit.id);
  const d = (await hubClient(row.id, { owner: ctx.role === 'admin' }).catch(() => null)) || {};
  const alertsById = new Map((board.alerts || []).map((a) => [String(a.id), a]));
  const five = row.five || {};
  const counters = d.counters || {};
  const w = d.warmup || null;
  const kinds = d.repliesByKind && typeof d.repliesByKind === 'object' ? Object.fromEntries(Object.entries(d.repliesByKind).map(([k, v]) => [k, num(v) ?? 0])) : {};
  return {
    found: true,
    id: row.id, name: row.name, plan: row.plan || 'trial', stage, step: row.simple?.step || null,
    ...(row.demo ? { testRun: true } : {}),
    status: row.simple?.label || row.stateLabel || null,
    next: row.simple?.next || null,
    needsYou: Boolean(row.simple?.needsYou),
    day: num(row.simple?.dayOf30) ?? num(row.trialDay), day1Date: row.day1Date || null, day30Date: (row.plan || 'trial') === 'trial' ? row.day30Date || null : null,
    health: row.health || null,
    numbers: {
      sent: num(five.sent) ?? num(counters.sent), replies: num(five.replies) ?? num(counters.replies),
      bounced: num(counters.bounces) ?? num(counters.bounced), interested: num(five.positive) ?? num(kinds.interested),
      booked: num(five.booked) ?? num(counters.booked), qualified: num(five.qualified),
    },
    replyTypes: kinds,
    warmup: w ? { status: w.status || null, day: num(w.day), of: num(w.of), inboxRatePct: pct(w.inboxRate), readyBy: w.readyBy || null, inboxes: Array.isArray(w.inboxes) ? w.inboxes.length : null } : (row.inboxRate != null ? { inboxRatePct: pct(row.inboxRate) } : null),
    leads: d.leadsByStatus && typeof d.leadsByStatus === 'object' ? d.leadsByStatus : null,
    nextUp: row.nextUp || null,
    thingsToDo: needsLines(row.todo, alertsById).map((x) => x.text),
    openAlerts: num(row.openAlerts) ?? 0,
  };
}

async function calendar_summary(args, ctx) {
  const now = ctx.now();
  const from = Date.parse(args?.from) || now.getTime() - 86400e3;
  let to = Date.parse(args?.to) || from + 14 * 86400e3;
  if (to <= from) to = from + 86400e3;
  if (to - from > 62 * 86400e3) to = from + 62 * 86400e3;
  const v = await calendarView({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), now });
  const one = (m) => ({
    when: m.labels?.owner ? `${m.labels.owner} (Sri Lanka)` : m.start, eastern: m.labels?.eastern || null, start: m.start, minutes: num(m.minutes),
    company: m.company || (m.status === 'blocked' ? 'busy block' : null), type: m.status === 'blocked' ? 'block' : m.kind || 'other', status: m.status,
    ...(m.meetLink ? { hasMeetLink: true } : {}), ...(m.demo ? { testRun: true } : {}),
  });
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), timeZone: 'Sri Lanka (Asia/Colombo), US Eastern beside it',
    meetings: (v.meetings || []).map(one),
    waitingForYourYes: (v.requests || []).map(one),
  };
}

async function team_summary(_args) {
  const { team } = await teamView();
  return {
    team: (team || []).map((p) => ({
      firstName: firstName(p.name) || (p.role === 'admin' ? 'The owner' : 'A team member'),
      role: p.role === 'admin' ? 'owner' : 'team member',
      online: Boolean(p.online),
      status: p.status?.text || null, statusAt: p.status?.at || null,
      looksAfter: (p.clients || []).map((c) => c.name),
    })),
  };
}

async function my_outreach() {
  const { GET } = await import('@/app/api/mc/outreach/route');
  const res = await GET();
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { error: 'The sending history could not be read just now.' };
  const t = j.totals || {};
  const keep = ['sent', 'newSends', 'followUps', 'opens', 'uniqueOpens', 'replies', 'bounces', 'days', 'firstDay', 'lastDay'];
  return { totals: Object.fromEntries(keep.map((k) => [k, t[k] ?? null])), inboxCount: Array.isArray(j.inboxes) ? j.inboxes.length : null };
}

async function money_summary(_args, ctx) {
  if (ctx.role !== 'admin') return { error: 'Money is only for the owner.' };
  const board = await ctx.board();
  const others = (board.machine?.others || []).filter((r) => !HIDDEN_IDS.has(r.id));
  const rows = [...boardRows(board).map((x) => x.row), ...others];
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TZ, year: 'numeric', month: '2-digit' }).format(ctx.now());
  const monthOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TZ, year: 'numeric', month: '2-digit' }).format(new Date(iso));
  const clients = [];
  const totals = { receivedAllTime: 0, receivedThisMonth: 0, unpaid: 0, paidInvoices: 0, unpaidInvoices: 0 };
  const test = { received: 0 };
  for (const r of rows) {
    const inv = r.invoice;
    if (!inv || inv.amount == null) continue;
    const amount = Number(inv.amount) || 0;
    const paid = Boolean(inv.paidAt) || inv.status === 'paid';
    clients.push({ name: r.name, plan: inv.plan || r.plan || null, amountUsd: amount, status: paid ? 'paid' : inv.status || 'sent', issued: dateOnly(inv.issuedAt), paid: dateOnly(inv.paidAt), ...(r.demo ? { testRun: true } : {}) });
    if (r.demo) { if (paid) test.received += amount; continue; }
    if (paid) { totals.receivedAllTime += amount; totals.paidInvoices += 1; if (inv.paidAt && monthOf(inv.paidAt) === month) totals.receivedThisMonth += amount; }
    else { totals.unpaid += amount; totals.unpaidInvoices += 1; }
  }
  return { currency: 'USD', month, totals, ...(test.received ? { testRunReceivedNotCounted: test.received } : {}), clients, prices: { starter: 2497, growth: 3997, scale: 8497 } };
}

// ─── the guide ───────────────────────────────────────────────────────────────

let kbCache = null;
export function kbSections() {
  if (kbCache) return kbCache;
  const file = path.join(process.cwd(), 'src', 'lib', 'ava', 'kb.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  kbCache = text.split(/\n(?=## )/).filter((s) => s.startsWith('## ')).map((s) => {
    const [head, ...rest] = s.split('\n');
    return { title: head.replace(/^##\s*/, '').trim(), text: rest.join('\n').trim() };
  });
  return kbCache;
}
const STOP = new Set('a an the to of for in on at is are am be do does did i me my we our you your it its this that and or please can could would will should with about what how why when where who which there any some tell show give get let know need needs want'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const toks = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

async function search_kb(args) {
  const q = toks(args?.query || '');
  const secs = kbSections();
  if (!q.length) return { results: secs.slice(0, 1) };
  const scored = secs.map((s) => {
    const head = new Set(toks(s.title));
    const body = new Set(toks(s.text));
    let score = 0;
    for (const w of new Set(q)) { if (head.has(w)) score += 3; if (body.has(w)) score += 1; }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return { results: scored.map((x) => ({ title: x.s.title, text: x.s.text.slice(0, 1800) })) };
}

// ─── definitions (OpenAI function calling) ──────────────────────────────────

const DEFS = {
  hub_summary: { description: 'Everything at a glance: clients by stage (company names, step, day), what needs the owner now (as types, e.g. "1 reply to read and answer at Ridgeline IT"), open alerts, waiting list.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  client_overview: { description: 'One client by (fuzzy) company name: stage, day, status, next step, sent/replies/bounced/interested/booked counts, reply types, warm-up progress and inbox rate, leads by status, things to do.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Company name as the user said it' } }, required: ['name'], additionalProperties: false } },
  calendar_summary: { description: 'Calls and meetings between two times (ISO dates; default: yesterday to two weeks ahead): Sri Lanka time, US Eastern, company, meeting type, status; plus times waiting for a yes.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, additionalProperties: false } },
  team_summary: { description: 'The team: first names, online now, their "working on" status line, clients each looks after.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  my_outreach: { description: "The owner's own outreach (My stats): totals only — sent, opens, replies, bounces, days.", parameters: { type: 'object', properties: {}, additionalProperties: false } },
  money_summary: { description: 'OWNER ONLY. Money received (all time, this month), unpaid invoices, and each client\'s month-one invoice (plan, amount, paid or not).', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  search_kb: { description: 'Search the written guide: the whole process (apply → yes → onboarding call → inboxes → warm-up → launch call → sending → replies → calls → day 30 → invoice), every hub page and button, settings, roles, FAQs.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
};
const RUN = { hub_summary, client_overview, calendar_summary, team_summary, my_outreach, money_summary, search_kb };
export const TOOL_NAMES = Object.keys(RUN);

/** The tools a role may use (a team member never gets money_summary). */
export function toolsFor(role) {
  return TOOL_NAMES.filter((n) => n !== 'money_summary' || role === 'admin');
}
export function toolDefs(role) {
  return toolsFor(role).map((name) => ({ type: 'function', function: { name, description: DEFS[name].description, parameters: DEFS[name].parameters } }));
}

/**
 * A tool's context: role, the clock, and the board read at most once per
 * question (several tools share it).
 */
export function toolContext({ role = 'employee', now = () => new Date() } = {}) {
  let boardP = null;
  let namesP = null;
  return {
    role, now,
    board: () => (boardP ||= hubBoard({ now: now() })),
    names: () => (namesP ||= personNames()),
  };
}

/** Run one tool → a clean, personal-data-free object (errors become { error }). */
export async function runTool(name, args, ctx) {
  if (!toolsFor(ctx.role).includes(name)) return { error: name === 'money_summary' ? 'Money is only for the owner.' : `There is no tool called ${String(name).slice(0, 40)}.` };
  let out;
  try { out = await RUN[name](args && typeof args === 'object' ? args : {}, ctx); } catch (err) { out = { error: `That look-up failed: ${String(err?.message || err).slice(0, 120)}` }; }
  return clean(out, await ctx.names());
}
