// Stage D (Phase 6): report + close systems and Mission Control.
// Fake KV, stubbed SMTP (nodemailer transport) and no network.
import { register } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { setOverride } from '@/lib/config';
import { createClient, getClient, setState } from '@/lib/db/client';
import { saveInbox } from '@/lib/db/inboxes';
import crypto from 'node:crypto';
import { composeFriday, runFriday } from '@/lib/systems/friday';
import { runDayJobs } from '@/lib/systems/trialmanager';
import { deleteClientData, retireClient } from '@/lib/systems/wrapup';
import { createInvoice, runInvoiceJob, getInvoice, chaseUnpaidInvoice, chaseUnpaidInvoices } from '@/lib/systems/invoice';
import { morningDigest } from '@/lib/systems/digests';
import { alertOwner } from '@/lib/notify';
import { validateAgainst } from '@/lib/systems/configedit';
import { clientNow, instantForTrialDay, offsetFor } from '@/lib/testclock';
import { trialDay } from '@/lib/time';
import { TEMPLATES } from '@/lib/templates/client/stage-d';
import { fill, slotsOf } from '@/lib/templates/render';

// Folder imports ('@/lib/templates/client') resolve to index.js, as in Next.
register('./stage-d-loader.mjs', import.meta.url);

// ── stubs ──
const mail = [];
nodemailer.createTransport = () => ({ sendMail: async (m) => { mail.push(m); return { messageId: `<${mail.length}@test>` }; }, close() {}, verify: async () => true });
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Owner';
process.env.OWNER_EMAIL = 'owner@aviance.test';
process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
delete process.env.TELEGRAM_BOT_TOKEN;
globalThis.fetch = async () => { throw new Error('network disabled in tests'); };

const CLIENT = 'acme';
const TOTALS = { sent: 1040, sentD0: 412, sentD3: 300, sentD7: 200, sentD10: 128, bounces: 15, replies: 31, positive: 12, booked: 4, held: 3, qualified: 3, noshows: 1, wrongfit: 0, warmupSent: 400, warmupInbox: 380, warmupSpam: 20, warmupRescued: 20, companiesContacted: 412 };
const DAY1 = '2026-10-01';
/** A moment on trial day N (10:00 ET-ish) when Day 1 is DAY1. */
const onDay = (n) => new Date(Date.parse(`${DAY1}T14:00:00Z`) + (n - 1) * 864e5);

const toClient = () => mail.filter((m) => m.to === 'ann@acme.test');
const subjects = () => toClient().map((m) => m.subject);
const alerts = async () => (await kv.lrange('system:alerts:log', 0, -1)).map((a) => a.key);

async function setup({ state = 'sending', totals = TOTALS, trial = {}, settings = true } = {}) {
  __reset();
  mail.length = 0;
  if (settings) {
    await setOverride(null, 'OWNER.signerName', 'Limeth');
    await setOverride(null, 'REVIEW.clutchUrl', 'https://clutch.co/profile/aviance');
    await setOverride(null, 'PAYMENT.paypalMe', 'https://paypal.me/aviance');
  }
  await createClient(CLIENT, { name: 'Acme IT', contactName: 'Ann', contactEmail: 'ann@acme.test', mainDomain: 'acme.test', state: 'applied' });
  await kv.hset(`client:${CLIENT}`, { state });
  await kv.hset(`client:${CLIENT}:profile`, { capacityPerWeek: '5', niche: 'msp' });
  await kv.hset(`client:${CLIENT}:trial`, { signedDay: '2026-09-17', day1Date: DAY1, firstSendAt: `${DAY1}T13:00:00Z`, day1NoticeAt: `${DAY1}T14:00:00Z`, agreementAcceptedAt: '2026-09-17T12:00:00Z', ...trial });
  await saveInbox(CLIENT, { email: 'sam@acme-team.test', password: 'app-pw', displayName: 'Sam', enabled: true });
  await kv.hset(`inbox:${CLIENT}:sam@acme-team.test`, { warmupStartedAt: '2026-09-17T12:00:00Z', inboxRate7d: '0.95' });
  if (totals) await kv.hset(`client:${CLIENT}:counters:total`, totals);
}

beforeEach(() => { mail.length = 0; });

// ── Friday update ──
test('Friday update: build variant during the build weeks, under 120 words', async () => {
  await setup({ state: 'warming', totals: null, trial: { day1Date: '2026-10-15', signedDay: '2026-10-01', firstSendAt: '' } });
  await kv.hset(`client:${CLIENT}:sequence`, { variantA: '{}' });
  for (let i = 0; i < 5; i++) await kv.hset(`client:${CLIENT}:leads`, { [`p${i}@x.test`]: { email: `p${i}@x.test`, status: 'unsent' } });
  await kv.sadd(`client:${CLIENT}:leads:index:unsent`, 'p0@x.test', 'p1@x.test', 'p2@x.test', 'p3@x.test', 'p4@x.test');
  const f = await composeFriday(CLIENT, new Date('2026-10-09T14:00:00Z'));
  assert.equal(f.ok, true);
  assert.equal(f.variant, 'build');
  assert.match(f.text, /build week/);
  assert.match(f.text, /Inboxes warming: day \d+ of 14/);
  assert.match(f.text, /List: 5 contacts found/);
  // The launch-call flow: before the invite the emails are shown on the call — nothing is asked of them.
  assert.match(f.text, /Emails: written — we go through them together on a launch call near the end of warm-up/);
  assert.match(f.text, /Waiting on you: nothing/);
  assert.ok(f.words < 120, `${f.words} words`);
  // Invited, not booked: picking a time is the ask.
  await kv.hset(`client:${CLIENT}:launchcall`, { sentAt: '2026-10-09T13:00:00Z' });
  let g = await composeFriday(CLIENT, new Date('2026-10-09T14:00:00Z'));
  assert.match(g.text, /Emails: ready — pick a time for our launch call, or approve them on the page/);
  assert.match(g.text, /Waiting on you: picking a time for the launch call/);
  // Booked: the day, and nothing asked.
  await kv.hset(`client:${CLIENT}:launchcall`, { bookedAt: '2026-10-09T15:00:00Z', bookedFor: '2026-10-13T15:00:00Z' });
  g = await composeFriday(CLIENT, new Date('2026-10-09T16:00:00Z'));
  assert.match(g.text, /Emails: ready — we go through them on our launch call Tue 13 Oct/);
  assert.match(g.text, /Waiting on you: nothing/);
  // The old plain approval email (no launch call): approving is the ask.
  await kv.del(`client:${CLIENT}:launchcall`);
  await kv.hset(`client:${CLIENT}:approval`, { sentAt: '2026-10-08T13:00:00Z' });
  g = await composeFriday(CLIENT, new Date('2026-10-09T16:00:00Z'));
  assert.match(g.text, /Emails: awaiting your approval/);
  assert.match(g.text, /Waiting on you: approving the emails/);
});

test('Friday update: sending variant with pace-log fix, watch line and personal line; sent once', async () => {
  await setup();
  const friday = new Date('2026-10-16T14:00:00Z'); // Day 16, a Friday
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-14']) await kv.hset(`client:${CLIENT}:counters:${d}`, { sent: 60, replies: 2, positive: 1, booked: 0, held: 0 });
  await kv.lpush(`client:${CLIENT}:pacelog`, { at: '2026-10-15T22:00:00Z', day: 15, test: 'qualified = 0', fix: 'compressed the sequence to 3–2–3' });
  await kv.hset(`client:${CLIENT}:counters:total`, { bounces: 17 }); // 1.6% of 1040 → "watching it"
  await kv.hset(`client:${CLIENT}:leads`, { 'bo@bolt.test': { email: 'bo@bolt.test', company: 'Bolt IT', status: 'replied' } });
  await kv.hset(`client:${CLIENT}:replies`, { r1: { leadEmail: 'bo@bolt.test', kind: 'interested', receivedAt: '2026-10-13T15:00:00Z', snippet: 'tell me more' } });
  const f = await composeFriday(CLIENT, friday);
  assert.equal(f.ok, true, f.blockedReason);
  assert.equal(f.variant, 'sending');
  assert.match(f.text, /^A reply came in from Bolt IT on Tue\./);
  assert.match(f.text, /week 3 of sending/);
  assert.doesNotMatch(f.text, /trial/i);
  assert.match(f.text, /Sent this week: 180 · to date: 1040, to 412 companies/);
  assert.match(f.text, /Replies: 6 \(3\.3%\) · positive: 3/);
  assert.match(f.text, /This week: compressed the sequence to 3–2–3/);
  assert.match(f.text, /Watch: bounce at 1\.6%, under the 2% line\. Watching it\./);
  assert.ok(f.words < 120, `${f.words} words`);
  const a = await runFriday(CLIENT, { now: friday });
  const b = await runFriday(CLIENT, { now: friday });
  assert.equal(a.sent, true);
  assert.equal(b.sent, false);
  assert.equal(toClient().length, 1);
});

// ── Wrap-up deletion ──
test('wrap-up deletion removes client data, keeps the stub (deleted + mainDomain) and learning', async () => {
  await setup({ state: 'paused' });
  await kv.hset(`client:${CLIENT}:leads`, { 'a@b.test': { email: 'a@b.test' } });
  await kv.set(`pacing:${CLIENT}`, { x: 1 });
  await kv.set(`lead:${CLIENT}:a@b.test:claim`, 1);
  await kv.hset('learning:msp', { A: { sends: 10, replies: 1 } });
  await kv.hset(`client:${CLIENT}`, { ownerNotes: 'private note', website: 'https://acme.test' });
  await retireClient(CLIENT, { now: onDay(45) });
  assert.equal((await getClient(CLIENT)).state, 'retired');
  assert.equal((await deleteClientData(CLIENT, { now: onDay(60) })).skipped, 'not due');
  const r = await deleteClientData(CLIENT, { now: onDay(75) });
  assert.ok(r.deleted > 5);
  const stub = await getClient(CLIENT);
  assert.equal(stub.state, 'deleted');
  assert.equal(stub.mainDomain, 'acme.test');
  assert.equal(stub.ownerNotes, undefined);
  assert.ok(await kv.hgetall('learning:msp'));
  const left = (await kv.scan(0, { match: `*${CLIENT}*` }))[1].sort();
  assert.deepEqual(left, [`client:${CLIENT}`, `client:${CLIENT}:events`]);
  assert.equal(await kv.get(`pacing:${CLIENT}`), null);
  assert.equal(await kv.hgetall(`inbox:${CLIENT}:sam@acme-team.test`), null);
});

// ── Invoice ──
test('invoice is held with config_missing when no payment method is set, then sent once it is', async () => {
  await setup({ state: 'onboarding', settings: false });
  await setOverride(null, 'OWNER.signerName', 'Limeth');
  const r = await createInvoice(CLIENT, 'starter', { now: onDay(31) });
  assert.equal(r.status, 'blocked');
  assert.equal(toClient().length, 0);
  assert.ok((await alerts()).includes('config_missing'));
  await setOverride(null, 'PAYMENT.wiseDetails', 'Wise USD account 123');
  await runInvoiceJob(CLIENT, { now: onDay(32) });
  const inv = toClient().find((m) => /^Invoice /.test(m.subject));
  assert.match(inv.text, /Wise \(bank transfer\): Wise USD account 123/);
  assert.match(inv.text, /Welcome to Starter/);
  await runInvoiceJob(CLIENT, { now: onDay(35) }); // +3 days → reminder
  assert.ok(subjects().some((s) => /^Reminder: invoice/.test(s)));
});

// ── Morning digest ──
test('morning digest says "All green" when nothing is open', async () => {
  await setup();
  const g = await morningDigest({ now: onDay(10), send: false });
  assert.equal(g.allGreen, true);
  assert.match(g.body, /^All green\./);
  await alertOwner('dispute', { clientId: CLIENT, body: 'x' });
  const y = await morningDigest({ now: onDay(10), send: false });
  assert.equal(y.allGreen, false);
  assert.match(y.body, /Acme IT \(sending\)/);
  assert.match(y.body, /Call disputed/);
});

// ── Test clock, config validation, templates ──
test('scaled clock (a _test client only): scaled time and jump to Day N', () => {
  const origin = new Date('2026-10-01T00:00:00Z');
  const c = { id: '_test', clockScale: '24', clockOrigin: origin.toISOString(), clockOffsetMs: '0' };
  assert.equal(clientNow(c, new Date(origin.getTime() + 3600_000)).toISOString(), '2026-10-02T00:00:00.000Z');
  assert.equal(clientNow({ id: 'acme', clockScale: '24', clockOrigin: origin.toISOString() }, origin).toISOString(), origin.toISOString());
  const trial = { day1Date: '2026-10-05' };
  const now = new Date(origin.getTime() + 7200_000);
  const off = offsetFor(c, instantForTrialDay(trial, 29), now);
  assert.equal(trialDay(trial, clientNow({ ...c, clockOffsetMs: String(off) }, now)), 29);
});

test('config edits are validated against the default shape', () => {
  assert.equal(validateAgainst(3, 5), null);
  assert.match(validateAgainst(3, '5'), /number/);
  assert.equal(validateAgainst(null, 'https://paypal.me/x'), null);
  assert.match(validateAgainst({ a: 1, b: 2 }, { a: 1 }), /missing b/);
  assert.match(validateAgainst(['09:00', '17:00'], ['9am', '17:00']), /HH:MM/);
  assert.equal(validateAgainst([-5, -3], [-6, -2]), null);
});

test('every Stage D template renders with sample data and no unfilled slot', () => {
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const vars = Object.fromEntries([...slotsOf(t.subject || ''), ...slotsOf(t.body)].map((s) => [s, `x${s}`]));
    const body = fill(key, t.body, vars);
    assert.doesNotMatch(body, /\{[A-Za-z]/, key);
  }
});

test('Stage D jobs: client jobs skip aviance, run at 09:00 on the client clock; digests are global', async () => {
  const { JOBS } = await import('@/lib/joblist/stage-d');
  const job = (n) => JOBS.find((j) => j.name === n);
  const nine = new Date('2026-10-16T13:30:00Z'); // Fri 09:30 ET
  const eight = new Date('2026-10-16T11:30:00Z'); // Fri 07:30 ET
  const acme = { id: 'acme', state: 'sending' };
  assert.equal(await job('day-jobs').due({ client: { id: 'aviance', state: 'sending' }, now: nine }), null);
  assert.equal(await job('day-jobs').due({ client: acme, now: nine }), '2026-10-16');
  assert.equal(await job('day-jobs').due({ client: acme, now: eight }), null);
  assert.equal(await job('day-jobs').due({ client: { id: 'x', state: 'applied' }, now: nine }), null);
  assert.equal(await job('friday').due({ client: acme, now: nine }), '2026-10-16');
  assert.equal(await job('friday').due({ client: acme, now: new Date('2026-10-15T13:30:00Z') }), null);
  assert.equal(await job('invoice').due({ client: acme, now: nine }), null);
  // _test on a 24× clock: one real hour later it is the next trial day.
  const t = { id: '_test', state: 'sending', clockScale: '24', clockOrigin: '2026-10-16T13:30:00Z', clockOffsetMs: '0' };
  assert.equal(await job('day-jobs').due({ client: t, now: new Date('2026-10-16T14:30:00Z') }), '2026-10-17');
  assert.equal(job('morning').scope, 'global');
  assert.equal(await job('morning').due({ now: new Date('2026-10-16T02:45:00Z') }), '2026-10-16'); // 08:15 Colombo
  assert.equal(await job('monday').due({ now: new Date('2026-10-19T02:45:00Z') }), '2026-10-19');
  assert.equal(await job('monday').due({ now: new Date('2026-10-16T02:45:00Z') }), null);
});

test('Monday digest: clients sending and calls booked from stored counters; "not measured" when no owner time was logged', async () => {
  await setup();
  const { mondayDigest } = await import('@/lib/systems/digests');
  const empty = await mondayDigest({ now: onDay(12), send: false });
  assert.match(empty.body, /^Clients sending: 1/);
  assert.match(empty.body, /Calls booked for them \(all time, stored counters\): 4/);
  assert.match(empty.body, /Your time per client: not measured/);
  assert.match(empty.body, /Health:\n {2}• (GREEN|YELLOW|RED) Acme IT/);
  assert.doesNotMatch(empty.body, /trial/i);
  await kv.hset('system:trials:ledger', { a: { booked: 2, ownerMinutes: 480 }, b: { booked: 0 } });
  const r = await mondayDigest({ now: onDay(12), send: false });
  assert.match(r.body, /Your time per client: 8\.0 h per client \(from 1 client with recorded minutes\)/);
});

// ── Unpaid invoice chase (24 hours) ──
test('invoice chase: 23h nothing; 25h one email and one hub alert; later runs and paid invoices nothing', async () => {
  await setup({ state: 'converted' });
  await setOverride(CLIENT, 'PLANS', { starter: { price: 2497, calls: 5 } }).catch(() => {});
  const sent = onDay(31);
  await createInvoice(CLIENT, 'starter', { now: sent });
  const chaseMails = () => toClient().filter((m) => /Quick note about invoice/.test(m.subject));
  const chaseAlerts = async () => (await alerts()).filter((k) => k === 'invoice_not_paid_yet');
  const at = (h) => new Date(sent.getTime() + h * 3600e3);
  const clients = async () => [await getClient(CLIENT)];

  assert.deepEqual(await chaseUnpaidInvoices({ clients: await clients(), now: at(23) }), { reminded: 0, held: 0 });
  assert.equal(chaseMails().length, 0);
  assert.equal((await chaseAlerts()).length, 0);

  assert.equal((await chaseUnpaidInvoices({ clients: await clients(), now: at(25) })).reminded, 1);
  assert.equal(chaseMails().length, 1);
  assert.equal((await chaseAlerts()).length, 1);
  assert.ok((await kv.hget(`client:${CLIENT}:invoice`, 'remindedAt')) || (await getInvoice(CLIENT)).remindedAt);

  await chaseUnpaidInvoices({ clients: await clients(), now: at(26) });
  await chaseUnpaidInvoices({ clients: await clients(), now: at(80) });
  assert.equal(chaseMails().length, 1);
  assert.equal((await chaseAlerts()).length, 1);
});

test('invoice chase: a paid invoice is never chased; a missing sentAt falls back to issuedAt and is stored', async () => {
  await setup({ state: 'converted' });
  const t0 = onDay(31);
  await kv.hset(`client:${CLIENT}:invoice`, { plan: 'starter', amount: 2497, invoiceNo: 'AV-X', issuedAt: t0.toISOString(), status: 'sent' });
  const later = new Date(t0.getTime() + 30 * 3600e3);
  await kv.hset(`client:${CLIENT}:invoice`, { paidAt: later.toISOString(), status: 'paid' });
  assert.equal((await chaseUnpaidInvoice(CLIENT, { now: later })).skipped, 'nothing to chase');
  assert.equal(toClient().length, 0);
  await kv.hset(`client:${CLIENT}:invoice`, { paidAt: '', status: 'sent' });
  assert.equal((await chaseUnpaidInvoice(CLIENT, { now: later })).reminded, true);
  assert.equal((await getInvoice(CLIENT)).sentAt, t0.toISOString());
});
