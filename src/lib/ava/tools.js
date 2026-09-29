/**
 * Ava's tools (docs/HUB-API.md "Ava (AI helper)") — what the brain may look
 * up, run here on the machine. Seven broad tools (fewer, richer tools keep
 * each request small and the choice easy):
 *
 *   search_hub {query}      clients / applications / calls / team by name or state, + the guide
 *   get_client {name|id}    one client's whole picture (money only for the owner)
 *   list_clients {filter}   clients by step, what needs the owner, the waiting list
 *   get_numbers {scope}     my_outreach | all_clients | money (owner only)
 *   get_calendar {from,to}  calls and meetings
 *   web_search {query}      current / outside facts (Tavily, then Exa) — only with a search key
 *   propose_action {name, args, label}  a button for the user (navigate, read, draft, or a confirm)
 *
 * EVERY output is free of personal data: company names, counts, stages,
 * dates, day numbers, rates and plan names only. Never a prospect's name, an
 * email address, a phone number, a message body, the client's contact
 * person's email, a credential, a token, a link, or (for team members) any
 * money. Built from structured fields only (to-dos become their TYPE, never
 * their text), then passed through clean() (lib/ava/text.js) as a second
 * net. Outputs are compact (lists capped) to keep each request small.
 */

import { hubBoard, hubClient } from '@/lib/systems/hubview';
import { teamView } from '@/lib/systems/team';
import { calendarView } from '@/lib/systems/calendar';
import { personNames, prospectNames, cleanText, clean } from '@/lib/ava/text';
import { retrieve, guideChunks } from '@/lib/ava/kb';
import { webSearch } from '@/lib/ava/search';
import { proposalToAction, CONFIRMS, VIEWS, CLIENT_TABS, SETTINGS_SECTIONS } from '@/lib/ava/actions';

export const OWNER_TZ = 'Asia/Colombo';
export { personNames, cleanText, clean };

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

/** Every client that matches a name said or typed a bit wrong → [{ c, s }] best first. */
export function scoreClients(query, clients) {
  const q = norm(query);
  if (!q) return [];
  const out = [];
  for (const c of clients) {
    let best = 0;
    const consider = (s) => { if (s > best) best = s; };
    const full = norm(c.name);
    const id = norm(String(c.id).replace(/^demo-/, ''));
    if (full === q || id === q) { out.push({ c, s: 100 }); continue; }
    if (full && (full.includes(q) || q.includes(full))) consider(60 + Math.min(q.length, full.length));
    const words = full.split(' ').filter((w) => w.length >= 3 && !GENERIC.has(w));
    for (const w of words) {
      for (const qw of q.split(' ')) {
        if (qw === w) consider(40 + w.length);
        else if (qw.length >= 4 && w.length >= 4) { const d = lev(qw, w); if (d <= (w.length >= 8 ? 2 : 1)) consider(30 + w.length - d * 5); }
      }
    }
    const flat = full.replace(/ /g, ''); const qflat = q.replace(/ /g, '');
    if (qflat.length >= 5 && flat.length >= 5) { const d = lev(qflat, flat.slice(0, qflat.length)); if (d <= 1) consider(25); }
    if (best > 0) out.push({ c, s: best });
  }
  return out.sort((a, b) => b.s - a.s);
}

/** The best client for a name said or typed a bit wrong → { id, name } | null. */
export function matchClient(query, clients) {
  return scoreClients(query, clients)[0]?.c || null;
}

// ─── shared pieces ───────────────────────────────────────────────────────────

const PAID = ['starter', 'growth', 'scale'];
const LIST_CAP = 20;
const cap = (arr, n = LIST_CAP) => (arr.length > n ? arr.slice(0, n) : arr);

/** One compact line about a client on the board. */
function clientLine({ row, stage }) {
  return {
    id: row.id, name: row.name, plan: row.plan || 'trial', stage, step: row.simple?.step || null,
    status: row.simple?.label || row.stateLabel || null,
    day: num(row.simple?.dayOf30) ?? num(row.trialDay), needsYou: Boolean(row.simple?.needsYou),
    ...(row.demo ? { testRun: true } : {}),
  };
}

/** Stage key for a row (board.stages[].key). */
function rowsWithKeys(board) {
  const out = [];
  for (const s of board.stages || []) for (const r of s.clients || []) if (!HIDDEN_IDS.has(r.id)) out.push({ row: r, stage: s.label, key: s.key });
  return out;
}

function counts(rows) {
  return {
    totalClients: rows.length,
    trials: rows.filter((x) => !PAID.includes(x.row.plan)).length,
    paying: rows.filter((x) => PAID.includes(x.row.plan)).length,
    needYouNow: rows.filter((x) => x.row.simple?.needsYou).length,
  };
}

async function calendarRange(args, ctx, { defaultBackDays = 1, defaultAheadDays = 14 } = {}) {
  const now = ctx.now();
  const from = Date.parse(args?.from) || now.getTime() - defaultBackDays * 86400e3;
  let to = Date.parse(args?.to) || from + (defaultBackDays + defaultAheadDays) * 86400e3;
  if (to <= from) to = from + 86400e3;
  if (to - from > 62 * 86400e3) to = from + 62 * 86400e3;
  const v = await calendarView({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), now });
  const one = (m) => ({
    when: m.labels?.owner ? `${m.labels.owner} (Sri Lanka)` : m.start, eastern: m.labels?.eastern || null, start: m.start, minutes: num(m.minutes),
    company: m.company || (m.status === 'blocked' ? 'busy block' : null), type: m.status === 'blocked' ? 'block' : m.kind || 'other', status: m.status,
    ...(m.meetLink ? { hasMeetLink: true } : {}), ...(m.demo ? { testRun: true } : {}),
  });
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), meetings: (v.meetings || []).map(one), waitingForYourYes: (v.requests || []).map(one) };
}

async function teamList() {
  const { team } = await teamView();
  return (team || []).map((p) => ({
    firstName: firstName(p.name) || (p.role === 'admin' ? 'The owner' : 'A team member'),
    role: p.role === 'admin' ? 'owner' : 'team member',
    online: Boolean(p.online),
    status: p.status?.text || null, statusAt: p.status?.at || null,
    looksAfter: (p.clients || []).map((c) => c.name),
  }));
}

// ─── search_hub ──────────────────────────────────────────────────────────────

const STATE_WORDS = [
  [/\b(appl(y|ied|ication)s?|new|review|queue|waiting list)\b/i, ['intake']],
  [/\bonboard(ing)?\b/i, ['onboard']],
  [/\b(buy(ing)?|set ?up|setting up|domain|inbox(es)?)\b/i, ['setup']],
  [/\bwarm(ing)?[- ]?up\b|\bwarming\b/i, ['build']],
  [/\b(send(ing)?|live|paused|extension)\b/i, ['live']],
  [/\b(decid(e|ing)|day ?30|decision)\b/i, ['decide']],
  [/\b(convert(ed)?|won|paying|paid)\b/i, ['won']],
  [/\b(done|ended|finished|declined|not taken|closing|not now)\b/i, ['closing', 'ended']],
];

async function search_hub(args, ctx) {
  const query = String(args?.query || '').slice(0, 200);
  const board = await ctx.board();
  const rows = rowsWithKeys(board);
  const scored = scoreClients(query, rows.map((x) => ({ id: x.row.id, name: x.row.name })));
  const byName = scored.filter((x) => x.s >= 30).map((x) => rows.find((r) => r.row.id === x.c.id));
  const keys = new Set(STATE_WORDS.filter(([re]) => re.test(query)).flatMap(([, k]) => k));
  const byState = keys.size ? rows.filter((r) => keys.has(r.key)) : [];
  const needs = /\bneed(s)? (me|you|the owner)|urgent|to-?do|what('s| is) (waiting|next)/i.test(query) ? rows.filter((r) => r.row.simple?.needsYou) : [];
  const seen = new Set();
  const clients = [];
  for (const r of [...byName, ...needs, ...byState]) { if (r && !seen.has(r.row.id)) { seen.add(r.row.id); clients.push(clientLine(r)); } }
  const out = { query, clients: cap(clients, 12) };
  if (clients.length > 12) out.moreClients = clients.length - 12;
  // Calls: by company or by call type.
  const cal = await calendarRange({}, ctx, { defaultBackDays: 7, defaultAheadDays: 30 }).catch(() => null);
  if (cal) {
    const names = new Set(clients.map((c) => norm(c.name)));
    const typeHit = /\b(call|calls|meeting|meetings|calendar|launch|onboarding|booked)\b/i.test(query);
    const meetings = cal.meetings.filter((m) => (m.company && names.has(norm(m.company))) || (typeHit && m.type !== 'block'));
    if (meetings.length) out.calls = cap(meetings, 10);
    if (typeHit && cal.waitingForYourYes.length) out.callTimesWaitingForYourYes = cap(cal.waitingForYourYes, 10);
  }
  // Team.
  const team = await teamList().catch(() => []);
  const teamHit = /\b(team|staff|online|who is working|people|colleague|employee)\b/i.test(query);
  const q = norm(query);
  const people = team.filter((p) => teamHit || (p.firstName && q.split(' ').includes(norm(p.firstName))) || p.looksAfter.some((n) => names2(n, q)));
  if (people.length) out.team = cap(people, 12);
  if (/\bwait(ing)? ?list|queue\b/i.test(query)) out.waitingList = (board.machine?.queue || []).map((x) => x.name || x.id);
  // The guide.
  const guide = retrieve(query, { page: ctx.page || {}, facts: await ctx.facts(), limit: 3, maxTokens: 600 });
  if (guide.length) out.guide = guide.map((g) => ({ title: g.title, text: g.text }));
  if (!clients.length && !out.calls && !out.team && !out.guide) out.message = 'Nothing in the hub matches that. Try a company name, a step (applied, warming up, sending…) or "team".';
  return out;
}
const names2 = (clientName, q) => { const n = norm(clientName); return n && q && (n.includes(q) || q.includes(n)); };

// ─── get_client ──────────────────────────────────────────────────────────────

function callsOf(d) {
  const list = Array.isArray(d.bookings) ? d.bookings : [];
  const byStatus = {};
  for (const b of list) { const k = String(b.status || 'booked'); byStatus[k] = (byStatus[k] || 0) + 1; }
  const upcoming = list.filter((b) => b.scheduledAt && Date.parse(b.scheduledAt) > Date.now() && ['booked', 'rebooked'].includes(b.status)).length;
  return { total: list.length, qualified: list.filter((b) => b.qualified).length, byStatus, upcoming };
}
const callCard = (c) => (c ? { status: c.status || null, bookedFor: c.bookedFor || null, heldAt: c.heldAt || null, overdue: Boolean(c.overdue), remindersSent: num(c.remindersSent), needsReply: Boolean(c.needsReply) } : null);

async function get_client(args, ctx) {
  const board = await ctx.board();
  const rows = rowsWithKeys(board);
  const wanted = String(args?.id || args?.name || '').trim() || ctx.page?.clientId || '';
  let hit = rows.find((x) => x.row.id === wanted);
  if (!hit) {
    const m = matchClient(wanted, rows.map((x) => ({ id: x.row.id, name: x.row.name })));
    hit = m ? rows.find((x) => x.row.id === m.id) : null;
  }
  if (!hit) return { found: false, message: wanted ? 'No client by that name.' : 'Which client? Give a name.', clients: cap(rows.map((x) => x.row.name), 30) };
  const { row, stage } = hit;
  const owner = ctx.role === 'admin';
  const d = (await hubClient(row.id, { owner }).catch(() => null)) || {};
  const alertsById = new Map((board.alerts || []).map((a) => [String(a.id), a]));
  const five = row.five || {};
  const counters = d.counters || {};
  const w = d.warmup || null;
  const kinds = d.repliesByKind && typeof d.repliesByKind === 'object' ? Object.fromEntries(Object.entries(d.repliesByKind).map(([k, v]) => [k, num(v) ?? 0]).filter(([, v]) => v)) : {};
  const out = {
    found: true,
    id: row.id, name: row.name, plan: row.plan || 'trial', stage, step: row.simple?.step || null,
    ...(row.demo ? { testRun: true } : {}),
    status: row.simple?.label || row.stateLabel || null,
    next: row.simple?.next || null,
    needsYou: Boolean(row.simple?.needsYou),
    day: num(row.simple?.dayOf30) ?? num(row.trialDay), day1Date: row.day1Date || null, day30Date: (row.plan || 'trial') === 'trial' ? row.day30Date || null : null,
    health: row.health || null,
    emails: {
      sent: num(five.sent) ?? num(counters.sent), replies: num(five.replies) ?? num(counters.replies),
      bounced: num(counters.bounces) ?? num(counters.bounced), interested: num(five.positive) ?? num(kinds.interested),
      booked: num(five.booked) ?? num(counters.booked), qualified: num(five.qualified),
    },
    replyTypes: kinds,
    calls: callsOf(d),
    onboardingCall: callCard(d.onboardCall),
    launchCall: callCard(d.launchCall),
    warmup: w ? { status: w.status || null, day: num(w.day), of: num(w.of), inboxRatePct: pct(w.inboxRate), readyBy: w.readyBy || null, inboxes: Array.isArray(w.inboxes) ? w.inboxes.length : null } : (row.inboxRate != null ? { inboxRatePct: pct(row.inboxRate) } : null),
    leads: d.leadsByStatus && typeof d.leadsByStatus === 'object' ? d.leadsByStatus : null,
    nextUp: row.nextUp || null,
    thingsToDo: cap(needsLines(row.todo, alertsById).map((x) => x.text), 8),
    openAlerts: num(row.openAlerts) ?? 0,
  };
  if (owner) {
    const inv = row.invoice || d.invoice || null;
    if (inv && inv.amount != null) out.money = { plan: inv.plan || row.plan || null, amountUsd: Number(inv.amount) || 0, status: inv.paidAt || inv.status === 'paid' ? 'paid' : inv.status || 'sent', issued: dateOnly(inv.issuedAt), paid: dateOnly(inv.paidAt) };
  }
  return out;
}

// ─── list_clients ────────────────────────────────────────────────────────────

export const FILTERS = ['all', 'needs_you', 'trials', 'paying', 'applied', 'onboarding', 'setting_up', 'warming_up', 'sending', 'deciding', 'done', 'waiting_list', 'test_run'];
const FILTER_KEYS = { applied: ['intake'], onboarding: ['onboard'], setting_up: ['setup'], warming_up: ['build'], sending: ['live'], deciding: ['decide'], done: ['won', 'closing', 'ended'] };

async function list_clients(args, ctx) {
  const filter = FILTERS.includes(args?.filter) ? args.filter : 'all';
  const board = await ctx.board();
  const alertsById = new Map((board.alerts || []).map((a) => [String(a.id), a]));
  const rows = rowsWithKeys(board);
  let pick = rows;
  if (filter === 'needs_you') pick = rows.filter((r) => r.row.simple?.needsYou);
  else if (filter === 'trials') pick = rows.filter((r) => !PAID.includes(r.row.plan));
  else if (filter === 'paying') pick = rows.filter((r) => PAID.includes(r.row.plan));
  else if (filter === 'test_run') pick = rows.filter((r) => r.row.demo);
  else if (FILTER_KEYS[filter]) pick = rows.filter((r) => FILTER_KEYS[filter].includes(r.key));
  const out = { filter, ...counts(rows), count: filter === 'waiting_list' ? (board.machine?.queue || []).length : pick.length };
  if (filter !== 'waiting_list') out.clients = cap(pick.map(clientLine));
  if (pick.length > LIST_CAP) out.more = pick.length - LIST_CAP;
  if (filter === 'all' || filter === 'needs_you') {
    out.needsTheOwner = cap(needsLines(board.todos, alertsById).map((x) => ({ text: x.text, urgent: x.urgent })), 15);
    out.openAlerts = num(board.machine?.openAlerts) ?? 0;
    out.newPlanInquiries = (board.inquiries?.latest || []).filter((q) => q.status === 'new').length;
  }
  if (filter === 'all' || filter === 'waiting_list' || filter === 'applied') {
    out.activeTrials = num(board.machine?.activeTrials); out.maxActiveTrials = num(board.machine?.maxActiveTrials);
    out.waitingList = (board.machine?.queue || []).map((q) => q.name || q.id);
  }
  return out;
}

// ─── get_numbers ─────────────────────────────────────────────────────────────

async function my_outreach() {
  const { GET } = await import('@/app/api/mc/outreach/route');
  const res = await GET();
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { error: 'The sending history could not be read just now.' };
  const t = j.totals || {};
  const keep = ['sent', 'newSends', 'followUps', 'opens', 'uniqueOpens', 'replies', 'bounces', 'days', 'firstDay', 'lastDay'];
  return { scope: 'my_outreach', about: "Aviance's own cold emails (My stats)", totals: Object.fromEntries(keep.map((k) => [k, t[k] ?? null])), inboxCount: Array.isArray(j.inboxes) ? j.inboxes.length : null };
}

async function all_clients(ctx) {
  const board = await ctx.board();
  const rows = rowsWithKeys(board);
  const tot = { sent: 0, replies: 0, interested: 0, booked: 0, qualified: 0 };
  const per = [];
  for (const { row, stage } of rows) {
    const f = row.five || {};
    const one = { name: row.name, stage, sent: num(f.sent), replies: num(f.replies), interested: num(f.positive), booked: num(f.booked), qualified: num(f.qualified), ...(row.demo ? { testRun: true } : {}) };
    if (!row.demo) for (const k of Object.keys(tot)) tot[k] += one[k] || 0;
    if (Object.values(one).some((v) => typeof v === 'number' && v > 0)) per.push(one);
  }
  const byStage = {};
  for (const r of rows) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  return {
    scope: 'all_clients', ...counts(rows), byStage, totalsRealClients: tot,
    replyRatePct: tot.sent ? Math.round((tot.replies / tot.sent) * 1000) / 10 : null,
    clients: cap(per.sort((a, b) => (b.sent || 0) - (a.sent || 0))),
    activeTrials: num(board.machine?.activeTrials), maxActiveTrials: num(board.machine?.maxActiveTrials),
  };
}

async function money(ctx) {
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
  const { cfg } = await import('@/lib/config');
  const plans = (await cfg(null, 'PLANS').catch(() => null)) || {};
  const prices = {};
  for (const k of PAID) if (plans[k]) prices[k] = { priceUsdPerMonth: num(plans[k].price), callsIncluded: num(plans[k].calls), reach: num(plans[k].reach) };
  return { scope: 'money', currency: 'USD', month, totals, ...(test.received ? { testRunReceivedNotCounted: test.received } : {}), clients: cap(clients), prices };
}

async function get_numbers(args, ctx) {
  const scope = String(args?.scope || 'all_clients');
  if (scope === 'my_outreach') return my_outreach();
  if (scope === 'money') return money(ctx);
  return all_clients(ctx);
}

// ─── get_calendar ────────────────────────────────────────────────────────────

async function get_calendar(args, ctx) {
  const r = await calendarRange(args, ctx);
  return { ...r, timeZone: 'Sri Lanka (Asia/Colombo), US Eastern beside it', meetings: cap(r.meetings, 25), waitingForYourYes: cap(r.waitingForYourYes, 10) };
}

// ─── web_search ──────────────────────────────────────────────────────────────

async function web_search(args, ctx) {
  // Only the question's words go out: no emails, phones, links, contact or prospect names.
  const names = [...await ctx.names(), ...await prospectNames().catch(() => [])];
  const out = await webSearch(args?.query, { names });
  return out.query ? { ...out, query: cleanText(out.query, names) } : out;
}

// ─── propose_action ──────────────────────────────────────────────────────────

async function propose_action(args, ctx) {
  const action = proposalToAction(args, ctx.role);
  if (!action) return { error: `That button can't be offered${ctx.role !== 'admin' ? ' to a team member' : ''} — check the name and args.` };
  ctx.actions.push(action);
  return { ok: true, action, note: action.type === 'navigate' ? 'The hub opens this page now.' : action.type === 'read' ? 'The hub reads the screen out loud itself; say one short line.' : 'The user sees this as a button; nothing has happened yet — do not say it is done.' };
}

// ─── definitions (OpenAI function calling) ──────────────────────────────────

const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const DEFS = {
  search_hub: { description: 'Search the hub: clients and applications by (fuzzy) name or by step (applied, onboarding, setting up, warming up, sending, deciding, done, needs me), calls by company or type, the team (who is online, what they work on, who looks after whom), the waiting list, plus the matching parts of the guide.', parameters: obj({ query: { type: 'string' } }, ['query']) },
  get_client: { description: "One client's whole picture: stage, day, status, next step, emails sent/replies/bounced/interested/booked, reply types, calls (booked, qualified, upcoming), onboarding and launch call, warm-up and inbox rate, leads, things to do; money for the owner. No name = the client on screen.", parameters: obj({ name: { type: 'string', description: 'Company name as said' }, id: { type: 'string' } }) },
  list_clients: { description: 'Clients by filter, with counts. "needs_you" and "all" also list what needs the owner now (as types, e.g. "1 reply to read and answer at Ridgeline IT"), open alerts and new plan inquiries.', parameters: obj({ filter: { type: 'string', enum: FILTERS } }, ['filter']) },
  get_numbers: { description: 'Numbers. my_outreach = Aviance\'s own cold emails (My stats: sent, opens, replies, bounces). all_clients = totals and per-client emails, replies, interested, calls booked. money = OWNER ONLY: money received (all time, this month), unpaid invoices, plan prices.', parameters: obj({ scope: { type: 'string', enum: ['my_outreach', 'all_clients', 'money'] } }, ['scope']) },
  get_calendar: { description: 'Calls and meetings between two ISO dates (default: yesterday to two weeks ahead): Sri Lanka time with US Eastern, company, call type, status; plus call times waiting for the owner\'s yes.', parameters: obj({ from: { type: 'string' }, to: { type: 'string' } }) },
  web_search: { description: 'Search the web for current or outside facts (news, prices, laws, other companies, anything after your training). Send only a short topic query — never a person\'s name, email address or phone number.', parameters: obj({ query: { type: 'string' } }, ['query']) },
  propose_action: { description: `Offer the user a button (you cannot change anything yourself). name: "navigate" opens a page at once — args {view: ${VIEWS.join('|')}; for view client also id (client id from get_client/search_hub; fuzzy names are fine there) and tab? ${CLIENT_TABS.join('|')}; for view settings section? ${SETTINGS_SECTIONS.join('|')}}. "read" (args {what:"page"}) has the hub read out what is on the screen (after a navigate when they said "open X and read it"). "draft" (args {title, text}) gives text to copy, e.g. an email. Or a confirm button: ${CONFIRMS.join(', ')} (open_client/give_access {id}; mark_todo_seen {id, todoId}; set_my_status {text}; add_change_request {text} for a wish to change how the hub works).`, parameters: obj({ name: { type: 'string' }, args: { type: 'object' }, label: { type: 'string', description: 'Button text' } }, ['name']) },
};
const RUN = { search_hub, get_client, list_clients, get_numbers, get_calendar, web_search, propose_action };
export const TOOL_NAMES = Object.keys(RUN);

/** Old names (a brain may still use them) → the new tool and args. */
const ALIASES = {
  hub_summary: () => ['list_clients', { filter: 'all' }],
  client_overview: (a) => ['get_client', a],
  calendar_summary: (a) => ['get_calendar', a],
  team_summary: () => ['search_hub', { query: 'team' }],
  my_outreach: () => ['get_numbers', { scope: 'my_outreach' }],
  money_summary: () => ['get_numbers', { scope: 'money' }],
  search_kb: (a) => ['search_hub', a],
};

/** The tools a role may use (web_search only with a search key: `opts.search`). */
export function toolsFor(role, { search = true } = {}) {
  return TOOL_NAMES.filter((n) => n !== 'web_search' || search);
}
export function toolDefs(role, opts = {}) {
  const owner = role === 'admin';
  return toolsFor(role, opts).map((name) => {
    let { description, parameters } = DEFS[name];
    if (name === 'get_numbers' && !owner) parameters = obj({ scope: { type: 'string', enum: ['my_outreach', 'all_clients'] } }, ['scope']);
    if (name === 'get_numbers' && !owner) description = description.replace(/ money = OWNER ONLY.*$/, '');
    return { type: 'function', function: { name, description, parameters } };
  });
}

/**
 * A tool's context: role, the clock, the page, and the board read at most
 * once per question (several tools share it). `actions` collects what
 * propose_action offers.
 */
export function toolContext({ role = 'employee', now = () => new Date(), page = {}, facts = null } = {}) {
  let boardP = null;
  let namesP = null;
  let factsP = null;
  return {
    role, now, page, actions: [],
    board: () => (boardP ||= hubBoard({ now: now() })),
    names: () => (namesP ||= personNames()),
    facts: () => (factsP ||= (facts != null ? Promise.resolve(facts) : import('@/lib/ava/facts').then((m) => m.getFacts()).then((f) => f.text).catch(() => ''))),
  };
}

/** Run one tool → a clean, personal-data-free object (errors become { error }). */
export async function runTool(name, args, ctx) {
  let n = String(name || '');
  let a = args && typeof args === 'object' ? args : {};
  if (ALIASES[n]) [n, a] = ALIASES[n](a);
  if (!RUN[n]) return { error: `There is no tool called ${String(name).slice(0, 40)}.` };
  if (n === 'get_numbers' && a.scope === 'money' && ctx.role !== 'admin') return { error: 'Money is only for the owner.' };
  let out;
  try { out = await RUN[n](a, ctx); } catch (err) { out = { error: `That look-up failed: ${String(err?.message || err).slice(0, 120)}` }; }
  return clean(out, await ctx.names());
}

/** Kept for callers of the old guide search: the guide's sections by title. */
export const kbSections = () => guideChunks().map((c) => ({ title: c.title, text: c.text }));
