/**
 * Placement testing v2 (SPEC §6.6, §7.7; research: docs/research/v2-deliverability.md §3).
 *
 * Two kinds of test land in one history, client:{id}:placement (list, newest
 * first, capped at 30):
 *   - seed   — the canary (canary.js): our own helper mailboxes, real inbox
 *              vs spam placement per provider (Gmail, Yahoo, iCloud, GMX …);
 *   - spam   — one real-looking email from each trial inbox (the client's own
 *              Day 0 copy, rendered for a made-up sample company, with the
 *              same headers the Sender uses) to a free spam-test tool, whose
 *              verdict is fetched automatically:
 *                mail-tester   score out of 10 + SPF/DKIM/DMARC, SpamAssassin
 *                              rules, blacklists of the real sending IP. JSON
 *                              results are a paid feature per its FAQ, so it is
 *                              used with MAILTESTER_USERNAME (the owner's
 *                              account, one-time credits) or when the owner
 *                              turns PLACEMENT.mailTesterFree on (3 free
 *                              tests / 24 h);
 *                dkimvalidator free, no account: SpamAssassin points + DKIM
 *                              + SPF verdicts (the default).
 *
 * Schedule, per inbox: from Day −PLACEMENT.daysBeforeDay1 (−3) while warming,
 * daily until a test passes; Day 1; then every PLACEMENT.everyDays (7) while
 * sending (daily again after a failure). A tool's daily allowance
 * (PLACEMENT.dailyLimit, all clients together) is claimed with INCR before
 * each send; over it, the test waits for tomorrow.
 *
 * Day 1 gate (readiness.js): every inbox's latest spam test passed within
 * PLACEMENT.maxAgeDays (mail-tester ≥ PLACEMENT.minScore; dkimvalidator
 * SpamAssassin ≤ PLACEMENT.maxSpamAssassin with DKIM and SPF pass), on top of
 * the seed placement ≥ CANARY.gate. A failure alerts `spam_score_low` with
 * the tool's own reasons; a tool that cannot be reached alerts
 * `placement_test_failed` (PLACEMENT.gate = false starts Day 1 without it).
 *
 * The job is a small state machine in client:{id}:placementrun:{day} so each
 * tick does bounded work: sending → waiting → checking → done.
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getTrial, getProfile, updateClient, WARMUP_STATES, SENDING_STATES } from '@/lib/db/client';
import { getInboxRecords, patchInbox, toAccount } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { ET, dayKeyIn, trialDay, partsIn, daysBetween } from '@/lib/time';

export const PLACEMENT_CAP = 30;
const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const round = (n, p = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** p) / 10 ** p);
const stripTags = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ── history ──────────────────────────────────────────────────────────────────

/** Add one result to the client's placement history (newest first, capped). */
export async function recordPlacement(clientId, entry) {
  const p = kv.pipeline();
  p.lpush(K.placement(clientId), JSON.stringify(entry));
  p.ltrim(K.placement(clientId), 0, PLACEMENT_CAP - 1);
  await p.exec();
  return entry;
}

/** Newest-first placement history (parsed). */
export async function placementHistory(clientId, n = PLACEMENT_CAP) {
  const rows = (await kv.lrange(K.placement(clientId), 0, Math.max(0, n - 1))) || [];
  return rows.map((r) => parse(r, null)).filter(Boolean);
}

/** Latest spam-test (non-seed) entry per inbox from a newest-first history. */
export function latestSpamTests(history) {
  const out = {};
  for (const e of history || []) if (e && e.tool !== 'seed' && e.inbox && !out[e.inbox]) out[e.inbox] = e;
  return out;
}

// ── tools ────────────────────────────────────────────────────────────────────

const base36 = (n) => { let s = ''; const bytes = crypto.randomBytes(n); for (const b of bytes) s += (b % 36).toString(36); return s; };

/**
 * mail-tester JSON (https://www.mail-tester.com/{id}?format=json) → verdict.
 * Overall score = displayedMark "x/10" (10 + the summed deductions in `mark`).
 * Not arrived yet: status false + "Mail not found…".
 */
export function parseMailTester(json) {
  if (!json || typeof json !== 'object') return { ready: false, error: 'no JSON' };
  const title = String(json.title || '');
  if (json.status === false || /mail not found/i.test(title)) return { ready: false, waiting: /not found|wait/i.test(title), note: title.slice(0, 120) };
  let score = null;
  const m = /(-?\d+(?:[.,]\d+)?)\s*\/\s*10/.exec(String(json.displayedMark || ''));
  if (m) score = Number(m[1].replace(',', '.'));
  else if (Number.isFinite(Number(json.mark)) && Number(json.mark) <= 0) score = 10 + Number(json.mark);
  if (score == null) return { ready: false, error: 'result has no score' };
  score = Math.max(0, Math.min(10, round(score, 1)));
  const bad = [];
  const good = [];
  const sig = json.signature?.subtests || {};
  for (const [k, label] of [['spf', 'SPF'], ['dkim', 'DKIM'], ['dmarc', 'DMARC'], ['rDns', 'Reverse DNS'], ['aRecord', 'A record'], ['mxRecord', 'MX record']]) {
    const t = sig[k];
    if (!t) continue;
    const st = String(t.status ?? '').toLowerCase();
    const ok = st === 'pass' || st === 'true' || t.status === true || (Number(t.mark) >= 0 && !/fail/.test(String(t.statusClass || '')));
    (ok ? good : bad).push(`${label} ${ok ? 'pass' : st && st !== 'false' ? st : 'fail'}`);
  }
  const sa = json.spamAssassin || {};
  if (sa.score != null) (Number(sa.mark) < 0 ? bad : good).push(`SpamAssassin ${round(sa.score, 1)}`);
  const rules = Object.values(sa.rules || {}).filter((r) => Number(r?.score) > 0).sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 5);
  for (const r of rules) bad.push(`${r.code || 'rule'} +${round(r.score, 1)}${r.description ? `: ${String(r.description).slice(0, 90)}` : ''}`);
  const bl = json.blacklists || {};
  const hits = Object.values(bl.blacklists || {}).filter((z) => Number(z?.statusCode) > 0 || Number(z?.hitMark) < 0).map((z) => z.name || z.dns).filter(Boolean);
  if (hits.length) bad.push(`Blacklisted on ${hits.slice(0, 5).join(', ')}`);
  else if (bl.blacklists) good.push('Not on the blacklists checked');
  const unsub = json.body?.subtests?.listUnsubscribe;
  if (unsub && Number(unsub.mark) < 0) bad.push('List-Unsubscribe header missing or wrong');
  for (const [k, label] of [['body', 'Content'], ['links', 'Links']]) {
    const b = json[k];
    if (b && Number(b.mark) < 0) bad.push(`${label}: ${String(stripTags(b.title || b.description || 'deducted')).slice(0, 90)} (${round(b.mark, 1)})`);
  }
  return { ready: true, score, detail: [...bad, ...good].slice(0, 14) };
}

/** dkimvalidator pages (sa.pl, dkim.pl, spf.pl) → verdict. */
export function parseDkimValidator({ sa = '', dkim = '', spf = '' } = {}) {
  const t = { sa: stripTags(sa), dkim: stripTags(dkim), spf: stripTags(spf) };
  if (/haven'?t received an email recently/i.test(t.sa) || /haven'?t received an email recently/i.test(t.dkim)) return { ready: false, waiting: true };
  if (/invalid email address/i.test(t.sa)) return { ready: false, error: 'invalid test address' };
  const m = /SpamAssassin Score:\s*(-?\d+(?:\.\d+)?)/i.exec(t.sa);
  if (!m) return { ready: false, error: 'no SpamAssassin score in the page' };
  const spamAssassin = Number(m[1]);
  const markedSpam = /Message is marked as spam/i.test(t.sa) && !/NOT marked as spam/i.test(t.sa);
  let dkimResult = 'unknown';
  if (/does not contain a DKIM Signature/i.test(t.dkim)) dkimResult = 'none';
  else { const d = /result\s*=\s*([a-z]+)/i.exec(t.dkim); if (d) dkimResult = d[1].toLowerCase(); }
  const s = /Result code:\s*([a-z]+)/i.exec(t.spf);
  const spfResult = s ? s[1].toLowerCase() : 'unknown';
  const rules = [];
  for (const line of t.sa.split('\n')) {
    const r = /^\s*(-?\d+(?:\.\d+)?)\s+([A-Z0-9_]{3,})\s+(.*)$/.exec(line);
    if (r && Number(r[1]) > 0) rules.push({ score: Number(r[1]), code: r[2], text: r[3].trim() });
  }
  rules.sort((a, b) => b.score - a.score);
  const detail = [
    ...(dkimResult !== 'pass' ? [`DKIM ${dkimResult}`] : []),
    ...(spfResult !== 'pass' ? [`SPF ${spfResult}`] : []),
    ...(markedSpam ? ['SpamAssassin marks it as spam'] : []),
    ...rules.slice(0, 5).map((r) => `${r.code} +${r.score}${r.text ? `: ${r.text.slice(0, 90)}` : ''}`),
    `SpamAssassin ${spamAssassin} points`,
    ...(dkimResult === 'pass' ? ['DKIM pass'] : []),
    ...(spfResult === 'pass' ? ['SPF pass'] : []),
  ];
  return { ready: true, spamAssassin, dkim: dkimResult, spf: spfResult, markedSpam, detail: detail.slice(0, 14) };
}

export const TOOLS = {
  'mail-tester': {
    newId: ({ username } = {}) => (username ? `${String(username).trim()}-${base36(16)}` : `test-${base36(9)}`),
    address: (id) => `${id}@srv1.mail-tester.com`,
    reportUrl: (id) => `https://www.mail-tester.com/${id}`,
    async fetch(id, { fetchJson }) {
      const r = await fetchJson(`https://www.mail-tester.com/${encodeURIComponent(id)}?format=json`, { service: 'mailtester', timeoutMs: 12_000, retry: false, headers: { accept: 'application/json' } });
      if (r.status >= 400 && !r.json) return { ready: false, error: `HTTP ${r.status}` };
      return parseMailTester(r.json);
    },
  },
  dkimvalidator: {
    newId: () => `av${base36(18)}`,
    address: (id) => `${id}@dkimvalidator.com`,
    // The SpamAssassin page (the site keeps a message a few hours only).
    reportUrl: (id) => `https://dkimvalidator.com/cgi-bin/sa.pl?email=${encodeURIComponent(id)}`,
    async fetch(id, { fetchText }) {
      const q = encodeURIComponent(id);
      const sa = await fetchText(`https://dkimvalidator.com/cgi-bin/sa.pl?email=${q}`);
      const first = parseDkimValidator({ sa });
      if (first.waiting || (first.error && first.error !== 'no SpamAssassin score in the page')) return first;
      const [dkim, spf] = await Promise.all([fetchText(`https://dkimvalidator.com/cgi-bin/dkim.pl?email=${q}`), fetchText(`https://dkimvalidator.com/cgi-bin/spf.pl?email=${q}`)]);
      return parseDkimValidator({ sa, dkim, spf });
    },
  },
};

/** Which tool runs: PLACEMENT.tool, 'auto' = mail-tester with an account or opt-in, else dkimvalidator. */
export function pickTool(settings, env = process.env) {
  const want = String(settings.tool || 'auto');
  const username = (env.MAILTESTER_USERNAME || '').trim() || null;
  if (want === 'mail-tester') return { tool: 'mail-tester', username };
  if (want === 'dkimvalidator') return { tool: 'dkimvalidator', username: null };
  if (username || settings.mailTesterFree) return { tool: 'mail-tester', username };
  return { tool: 'dkimvalidator', username: null };
}

/** Pure: does a tool verdict pass the gate line? */
export function passes(verdict, settings) {
  if (!verdict || !verdict.ready) return false;
  if (verdict.score != null) return verdict.score >= Number(settings.minScore);
  if (verdict.spamAssassin != null) return verdict.spamAssassin <= Number(settings.maxSpamAssassin) && verdict.dkim === 'pass' && verdict.spf === 'pass' && !verdict.markedSpam;
  return false;
}

// ── network seam (tests replace members) ────────────────────────────────────

async function defaultFetchJson(url, opts) {
  const { fetchJson } = await import('@/lib/ext/http');
  return fetchJson(url, opts);
}
async function defaultFetchText(url) {
  const { fetchExt } = await import('@/lib/ext/http');
  const res = await fetchExt(url, { service: 'dkimvalidator', timeoutMs: 12_000, retry: false });
  if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status}`), { http: res.status });
  return res.text();
}
async function defaultSend(account, mail) {
  const { net } = await import('@/lib/systems/warmup');
  return net.send(account, mail);
}

export const placementNet = { send: (a, m) => defaultSend(a, m), fetchJson: (u, o) => defaultFetchJson(u, o), fetchText: (u) => defaultFetchText(u) };

// ── the test email ───────────────────────────────────────────────────────────

/** A made-up company, so no real prospect's name ever goes to a third-party tool. */
export function sampleCompany(profile = {}) {
  const cities = String(profile.cities || '').split(/[;\n]|,(?=\s*[A-Z][a-z])/).map((s) => s.trim()).filter(Boolean);
  const city = (cities[0] || '').split(',')[0].trim() || null;
  return { first_name: 'Jordan', name: 'Jordan Ellis', company: 'Northfield Partners', city, types: [], sequenceVariant: 'A' };
}

/**
 * The client's own Day 0 email (variant A, else B) for the sample company,
 * rendered exactly as the Sender would; a plain business note when no copy
 * is stored yet (reported as `copy: false`).
 */
export async function composeTestEmail(clientId, account) {
  try {
    const [{ loadClientSequence, trialVars, buildTouch }, profile, client] = await Promise.all([
      import('@/lib/systems/sender'), getProfile(clientId), kv.hgetall(K.client(clientId)),
    ]);
    const seqs = await loadClientSequence(clientId);
    const variant = seqs.A || seqs.B;
    if (variant) {
      const lead = sampleCompany(profile);
      const vars = trialVars(lead, { client: client || {}, profile, account, variant });
      const built = buildTouch({ seq: variant, touch: 'd0', lead, vars });
      return { subject: built.subject, text: built.text, html: built.html, copy: true };
    }
  } catch {}
  const name = String(account?.displayName || '').split(/\s+/)[0] || '';
  const text = `Hi Jordan,\n\nQuick question about how Northfield Partners handles new projects at the moment. Would a short call next week be useful?\n\nThanks,\n${name}`.trim();
  return { subject: 'Quick question', text, html: `<p>${text.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`, copy: false };
}

// ── schedule ─────────────────────────────────────────────────────────────────

const SETTING_KEYS = ['tool', 'mailTesterFree', 'gate', 'minScore', 'maxSpamAssassin', 'dailyLimit', 'daysBeforeDay1', 'everyDays', 'at', 'checkAfterMin', 'giveUpMin', 'maxAgeDays', 'sendsPerRun', 'checksPerRun'];

async function settingsFor(clientId) {
  // Key by key, so an override of one dotted key (PLACEMENT.gate) counts
  // (inside a tick these reads come from the config snapshot).
  const vals = await Promise.all(SETTING_KEYS.map((k) => cfg(clientId, `PLACEMENT.${k}`)));
  const s = Object.fromEntries(SETTING_KEYS.map((k, i) => [k, vals[i]]));
  return {
    tool: s.tool || 'auto', mailTesterFree: Boolean(s.mailTesterFree), gate: s.gate !== false,
    minScore: Number(s.minScore ?? 8), maxSpamAssassin: Number(s.maxSpamAssassin ?? 2),
    dailyLimit: s.dailyLimit || {}, daysBeforeDay1: Number(s.daysBeforeDay1 ?? 3), everyDays: Number(s.everyDays ?? 7),
    at: s.at || '08:00', checkAfterMin: Number(s.checkAfterMin ?? 4), giveUpMin: Number(s.giveUpMin ?? 120),
    maxAgeDays: Number(s.maxAgeDays ?? 10), sendsPerRun: Number(s.sendsPerRun ?? 2), checksPerRun: Number(s.checksPerRun ?? 2),
  };
}

/**
 * Pure: which inboxes need a spam test today.
 * @param state      client.state
 * @param td         trial day (null = no dates yet)
 * @param day        today's ET day key
 * @param day1Date   trial.day1Date
 * @param latest     {inbox: latest spam-test entry}
 */
export function dueInboxes({ state, td, day, day1Date, inboxes, latest, s }) {
  if (td == null) return [];
  const warming = state === 'warming';
  // `ready` on Day 1 itself: the Day 1 test runs before the Sender's first send moves it to `sending`.
  const sending = SENDING_STATES.has(state) || state === 'paused' || (state === 'ready' && td >= 1);
  if (!warming && !sending) return [];
  if (warming && td < -s.daysBeforeDay1) return [];
  const out = [];
  for (const email of inboxes) {
    const e = latest[email];
    const age = e?.day ? daysBetween(e.day, day) : null;
    if (e?.day === day) continue;                                   // one test per inbox per day
    if (!e) { out.push(email); continue; }
    if (warming) { if (!e.pass || age > s.maxAgeDays - 1) out.push(email); continue; }
    // sending: Day 1 once, then every everyDays; a failed one again tomorrow
    if (!e.pass) out.push(email);
    else if (day1Date && e.day < day1Date && td >= 1) out.push(email);
    else if (age >= s.everyDays) out.push(email);
  }
  return out;
}

/** Due every 5 minutes from PLACEMENT.at until today's run is settled (client.placementDay). */
export async function placementDue(client, now = new Date()) {
  if (!WARMUP_STATES.has(client.state)) return null;
  const at = await cfg(client.id, 'PLACEMENT.at');
  const p = partsIn(ET, now);
  if (p.hhmm < at || client.placementDay === p.dayKey) return null;
  const m = Math.floor(p.minuteOfDay / 5) * 5;
  return `${p.dayKey}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

async function claimQuota(tool, day, limit) {
  if (!(limit > 0)) return true;
  const key = K.placementQuota(tool, day);
  const n = Number(await kv.incr(key));
  if (n === 1) await kv.expire(key, 2 * 86400);
  if (n > limit) { await kv.decr(key); return false; }
  return true;
}
async function releaseQuota(tool, day) { try { await kv.decr(K.placementQuota(tool, day)); } catch {} }

async function settle(clientId, key, day, fields = {}) {
  await kv.hset(key, { phase: 'done', doneAt: new Date().toISOString(), ...fields });
  await kv.expire(key, 3 * 86400);
  await updateClient(clientId, { placementDay: day });
}

/**
 * One bounded step of today's spam test for a client (the `placement` job).
 */
export async function runPlacement({ client, now = new Date(), deadline = Date.now() + 15_000, deps = {} } = {}) {
  const net = { ...placementNet, ...deps };
  const id = client.id;
  const day = dayKeyIn(ET, now);
  const key = K.placementRun(id, day);
  const s = await settingsFor(id);
  let run = (await kv.hgetall(key)) || {};
  if (run.phase === 'done') { await updateClient(id, { placementDay: day }); return { phase: 'done' }; }

  if (!run.phase) {
    const trial = await getTrial(id);
    const td = trialDay(trial, now);
    const recs = (await getInboxRecords(id)).filter((r) => r.passwordEnc);
    const latest = latestSpamTests(await placementHistory(id));
    const due = dueInboxes({ state: client.state, td, day, day1Date: trial.day1Date || null, inboxes: recs.map((r) => r.email), latest, s });
    if (!due.length) { await settle(id, key, day, { note: 'nothing due' }); return { phase: 'done', due: 0 }; }
    const { tool, username } = pickTool(s);
    run = { phase: 'sending', tool, queue: JSON.stringify(due), pending: '[]', startedAt: now.toISOString(), ...(username ? { account: '1' } : {}) };
    await kv.hset(key, run);
    await kv.expire(key, 3 * 86400);
    await logEvent(id, 'placement', 'started', { tool, inboxes: due });
  }

  const tool = TOOLS[run.tool] ? run.tool : 'dkimvalidator';
  const T = TOOLS[tool];

  if (run.phase === 'sending') {
    const queue = parse(run.queue, []);
    const pending = parse(run.pending, []);
    const recs = Object.fromEntries((await getInboxRecords(id)).map((r) => [r.email, r]));
    const limit = Number(s.dailyLimit?.[tool]) || 0;
    let n = 0;
    let quotaOut = false;
    while (queue.length && n < s.sendsPerRun && Date.now() < deadline - 4000) {
      const email = queue[0];
      const rec = recs[email];
      const account = rec ? toAccount(rec) : null;
      if (!account) { queue.shift(); await failed(id, { tool, inbox: email, error: 'inbox password missing or unreadable', now, day }); continue; }
      if (!(await claimQuota(tool, day, limit))) { quotaOut = true; break; }
      queue.shift();
      n++;
      const testId = T.newId({ username: (process.env.MAILTESTER_USERNAME || '').trim() || null });
      const mail = await composeTestEmail(id, account);
      let res;
      try {
        res = await net.send(account, { to: T.address(testId), subject: mail.subject, text: mail.text, html: mail.html, headers: {}, noTrack: true, touch: 'd0' });
      } catch (err) { res = { success: false, error: err.message }; }
      if (!res?.success) {
        await releaseQuota(tool, day);
        await failed(id, { tool, inbox: email, error: `send failed: ${String(res?.error || 'unknown').slice(0, 120)}`, now, day });
        continue;
      }
      try { const { statBump } = await import('@/lib/systems/warmup'); await statBump(email, 'sent', 1, now); } catch {}
      pending.push({ inbox: email, id: testId, sentAt: now.toISOString(), copy: mail.copy, errors: 0 });
    }
    const fields = { queue: JSON.stringify(queue), pending: JSON.stringify(pending) };
    if (quotaOut) {
      await logEvent(id, 'placement', 'quota_used', { tool, waiting: queue });
      fields.quotaWait = JSON.stringify(queue);
      fields.queue = '[]';
      queue.length = 0;
    }
    if (!queue.length) Object.assign(fields, pending.length ? { phase: 'waiting', sentDoneAt: now.toISOString() } : { phase: 'done', doneAt: now.toISOString() });
    await kv.hset(key, fields);
    if (fields.phase === 'done') { await updateClient(id, { placementDay: day }); return { phase: 'done', sent: 0, quotaWait: quotaOut }; }
    return { phase: fields.phase || 'sending', sent: pending.length };
  }

  if (run.phase === 'waiting') {
    if (now.getTime() - Date.parse(run.sentDoneAt) < s.checkAfterMin * 60e3) return { phase: 'waiting' };
    await kv.hset(key, { phase: 'checking' });
    run.phase = 'checking';
  }

  if (run.phase === 'checking') {
    let pending = parse(run.pending, []);
    const results = [];
    let checked = 0;
    for (const t of pending) {
      if (checked >= s.checksPerRun || Date.now() > deadline - 5000) break;
      checked++;
      let v;
      try { v = await T.fetch(t.id, net); } catch (err) { v = { ready: false, error: `${err.message}`.slice(0, 120), network: true }; }
      const ageMin = (now.getTime() - Date.parse(t.sentAt)) / 60e3;
      if (v.ready) {
        const pass = passes(v, s);
        const entry = { at: now.toISOString(), day, tool, inbox: t.inbox, score: v.score ?? null, spamAssassin: v.spamAssassin ?? null, pass, inboxRate: null, detail: v.detail || [], reportUrl: T.reportUrl(t.id), copy: t.copy !== false };
        await recordPlacement(id, entry);
        await patchInbox(id, t.inbox, { spamTool: tool, spamScore: entry.score == null ? '' : String(entry.score), spamAssassin: entry.spamAssassin == null ? '' : String(entry.spamAssassin), spamPass: pass ? '1' : '0', spamTestAt: entry.at });
        results.push(entry);
        t.done = true;
      } else if (v.error && !v.waiting) {
        t.errors = (t.errors || 0) + 1;
        t.lastError = v.error;
        if (t.errors >= 3 || ageMin >= s.giveUpMin) { await failed(id, { tool, inbox: t.inbox, error: v.error, now, day, reportUrl: T.reportUrl(t.id) }); t.done = true; }
      } else if (ageMin >= s.giveUpMin) {
        await failed(id, { tool, inbox: t.inbox, error: `no result ${s.giveUpMin} min after sending (the mail may not have arrived)`, now, day, reportUrl: T.reportUrl(t.id) });
        t.done = true;
      }
    }
    pending = pending.filter((t) => !t.done);
    await kv.hset(key, { pending: JSON.stringify(pending) });
    for (const e of results) await announce(id, e, s);
    if (pending.length) return { phase: 'checking', recorded: results.length, pending: pending.length };
    await settle(id, key, day);
    await logEvent(id, 'placement', 'done', { tool });
    return { phase: 'done', recorded: results.length };
  }
  return { phase: run.phase };
}

async function failed(clientId, { tool, inbox, error, now, day, reportUrl = null }) {
  const entry = { at: now.toISOString(), day, tool, inbox, score: null, spamAssassin: null, pass: false, error, inboxRate: null, detail: [`Test could not complete: ${error}`], reportUrl };
  await recordPlacement(clientId, entry);
  await logEvent(clientId, 'placement', 'test_failed', { tool, inbox, error });
  await alertOwner('placement_test_failed', {
    clientId, scope: `${clientId}:${day}`, vars: { clientId },
    body: `The ${tool} spam test for ${inbox} did not finish: ${error}`,
    did: 'It runs again tomorrow. Day 1 waits for a passing test while PLACEMENT.gate is on; if the tool stays unreachable, set PLACEMENT.gate to false in /mc/config (the seed placement test still gates Day 1).',
  });
  return entry;
}

async function announce(clientId, e, s) {
  await logEvent(clientId, 'placement', 'result', { tool: e.tool, inbox: e.inbox, score: e.score, spamAssassin: e.spamAssassin, pass: e.pass });
  if (e.pass) return;
  const line = e.score != null ? `${e.score}/10 (needs ${s.minScore})` : `${e.spamAssassin} SpamAssassin points (needs ≤ ${s.maxSpamAssassin}, with DKIM and SPF pass)`;
  await alertOwner('spam_score_low', {
    clientId, scope: `${clientId}:${e.inbox}:${e.day}`, vars: { clientId, email: e.inbox, score: e.score != null ? e.score : `SA ${e.spamAssassin}` },
    body: `Spam test (${e.tool}) for ${e.inbox}: ${line}.\n\nWhat the tool flagged:\n${e.detail.map((d) => `• ${d}`).join('\n')}${e.reportUrl ? `\n\nFull report: ${e.reportUrl}` : ''}`,
    did: 'Logged. Before Day 1 the start waits and the test repeats daily; while sending it repeats tomorrow. Fix what is flagged (DNS records, wording in the copy) — nothing else changed.',
  });
}

// ── gate + views ─────────────────────────────────────────────────────────────

/**
 * Day 1 gate part: every inbox's latest spam test passed and is at most
 * PLACEMENT.maxAgeDays old. `ok` true when PLACEMENT.gate is off.
 */
export async function spamTestGate(clientId, now = new Date(), { inboxes = null, history = null } = {}) {
  const s = await settingsFor(clientId);
  const recs = inboxes || (await getInboxRecords(clientId)).filter((r) => r.passwordEnc).map((r) => r.email);
  const latest = latestSpamTests(history || (await placementHistory(clientId)));
  const day = dayKeyIn(ET, now);
  const rows = recs.map((email) => {
    const e = latest[email];
    const fresh = e?.day ? daysBetween(e.day, day) <= s.maxAgeDays : false;
    return { email, tool: e?.tool || null, score: e?.score ?? null, spamAssassin: e?.spamAssassin ?? null, pass: Boolean(e?.pass && fresh), at: e?.at || null, stale: Boolean(e && !fresh), error: e?.error || null };
  });
  if (!s.gate) return { ok: true, skipped: 'PLACEMENT.gate is off', minScore: s.minScore, inboxes: rows };
  return { ok: rows.length > 0 && rows.every((r) => r.pass), minScore: s.minScore, maxSpamAssassin: s.maxSpamAssassin, inboxes: rows };
}
