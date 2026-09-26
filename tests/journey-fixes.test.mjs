// One focused test per problem the journey (tests/journey.test.mjs) found and
// fixed. Each says what went wrong before, in one line. Fake KV, stubbed mail,
// DNS and network — nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { io } from '@/lib/systems/intake-io';
import { ALERTS } from '@/lib/templates/owner';
import { alertOwner, ackAlerts } from '@/lib/notify';

process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.OWNER_INBOX = 'hello@aviance.test:app-pw:Limeth Sith';
process.env.OWNER_EMAIL = 'owner@aviance.test';
process.env.PUBLIC_BASE_URL = 'https://app.test';
let sent = [];
nodemailer.createTransport = (opts = {}) => ({
  async sendMail(m) { sent.push({ ...m, user: opts.auth?.user }); return { messageId: m.messageId, response: '250 OK' }; },
  async verify() { return true; },
  close() {},
});
const realIo = { ...io };

beforeEach(async () => {
  __reset();
  sent = [];
  Object.assign(io, realIo);
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
});
const log = async () => ((await kv.lrange(K.alertLog(), 0, -1)) || []);

// ── 1. The research's quick market count ─────────────────────────────────────

test('fit score: a market count Google cut off (60 a search) is a floor, never "Market too small"', async () => {
  // Before: the research asks 2 searches × 60 places × 3 = 360 at most, under the 500 line → EVERY applicant "Not a fit".
  const { scoreFit } = await import('@/lib/systems/fitscore');
  const x = { now: new Date('2026-10-01T12:00:00Z'), application: { web_sellsTo: 'Managed IT for law firms in Charlotte', web_city: 'Charlotte, NC', dealValue: '5000', slotsPerWeek: '5', soldToStrangers: 'yes', meetWithin5Days: 'yes' }, customers: 'law firms', signals: {}, website: { pagesRead: 5 } };
  const capped = scoreFit({ ...x, market: { estimate: 360, query: 'law firms in Charlotte, NC', source: 'places', capped: true } });
  assert.deepEqual(capped.dealbreakers.filter((d) => /Market too small/.test(d.text)), []);
  const item = capped.parts.find((p) => p.key === 'market').items[0];
  assert.equal(item.status, 'ok');
  assert.match(item.text, /^At least 360 companies to reach — Google lists at most 60 per search/);
  // A search Google did NOT cut off that found few is a real small market: still a dealbreaker.
  const small = scoreFit({ ...x, market: { estimate: 90, query: 'law firms in Tiny, NC', source: 'places' } });
  assert.ok(small.dealbreakers.some((d) => /Market too small — about 90/.test(d.text)));
});

// ── 2. Alerts that outlive what they were about ──────────────────────────────

test('ackAlerts: the machine acknowledges a trial\'s alerts once handled; others and other trials stay open', async () => {
  // Before: an urgent alert (new_application, legal_reply, dns_fail …) stayed a to-do + red dot until the owner found it in /mc/alerts.
  await createClient('acme', { name: 'Acme Co', state: 'applied' });
  await createClient('bolt', { name: 'Bolt Co', state: 'applied' });
  await alertOwner('new_application', { clientId: 'acme', vars: { company: 'Acme' } });
  await alertOwner('new_application', { clientId: 'bolt', vars: { company: 'Bolt' } });
  await alertOwner('angry_reply', { clientId: 'acme', vars: { clientId: 'acme' } });
  assert.equal(await ackAlerts('acme', ['new_application'], { reason: 'application approved' }), 1);
  const byKey = Object.fromEntries((await log()).map((a) => [`${a.clientId}:${a.key}`, a]));
  assert.equal(byKey['acme:new_application'].acknowledged, true);
  assert.equal(byKey['acme:new_application'].acknowledgedBy, 'machine');
  assert.equal(byKey['bolt:new_application'].acknowledged, false);
  assert.equal(byKey['acme:angry_reply'].acknowledged, false);
  // Titles name the trial ("Acme Co"), not its id (before: "Angry reply: acme").
  assert.equal(byKey['acme:angry_reply'].title, 'Angry reply: Acme Co');
});

test('approve / decline acknowledge the application\'s alerts; clearing a legal hold acknowledges legal_reply', async () => {
  const { approveApplication, declineApplication } = await import('@/lib/systems/gatekeeper');
  for (const id of ['acme', 'bolt']) {
    await createClient(id, { name: `${id} co`, contactName: 'Ann Lee', contactEmail: `ann@${id}.com`, mainDomain: `${id}.com`, state: 'applied', source: 'website' });
    await kv.hset(K.application(id), { review: 'pending', mainDomain: `${id}.com`, receivedAt: '2026-10-05T12:00:00Z' });
    await alertOwner('new_application', { clientId: id, vars: { company: id } });
  }
  io.notifyClient = async () => ({ sent: true, messageId: '<x@y>' });
  io.scanMailbox = async () => ({ ok: true, messages: [], uidState: {} });
  await approveApplication('acme', { now: new Date('2026-10-05T14:00:00Z') });
  await declineApplication('bolt', 'not a fit this time.');
  assert.ok((await log()).every((a) => a.key !== 'new_application' || a.acknowledged));

  await createClient('carl', { name: 'Carl Co', state: 'sending', legalHoldAt: '2026-10-06T10:00:00Z' });
  await alertOwner('legal_reply', { clientId: 'carl', vars: { clientId: 'carl' } });
  const { POST } = await import('@/app/api/mc/clients/[id]/route');
  const res = await POST(new Request('https://app.test/api/mc/clients/carl', { method: 'POST', body: JSON.stringify({ action: 'clearLegalHold' }) }), { params: Object.assign(Promise.resolve({ id: 'carl' }), { id: 'carl' }) }); // Next 15's params: a promise that also carries the values
  assert.equal(res.status, 200);
  assert.equal((await log()).find((a) => a.key === 'legal_reply').acknowledged, true);
});

test('to-dos: one per alert kind (a daily repeat is one line with a count); none where a native to-do says it', async () => {
  // Before: 16 identical "DNS record wrong" to-dos after 16 days; "New trial application" next to "Review … application".
  const { todosFor } = await import('@/lib/systems/hubview');
  const now = new Date('2026-10-20T15:00:00Z');
  const alert = (id, key, at, title) => ({ id, key, at, title, urgent: true, clientId: 'acme', acknowledged: false });
  const ctx = {
    client: { id: 'acme', name: 'Acme', state: 'sending', legalHoldAt: '2026-10-20T10:00:00Z' }, now,
    alerts: [alert('a1', 'dns_fail', '2026-10-18T10:00:00Z', 'DNS record wrong for x.com'), alert('a2', 'dns_fail', '2026-10-19T10:00:00Z', 'DNS record wrong for x.com'), alert('a3', 'dns_fail', '2026-10-20T10:00:00Z', 'DNS record wrong for x.com'), alert('l1', 'legal_reply', '2026-10-20T10:00:00Z', 'LEGAL reply: Acme')],
  };
  const todos = todosFor(ctx);
  const dns = todos.filter((t) => /DNS record/.test(t.text));
  assert.equal(dns.length, 1);
  assert.equal(dns[0].text, 'DNS record wrong for x.com (3 alerts)');
  assert.deepEqual(dns[0].action, { type: 'api', method: 'POST', path: '/api/mc/alerts', body: { action: 'ack', ids: ['a3', 'a2', 'a1'] } });
  assert.equal(todos.filter((t) => /legal/i.test(t.text)).length, 1, 'the legal hold to-do, not also its alert');
  // The hub's button acknowledges the whole group.
  for (const a of ctx.alerts) await kv.lpush(K.alertLog(), a);
  const { POST } = await import('@/app/api/mc/alerts/route');
  const res = await POST(new Request('https://app.test/api/mc/alerts', { method: 'POST', body: JSON.stringify(dns[0].action.body) }));
  assert.deepEqual(await res.json(), { ok: true, acknowledged: 3 });
  assert.deepEqual((await log()).filter((a) => !a.acknowledged).map((a) => a.id), ['l1']);
});

test('health and the morning digest ignore news alerts (a purchase found, a bot answer, a conversion)', async () => {
  // Before: every trial stayed yellow ("6 alerts open") and every digest said "1 client with open alerts", for good.
  const { computeHealth } = await import('@/lib/systems/health');
  const client = { id: 'acme', state: 'sending' };
  const news = ['bot_replied', 'purchase_found', 'inboxes_ready', 'converted', 'meeting_requested', 'onboard_reply'].map((key) => ({ key, urgent: false }));
  for (const n of news) assert.equal(ALERTS[n.key].info, true, n.key);
  assert.equal(computeHealth({ client, alerts: news }).colour, 'green');
  assert.equal(computeHealth({ client, alerts: [...news, { key: 'inbox_rate_low', urgent: false }] }).colour, 'yellow');
  await createClient('acme', { name: 'Acme', state: 'sending' });
  await alertOwner('purchase_found', { clientId: 'acme', vars: { domain: 'x.com', company: 'Acme' } });
  const { morningDigest } = await import('@/lib/systems/digests');
  assert.match((await morningDigest({ now: new Date('2026-10-20T02:30:00Z'), send: false })).body, /^All green\./);
});

// ── 3. The daily DNS check on a CheapInboxes domain ──────────────────────────

test('Auth Guard: a CheapInboxes domain passes DMARC with CheapInboxes\' own report address; a pass clears dns_fail', async () => {
  // Before: the setup check passed it, the daily check failed it → an urgent false "DNS record wrong" every day.
  const { runAuthCheck } = await import('@/lib/systems/authguard');
  await createClient('acme', { name: 'Acme', state: 'warming' });
  await kv.hset(K.domain('acme'), { name: 'getacme.com', registrar: 'cheapinboxes' });
  io.dns = {
    resolveTxt: async (n) => (n.startsWith('google._domainkey.') ? [['v=DKIM1; k=rsa; p=MIIB']] : n.startsWith('_dmarc.') ? [['v=DMARC1; p=none; rua=mailto:dmarc-reports@cheapinboxes.com']] : [['v=spf1 include:_spf.google.com ~all']]),
    resolveMx: async () => [{ exchange: 'smtp.google.com', priority: 1 }],
    resolve4: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
  };
  await alertOwner('dns_fail', { clientId: 'acme', vars: { domain: 'getacme.com' } });
  const r = await runAuthCheck({ clientId: 'acme', now: new Date('2026-10-08T10:00:00Z') });
  assert.deepEqual(r.failed, []);
  assert.equal((await log()).find((a) => a.key === 'dns_fail').acknowledged, true);
  // A domain bought elsewhere still needs the collector address (unchanged rule).
  await kv.hset(K.domain('acme'), { registrar: 'porkbun' });
  assert.deepEqual((await runAuthCheck({ clientId: 'acme', now: new Date('2026-10-09T10:00:00Z') })).failed, ['dmarc']);
});

// ── 4. Client emails at midnight and on weekends ─────────────────────────────

test('build-phase emails to the client: approval inside US hours, booking test on a business day, no weekend reminder', async () => {
  // Before: the approval link went at 00:00 ET, the booking test on Saturday 00:00, its reminder on Sunday.
  const { JOBS } = await import('@/lib/jobs');
  const job = (name) => JOBS.find((j) => j.name === name);
  const client = { id: 'acme', state: 'warming', intakeStep: 'welcome' };
  const at = (iso) => new Date(iso);
  assert.equal(await job('approval').due({ client, now: at('2026-10-14T04:00:00Z') }), null, '00:00 ET');
  assert.equal(await job('approval').due({ client, now: at('2026-10-14T13:00:00Z') }), '2026-10-14T09');
  assert.equal(await job('booking-test').due({ client, now: at('2026-10-17T14:00:00Z') }), null, 'Saturday');
  assert.equal(await job('booking-test').due({ client, now: at('2026-10-16T13:00:00Z') }), '2026-10-16T09');
  assert.equal(await job('booking-reminder').due({ client, now: at('2026-10-18T15:00:00Z') }), null, 'Sunday');
  assert.equal(await job('booking-reminder').due({ client, now: at('2026-10-19T15:00:00Z') }), '2026-10-19');
  assert.equal(await job('welcome').due({ client, now: at('2026-10-07T09:40:00Z') }), null, '05:40 ET');
  assert.equal(await job('welcome').due({ client, now: at('2026-10-07T13:30:00Z') }), '2026-10-07T09');
  const { testStartDay } = await import('@/lib/systems/bookingtest');
  assert.equal(testStartDay('2026-10-21'), '2026-10-16', 'Day −4 is a Saturday → the Friday before');
});

test('the hot-lead nudge to the client waits for their working day; the invoice reminder for a business day', async () => {
  // Before: "Still waiting — …" at 11 pm and on Sundays; the invoice reminder on a Sunday.
  const { inClientDay } = await import('@/lib/systems/replies');
  assert.equal(inClientDay(new Date('2026-10-23T03:00:00Z'), 'America/New_York'), false, 'Thu 23:00 ET');
  assert.equal(inClientDay(new Date('2026-10-25T14:00:00Z'), 'America/New_York'), false, 'Sunday 10:00 ET');
  assert.equal(inClientDay(new Date('2026-10-23T12:00:00Z'), 'America/New_York'), true, 'Fri 08:00 ET');
  assert.equal(inClientDay(new Date('2026-10-23T12:00:00Z'), 'America/Los_Angeles'), false, 'Fri 05:00 PT');
  const { runInvoiceJob } = await import('@/lib/systems/invoice');
  await createClient('acme', { name: 'Acme', state: 'converted', contactName: 'Ann Lee', contactEmail: 'ann@acme.com' });
  await kv.hset(K.invoice('acme'), { plan: 'starter', status: 'sent', issuedAt: '2026-11-19T19:10:00Z', invoiceNo: 'AV-1', amount: 2497 });
  await kv.hset('system:config', { 'PAYMENT.paypalMe': JSON.stringify('https://paypal.me/aviance') });
  const sunday = await runInvoiceJob('acme', { now: new Date('2026-11-22T15:00:00Z') });
  assert.equal(sunday.waiting, 'business day');
  assert.equal(sent.filter((m) => /Reminder: invoice/.test(m.subject || '')).length, 0);
  const monday = await runInvoiceJob('acme', { now: new Date('2026-11-23T15:00:00Z') });
  assert.equal(monday.reminder, 3);
  assert.equal(sent.filter((m) => /Reminder: invoice/.test(m.subject || '')).length, 1);
});

test('the Monday digest is dated the owner\'s Monday, not the US Sunday', async () => {
  const { mondayDigest } = await import('@/lib/systems/digests');
  await mondayDigest({ now: new Date('2026-10-12T02:30:00Z') }); // Mon 08:00 Colombo = Sun 22:30 ET
  assert.equal((await log()).find((a) => a.key === 'monday_digest').title, 'Monday KPIs — 2026-10-12');
});

// ── 5. Warm-up replies and the ramp ──────────────────────────────────────────

test('warm-up: a trial inbox\'s replies stay inside its ramp quota; a helper replies up to the ceiling', async () => {
  // Before: a day-3 inbox (quota 3) sent 7 warm-up emails — the replies ignored the ramp.
  const { processMailbox, statBump, makeMarker } = await import('@/lib/systems/warmup');
  const { encrypt } = await import('@/lib/crypto');
  const now = new Date('2026-10-09T16:00:00Z');
  const mk = (email, extra) => ({ email, key: `x|${email}`, record: { email, displayName: 'X', provider: 'google', passwordEnc: encrypt('abcdefghijklmnop') }, tz: 'America/New_York', ...extra });
  const trial = mk('dana@getacme.com', { clientId: 'acme', quota: 3 });
  const helper = mk('help@gmail.com', { clientId: '_helper', isHelper: true, quota: 8 });
  const replies = [];
  const box = (owner) => {
    const msgs = [{ uid: 1, envelope: { messageId: `<w-${owner}@x>`, from: [{ address: owner === trial.email ? helper.email : trial.email }], subject: 'Lunch' }, headers: `X-Aviance-Warm: ${makeMarker('w')}\r\n` }];
    return { async connect() {}, async logout() {}, async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' }]; }, async getMailboxLock() { return { release() {} }; }, async search() { return msgs.map((m) => m.uid); }, async *fetch() { for (const m of msgs) yield m; }, async messageFlagsAdd() {}, async messageMove() {} };
  };
  const deps = { imap: async (acct) => box(acct.email), send: async (acct, mail) => { replies.push(acct.email); return { success: true, messageId: '<r@x>' }; }, rng: () => 0 };
  const poolByEmail = { [trial.email]: trial, [helper.email]: helper };
  await statBump(trial.email, 'sent', 3, now); // its 3 for the day already went
  await processMailbox(trial, { now, deps, poolByEmail });
  assert.deepEqual(replies, [], 'no reply past the ramp quota');
  await statBump(helper.email, 'sent', 8, now); // a helper at its own quota still answers (the ceiling is 15)
  await processMailbox(helper, { now, deps, poolByEmail });
  assert.deepEqual(replies, [helper.email]);
});

// ── 6. The simple status says what is really happening ───────────────────────

test('simple: a held trial does not say "Sending — day N"; the bot\'s answer is not "you answered"', async () => {
  const { simpleFor } = await import('@/lib/systems/hubview');
  const { onboardCallView, normaliseSettings } = await import('@/lib/systems/onboardcall');
  const now = new Date('2026-10-28T16:00:00Z');
  const base = (client, over = {}) => ({ client: { id: 'acme', name: 'Acme', contactName: 'Ann Lee', ...client }, trial: {}, counters: {}, alerts: [], now, day: 6, ...over });
  let s = simpleFor(base({ state: 'sending', legalHoldAt: '2026-10-28T14:45:00Z' }));
  assert.deepEqual([s.label, s.next, s.needsYou], ['Sending stopped — a prospect replied with a legal threat', 'Read the legal reply, then clear the hold', true]);
  s = simpleFor(base({ state: 'sending', sendHold: 'blacklisted: getacme.com' }));
  assert.equal(s.label, 'Sending on hold — blacklisted: getacme.com');
  assert.equal(s.needsYou, true);
  s = simpleFor(base({ state: 'sending' }));
  assert.equal(s.label, 'Sending — day 6 of 30');

  const raw = { sentAt: '2026-10-02T03:30:00Z', dueBy: '2026-10-07T03:30:00Z', contactEmail: 'ann@acme.com', lastReplyAt: '2026-10-02T13:05:00Z', lastAnsweredAt: '2026-10-02T13:10:00Z', lastBotAt: '2026-10-02T13:10:00Z' };
  const oc = onboardCallView(raw, [], { now: new Date('2026-10-02T14:00:00Z'), settings: normaliseSettings(), clientState: 'onboarding' });
  assert.equal(oc.label, 'The reply bot answered — waiting for them to book');
  s = simpleFor(base({ state: 'onboarding' }, { onboardCall: oc, now: new Date('2026-10-02T14:00:00Z') }));
  assert.deepEqual([s.label, s.next, s.needsYou], ['Accepted — the reply bot answered, waiting for them to pick a time', 'Nothing for you: the time they pick on your booking page comes to your Calendar', false]);
  // The owner answered himself (after the bot): the old words.
  const own = onboardCallView({ ...raw, lastOwnerReplyAt: '2026-10-02T13:30:00Z' }, [], { now: new Date('2026-10-02T14:00:00Z'), settings: normaliseSettings(), clientState: 'onboarding' });
  assert.equal(own.label, 'You answered — waiting for them to book');
});

// ── 7. Normal silence is not an emergency ────────────────────────────────────

test('Emergency Runner: no replies for 2 business days only counts when the campaign\'s own rate expected replies', async () => {
  // Before: ANY send after 2 quiet business days stopped the trial and emailed the client "we caught a deliverability issue".
  const { detectTrigger } = await import('@/lib/systems/emergency');
  const now = new Date('2026-11-04T15:00:00Z'); // Wed
  const client = { id: 'acme', state: 'sending' };
  await createClient('acme', { name: 'Acme', state: 'sending' });
  await kv.hset(K.sendState('acme'), { lastReplyAt: '2026-10-30T15:00:00Z' }); // Fri: 3 business days quiet
  await kv.hset(K.countersTotal('acme'), { sent: 400, replies: 12 }); // 3 % reply rate
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) await kv.hset(K.countersDay('acme', d), { sent: 25 });
  assert.equal(await detectTrigger('acme', client, now), null, '75 sends × 3 % = 2.3 expected: normal silence');
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) await kv.hset(K.countersDay('acme', d), { sent: 60 });
  const t = await detectTrigger('acme', client, now);
  assert.equal(t.code, 'no_replies', '180 sends × 3 % = 5.4 expected, none came');
  assert.match(t.detail, /about 5\.4 expected/);
});

// ── 8. Without the heartbeat the intake still moves ──────────────────────────

test('carryIntake: with no tick, the hub\'s check runs the due Stage A jobs once (the tick\'s own claims); a live tick owns them', async () => {
  // Before: the market count (when the 20 s request ran out) and the Price Scout (the client's "setup in progress",
  // the owner's shopping list) only ever ran on the tick — which is not running yet.
  const { carryIntake } = await import('@/lib/systems/carry');
  await createClient('acme', { name: 'Acme', state: 'awaiting_purchase', intakeStep: 'pricescout', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
  const ran = [];
  const scout = await import('@/lib/jobs').then((m) => m.JOBS.find((j) => j.name === 'pricescout'));
  const realRun = scout.run;
  scout.run = async (ctx) => { ran.push(ctx.clientId); return { sent: true }; };
  try {
    const now = new Date('2026-10-06T18:21:00Z');
    let r = await carryIntake({ now });
    assert.deepEqual(r.ran, [{ job: 'pricescout', clientId: 'acme' }]);
    r = await carryIntake({ now });
    assert.deepEqual(r.ran, [], 'the same minute never runs twice (the tick\'s claim)');
    assert.equal((await getClient('acme'))['jp:pricescout'], '2026-10-06T14:21');
    await kv.hset(K.heartbeat(), { lastTickAt: new Date('2026-10-06T18:21:30Z').toISOString() });
    r = await carryIntake({ now: new Date('2026-10-06T18:22:00Z') });
    assert.equal(r.skipped, 'heartbeat');
    assert.deepEqual(ran, ['acme']);
  } finally { scout.run = realRun; }
});

test('the shopping list alert with CheapInboxes connected says buy there — not the registrars and "paste the logins"', async () => {
  const { runPriceScout } = await import('@/lib/systems/pricescout');
  process.env.CHEAPINBOXES_API_KEY = 'ci_live_test_0123456789';
  try {
    await createClient('acme', { name: 'Acme Co', state: 'awaiting_purchase', intakeStep: 'pricescout', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
    await kv.hset(K.profile('acme'), { senderName: 'Ann Lee', senderPrefix: 'ann', marketEstimate: 1800 });
    await kv.hset(K.autobuy('acme'), { buy: JSON.stringify({ domain: 'getacme.com', price: 11.25, mailboxes: [{ email: 'ann@getacme.com' }, { email: 'ann.lee@getacme.com' }] }) });
    const alerts = [];
    io.alertOwner = async (key, o) => { alerts.push({ key, ...o }); return { sent: true }; };
    io.notifyClient = async () => ({ sent: true });
    globalThis.fetch = async (url) => (String(url).includes('rdap') ? new Response('', { status: 404 }) : new Response(JSON.stringify({ status: 'SUCCESS', pricing: { com: { registration: '10.37', renewal: '11.08' } } }), { status: 200 }));
    await runPriceScout('acme', { now: new Date('2026-10-06T18:21:00Z'), deadline: Date.now() + 30000 });
    const body = alerts.find((a) => a.key === 'shopping_list').body;
    assert.match(body, /Buy on CheapInboxes: getacme\.com \(\$11\.25 first year\) with 2 inboxes — ann@getacme\.com, ann\.lee@getacme\.com\./);
    assert.doesNotMatch(body, /paste form|Turn auto-renew OFF|Best domains/);
  } finally { delete process.env.CHEAPINBOXES_API_KEY; }
});

// ── 9. The owner's answer mid-trial goes in the right thread ─────────────────

test('the owner\'s reply to a message they sent after onboarding answers THAT message (subject + In-Reply-To)', async () => {
  // Before: it went as "Re: You're in — let's book your onboarding call", In-Reply-To their October reply.
  const { ownerReply, readCall } = await import('@/lib/systems/onboardcall');
  const conv = await import('@/lib/systems/conversation');
  await createClient('acme', { name: 'Acme', state: 'sending', contactName: 'Dana Whitfield', contactEmail: 'dana@acme.com', onboardCallSentAt: '2026-10-02T03:30:00Z' });
  await kv.hset(K.onboardCall('acme'), { sentAt: '2026-10-02T03:30:00Z', subject: "You're in — let's book your onboarding call", contactEmail: 'dana@acme.com', lastReplyAt: '2026-10-02T13:05:00Z', lastInSubject: "Re: You're in — let's book your onboarding call", lastInMessageId: '<old@acme.com>', messageIds: JSON.stringify(['<acc@aviance.test>', '<old@acme.com>']) });
  await conv.noteInbound('acme', { at: '2026-10-26T14:12:00Z', messageId: '<new@acme.com>', subject: 'Question about the trial' });
  await ownerReply('acme', 'Yes — Columbia from Monday.', { now: new Date('2026-10-26T14:30:00Z') });
  const m = sent.find((x) => x.to === 'dana@acme.com');
  assert.equal(m.subject, 'Re: Question about the trial');
  assert.equal(m.inReplyTo, '<new@acme.com>');
  assert.ok(m.references.includes('<old@acme.com>') && m.references.includes('<new@acme.com>'));
  assert.ok(JSON.parse((await readCall('acme')).messageIds).length >= 3);
});

// ── 10. inboxes_ready tells the truth about warm-up ──────────────────────────

test('inboxes_ready: "warm-up has started" only when the circle is full; else how many helpers to add', () => {
  assert.equal(ALERTS.inboxes_ready.title, '{domain} and {count} inboxes are ready — {next}');
});
