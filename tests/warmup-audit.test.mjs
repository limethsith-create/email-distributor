// Warm-up from purchase — the audit's fixes (docs/IMPROVE-PASS.md D), each on
// its own: readiness at every warm-up run once an inbox is past day 12 (a
// missed nightly check made up, today's check as soon as the day's warm-up is
// over, the Day 1 gate right after it — the rule itself unchanged), readyBy
// across a made-up check, and the canary tested with the warm-up circle (not
// only helpers) with a plain note when that is thin. The setup check without
// the heartbeat is in tests/autobuy.test.mjs.
//
// Fake KV; SMTP / IMAP are stubs. Nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { saveInbox, patchInbox, getInboxRecords } from '@/lib/db/inboxes';
import { insertLeads } from '@/lib/db/leads';
import { addDays } from '@/lib/time';
import {
  getPool, saveHelper, readinessCheckpoint, warmupDayOver, runWarmupDaily, estimateReadyBy, CATCHUP_DAYS, MARKER_HEADER,
} from '@/lib/systems/warmup';
import { canarySeeds, canaryNote, runCanary, latestCanary, THIN_SEEDS } from '@/lib/systems/canary';
import { readinessGate } from '@/lib/systems/readiness';
import { placementHistory } from '@/lib/systems/placement';
import { simpleFor } from '@/lib/systems/hubview';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.OWNER_INBOX;

// Warm-up day 1 = Thursday 1 October (10:00 ET): day 12 = 12 Oct, day 13 = 13 Oct, day 14 = Wednesday 14 Oct.
const START = '2026-10-01T14:00:00Z';
const et = (day, hhmm) => new Date(`${day}T${hhmm}:00-04:00`); // October: EDT
const INBOX = 'ann@acme-trial.com';
const alerts = async () => ((await kv.lrange(K.alertLog(), 0, -1)) || []).map((a) => a.key);

beforeEach(() => __reset());

/** A trial in warming with one inbox, its stats at `rate` (19 of 20 in the inbox = 0.95) every day of the window. */
async function warmingTrial(id = 'acme', { inbox = INBOX, record = {}, trial = { signedDay: '2026-10-01', day1Date: '2026-10-15', day30Date: '2026-11-13' }, inboxes = 19, spam = 1, tz = null } = {}) {
  await createClient(id, { state: 'warming', name: 'Acme IT', contactName: 'Pat Lee', contactEmail: `pat@${id}.com` });
  await kv.hset(K.trial(id), trial);
  await saveInbox(id, { email: inbox, password: 'pw', provider: 'google', displayName: 'Ann Lee' });
  await patchInbox(id, inbox, { warmupStartedAt: START, ...(tz ? { tz } : {}), ...record });
  for (let d = '2026-09-28'; d <= '2026-10-16'; d = addDays(d, 1)) await kv.hset(K.warmupStats(inbox, d), { inbox: inboxes, spam });
}
const recOf = async (id = 'acme', email = INBOX) => (await getInboxRecords(id)).find((r) => r.email === email);
const statsReads = () => {
  const orig = kv.hgetall;
  let n = 0;
  kv.hgetall = async (k, ...a) => { if (String(k).startsWith('warmup:stats:')) n++; return orig(k, ...a); };
  return { get n() { return n; }, restore() { kv.hgetall = orig; } };
};

// ── readiness at every warm-up run ────────────────────────────────────────────

test('a nightly check the 23:45 run missed is made up by the next warm-up run (past day 12), with that day\'s own window; nothing due costs no read', async () => {
  // Day 12 passed (streak 1); the 23:45 run on day 13 (13 Oct) never happened — no tick in its 15 minutes.
  await warmingTrial('acme', { record: { readyCheckedDay: '2026-10-12', readyStreak: '1', warmupReady: '0', inboxRate7d: '0.950' } });
  // Day 13's own window is the one that counts: a spam-heavy day 14 (today) must not change it.
  await kv.hset(K.warmupStats(INBOX, '2026-10-14'), { inbox: 0, spam: 30 });
  const now = et('2026-10-14', '10:00');
  const r = await readinessCheckpoint(await getPool({ now }), { now });
  assert.deepEqual(r.checked.map(({ day, streak, ready, late }) => ({ day, streak, ready, late })), [{ day: '2026-10-13', streak: 2, ready: false, late: true }], 'made up: streak 2, but day 13 < 14 days');
  assert.equal(r.checked[0].rate, 0.95, "day 13's window (7–13 Oct), not today's");
  let rec = await recOf();
  assert.deepEqual([rec.readyCheckedDay, rec.readyStreak, rec.warmupReady], ['2026-10-13', '2', '0']);
  // Today's check waits for the day's warm-up to be over; a run with nothing due reads no stats at all.
  const reads = statsReads();
  const again = await readinessCheckpoint(await getPool({ now: et('2026-10-14', '10:15') }), { now: et('2026-10-14', '10:15') });
  reads.restore();
  assert.deepEqual(again.checked, []);
  assert.equal(reads.n, 0, 'no check due → no read');
  // Without the fix the streak would restart tonight (13 Oct missing) and the inbox be ready only on day 15.
  rec = await recOf();
  assert.equal(estimateReadyBy([{ start: '2026-10-01', rate: 0.95, streak: Number(rec.readyStreak), checkedDay: rec.readyCheckedDay, ready: false }], { today: '2026-10-14' }), '2026-10-14');
});

test('today\'s check is made as soon as the day\'s warm-up is over (read hours ended, its own send hours closed), not only at 23:45 — and never twice', async () => {
  await warmingTrial('acme', { record: { readyCheckedDay: '2026-10-13', readyStreak: '1', warmupReady: '0' } });
  // 22:10 ET: warm-up mail is still being read (and replied to) until 23:30 — no check yet.
  let r = await readinessCheckpoint(await getPool({ now: et('2026-10-14', '22:10') }), { now: et('2026-10-14', '22:10') });
  assert.deepEqual(r.checked, []);
  // 23:30 ET: nothing more can land today — the check is the 23:45 one, made now: day 14, streak 2 → ready.
  const now = et('2026-10-14', '23:30');
  r = await readinessCheckpoint(await getPool({ now }), { now });
  assert.deepEqual(r.checked.map(({ day, streak, ready, late }) => ({ day, streak, ready, late })), [{ day: '2026-10-14', streak: 2, ready: true, late: false }]);
  const rec = await recOf();
  assert.deepEqual([rec.readyCheckedDay, rec.readyStreak, rec.warmupReady, rec.inboxRate7d], ['2026-10-14', '2', '1', '0.950']);
  // The Day 1 gate was looked at at once (red here: nothing else is ready yet — and no slide before Day 1).
  assert.deepEqual(r.gates, [{ clientId: 'acme', ready: false }]);
  assert.equal((await getClient('acme')).state, 'warming');
  // The 23:45 run does not check the day again (one check per ET day, as before).
  await kv.hset(K.warmupStats(INBOX, '2026-10-14'), { inbox: 0, spam: 40 });
  await runWarmupDaily({ now: et('2026-10-14', '23:45') });
  assert.deepEqual([(await recOf()).readyStreak, (await recOf()).warmupReady], ['2', '1']);
});

test('the rule is unchanged: a day under the line breaks the streak, fewer than 14 days is never ready, inboxes up to day 12 are left to the nightly run', async () => {
  // Under the line on day 14: made at 23:30 like the nightly one — streak 0.
  await warmingTrial('acme', { record: { readyCheckedDay: '2026-10-13', readyStreak: '1', warmupReady: '0' }, inboxes: 17, spam: 3 });
  let now = et('2026-10-14', '23:30');
  let r = await readinessCheckpoint(await getPool({ now }), { now });
  assert.deepEqual(r.checked.map(({ streak, ready }) => ({ streak, ready })), [{ streak: 0, ready: false }]);
  assert.deepEqual(r.gates, []);
  // Day 12 with a missed check: not the checkpoint's (no check before day 13 can make it ready) — no reads.
  __reset();
  await warmingTrial('acme', { record: { readyCheckedDay: '2026-10-10', readyStreak: '1', warmupReady: '0' } });
  now = et('2026-10-12', '23:35');
  const reads = statsReads();
  r = await readinessCheckpoint(await getPool({ now }), { now });
  reads.restore();
  assert.deepEqual(r.checked, []);
  assert.equal(reads.n, 0);
  assert.equal(CATCHUP_DAYS, 7);
});

test('warmupDayOver: the ET read hours have ended and the inbox\'s own warm-up hours stay closed until the ET day ends', () => {
  const hours = { readHours: ['06:00', '23:30'], sendHours: ['07:00', '22:00'] };
  assert.equal(warmupDayOver({ tz: 'America/New_York' }, et('2026-10-14', '23:29'), hours), false);
  assert.equal(warmupDayOver({ tz: 'America/New_York' }, et('2026-10-14', '23:30'), hours), true);
  assert.equal(warmupDayOver({}, et('2026-10-14', '23:50'), hours), true, 'ET by default');
  // Los Angeles: 20:30 there — it still sends today (ET), so the nightly run decides as before.
  assert.equal(warmupDayOver({ tz: 'America/Los_Angeles' }, et('2026-10-14', '23:30'), hours), false);
  // Berlin: 05:30 there — its day's sends ended at 16:00 ET, the next start is after the ET midnight.
  assert.equal(warmupDayOver({ tz: 'Europe/Berlin' }, et('2026-10-14', '23:30'), hours), true);
});

test('a held Day 1 moves to the next sending day right after the last check turns the inbox ready — a day sooner than the 00:30 run', async () => {
  const notes = [];
  const deps = { notify: async (id, key, vars) => { notes.push({ key, vars }); return { sent: true }; } };
  // Day 1 (9 Oct) was held after the slides; everything else is green — only warm-up was missing.
  await warmingTrial('held', { record: { readyCheckedDay: '2026-10-13', readyStreak: '1', warmupReady: '0' }, trial: { signedDay: '2026-09-25', day1Date: '2026-10-09', day30Date: '2026-11-07', day1Slides: '7', day1Held: '1', slideCheckedDay: '2026-10-14' } });
  await kv.hset(K.sequence('held'), { approvedAt: START, approvalMode: 'call' });
  await insertLeads('held', Array.from({ length: 200 }, (_, i) => ({ email: `p${i}@co${i}.com`, company: `Co ${i}` })));
  await kv.hset(K.canary('held', '2026-10-14'), { phase: 'done', result: JSON.stringify({ overall: 0.95, min: 0.95, perInbox: { [INBOX]: { sent: 10, inbox: 9, placement: 0.9 } } }) });
  await kv.lpush(K.placement('held'), JSON.stringify({ at: START, day: '2026-10-14', tool: 'dkimvalidator', inbox: INBOX, score: null, spamAssassin: 0.5, pass: true, detail: [] }));
  await kv.hset(K.profile('held'), { bookingTested: '1' });
  const now = et('2026-10-14', '23:30'); // Wednesday
  const r = await readinessCheckpoint(await getPool({ now }), { now, deps });
  assert.deepEqual(r.gates, [{ clientId: 'held', ready: true }]);
  assert.equal((await getClient('held')).state, 'ready');
  const trial = await kv.hgetall(K.trial('held'));
  // The hourly run at 00:30 would have said Friday 16 October (the next sending day after Thursday).
  assert.equal(trial.day1Date, '2026-10-15', 'Thursday, the next sending day after today');
  assert.equal(trial.day1Held, '');
  assert.deepEqual(notes.map((n) => n.key), ['day1_moved']);
  assert.equal(notes[0].vars.reason, 'everything is now ready');
});

test('the nightly run also looks at the Day 1 gate at once when it makes the last inbox ready', async () => {
  await warmingTrial('acme', { record: { readyCheckedDay: '2026-10-13', readyStreak: '1', warmupReady: '0' } });
  const r = await runWarmupDaily({ now: et('2026-10-14', '23:45') });
  assert.deepEqual(r.gates, [{ clientId: 'acme', ready: false }]);
  assert.equal((await recOf()).warmupReady, '1');
});

test('estimateReadyBy: a passing streak survives a check the nightly run missed once past day 12; earlier gaps and failing inboxes as before', () => {
  const s = { today: '2026-10-14', readyRate: 0.9, need: 2, minDays: 14, maxSlideDays: 7 };
  // Day 14, last check day 12 (passing, streak 1): day 13 is made up → ready tonight, not tomorrow.
  assert.equal(estimateReadyBy([{ start: '2026-10-01', rate: 0.95, streak: 1, checkedDay: '2026-10-12', ready: false }], s), '2026-10-14');
  // Day 16 after two missed nights (streak 1 on day 13): made up at once → today.
  assert.equal(estimateReadyBy([{ start: '2026-09-29', rate: 0.95, streak: 1, checkedDay: '2026-10-11', ready: false }], s), '2026-10-14');
  // Under the line: a fresh streak from tonight, as before.
  assert.equal(estimateReadyBy([{ start: '2026-10-01', rate: 0.85, streak: 0, checkedDay: '2026-10-12', ready: false }], s), '2026-10-15');
  // Day 8 with a gap: no check before day 13 is made up — day 14 is the date anyway.
  assert.equal(estimateReadyBy([{ start: '2026-10-07', rate: 0.95, streak: 3, checkedDay: '2026-10-11', ready: false }], s), '2026-10-20');
  // Checked yesterday / today: unchanged.
  assert.equal(estimateReadyBy([{ start: '2026-10-01', rate: 0.95, streak: 1, checkedDay: '2026-10-13', ready: false }], s), '2026-10-14');
  assert.equal(estimateReadyBy([{ start: '2026-10-01', rate: 0.95, streak: 1, checkedDay: '2026-10-14', ready: false }], s), '2026-10-15');
});

test('the warm-up row: when an inbox passes only on Day 1 or later, `next` gives the day the first emails really go', () => {
  const ctx = (readyBy, extra = {}, inboxRate = 0.86) => ({ client: { id: 'acme', name: 'Acme Co', state: 'warming' }, trial: { day1Date: '2026-10-21' }, now: new Date('2026-10-19T15:00:00Z'),
    warmup: { status: 'warming', label: 'Warming up — day 13 of about 14 · 86% reach the inbox', readyBy, inboxRate, helpersNeeded: 0, problem: null }, ...extra });
  // Ready the evening before Day 1: Day 1 holds.
  assert.deepEqual([simpleFor(ctx('2026-10-20')).label, simpleFor(ctx('2026-10-20')).next], ['Warming up — day 13 of about 14 · 86% reach the inbox', 'Nothing for you: first emails on Wednesday 21 October']);
  // Ready only on Thursday 22 → Day 1 slides to Friday 23; ready on Friday 23 → Monday 26.
  assert.equal(simpleFor(ctx('2026-10-22')).next, 'Nothing for you: warm-up needs a few more days — first emails about Friday 23 October');
  assert.equal(simpleFor(ctx('2026-10-23')).next, 'Nothing for you: warm-up needs a few more days — first emails about Monday 26 October');
  // After the launch call too; no date known (null) → the Day 1 on file, as before.
  const lc = { launchCall: { status: 'held', approvedOnCall: '2026-10-20T15:40:00Z' } };
  assert.equal(simpleFor(ctx('2026-10-22', lc)).label, 'Launch call done — first emails about Friday 23 October');
  assert.equal(simpleFor(ctx(null)).next, 'Nothing for you: first emails on Wednesday 21 October');
  // Never measured yet: the date is a guess — the Day 1 on file stays (the card's problem line says why).
  assert.equal(simpleFor(ctx('2026-10-22', {}, null)).next, 'Nothing for you: first emails on Wednesday 21 October');
});

// ── the canary with the warm-up circle ───────────────────────────────────────

function fakeImap(boxes) {
  return async (account) => {
    const box = (boxes[account.email] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    let cur = null;
    return {
      async connect() {},
      async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }]; },
      async getMailboxLock(p) { cur = p; box[p] ||= []; return { release() {} }; },
      async search(q) { const want = String(q.header['x-aviance-warm'] || '').toLowerCase(); return box[cur].filter((m) => m.headers.toLowerCase().includes(want)).map((m) => m.uid); },
      async *fetch(uids) { for (const m of [...box[cur]]) if (uids.includes(m.uid)) yield m; },
      async messageFlagsAdd() {},
      async messageMove(uid, dest) { const i = box[cur].findIndex((x) => x.uid === uid); const [m] = box[cur].splice(i, 1); box[dest].push({ ...m, uid: m.uid + 1000 }); },
      async logout() {},
    };
  };
}

test('the canary tests with the warm-up circle when there are no helpers — never the client\'s own inboxes — and says so in plain words', async () => {
  // Acme is on Day −3; the circle has no helpers: the owner's two outreach inboxes and another trial's two.
  await createClient('acme', { state: 'warming', name: 'Acme IT' });
  await kv.hset(K.trial('acme'), { signedDay: '2026-09-22', day1Date: '2026-10-08' });
  for (const e of ['a@acme-trial.com', 'b@acme-trial.com']) { await saveInbox('acme', { email: e, password: 'x' }); await patchInbox('acme', e, { warmupStartedAt: START }); }
  await createClient('aviance', { state: 'sending' });
  for (const e of ['me@aviance.online', 'team@aviance.online']) await saveInbox('aviance', { email: e, password: 'x' });
  await createClient('bolt', { state: 'warming', name: 'Bolt Co' });
  for (const e of ['x@bolt-trial.com', 'y@bolt-trial.com']) { await saveInbox('bolt', { email: e, password: 'x' }); await patchInbox('bolt', e, { warmupStartedAt: START }); }
  await patchInbox('bolt', 'y@bolt-trial.com', { warmupHealth: 'auth_failed' }); // its login failed: not a seed

  const t0 = new Date('2026-10-05T11:30:00Z'); // 07:30 ET, Day −3
  const seeds = await canarySeeds('acme', { now: t0, want: 10 });
  assert.deepEqual(seeds.map((x) => x.email), ['me@aviance.online', 'team@aviance.online', 'x@bolt-trial.com']);
  assert.ok(seeds.every((x) => !x.isHelper));

  const boxes = {};
  const send = async (account, mail) => {
    const box = (boxes[mail.to] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    box.INBOX.push({ uid: box.INBOX.length + 1, envelope: { messageId: `<${account.email}-${mail.to}>`, from: [{ address: account.email }], subject: mail.subject }, headers: `X-Aviance-Warm: ${mail.headers[MARKER_HEADER]}\r\n` });
    return { success: true };
  };
  const deps = { send, imap: fakeImap(boxes) };
  const client = await getClient('acme');
  let r = await runCanary({ client, now: t0, deps });
  r = await runCanary({ client, now: new Date(t0.getTime() + 5 * 60e3), deps });
  r = await runCanary({ client, now: new Date(t0.getTime() + 20 * 60e3), deps });
  r = await runCanary({ client, now: new Date(t0.getTime() + 25 * 60e3), deps });
  assert.equal(r.phase, 'done');
  assert.equal(r.placement, 1);
  assert.ok(!(await alerts()).includes('canary_incomplete'), 'before: "no working helper accounts" — Day 1 held until the owner added helpers');
  assert.equal(boxes['a@acme-trial.com'], undefined, 'never its own inboxes');
  const latest = await latestCanary('acme', t0);
  assert.equal(latest.seeds, 3);
  assert.equal(latest.note, 'Tested with 3 mailboxes (other inboxes in the warm-up circle — no warm-up helpers yet) — the usual is 10. With fewer than 4, one email in spam moves the rate a lot — add warm-up helpers for a steadier number. All of them use the same mail filter (Gmail / Google Workspace), so other providers were not tested.');
  // The note is the first line of the seed test in the placement history (the hub's deliverability card) …
  const seed = (await placementHistory('acme')).find((e) => e.tool === 'seed');
  assert.equal(seed.detail[0], latest.note);
  // … and rides on the Day 1 gate's canary part (the gate itself unchanged: every inbox at ≥ 85%).
  const gate = await readinessGate('acme', t0);
  assert.deepEqual([gate.checks.canary.ok, gate.checks.canary.seeds, gate.checks.canary.note], [true, 3, latest.note]);
});

test('canary seeds: helpers first, then the circle, up to the usual number; the note only when it is thin', async () => {
  await createClient('acme', { state: 'warming', name: 'Acme IT' });
  await saveInbox('acme', { email: 'a@acme-trial.com', password: 'x' });
  await createClient('aviance', { state: 'sending' });
  await saveInbox('aviance', { email: 'me@aviance.online', password: 'x' });
  await saveHelper({ email: 'h1@yahoo.com', password: 'x', provider: 'yahoo' });
  await saveHelper({ email: 'h2@gmail.com', password: 'x', provider: 'google' });
  const now = new Date('2026-10-05T11:30:00Z');
  const seeds = await canarySeeds('acme', { now, want: 2 });
  assert.deepEqual(seeds.map((x) => [x.email, x.isHelper]).sort(), [['h1@yahoo.com', true], ['h2@gmail.com', true]], 'helpers fill the list first');
  assert.equal((await canarySeeds('acme', { now, want: 10 })).at(-1).email, 'me@aviance.online', 'then the circle');

  const H = (n, provider = 'google') => Array.from({ length: n }, (_, i) => ({ email: `h${i}@x${i}.com`, provider: i % 2 ? 'yahoo' : provider, isHelper: true }));
  assert.equal(canaryNote(H(10), 10), null, 'the usual ten helpers on more than one filter');
  assert.equal(canaryNote(H(8), 10), 'Tested with 8 mailboxes — the usual is 10.');
  assert.match(canaryNote(H(2), 10), new RegExp(`^Tested with 2 mailboxes — the usual is 10\\. With fewer than ${THIN_SEEDS}, one email in spam`));
  assert.equal(canaryNote([...H(5), { email: 'x@bolt.com', provider: 'google', isHelper: false }], 10), 'Tested with 6 mailboxes (5 warm-up helpers and 1 other inbox in the warm-up circle) — the usual is 10.');
  assert.match(canaryNote(Array.from({ length: 10 }, (_, i) => ({ email: `g${i}@gmail.com`, provider: 'google', isHelper: true })), 10), /^Tested with 10 mailboxes\. All of them use the same mail filter \(Gmail \/ Google Workspace\)/);
  assert.equal(canaryNote([], 10), null);
});
