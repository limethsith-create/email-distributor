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
import { renderReport, recommendPlan } from '@/lib/systems/reports';
import { composeFriday, runFriday } from '@/lib/systems/friday';
import { runDayJobs } from '@/lib/systems/trialmanager';
import { startExtension } from '@/lib/systems/extension';
import { decide, decisionView } from '@/lib/systems/decision';
import { decisionLink } from '@/lib/systems/reports';
import { deleteClientData, retireClient } from '@/lib/systems/wrapup';
import { startPlan } from '@/lib/systems/planstart';
import { runInvoiceJob } from '@/lib/systems/invoice';
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

// ── 1. Rule 4 ──
test('a report with a missing counter is blocked, alerts the owner, and never shows 0', async () => {
  const { qualified, ...rest } = TOTALS;
  await setup({ totals: rest });
  const r = await renderReport('day29', CLIENT, { now: onDay(29) });
  assert.equal(r.ok, false);
  assert.match(r.blockedReason, /qualified/);
  const stored = await kv.hgetall(`client:${CLIENT}:report:day29`);
  assert.match(stored.blockedReason, /qualified/);
  assert.equal(stored.text, '');
  assert.ok((await alerts()).includes('report_blocked'));
  // The day job holds the report and the decision; the client gets nothing.
  await runDayJobs(CLIENT, { now: onDay(29) });
  assert.equal(toClient().length, 0);
  assert.equal((await getClient(CLIENT)).state, 'sending');
});

test('the Day 29 report renders from counters with the arithmetic', async () => {
  await setup();
  const r = await renderReport('day29', CLIENT, { now: onDay(29), decisionUrl: 'https://x/c/t/decide' });
  assert.equal(r.ok, true);
  assert.match(r.text, /Companies contacted: 412 · Emails sent: 1040 · Bounce: 1\.4%/);
  assert.match(r.text, /3 qualified calls from 412 companies is 0\.73%/);
  assert.match(r.text, /about 14 calls at your rate, and we guarantee 10/);
  assert.match(r.text, /about 29, and we guarantee 20/);
  assert.match(r.text, /Inbox placement: not measured/);
  assert.equal(r.attachments.length, 2);
});

// ── 2. Plan Recommender ──
test('plan recommender: every branch, with the arithmetic paragraph', () => {
  const plans = { starter: { price: 2497, calls: 10, reach: 2000 }, growth: { price: 3997, calls: 20, reach: 4000 }, scale: { price: 8497, calls: 50, reach: 10000 }, payPerShow: 250 };
  const base = { positive: 12, companies: 412, kickoffDate: 'Thu 17 Sep', plans, capacity: { starterMax: 3, growthMax: 7 } };
  const g = recommendPlan({ ...base, qualified: 3, capacityPerWeek: 5 });
  assert.equal(g.plan, 'growth');
  assert.match(g.text, /3 qualified calls from 412 companies is 0\.73%/);
  assert.match(g.text, /about 14 calls; we guarantee 10/);
  assert.match(g.text, /about 29 at your rate/);
  assert.match(g.text, /You told us on Thu 17 Sep you can take 5 calls a week\. That’s Growth — \$3,997, and it works out at \$200 a call/);
  assert.equal(recommendPlan({ ...base, qualified: 4, capacityPerWeek: 2 }).plan, 'starter');
  assert.equal(recommendPlan({ ...base, qualified: 4, capacityPerWeek: 3 }).plan, 'starter');
  assert.equal(recommendPlan({ ...base, qualified: 4, capacityPerWeek: 7 }).plan, 'growth');
  const s = recommendPlan({ ...base, qualified: 9, capacityPerWeek: 8 });
  assert.equal(s.plan, 'scale');
  assert.match(s.text, /\$8,497.*\$170 a call/);
  assert.equal(recommendPlan({ ...base, qualified: 3, capacityPerWeek: null }).kind, 'capacity_unknown');
  const thin = recommendPlan({ ...base, qualified: 1, capacityPerWeek: 10 });
  assert.equal(thin.plan, 'starter');
  assert.equal(thin.kind, 'thin');
  assert.match(thin.text, /1 qualified call from 412 companies is 0\.24%/);
  const pps = recommendPlan({ ...base, qualified: 0, positive: 9, capacityPerWeek: 5 });
  assert.equal(pps.plan, 'starter');
  assert.equal(pps.kind, 'pay_per_show');
  assert.match(pps.text, /9 positive replies from 412 companies is 2\.2%/);
  assert.match(pps.text, /pay per show, \$250/);
  const ext = recommendPlan({ ...base, qualified: 0, positive: 0 });
  assert.equal(ext.plan, null);
  assert.equal(ext.kind, 'extension');
  const wb = recommendPlan({ ...base, qualified: 0, positive: 0, extensionUsed: true });
  assert.equal(wb.plan, null);
  assert.equal(wb.kind, 'winback');
});

// ── 3. Friday update ──
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
  assert.match(f.text, /Emails: awaiting your approval/);
  assert.match(f.text, /Waiting on you: approving the emails/);
  assert.ok(f.words < 120, `${f.words} words`);
});

test('Friday update: trial variant with pace-log fix, watch line and personal line; sent once', async () => {
  await setup();
  const friday = new Date('2026-10-16T14:00:00Z'); // Day 16, a Friday
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-14']) await kv.hset(`client:${CLIENT}:counters:${d}`, { sent: 60, replies: 2, positive: 1, booked: 0, held: 0 });
  await kv.lpush(`client:${CLIENT}:pacelog`, { at: '2026-10-15T22:00:00Z', day: 15, test: 'qualified = 0', fix: 'compressed the sequence to 3–2–3' });
  await kv.hset(`client:${CLIENT}:counters:total`, { bounces: 17 }); // 1.6% of 1040 → "watching it"
  await kv.hset(`client:${CLIENT}:leads`, { 'bo@bolt.test': { email: 'bo@bolt.test', company: 'Bolt IT', status: 'replied' } });
  await kv.hset(`client:${CLIENT}:replies`, { r1: { leadEmail: 'bo@bolt.test', kind: 'interested', receivedAt: '2026-10-13T15:00:00Z', snippet: 'tell me more' } });
  const f = await composeFriday(CLIENT, friday);
  assert.equal(f.ok, true, f.blockedReason);
  assert.equal(f.variant, 'trial');
  assert.match(f.text, /^A reply came in from Bolt IT on Tue\./);
  assert.match(f.text, /trial week 3 of 4/);
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

// ── 4. Day-job routing ──
test('day jobs: Day 29 report, Day 30 with a qualified call → deciding + handover', async () => {
  await setup();
  await runDayJobs(CLIENT, { now: onDay(28) });
  assert.equal(toClient().length, 0);
  await runDayJobs(CLIENT, { now: onDay(29) });
  assert.deepEqual(subjects(), ['Acme IT — 30-Day Trial Report']);
  assert.equal(toClient()[0].attachments.length, 2);
  await runDayJobs(CLIENT, { now: onDay(29) }); // idempotent
  assert.equal(toClient().length, 1);
  await runDayJobs(CLIENT, { now: onDay(30) });
  assert.equal((await getClient(CLIENT)).state, 'deciding');
  assert.ok(subjects().includes('Everything from your trial — Acme IT'));
  assert.ok(subjects().includes('Day 30 — your numbers and one recommendation'));
  const trial = await kv.hgetall(`client:${CLIENT}:trial`);
  assert.equal(Date.parse(trial.bonusExpiresAt) - Date.parse(trial.decisionSentAt), 24 * 3600_000);
});

test('day jobs: Day 30 with 0 qualified → extension; ends at the first qualified call; never twice', async () => {
  await setup({ totals: { ...TOTALS, qualified: 0, held: 0, booked: 1 } });
  await runDayJobs(CLIENT, { now: onDay(29) });
  assert.deepEqual(subjects(), ['Acme IT — Trial Report']); // zero-call version
  await runDayJobs(CLIENT, { now: onDay(30) });
  assert.equal((await getClient(CLIENT)).state, 'extension');
  assert.ok(subjects().includes('Day 30 — we keep going'));
  assert.ok((await alerts()).includes('extension_started'));
  await runDayJobs(CLIENT, { now: onDay(35) });
  assert.equal((await getClient(CLIENT)).state, 'extension');
  await kv.hset(`client:${CLIENT}:counters:total`, { qualified: 1, held: 1 });
  await runDayJobs(CLIENT, { now: onDay(41) });
  assert.equal((await getClient(CLIENT)).state, 'deciding');
  assert.equal((await kv.hgetall(`client:${CLIENT}:trial`)).decisionDay, '41');
  assert.equal((await startExtension(CLIENT)).refused, 'already used');
});

test('day jobs: extension cap → deciding with the zero-call report', async () => {
  await setup({ totals: { ...TOTALS, qualified: 0, positive: 0, held: 0, booked: 0 } });
  await runDayJobs(CLIENT, { now: onDay(29) });
  await runDayJobs(CLIENT, { now: onDay(30) });
  assert.equal((await getClient(CLIENT)).state, 'extension');
  await runDayJobs(CLIENT, { now: onDay(59) });
  assert.equal((await getClient(CLIENT)).state, 'extension');
  await runDayJobs(CLIENT, { now: onDay(60) });
  assert.equal((await getClient(CLIENT)).state, 'deciding');
  const zeroMail = toClient().find((m) => m.subject === 'Day 60 — the honest numbers');
  assert.ok(zeroMail, subjects().join(' | '));
  assert.match(zeroMail.text, /we didn’t get you a call/);
  assert.match(zeroMail.text, /change the offer or the market/); // extension used → no plan
});

// ── 5. Ladder ──
test('ladder: review request Day 31, ladder 33/37/44, exit interview, Day 45 retire', async () => {
  await setup({ state: 'deciding', trial: { decisionDay: '30', decisionSentAt: onDay(30).toISOString(), decisionEmailAt: onDay(30).toISOString(), bonusExpiresAt: onDay(31).toISOString() } });
  await kv.hset(`client:${CLIENT}:replies`, { r1: { leadEmail: 'bo@bolt.test', kind: 'interested', receivedAt: '2026-10-13T15:00:00Z', snippet: 'tell me more' } });
  await runDayJobs(CLIENT, { now: onDay(31) });
  assert.deepEqual(subjects(), ['The review — ten minutes']);
  assert.match(toClient()[0].text, /https:\/\/clutch\.co\/profile\/aviance/);
  assert.match(toClient()[0].text, /I received this service for free for my review\./);
  await runDayJobs(CLIENT, { now: onDay(32) });
  assert.equal(toClient().length, 1);
  await setState(CLIENT, 'not_now', 'test');
  await runDayJobs(CLIENT, { now: onDay(33) });
  assert.ok(subjects().includes('The review link, once more'));
  assert.ok(subjects().includes('Three questions, ten minutes'));
  // The exit interview goes from the trial inbox so the Reply Handler can store the answer.
  assert.match(String(toClient().find((m) => m.subject === 'Three questions, ten minutes').from), /sam@acme-team\.test/);
  await runDayJobs(CLIENT, { now: onDay(37) });
  const d37 = toClient().find((m) => m.subject === 'Conversations still open from your trial');
  assert.match(d37.text, /bo@bolt\.test/);
  await runDayJobs(CLIENT, { now: onDay(44) });
  assert.ok(subjects().includes('The trial domain retires tomorrow'));
  await runDayJobs(CLIENT, { now: onDay(45) });
  assert.equal((await getClient(CLIENT)).state, 'retired');
  assert.equal((await kv.hgetall(`inbox:${CLIENT}:sam@acme-team.test`)).enabled, '0');
  assert.ok((await kv.hgetall(`client:${CLIENT}:domain`)).retiredAt);
  assert.ok((await alerts()).includes('cancel_inboxes'));
  assert.equal((await kv.hgetall(`client:${CLIENT}:trial`)).dataDeleteAt, '2026-12-14');
});

test('ladder: review request waits for REVIEW.clutchUrl; shifted after an extension; no click by Day 45 → not_now', async () => {
  await setup({ state: 'deciding', settings: false, trial: { decisionDay: '47', decisionEmailAt: 'x' } });
  await setOverride(null, 'OWNER.signerName', 'Limeth');
  await runDayJobs(CLIENT, { now: onDay(47) });
  assert.equal(toClient().length, 0);
  await runDayJobs(CLIENT, { now: onDay(48) }); // ladder day 31, no Clutch link set
  assert.equal(toClient().length, 0);
  assert.ok((await alerts()).includes('config_missing'));
  await setOverride(null, 'REVIEW.clutchUrl', 'https://clutch.co/x');
  await runDayJobs(CLIENT, { now: onDay(49) });
  assert.deepEqual(subjects(), ['The review — ten minutes']);
  await runDayJobs(CLIENT, { now: onDay(62) }); // ladder day 45
  const c = await getClient(CLIENT);
  assert.equal(c.state, 'retired');
  assert.equal((await kv.hgetall(`client:${CLIENT}:trial`)).decision, 'none');
});

// ── 6. Decision buttons ──
test('decision page: five numbers, bonus expiry, Start → converted + invoice', async () => {
  await setup({ state: 'deciding', trial: { decisionSentAt: onDay(30).toISOString(), bonusExpiresAt: new Date(onDay(30).getTime() + 864e5).toISOString() } });
  const token = (await decisionLink(CLIENT, 'mail')).split('/c/')[1].split('/')[0];
  const view = await decisionView(token, { now: onDay(30) });
  assert.equal(view.ok, true);
  assert.deepEqual(view.numbers.map((n) => n.value), [1040, 31, 12, 4, 3]);
  assert.equal(view.recommendation.plan, 'growth');
  assert.equal(view.bonus.calls, 22);
  assert.equal(view.bonus.expired, false);
  assert.equal((await decisionView(token, { now: onDay(32) })).bonus.expired, true);
  assert.ok(view.faq.length >= 4);
  const r = await decide(token, 'start', { now: new Date(onDay(30).getTime() + 3600_000) });
  assert.equal(r.outcome, 'converted');
  assert.equal(r.bonus, true);
  const c = await getClient(CLIENT);
  assert.equal(c.state, 'converted');
  assert.equal(c.plan, 'growth');
  const inv = toClient().find((m) => /^Invoice /.test(m.subject));
  assert.match(inv.text, /\$3,997/);
  assert.match(inv.text, /22 calls for the price of 20/);
  assert.match(inv.text, /paypal\.me\/aviance\/3997USD/);
  assert.ok((await alerts()).includes('converted'));
  assert.equal((await decide(token, 'start')).already, true);
});

test('decision page: Talk to someone and Not now; bonus lapses after 24 h; bad token refused', async () => {
  await setup({ state: 'deciding', trial: { decisionSentAt: onDay(30).toISOString(), bonusExpiresAt: new Date(onDay(30).getTime() + 864e5).toISOString() } });
  const token = (await decisionLink(CLIENT, 'mail')).split('/c/')[1].split('/')[0];
  const t = await decide(token, 'talk', { now: onDay(30) });
  assert.equal(t.outcome, 'talk');
  assert.ok(t.slots.length >= 2 && /ET$/.test(t.slots[0]));
  assert.ok((await alerts()).includes('talk_request'));
  assert.ok(subjects().includes('Let’s talk — pick a time'));
  assert.equal((await getClient(CLIENT)).state, 'deciding');
  assert.equal((await kv.hgetall(`client:${CLIENT}:promises`)) !== null, true);
  const n = await decide(token, 'notnow', { now: onDay(31) });
  assert.equal(n.outcome, 'not_now');
  assert.equal((await getClient(CLIENT)).state, 'not_now');
  // Still allowed to start from not_now (before Day 45) — but the bonus has lapsed.
  const s = await decide(token, 'start', { now: onDay(33) });
  assert.equal(s.outcome, 'converted');
  assert.equal(s.bonus, false);
  assert.equal((await decide('nope-not-a-token-at-all-xxxx', 'start')).ok, false);
});

// ── 7. Wrap-up deletion ──
test('wrap-up deletion removes client data, keeps the stub (deleted + mainDomain) and learning', async () => {
  await setup({ state: 'not_now' });
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

// ── 8. Invoice ──
test('invoice is held with config_missing when no payment method is set, then sent once it is', async () => {
  await setup({ state: 'converted', settings: false });
  await setOverride(null, 'OWNER.signerName', 'Limeth');
  const r = await startPlan(CLIENT, 'starter', { bonus: false, now: onDay(31) });
  assert.equal(r.invoice.status, 'blocked');
  assert.equal(toClient().length, 0);
  assert.ok((await alerts()).includes('config_missing'));
  await setOverride(null, 'PAYMENT.wiseDetails', 'Wise USD account 123');
  await runInvoiceJob(CLIENT, { now: onDay(32) });
  const inv = toClient().find((m) => /^Invoice /.test(m.subject));
  assert.match(inv.text, /Wise \(bank transfer\): Wise USD account 123/);
  assert.match(inv.text, /not applied/);
  await runInvoiceJob(CLIENT, { now: onDay(35) }); // +3 days → reminder
  assert.ok(subjects().some((s) => /^Reminder: invoice/.test(s)));
});

// ── 9. Morning digest ──
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
test('Test Mode clock: scaled time and jump to Day N', () => {
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

test('Stage D jobs: trial jobs skip aviance, run at 09:00 on the client clock; digests are global', async () => {
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

test('Monday digest: KPIs from the ledger, "not measured" when no owner time was logged', async () => {
  await setup();
  const { mondayDigest } = await import('@/lib/systems/digests');
  const empty = await mondayDigest({ now: onDay(12), send: false });
  assert.match(empty.body, /no finished trials yet/);
  assert.match(empty.body, /Time per trial: not measured/);
  assert.match(empty.body, /Health:\n {2}• (GREEN|YELLOW|RED) Acme IT/);
  await kv.hset('system:trials:ledger', { a: { booked: 2, converted: true, reviewCapturedAt: 'x', ownerMinutes: 480 }, b: { booked: 0, notNowAt: 'x' } });
  const r = await mondayDigest({ now: onDay(12), send: false });
  assert.match(r.body, /Trials that booked ≥ 1 call: 50% \(1 of 2\)/);
  assert.match(r.body, /Trial to paid: 50% \(1 of 2\)/);
  assert.match(r.body, /Time per trial: 8\.0 h per trial/);
});
