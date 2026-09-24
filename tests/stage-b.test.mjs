// Stage B (build systems) — fake KV, stubbed SMTP / IMAP / fetch. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { saveInbox, patchInbox, getInboxRecords } from '@/lib/db/inboxes';
import { insertLeads, getLeads, addToBlocklist, countByStatus } from '@/lib/db/leads';
import { HARD_COLD_CAP, setOverride } from '@/lib/config';
import { partsIn, addDays } from '@/lib/time';
import {
  warmupQuota, planPairs, pairKey, makeMarker, verifyMarker, isWarmupMessage, saveHelper, runWarmupSend, runWarmupRead,
  inboxRate7d, readinessUpdate, statsFor, MARKER_HEADER,
} from '@/lib/systems/warmup';
import { SUBJECTS, BODY_COUNT, bodyTemplate, sentenceCount, composeWarmup } from '@/lib/templates/warmup';
import { computeCap, sendingDayNumber, runRamp } from '@/lib/systems/ramp';
import { computePlacement } from '@/lib/systems/canary';
import { buildSequence, getStoredSequence, renderVariant, checkVariant, firstLineFor, FIRST_LINE_RULES, leadVars, nicheOf, saveEditedVariant } from '@/lib/systems/copy';
import { checkEmail, capsWords } from '@/lib/systems/copycheck';
import { sanityCheck } from '@/lib/systems/sanity';
import { handleWebhook, listReady, handleWorkflowRun } from '@/lib/systems/leadfinder';
import { parseBlocklistInput, addBlocklistInput, checkLead, resolveNames } from '@/lib/systems/blocklist';
import { approvalUrl, loadApprovalPage, approveSection, requestChange, runApprovalJob } from '@/lib/systems/approval';
import { runReadiness, nextSendingDay } from '@/lib/systems/readiness';
import { verifyGithubRequest } from '@/lib/ext/github';
import * as LF from '../scripts/leadfinder/lib.mjs';
import { filterCandidates, buildLead } from '../scripts/leadfinder/index.mjs';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.OWNER_INBOX;

const NOW = new Date('2026-10-05T15:00:00Z'); // Monday 11:00 ET
const alerts = async () => (await kv.lrange('system:alerts:log', 0, -1)).map((a) => a.key);
const seqRng = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

const PROFILE = {
  senderName: 'Sam Carter',
  postalAddress: '100 Main St, Dallas, TX 75201',
  oneLiner: 'We look after computers, email and backups for small offices in Dallas.',
  defaultNiche: 'managed IT',
  defaultIcp: 'dental practices',
  industry: 'managed IT services',
  titles: 'owner, president, office manager',
  cities: 'Dallas, TX',
  states: 'TX',
};

async function trialClient(id, { state = 'warming', profile = PROFILE, trial = {} } = {}) {
  await createClient(id, { state, name: 'Acme IT', contactName: 'Pat', contactEmail: `pat@${id}.com` });
  await kv.hset(K.profile(id), profile);
  if (Object.keys(trial).length) await kv.hset(K.trial(id), trial);
}

// ── Warm-up ──────────────────────────────────────────────────────────────────

test('warm-up quota follows the ramp table and never exceeds 15', () => {
  const table = { '1-3': 3, '4-7': 8, '8-14': 15, '15+': 8 };
  assert.equal(warmupQuota(0, table), 0);
  assert.equal(warmupQuota(1, table), 3);
  assert.equal(warmupQuota(5, table), 8);
  assert.equal(warmupQuota(14, table), 15);
  assert.equal(warmupQuota(30, table), 8);
  assert.equal(warmupQuota(10, { '1+': 40 }), 15);
});

test('warm-up text: 120 subjects × 200 bodies, 2–6 sentences, no links', () => {
  assert.equal(new Set(SUBJECTS).size, 120);
  const bodies = new Set();
  for (let i = 0; i < BODY_COUNT; i++) {
    const b = bodyTemplate(i);
    bodies.add(b);
    const n = sentenceCount(b);
    assert.ok(n >= 2 && n <= 6, `body ${i} has ${n} sentences`);
  }
  assert.equal(bodies.size, 200);
  const m = composeWarmup(seqRng([0.3, 0.7, 0.1]), { toName: 'Ann Lee', fromName: 'Bo Chan' });
  assert.match(m.text, /^Hi Ann,/);
  assert.doesNotMatch(m.text + m.html, /https?:|www\.|<img|\{/);
});

test('pairing: client inboxes first, different provider preferred, no repeat, quota respected', () => {
  const pool = [
    { email: 'ann@acme-trial.com', domain: 'acme-trial.com', provider: 'google', clientId: 'acme', isHelper: false, quota: 8 },
    { email: 'h1@gmail.com', domain: 'gmail.com', provider: 'google', clientId: '_helper', isHelper: true, quota: 8 },
    { email: 'h2@outlook.com', domain: 'outlook.com', provider: 'outlook', clientId: '_helper', isHelper: true, quota: 8 },
    { email: 'h3@yahoo.com', domain: 'yahoo.com', provider: 'yahoo', clientId: '_helper', isHelper: true, quota: 8 },
  ];
  const rng = () => 0.5;
  const plan = planPairs(pool, { n: 3, rng });
  assert.equal(plan[0].from.email, 'ann@acme-trial.com');
  assert.notEqual(plan[0].to.provider, 'google');
  const keys = plan.map((p) => pairKey(p.from.email, p.to.email));
  assert.equal(new Set(keys).size, keys.length);
  // A pair already used today is never chosen again, in either direction.
  const used = new Set([pairKey('ann@acme-trial.com', 'h2@outlook.com'), pairKey('ann@acme-trial.com', 'h3@yahoo.com')]);
  const p2 = planPairs(pool, { n: 1, rng, pairs: used });
  assert.equal(p2[0].from.email, 'ann@acme-trial.com');
  assert.equal(p2[0].to.email, 'h1@gmail.com');
  // Quota used up → not a sender.
  const p3 = planPairs(pool, { n: 4, rng, sent: { 'ann@acme-trial.com': 8 } });
  assert.ok(p3.every((p) => p.from.email !== 'ann@acme-trial.com'));
  // Outside the sender's hours → not a sender.
  assert.equal(planPairs(pool, { n: 3, rng, inWindow: () => false }).length, 0);
});

test('marker HMAC: verifies, rejects tampering, recognised by isWarmupMessage', () => {
  const m = makeMarker();
  assert.equal(verifyMarker(m).kind, 'w');
  assert.equal(verifyMarker(`${m.slice(0, -1)}${m.endsWith('a') ? 'b' : 'a'}`), null);
  assert.equal(verifyMarker('w.abc~0123456789abcdef0123456789abcdef'), null);
  const c = makeMarker('c', 'acme.2026-10-05');
  assert.deepEqual({ kind: verifyMarker(c).kind, tag: verifyMarker(c).tag }, { kind: 'c', tag: 'acme.2026-10-05' });
  assert.ok(isWarmupMessage({ 'x-aviance-warm': m }));
  assert.ok(isWarmupMessage(`Subject: hi\r\nX-Aviance-Warm: ${m}\r\n`));
  assert.ok(isWarmupMessage(new Map([['x-aviance-warm', m]])));
  assert.ok(!isWarmupMessage({ 'x-aviance-warm': 'forged~00000000000000000000000000000000' }));
  assert.ok(!isWarmupMessage({ subject: 'hello' }));
});

async function warmPool() {
  __reset();
  await trialClient('acme', { trial: { signedDay: '2026-09-25', day1Date: '2026-10-09' } });
  await saveInbox('acme', { email: 'ann@acme-trial.com', password: 'pw1', provider: 'google', displayName: 'Ann Lee' });
  await patchInbox('acme', 'ann@acme-trial.com', { warmupStartedAt: new Date(NOW.getTime() - 9 * 864e5).toISOString() });
  await saveHelper({ email: 'h1@gmail.com', password: 'pw2', provider: 'google', displayName: 'Hal One' });
  await saveHelper({ email: 'h2@outlook.com', password: 'pw3', provider: 'outlook', displayName: 'Hana Two' });
  // aviance inboxes never join the circle
  await createClient('aviance', { state: 'sending' });
  await saveInbox('aviance', { email: 'me@aviance.online', password: 'x' });
  await patchInbox('aviance', 'me@aviance.online', { warmupStartedAt: NOW.toISOString() });
}

test('warm-up send: marked mail, counted, pairs recorded, aviance excluded', async () => {
  await warmPool();
  const sent = [];
  const deps = { rng: () => 0.5, send: async (account, mail) => { sent.push({ from: account.email, ...mail }); return { success: true, messageId: `<${sent.length}@x>` }; } };
  const r = await runWarmupSend({ now: NOW, deadline: Date.now() + 20_000, deps });
  assert.equal(r.sent, 2);
  assert.deepEqual(sent.map((s) => `${s.from}>${s.to}`), ['ann@acme-trial.com>h2@outlook.com', 'h1@gmail.com>h2@outlook.com']);
  for (const s of sent) {
    assert.ok(isWarmupMessage(s.headers));
    assert.ok(s.html.includes(`data-w="${s.headers[MARKER_HEADER]}"`));
    assert.equal(s.transactional, true);
    assert.doesNotMatch(s.text, /https?:/);
  }
  assert.ok(!sent.some((s) => s.from.includes('aviance') || s.to.includes('aviance')));
  assert.equal((await kv.hgetall(K.countersTotal('acme'))).warmupSent, 1);
  assert.equal((await statsFor('ann@acme-trial.com', '2026-10-05')).sent, 1);
  assert.equal(Object.keys(await kv.hgetall(K.warmupPair('2026-10-05'))).length, 2);
  // Same minute again: every remaining pair is used, nothing is repeated.
  const again = await runWarmupSend({ now: NOW, deps });
  assert.ok(!sent.slice(2).some((s) => `${s.from}>${s.to}` === 'ann@acme-trial.com>h2@outlook.com'));
  assert.ok(again.sent <= 1);
});

function fakeImap(boxesByEmail, log) {
  return async (account) => {
    const boxes = (boxesByEmail[account.email] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    let cur = null;
    return {
      async connect() {},
      async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }]; },
      async getMailboxLock(p) { cur = p; boxes[p] ||= []; return { release() {} }; },
      async search(q) {
        const want = String(q.header['x-aviance-warm'] || '').toLowerCase();
        return boxes[cur].filter((m) => /x-aviance-warm/i.test(m.headers) && m.headers.toLowerCase().includes(want)).map((m) => m.uid);
      },
      async *fetch(uids) { for (const m of [...boxes[cur]]) if (uids.includes(m.uid)) yield m; },
      async messageFlagsAdd(uid, flags) { const m = boxes[cur].find((x) => x.uid === uid); m.flags = [...(m.flags || []), ...flags]; log.push(['flags', account.email, cur, flags.join(' ')]); },
      async messageMove(uid, dest) { const i = boxes[cur].findIndex((x) => x.uid === uid); const [m] = boxes[cur].splice(i, 1); boxes[dest].push({ ...m, uid: m.uid + 1000 }); log.push(['move', account.email, cur, dest]); },
      async logout() {},
    };
  };
}

const warmMsg = (uid, from, marker = makeMarker()) => ({
  uid,
  envelope: { messageId: `<m${uid}-${from}@x>`, from: [{ address: from }], subject: 'About the budget review' },
  headers: `X-Aviance-Warm: ${marker}\r\nMessage-ID: <m${uid}-${from}@x>\r\n`,
});

test('warm-up read: rescue from spam, seen/flag/reply/archive, landings counted for the sender', async () => {
  await warmPool();
  const log = [];
  const boxes = {
    'ann@acme-trial.com': { INBOX: [warmMsg(2, 'h2@outlook.com')], '[Gmail]/Spam': [warmMsg(1, 'h1@gmail.com')], '[Gmail]/All Mail': [] },
    'h1@gmail.com': { INBOX: [warmMsg(3, 'ann@acme-trial.com')], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] },
  };
  const replies = [];
  const deps = { rng: () => 0.1, imap: fakeImap(boxes, log), send: async (account, mail) => { replies.push({ from: account.email, ...mail }); return { success: true }; } };
  await setOverride(null, 'BUILD.warmupReadPerRun', 2);
  const r = await runWarmupRead({ now: NOW, deadline: Date.now() + 20_000, deps });
  await setOverride(null, 'BUILD.warmupReadPerRun', undefined);
  assert.equal(r.read, 2);
  const day = '2026-10-05';
  assert.equal((await statsFor('h1@gmail.com', day)).spam, 1);
  assert.equal((await statsFor('h1@gmail.com', day)).rescued, 1);
  assert.equal((await statsFor('h2@outlook.com', day)).inbox, 1);
  assert.equal((await statsFor('ann@acme-trial.com', day)).inbox, 1);
  // Client counters count the client inbox's landings only.
  const tot = await kv.hgetall(K.countersTotal('acme'));
  assert.equal(tot.warmupInbox, 1);
  assert.equal(tot.warmupSpam, undefined);
  // Spam → INBOX (rescue), then archived out of the client-facing inbox.
  assert.ok(log.some((l) => l[0] === 'move' && l[2] === '[Gmail]/Spam' && l[3] === 'INBOX'));
  assert.equal(boxes['ann@acme-trial.com'].INBOX.length, 0);
  assert.equal(boxes['ann@acme-trial.com']['[Gmail]/All Mail'].length, 2);
  assert.ok(log.some((l) => l[0] === 'flags' && l[3].includes('\\Flagged')));
  // Replies are in-thread and marked.
  assert.ok(replies.length >= 2);
  assert.ok(replies.every((x) => x.inReplyTo && /^Re: /.test(x.subject) && isWarmupMessage(x.headers)));
  // A second read of the same mailbox within 30 minutes is not due.
  const again = await runWarmupRead({ now: new Date(NOW.getTime() + 10 * 60e3), deps });
  assert.ok(again.results.every((x) => !['ann@acme-trial.com', 'h1@gmail.com'].includes(x.email)));
});

test('inboxRate7d and the readiness rule (≥ 0.90 twice in a row and ≥ 14 days)', async () => {
  __reset();
  const e = 'ann@acme-trial.com';
  for (let i = 0; i < 7; i++) await kv.hset(K.warmupStats(e, addDays('2026-10-05', -i)), { inbox: 9, spam: i === 0 ? 1 : 0 });
  await kv.hset(K.warmupStats(e, addDays('2026-10-05', -8)), { inbox: 0, spam: 50 }); // outside the window
  const { rate, inbox, spam } = await inboxRate7d(e, NOW);
  assert.equal(inbox, 63);
  assert.equal(spam, 1);
  assert.ok(Math.abs(rate - 63 / 64) < 1e-9);
  assert.equal((await inboxRate7d('nobody@x.com', NOW)).rate, null);

  let rec = {};
  let u = readinessUpdate(rec, { rate: 0.95, day: '2026-10-04', days: 13 });
  assert.deepEqual([u.streak, u.ready], [1, false]);
  rec = { ...rec, ...u.fields };
  u = readinessUpdate(rec, { rate: 0.95, day: '2026-10-05', days: 14 });
  assert.deepEqual([u.streak, u.ready], [2, true]);
  rec = { ...rec, ...u.fields };
  assert.equal(readinessUpdate(rec, { rate: 0.1, day: '2026-10-05', days: 14 }).fields, null); // same day: no double check
  u = readinessUpdate(rec, { rate: 0.85, day: '2026-10-06', days: 15 });
  assert.deepEqual([u.streak, u.ready], [0, false]);
  // Two passes on days 14 and 15 but a gap between them → streak restarts.
  u = readinessUpdate({ readyStreak: '1', readyCheckedDay: '2026-10-01' }, { rate: 0.99, day: '2026-10-05', days: 20 });
  assert.equal(u.streak, 1);
  assert.equal(readinessUpdate({}, { rate: null, day: '2026-10-05', days: 20 }).streak, 0);
});

// ── Canary + Ramp ────────────────────────────────────────────────────────────

test('canary placement: inbox landings / mails sent to readable helpers, per inbox and provider', () => {
  const sent = [
    { inbox: 'a@t.com', helper: 'h1@gmail.com', provider: 'google' },
    { inbox: 'a@t.com', helper: 'h2@outlook.com', provider: 'outlook' },
    { inbox: 'a@t.com', helper: 'h3@yahoo.com', provider: 'yahoo' },
    { inbox: 'b@t.com', helper: 'h1@gmail.com', provider: 'google' },
    { inbox: 'b@t.com', helper: 'h2@outlook.com', provider: 'outlook' },
  ];
  const res = computePlacement({ sent, checked: ['h1@gmail.com', 'h2@outlook.com'], landed: { 'a@t.com>google': { inbox: 1 }, 'a@t.com>outlook': { inbox: 1 }, 'b@t.com>google': { inbox: 1 }, 'b@t.com>outlook': { spam: 1 } } });
  assert.equal(res.perInbox['a@t.com'].placement, 1);
  assert.equal(res.perInbox['b@t.com'].placement, 0.5);
  assert.equal(res.min, 0.5);
  assert.equal(res.overall, 3 / 4);
  assert.equal(res.perProvider.outlook.placement, 0.5);
  assert.equal(res.perProvider.yahoo, undefined); // unreadable helper: not counted either way
});

test('canary run: Day −3 onwards, sends → waits 15 min → reads helpers → placement, alerts, emergency flag', async () => {
  __reset();
  const { canaryDue, runCanary, latestCanary } = await import('@/lib/systems/canary');
  await trialClient('acme', { state: 'sending', trial: { day1Date: '2026-09-28' } });
  await saveInbox('acme', { email: 'a@acme-trial.com', password: 'x' });
  await saveInbox('acme', { email: 'b@acme-trial.com', password: 'x' });
  await saveHelper({ email: 'h1@gmail.com', password: 'x', provider: 'google' });
  await saveHelper({ email: 'h2@outlook.com', password: 'x', provider: 'outlook' });
  const t0 = new Date('2026-10-05T11:30:00Z'); // 07:30 ET
  assert.equal(await canaryDue(await getClient('acme'), new Date('2026-10-05T11:00:00Z')), null); // before 07:30
  assert.ok(await canaryDue(await getClient('acme'), t0));
  // Day −5 of a warming client: too early (canary starts on the Day −3 gate).
  await trialClient('early', { trial: { signedDay: '2026-09-26', day1Date: '2026-10-10' } });
  assert.match((await runCanary({ client: await getClient('early'), now: t0 })).skipped, /before the canary gate/);
  assert.equal(await canaryDue(await getClient('early'), t0), null); // settled for today, no further reads

  const boxes = {};
  const log = [];
  // b@ lands in spam at Outlook; everything else in the inbox.
  const send = async (account, mail) => {
    const box = (boxes[mail.to] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    const folder = account.email.startsWith('b@') && mail.to.includes('outlook') ? '[Gmail]/Spam' : 'INBOX';
    box[folder].push({ uid: box[folder].length + 1 + (folder === 'INBOX' ? 0 : 500), envelope: { messageId: `<${account.email}-${mail.to}>`, from: [{ address: account.email }], subject: mail.subject }, headers: `X-Aviance-Warm: ${mail.headers[MARKER_HEADER]}\r\n` });
    return { success: true };
  };
  const deps = { send, imap: fakeImap(boxes, log) };
  const client = await getClient('acme');
  let r = await runCanary({ client, now: t0, deps });
  assert.equal(r.phase, 'waiting'); // 4 sends fit in one run (BUILD.canarySendsPerRun = 4)
  assert.equal((await statsFor('a@acme-trial.com', '2026-10-05')).sent, 2); // counts toward the warm-up ceiling
  r = await runCanary({ client, now: new Date(t0.getTime() + 5 * 60e3), deps });
  assert.equal(r.phase, 'waiting');
  r = await runCanary({ client, now: new Date(t0.getTime() + 16 * 60e3), deps });
  assert.equal(r.phase, 'done');
  assert.equal(r.placement, 0.75);
  assert.equal(r.min, 0.5);
  const c = await getClient('acme');
  assert.equal(c.canaryPlacement, '0.750');
  assert.equal(c.emergencyRequested, 'canary');
  const recs = Object.fromEntries((await getInboxRecords('acme')).map((x) => [x.email, x]));
  assert.equal(recs['a@acme-trial.com'].canaryPlacement, '1.000');
  assert.equal(recs['b@acme-trial.com'].canaryPlacement, '0.500');
  assert.ok((await alerts()).includes('placement_low'));
  assert.ok(log.some((l) => l[0] === 'move' && l[2] === '[Gmail]/Spam')); // rescued
  assert.equal((await latestCanary('acme', t0)).perProvider.outlook.placement, 0.5);
  assert.equal(await canaryDue(c, new Date(t0.getTime() + 20 * 60e3)), null); // done for today
});

test('ramp caps by sending day, modifiers, emergency and the hard cap', async () => {
  const caps = { '1-2': 8, '3-4': 12, '5-6': 16, '7+': 25 };
  assert.equal(computeCap({ sendingDay: 0, caps }).cap, 0);
  assert.equal(computeCap({ sendingDay: 1, caps }).cap, 8);
  assert.equal(computeCap({ sendingDay: 4, caps }).cap, 12);
  assert.equal(computeCap({ sendingDay: 6, caps }).cap, 16);
  assert.equal(computeCap({ sendingDay: 12, caps }).cap, 25);
  assert.equal(computeCap({ sendingDay: 12, caps: { '7+': 90 }, coldCap: 90 }).cap, HARD_COLD_CAP);
  assert.equal(computeCap({ sendingDay: 12, caps, inboxRate: 0.79, lowRate: 0.8 }).cap, 12);
  assert.equal(computeCap({ sendingDay: 12, caps, bounceRate: 0.03, bounceMax: 0.02 }).cap, 12);
  assert.equal(computeCap({ sendingDay: 12, caps, inboxRate: 0.5, bounceRate: 0.05 }).cap, 6);
  assert.equal(computeCap({ sendingDay: 12, caps, emergencyHalved: true }).cap, 12);
  assert.equal(computeCap({ sendingDay: 12, caps, emergencyActive: true }).cap, 0);
  assert.equal(computeCap({ sendingDay: 12, caps, capOverride: 10 }).cap, 10);
  assert.equal(computeCap({ sendingDay: 12, caps, capOverride: 40 }).cap, 25);
  // Sending days skip weekends and federal holidays (2026-10-12 is Columbus Day).
  assert.equal(sendingDayNumber('2026-10-05', '2026-10-04'), 0);
  assert.equal(sendingDayNumber('2026-10-05', '2026-10-09'), 5);
  assert.equal(sendingDayNumber('2026-10-05', '2026-10-12'), 5);
  assert.equal(sendingDayNumber('2026-10-05', '2026-10-13'), 6);

  __reset();
  await trialClient('acme', { state: 'sending', trial: { day1Date: '2026-09-21' } });
  await kv.hset(K.client('acme'), { emergencyHalved: '1' });
  await saveInbox('acme', { email: 'a@t.com', password: 'x' });
  await saveInbox('acme', { email: 'b@t.com', password: 'x' });
  await patchInbox('acme', 'a@t.com', { inboxRate7d: '0.750' });
  await kv.hset(K.countersDay('acme', '2026-10-04'), { sent: 100, bounces: 3 });
  const r = await runRamp({ client: await getClient('acme'), now: NOW });
  const caps2 = Object.fromEntries(r.inboxes.map((i) => [i.email, i.cap]));
  assert.deepEqual(caps2, { 'a@t.com': 3, 'b@t.com': 6 }); // 25 → rate ½ → bounces ½ → emergency ½
  const recs = Object.fromEntries((await getInboxRecords('acme')).map((x) => [x.email, x]));
  assert.equal(recs['a@t.com'].dailyCap, '3');
  assert.equal(recs['a@t.com'].rampStage, '7+');
  assert.ok((await alerts()).includes('inbox_rate_low'));
  await kv.hset(K.client('acme'), { emergencyActive: '1' });
  const r2 = await runRamp({ client: await getClient('acme'), now: NOW });
  assert.ok(r2.inboxes.every((i) => i.cap === 0));
});

// ── Copy Engine + Copy Checker ──────────────────────────────────────────────

const LEAD = { email: 'ann@smiledental.com', first_name: 'Ann', company: 'Smile Dental', city: 'Dallas', state: 'TX', types: ['dentist', 'health'], sequenceVariant: 'A' };

test('first-line rule table: 20 patterns, city and no-city forms, never a blank', () => {
  assert.equal(FIRST_LINE_RULES.length, 20);
  assert.equal(firstLineFor(LEAD, 'A'), 'Saw Smile Dental is one of the dental practices serving Dallas.');
  assert.equal(firstLineFor({ ...LEAD, city: '' }, 'B'), 'I was looking at dental practices and Smile Dental came up.');
  assert.equal(firstLineFor({ company: 'Bolt Co', types: ['something_else'] }, 'A'), 'Saw Bolt Co while looking at local businesses in your area.');
  assert.match(firstLineFor({ company: 'Top Roof', city: 'Austin', types: ['roofing_contractor'] }, 'C'), /roofing teams around Austin/);
  assert.throws(() => firstLineFor({ city: 'Austin' }));
  assert.equal(nicheOf({ industry: 'Managed IT services' }), 'msp');
  assert.equal(nicheOf({ industry: 'commercial roofing' }), 'trial-default');
});

test('copy engine builds A/B in the default.json shape, fills client slots, passes the checker', async () => {
  __reset();
  await trialClient('acme');
  const r = await buildSequence('acme');
  assert.ok(r.ok);
  const s = await getStoredSequence('acme');
  assert.equal(s.niche, 'msp');
  assert.equal(s.version, '1');
  assert.equal(s.active, 'both');
  for (const v of [s.variantA, s.variantB]) {
    assert.ok(v.name && v.footer && Array.isArray(v.touches));
    assert.deepEqual(v.touches.map((t) => [t.touch, t.day, t.thread]), [['d0', 0, 'new'], ['d3', 3, 'd0'], ['d7', 7, 'new'], ['d10', 10, 'd7']]);
    // only lead-level slots are left for the Sender
    const left = new Set(JSON.stringify(v).match(/\{[A-Za-z]+\}/g));
    assert.ok([...left].every((x) => ['{FirstName}', '{Company}', '{City}', '{FirstLine}'].includes(x)), [...left].join());
    assert.match(v.footer, /Sam Carter\nAcme IT\n100 Main St, Dallas, TX 75201\n\nNot the right fit\? Just reply STOP/);
  }
  // A and B differ only in the Day 0 subject and the first-line set.
  assert.notEqual(s.variantA.touches[0].subject, s.variantB.touches[0].subject);
  assert.equal(s.variantA.touches[0].body, s.variantB.touches[0].body);
  assert.notEqual(s.variantA.firstLineSet, s.variantB.firstLineSet);
  const a = renderVariant(s.variantA, LEAD);
  assert.equal(a[0].subject, 'IT support for Smile Dental');
  assert.match(a[0].body, /^Hi Ann,\n\nSaw Smile Dental is one of the dental practices serving Dallas\./);
  const b = renderVariant(s.variantB, LEAD);
  assert.match(b[0].body, /I was looking at dental practices in Dallas and Smile Dental came up\./);
  for (const v of [s.variantA, s.variantB]) for (const c of checkVariant(v, PROFILE, LEAD)) assert.ok(c.ok, `${c.touch}: ${JSON.stringify(c.failures)}`);
  assert.equal(leadVars(LEAD, s.variantB).FirstLine, firstLineFor(LEAD, 'B'));
  // An approved sequence is never overwritten by a rebuild.
  await kv.hset(K.sequence('acme'), { approvedAt: NOW.toISOString() });
  assert.equal((await buildSequence('acme')).skipped, 'approved');
  // Owner edits: shape checked, unknown slots refused, version bumped.
  await assert.rejects(saveEditedVariant('acme', 'A', { ...s.variantA, touches: [{ touch: 'd0', thread: 'new', subject: 'x', body: 'Hi {Nickname}' }] }), /Nickname/);
  assert.equal((await saveEditedVariant('acme', 'A', s.variantA)).version, 2);
});

test('copy engine: missing profile values block the build with copy_blocked', async () => {
  __reset();
  await trialClient('acme', { profile: { ...PROFILE, postalAddress: '' } });
  const r = await buildSequence('acme');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['postalAddress']);
  assert.ok((await alerts()).includes('copy_blocked'));
});

test('learning library seeds the best variant as A', async () => {
  __reset();
  await trialClient('acme');
  await kv.hset(K.learning('msp'), { 'msp-a1': { sends: 200, replies: 4, positive: 0 }, 'msp-b1': { sends: 200, replies: 6, positive: 3 } });
  await buildSequence('acme');
  const s = await getStoredSequence('acme');
  assert.equal(s.variantA.variantId, 'msp-b1');
  assert.equal(s.variantB.variantId, 'msp-a1');
});

test('copy checker: every rule fails when it should', async () => {
  __reset();
  await trialClient('acme');
  await buildSequence('acme');
  const s = await getStoredSequence('acme');
  const good = renderVariant(s.variantA, LEAD)[0];
  assert.deepEqual(checkEmail(good, PROFILE), { ok: true, failures: [] });
  const rules = (r, p = PROFILE, o) => checkEmail(r, p, o).failures.map((f) => f.rule);
  const withBody = (body) => ({ ...good, body, text: `${body}\n\n${s.variantA.footer}` });
  assert.deepEqual(rules(withBody(`${'word '.repeat(81)}ok?`)), ['word_count']);
  assert.ok(rules(good, PROFILE, { maxWords: 20 }).includes('word_count'));
  assert.deepEqual(rules(withBody('See https://acme.com first. Worth a call?')), ['no_urls']);
  assert.deepEqual(rules(withBody('See acme.com first. Worth a call?')), ['no_urls']);
  assert.deepEqual(rules({ ...withBody('See acme.com first. Worth a call?'), touch: 'd3' }), []);
  assert.deepEqual(rules(withBody('Hi Ann. Worth a call.')), ['cta_question']);
  assert.deepEqual(rules(withBody('Hi Ann. Worth a call? Or not?')), ['cta_question']);
  assert.deepEqual(rules(withBody('Hi {FirstName}. Worth a call?')), ['unfilled_slot']);
  assert.deepEqual(rules(withBody('Hi [Placeholder name]. Worth a call?')), ['placeholder']);
  assert.deepEqual(rules(withBody('We guarantee results. Act now, worth a call?')), ['spam_word']);
  assert.deepEqual(rules({ ...good, subject: 'FREE money inside' }), ['spam_word', 'all_caps']);
  assert.deepEqual(rules(withBody('This is HUGE news. Worth a call?')), ['all_caps']);
  assert.deepEqual(capsWords('IT and MSP work for the CEO, in TX'), []);
  assert.deepEqual(rules({ ...good, text: good.text.replace('100 Main St, Dallas, TX 75201', '') }), ['postal_address']);
  assert.deepEqual(rules(good, { ...PROFILE, postalAddress: '' }), ['postal_address']);
  assert.deepEqual(rules({ ...good, text: good.text.replace('Just reply STOP and I will not email you again.', '') }), ['stop_line']);
  assert.deepEqual(rules({ ...good, text: good.text.replaceAll('Sam Carter', 'Someone') }), ['sender_name']);
  assert.deepEqual(rules({ ...good, fromName: 'Other Person' }), ['sender_name']);
});

// ── Lead Finder webhook, Sanity, Blocklist ──────────────────────────────────

const row = (i, extra = {}) => ({ email: `owner${i}@biz${i}.com`, first_name: `Pat${i}`, name: `Pat${i} Doe`, title: 'Owner', company: `Biz ${i}`, website: `https://biz${i}.com`, city: 'Dallas', state: 'TX', types: ['dentist'], score: 4, riskLevel: 'safe', ...extra });

test('sanity check: > 2 failing rows reject the batch and give the pattern to exclude', () => {
  const chains = new Set(['statefarm.com']);
  const rows = Array.from({ length: 20 }, (_, i) => row(i));
  rows[0].title = 'Receptionist';
  rows[1].state = '';
  rows[2].website = 'https://statefarm.com/agent/x';
  const ok = sanityCheck(rows, { titles: 'owner, president' }, { chains, rng: () => 0.5 });
  assert.equal(ok.failCount, 3);
  assert.equal(ok.reject, true);
  assert.deepEqual(ok.exclude.titles, ['receptionist']);
  assert.deepEqual(ok.exclude.hosts, ['statefarm.com']);
  assert.equal(ok.exclude.requireState, true);
  rows[2].website = 'https://biz2.com';
  assert.equal(sanityCheck(rows, { titles: 'owner' }, { chains }).reject, false);
  assert.ok(sanityCheck([row(1, { types: ['hospital'] })], {}, { chains }).failures[0].reasons.includes('size'));
  assert.ok(sanityCheck([row(1, { employees: 400 })], { sizeMin: 5, sizeMax: 50 }, { chains }).failures[0].reasons.includes('size'));
});

test('webhook: a bad batch is rejected, the finder re-dispatched with the exclusion, owner alerted', async () => {
  __reset();
  process.env.LEADFINDER_TOKEN = 't';
  await trialClient('acme');
  const rows = Array.from({ length: 20 }, (_, i) => row(i, i < 3 ? { title: 'Receptionist' } : {}));
  const dispatched = [];
  const { handleBatch } = await import('@/lib/systems/leadfinder');
  const r = await handleBatch(await getClient('acme'), { runId: 'r1', batchNo: 1, leads: rows, placesRequests: 4 }, { dispatch: async (p) => { dispatched.push(p); return { ok: true }; } });
  assert.equal(r.rejected, true);
  assert.equal(r.stop, true);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].exclude.titles, ['receptionist']);
  assert.equal((await countByStatus('acme')).unsent, 0);
  assert.ok((await alerts()).includes('list_quality'));
  assert.equal((await kv.hgetall(K.usage('places', partsIn('UTC', new Date()).monthKey))).enterprise, 4);
});

test('webhook insert: blocklist / suppression / other client skipped, A/B alternates, tz from state', async () => {
  __reset();
  await trialClient('acme');
  await trialClient('other');
  await addToBlocklist('acme', 'blocked.com');
  await kv.sadd(K.suppression(), 'stop@gone.com');
  await kv.hset(K.leadHosts('msp', partsIn('UTC', new Date()).monthKey), { 'taken.com': 'other' });
  const leads = [
    row(1),
    row(2, { email: 'x@blocked.com', website: 'https://blocked.com' }),
    row(3, { email: 'stop@gone.com', website: 'https://gone.com' }),
    row(4, { email: 'y@taken.com', website: 'https://taken.com' }),
    row(5, { state: 'CA', city: 'San Diego' }),
    row(6, { state: 'CO' }),
  ];
  const body = { type: 'batch', clientId: 'acme', runId: 'r9', batchNo: 1, leads, placesRequests: 7, reoonChecks: 2 };
  const r = await handleWebhook(body);
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 3);
  assert.deepEqual(r.json.skipped, { 'blocklist:domain': 1, suppressed: 1, other_client: 1 });
  const stored = Object.fromEntries((await getLeads('acme')).map((l) => [l.email, l]));
  assert.deepEqual(['owner1@biz1.com', 'owner5@biz5.com', 'owner6@biz6.com'].map((e) => stored[e].sequenceVariant), ['A', 'B', 'A']);
  assert.equal(stored['owner5@biz5.com'].tz, 'America/Los_Angeles');
  assert.equal(stored['owner6@biz6.com'].tz, 'America/Denver');
  assert.equal(stored['owner1@biz1.com'].tz, 'America/Chicago');
  for (const l of Object.values(stored)) {
    assert.equal(l.status, 'unsent');
    assert.equal(l.campaign, 'trial');
    assert.ok(['safe', 'risky', 'catchall'].includes(l.riskLevel));
  }
  // The hosts are now this client's for the month (fairness for the other client).
  assert.deepEqual((await handleWebhook({ type: 'hosts', clientId: 'other', niche: 'msp', hosts: ['biz1.com', 'nobody.com'] })).json.taken, ['biz1.com']);
  // Idempotent: the same batch again adds nothing.
  assert.equal((await handleWebhook(body)).json.duplicate, true);
  assert.equal((await countByStatus('acme')).unsent, 3);
  const approvalRows = await kv.get(K.sanityRows('acme'));
  assert.ok(String(approvalRows).includes('Biz'));
  assert.equal((await listReady('acme')).ok, false);
});

test('webhook: short list widens once, then list_short; failures alert', async () => {
  __reset();
  await trialClient('acme');
  const dispatched = [];
  const { handleDone } = await import('@/lib/systems/leadfinder');
  const dispatch = async (p) => { dispatched.push(p); return { ok: true }; };
  await handleDone(await getClient('acme'), { found: 10, mode: 'initial' }, { dispatch });
  assert.equal(dispatched[0].widen, true);
  await handleDone(await getClient('acme'), { found: 10, mode: 'widen' }, { dispatch });
  assert.equal(dispatched.length, 1);
  assert.ok((await alerts()).includes('list_short'));
  await handleWebhook({ type: 'failed', clientId: 'acme', error: 'boom' });
  assert.ok((await alerts()).includes('leadfinder_failed'));
  const wr = await handleWorkflowRun({ action: 'completed', workflow_run: { name: 'leadfinder', display_title: 'leadfinder acme initial', conclusion: 'failure', id: 5 } });
  assert.equal(wr.clientId, 'acme');
  process.env.GITHUB_WEBHOOK_SECRET = 's3';
  const raw = '{"a":1}';
  const sig = `sha256=${crypto.createHmac('sha256', 's3').update(raw).digest('hex')}`;
  assert.ok(verifyGithubRequest(raw, { 'x-hub-signature-256': sig }));
  assert.ok(!verifyGithubRequest(raw, { 'x-hub-signature-256': 'sha256=00' }));
  assert.ok(verifyGithubRequest(raw, { authorization: 'Bearer s3' }));
  assert.ok(!verifyGithubRequest(raw, { authorization: 'Bearer nope' }));
});

test('blocklist keeper: parses names/domains/emails/CSV and blocks by email, host, website or name', async () => {
  __reset();
  const p = parseBlocklistInput('name,website\n"Acme Plumbing Inc", acme.com\nbob@rival.com; https://www.partner.io/about\nThe Big Firm LLC');
  assert.deepEqual(p.emails, ['bob@rival.com']);
  assert.deepEqual(p.domains.sort(), ['acme.com', 'partner.io']);
  assert.deepEqual(p.names, ['Acme Plumbing Inc', 'The Big Firm LLC']);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body).textQuery); return { ok: true, json: async () => ({ places: [{ id: 'p1', displayName: { text: `${JSON.parse(init.body).textQuery} (Dallas)` } }] }) }; };
  const resolved = await resolveNames(['Acme Plumbing Inc'], { apiKey: 'k', fetchImpl });
  assert.equal(resolved['Acme Plumbing Inc'], 'Acme Plumbing Inc (Dallas)');
  await trialClient('acme');
  await addBlocklistInput('acme', 'Big Firm, rival.com, x@y.com', { resolve: false });
  assert.equal(await checkLead('acme', { email: 'a@rival.com' }), 'blocklist:domain');
  assert.equal(await checkLead('acme', { email: 'x@y.com' }), 'blocklist:email');
  assert.equal(await checkLead('acme', { email: 'a@bigfirm.net', company: 'The Big Firm, LLC' }), 'blocklist:name');
  assert.equal(await checkLead('acme', { email: 'a@gmail.com', website: 'http://www.rival.com/x' }), 'blocklist:website');
  assert.equal(await checkLead('acme', { email: 'ok@fine.com', company: 'Fine Co' }), null);
});

// ── Approval page ────────────────────────────────────────────────────────────

test('approval by click: page data with ticks, change requests capped at 2 rounds, three approvals = approved', async () => {
  __reset();
  await trialClient('acme', { trial: { signedDay: '2026-09-28', day1Date: '2026-10-12' } });
  await insertLeads('acme', [LEAD]);
  await buildSequence('acme');
  const url = await approvalUrl('acme');
  const token = url.split('/c/')[1].split('/')[0];
  assert.equal(await approvalUrl('acme'), url); // the same link is reused
  const page = await loadApprovalPage(token);
  assert.equal(page.company, 'Acme IT');
  assert.equal(page.variants.A.length, 4);
  assert.ok(page.variants.A.every((e) => e.ok && e.ticks.every((t) => t.ok)));
  assert.equal(await loadApprovalPage('x'.repeat(43)), null);

  assert.equal((await requestChange(token, 'copy', 'Please say "IT team" instead')).round, 1);
  assert.ok((await alerts()).includes('change_requested'));
  assert.equal((await kv.hgetall(K.promises('acme')) && Object.keys(await kv.hgetall(K.promises('acme'))).length), 1);
  assert.equal((await requestChange(token, 'list', 'Fewer dentists')).changesLeft, 0);
  assert.equal((await requestChange(token, 'copy', 'one more')).status, 409);

  assert.equal((await approveSection(token, 'profile')).approved, false);
  assert.equal((await approveSection(token, 'list')).approved, false);
  assert.equal((await approveSection(token, 'copy')).approved, true);
  const s = await getStoredSequence('acme');
  assert.equal(s.approvalMode, 'click');
  assert.ok(s.approvedAt);
});

test('approval by silence: link Day −7, reminders Day −5 and −3, approved 48 h after the second', async () => {
  __reset();
  await trialClient('acme', { trial: { signedDay: '2026-09-28', day1Date: '2026-10-12' } });
  await insertLeads('acme', [LEAD]);
  const sent = [];
  const deps = { notify: async (id, key, vars, opts) => { sent.push({ key, vars, dedupe: opts.dedupe }); return { sent: true }; } };
  const client = await getClient('acme');
  const at = (day, hh = '14') => new Date(`${day}T${hh}:00:00Z`);
  assert.ok((await runApprovalJob({ client, now: at('2026-10-04'), deps })).waiting); // Day −8
  await runApprovalJob({ client, now: at('2026-10-05'), deps }); // Day −7
  assert.deepEqual(sent.map((x) => x.key), ['approval_link']);
  assert.match(sent[0].vars.approvalUrl, /\/c\/[A-Za-z0-9_-]+\/approve$/);
  assert.equal(sent[0].vars.day1Date, 'Monday, October 12');
  await runApprovalJob({ client, now: at('2026-10-06'), deps }); // Day −6: nothing
  await runApprovalJob({ client, now: at('2026-10-07'), deps }); // Day −5
  await runApprovalJob({ client, now: at('2026-10-09'), deps }); // Day −3
  assert.deepEqual(sent.map((x) => x.key), ['approval_link', 'approval_reminder', 'approval_reminder']);
  assert.equal((await runApprovalJob({ client, now: at('2026-10-10', '13'), deps })).waiting, 'client'); // 47 h
  const r = await runApprovalJob({ client, now: at('2026-10-11', '15'), deps }); // 49 h
  assert.equal(r.approved, 'silence');
  assert.equal(sent.at(-1).key, 'approved_by_silence');
  const s = await getStoredSequence('acme');
  assert.equal(s.approvalMode, 'silence');
  assert.ok(s.approvedAt);
  assert.ok((await alerts()).includes('approved_by_silence'));
});

// ── warming → ready ──────────────────────────────────────────────────────────

test('warming → ready: Day 1 slides one sending day while the gate is red, then ready when green', async () => {
  __reset();
  await trialClient('beta', { trial: { signedDay: '2026-09-22', day1Date: '2026-10-06', day30Date: '2026-11-04' } });
  await saveInbox('beta', { email: 'a@beta-trial.com', password: 'x' });
  const sent = [];
  const deps = { notify: async (id, key, vars, opts) => { sent.push({ key, vars, dedupe: opts.dedupe }); return { sent: true }; } };
  // Day −1: nothing is ready, but the last warm-up check (23:45) is still to come — no slide yet.
  assert.equal((await runReadiness({ client: await getClient('beta'), now: NOW, deps })).slid, undefined);
  // Tuesday = Day 1 morning, still red → Day 1 slides.
  const DAY1 = new Date(NOW.getTime() + 864e5);
  const r1 = await runReadiness({ client: await getClient('beta'), now: DAY1, deps });
  assert.equal(r1.slid, '2026-10-07');
  let trial = await kv.hgetall(K.trial('beta'));
  assert.equal(trial.day1Date, '2026-10-07');
  assert.equal(trial.day30Date, '2026-11-05');
  assert.equal(trial.day1Original, '2026-10-06');
  assert.equal(sent[0].key, 'day1_moved');
  assert.match(sent[0].vars.waitingLine, /approve the emails here/);
  assert.ok((await alerts()).includes('day1_slid'));
  // Same day again: no second slide.
  assert.equal((await runReadiness({ client: await getClient('beta'), now: new Date(DAY1.getTime() + 3600e3), deps })).slid, undefined);
  assert.equal(nextSendingDay('2026-10-09'), '2026-10-13'); // Fri → skips weekend + Columbus Day

  // Make every gate green.
  await kv.hset(K.sequence('beta'), { approvedAt: NOW.toISOString(), approvalMode: 'click' });
  await insertLeads('beta', Array.from({ length: 200 }, (_, i) => ({ email: `p${i}@co${i}.com`, company: `Co ${i}` })));
  await patchInbox('beta', 'a@beta-trial.com', { warmupReady: '1', inboxRate7d: '0.950', readyStreak: '2' });
  await kv.hset(K.canary('beta', '2026-10-05'), { phase: 'done', result: JSON.stringify({ overall: 0.9, min: 0.9, perInbox: { 'a@beta-trial.com': { sent: 10, inbox: 9, placement: 0.9 } } }) });
  // Still red until the client has done the Booking Link Tester (SPEC §6.7).
  const red = await runReadiness({ client: await getClient('beta'), now: new Date(DAY1.getTime() + 2 * 3600e3), deps });
  assert.equal(red.ready, false);
  assert.equal(red.checks.booking, false);
  await kv.hset(K.profile('beta'), { bookingTested: '1' });
  const r2 = await runReadiness({ client: await getClient('beta'), now: new Date(DAY1.getTime() + 2 * 3600e3), deps });
  assert.equal(r2.ready, true);
  assert.equal((await getClient('beta')).state, 'ready');
  trial = await kv.hgetall(K.trial('beta'));
  assert.equal(trial.day1Date, '2026-10-07'); // still in the future: kept
});

test('warming → ready: canary below the gate keeps it red; 7 slides → held + warmup_stalled', async () => {
  __reset();
  await trialClient('gamma', { trial: { signedDay: '2026-09-22', day1Date: '2026-10-06', day1Slides: '7' } });
  await saveInbox('gamma', { email: 'a@g.com', password: 'x' });
  await kv.hset(K.sequence('gamma'), { approvedAt: NOW.toISOString() });
  await insertLeads('gamma', Array.from({ length: 200 }, (_, i) => ({ email: `p${i}@co${i}.com`, company: `Co ${i}` })));
  await patchInbox('gamma', 'a@g.com', { warmupReady: '1' });
  await kv.hset(K.profile('gamma'), { bookingTested: '1' });
  await kv.hset(K.canary('gamma', '2026-10-05'), { phase: 'done', result: JSON.stringify({ overall: 0.8, min: 0.8, perInbox: { 'a@g.com': { sent: 10, inbox: 8, placement: 0.8 } } }) });
  const r = await runReadiness({ client: await getClient('gamma'), now: new Date(NOW.getTime() + 864e5), deps: { notify: async () => ({ sent: true }) } });
  assert.equal(r.held, true);
  assert.equal(r.checks.canary, false);
  assert.equal((await kv.hgetall(K.trial('gamma'))).day1Held, '1');
  assert.ok((await alerts()).includes('warmup_stalled'));
  assert.equal((await getClient('gamma')).state, 'warming');
});

// ── Lead Finder scripts (pure extraction + one stubbed pipeline step) ───────

const SITE_HOME = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Dentist","name":"Smile Dental","email":"info@smiledental.com","numberOfEmployees":{"value":12}},{"@type":"Person","name":"Dana Reyes","jobTitle":"Office Manager","email":"dana@smiledental.com"}]}</script>
</head><body><nav>Home About Contact</nav>
<h1>Welcome to Smile Dental</h1>
<p>Meet Jane Smith, DDS — Owner</p><p>Dr. Mark Lee | Partner</p>
<p>Founded by Maria Lopez in 1998.</p>
<p>Email <a href="mailto:hello@smiledental.com?subject=Hi">hello@smiledental.com</a> or write to jane [at] smiledental [dot] com.</p>
<img src="logo@2x.png"><p>Our team of 14 staff.</p></body></html>`;

test('crawler extraction: mailto, plain, JSON-LD, people near titles, employee hint, robots', () => {
  assert.deepEqual(LF.extractMailtos(SITE_HOME), [{ email: 'hello@smiledental.com', label: 'hello@smiledental.com' }]);
  assert.deepEqual(LF.extractPlainEmails(SITE_HOME).sort(), ['hello@smiledental.com', 'jane@smiledental.com']);
  const ld = LF.extractJsonLd(SITE_HOME);
  assert.deepEqual(ld.people, [{ name: 'Dana Reyes', title: 'Office Manager', email: 'dana@smiledental.com' }]);
  assert.equal(ld.orgs[0].email, 'info@smiledental.com');
  const people = LF.extractPeople(SITE_HOME);
  assert.ok(people.some((p) => p.name === 'Mark Lee' && p.title === 'partner'));
  assert.ok(people.some((p) => p.name === 'Maria Lopez' && p.title === 'founder'));
  assert.ok(!people.some((p) => /Welcome|Smile Dental/.test(p.name)));
  assert.deepEqual(LF.extractPeople('<p>Bob Jones - Office Manager</p><p>President: Carl O\'Neil</p><p>Sarah Kim, Co-Founder &amp; CEO</p>'), [
    { name: 'Bob Jones', title: 'office manager' }, { name: 'Carl O\'Neil', title: 'president' }, { name: 'Sarah Kim', title: 'co-founder & ceo' },
  ]);
  assert.equal(LF.extractEmployeeHint(SITE_HOME), 14);
  const rules = LF.parseRobots('User-agent: *\nDisallow: /team\nAllow: /team/public\n\nUser-agent: AvianceBot\nDisallow: /about');
  assert.equal(LF.robotsAllows(rules, '/about'), false); // our own group wins
  assert.equal(LF.robotsAllows(rules, '/team'), true);
  const star = LF.parseRobots('User-agent: *\nDisallow: /team\nAllow: /team/public');
  assert.equal(LF.robotsAllows(star, '/team'), false);
  assert.equal(LF.robotsAllows(star, '/team/public/x'), true);
  assert.equal(LF.robotsAllows(LF.parseRobots('User-agent: *\nDisallow:'), '/contact'), true);
});

test('crawler: contact choice, guess patterns, scoring, tz, filters', () => {
  const found = { mailtos: LF.extractMailtos(SITE_HOME), emails: LF.extractPlainEmails(SITE_HOME), ld: LF.extractJsonLd(SITE_HOME), people: LF.extractPeople(SITE_HOME) };
  const c = LF.pickContact(found, 'smiledental.com', ['office manager']);
  assert.deepEqual([c.kind, c.name, c.email, c.titleApproved], ['person', 'Dana Reyes', 'dana@smiledental.com', true]);
  const c2 = LF.pickContact({ ...found, ld: { people: [], orgs: [] }, people: [] }, 'smiledental.com');
  assert.deepEqual([c2.kind, c2.email], ['email', 'jane@smiledental.com']);
  const c3 = LF.pickContact({ mailtos: [{ email: 'info@x.com' }], emails: [], ld: { people: [], orgs: [] }, people: [] }, 'x.com');
  assert.deepEqual([c3.kind, c3.email, c3.source], ['role', 'info@x.com', 'mailto']);
  assert.deepEqual(LF.guessPatterns('jane', 'smith', 'x.com'), ['jane@x.com', 'jane.smith@x.com', 'jsmith@x.com', 'janes@x.com', 'j.smith@x.com']);
  assert.deepEqual(LF.splitName('Mark O. Lee'), { first: 'mark', last: 'lee', firstDisplay: 'Mark' });
  assert.equal(LF.scoreLead({ dreamMatch: 1, hasNamedPerson: true, titleApproved: true }), 5);
  assert.equal(LF.scoreLead({ isRole: true, riskLevel: 'catchall' }), -5);
  assert.equal(LF.dreamMatch({ company: 'Smile Dental', types: ['dentist'], state: 'TX' }, [{ industry: 'dental', state: 'TX' }, { name: 'no facts' }, { industry: 'plumbing' }]), 1);
  assert.equal(LF.tzForState('WA'), 'America/Los_Angeles');
  assert.deepEqual(LF.parseUsAddress('9 Elm St, Austin, TX 78701, USA'), { city: 'Austin', state: 'TX', zip: '78701' });
  assert.deepEqual(LF.buildQueries({ industry: 'dentist', cities: ['Dallas, TX'] }), ['dentist in Dallas, TX']);
  assert.ok(LF.buildQueries({ industry: 'dentist', cities: ['Dallas, TX'], states: ['TX'] }, { widen: true }).includes('dentist in OK, USA'));
  const { kept, dropped } = filterCandidates([
    { company: 'A', website: 'https://a.com', state: 'TX' },
    { company: 'A again', website: 'https://www.a.com/x', state: 'TX' },
    { company: 'No site', website: '' },
    { company: 'Chain', website: 'https://statefarm.com/agent', state: 'TX' },
    { company: 'Blocked Co LLC', website: 'https://b.com', state: 'TX' },
    { company: 'Mall', website: 'https://m.com', state: 'TX', types: ['shopping_mall'] },
  ], { blockedNames: ['blocked co'], chains: new Set(['statefarm.com']), exclude: { types: ['shopping_mall'] } });
  assert.deepEqual(kept.map((k) => k.host), ['a.com']);
  assert.deepEqual(dropped, { duplicate_host: 1, no_website: 1, chain: 1, blocklist: 1, excluded_pattern: 1 });
});

test('crawler pipeline step: named owner with no email → guessed + Reoon-checked; robots honoured', async () => {
  const pages = {
    'https://joes.com/robots.txt': 'User-agent: *\nDisallow: /team',
    'https://joes.com/': '<p>Joe Bloggs, Owner</p>',
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.startsWith('https://emailverifier.reoon.com/')) {
      const email = decodeURIComponent(/email=([^&]+)/.exec(url)[1]);
      return { ok: true, json: async () => ({ status: email === 'joe.bloggs@joes.com' ? 'safe' : 'invalid' }) };
    }
    if (pages[url] == null) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => (url.endsWith('.txt') ? 'text/plain' : 'text/html') }, text: async () => pages[url] };
  };
  const { reoonBudget } = await import('../scripts/leadfinder/verify.mjs');
  const reoon = reoonBudget(20);
  const lead = await buildLead({ company: "Joe's Plumbing", website: 'https://joes.com', host: 'joes.com', city: 'Austin', state: 'TX', types: ['plumber'], placeId: 'p1', source: 'places' }, { reoon, reoonKey: 'k', fetchImpl, resolveMx: async () => [{ exchange: 'mx.joes.com', priority: 1 }] });
  assert.equal(lead.email, 'joe.bloggs@joes.com');
  assert.equal(lead.riskLevel, 'safe');
  assert.equal(lead.first_name, 'Joe');
  assert.equal(lead.titleApproved, true);
  assert.equal(lead.tz, 'America/Chicago');
  assert.equal(reoon.used, 2);
  assert.ok(!fetched.includes('https://joes.com/team'));
  // No Reoon credits left → first@ guess kept but marked risky.
  const lead2 = await buildLead({ company: "Joe's Plumbing", website: 'https://joes.com', host: 'joes.com', state: 'TX', placeId: 'p1', source: 'places' }, { reoon: reoonBudget(0), reoonKey: 'k', fetchImpl, resolveMx: async () => [{ exchange: 'mx', priority: 1 }] });
  assert.deepEqual([lead2.email, lead2.riskLevel], ['joe@joes.com', 'risky']);
  // No MX → dropped.
  assert.equal(await buildLead({ company: 'Dead', website: 'https://dead.com', host: 'dead.com', placeId: 'p2', source: 'places' }, { reoon: reoonBudget(0), fetchImpl: async (u) => (u === 'https://dead.com/' ? { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<p>Ann Moss, Owner</p>' } : { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' }), resolveMx: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } }), null);
});
