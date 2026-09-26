// A check of every hub screen against the journey snapshots
// (tests/fixtures/journey) found the machine-side problems below; one focused
// test each (docs/HUB-API.md "Hub screens check"). Each says what the hub
// showed before. Fake KV, stubbed mail — nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { dayKeyIn, OWNER_TZ } from '@/lib/time';
import { createClient } from '@/lib/db/client';
import { io } from '@/lib/systems/intake-io';
import { alertOwner, notifyClient } from '@/lib/notify';
import { hubBoard, hubClient, todosFor, simpleFor, stateLabelFor, ownerAndEastern } from '@/lib/systems/hubview';
import { autobuyView } from '@/lib/systems/autobuy';
import { warmupView, warmupHubSettings } from '@/lib/systems/warmup';
import { invoiceView } from '@/lib/systems/invoice';
import { morningDigest, mondayDigest } from '@/lib/systems/digests';
import { noteInbound, noteAnswered } from '@/lib/systems/conversation';
import { onboardCallFor } from '@/lib/systems/onboardcall';
import { approveApplication } from '@/lib/systems/gatekeeper';
import { requestMeeting, calendarAction } from '@/lib/systems/calendar';
import { approvalUrl } from '@/lib/systems/approval';
import { decisionLink } from '@/lib/systems/reports';
import { mintToken, pageUrl, rememberLink, currentLinks } from '@/lib/pagetokens';
import { renderTemplate } from '@/lib/templates/client';

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
const NOW = new Date('2026-10-23T15:00:00Z'); // Fri 11:00 am ET · 8:30 pm Colombo
const base = (over = {}) => ({
  client: { id: 'acme', name: 'Acme', state: 'sending', contactName: 'Ann Lee' }, trial: {}, profile: {}, domain: {}, checks: {}, shopping: {}, inboxes: [], leads: {}, lf: {},
  approval: {}, sequence: {}, counters: {}, bookings: [], hot: [], invoice: null, promises: [], pacelog: [], reports: [], runState: {}, alerts: [], replies: [], now: NOW, day: 3, minMarket: 1000, ...over,
});

// ── 3. detail.row is the board row ───────────────────────────────────────────

test('trial detail `row` is the board row: the same alerts, health and counts (before: green and 0 while the board said red)', async () => {
  await createClient('acme', { name: 'Acme', state: 'sending', contactName: 'Ann Lee', contactEmail: 'ann@acme.com' });
  await alertOwner('angry_reply', { clientId: 'acme', body: 'Angry reply from someone' });
  const board = await hubBoard({ now: NOW });
  const row = board.stages.flatMap((s) => s.clients).find((r) => r.id === 'acme');
  const detail = await hubClient('acme', { now: NOW });
  assert.equal(row.health, 'red');
  assert.deepEqual([detail.row.health, detail.row.openAlerts, detail.row.urgentAlerts], [row.health, row.openAlerts, row.urgentAlerts]);
  assert.deepEqual([detail.row.openAlerts, detail.row.urgentAlerts], [1, 1]);
  assert.deepEqual(detail.row.todo.map((t) => t.id), row.todo.map((t) => t.id));
});

// ── 4. needsYou → next is what to do ─────────────────────────────────────────

test('simple: the red dot never comes with "Nothing for you" — an urgent alert gives what to do', () => {
  const alert = { id: 'a1', at: '2026-10-23T14:00:00Z', key: 'angry_reply', clientId: 'acme', title: 'Angry reply: Acme', urgent: true, acknowledged: false };
  const ctx = base({ alerts: [alert] });
  const todos = todosFor(ctx);
  assert.equal(todos[0].id, 'alert-a1:acme');
  const s = simpleFor(ctx, todos);
  assert.deepEqual([s.step, s.label, s.needsYou, s.next], ['sending', 'Sending — day 3 of 30', true, 'Read the angry reply and mark it as seen']);
  // Another urgent alert kind: still an instruction, naming the alert.
  const other = simpleFor(base({ alerts: [{ ...alert, key: 'domain_burned', title: 'Domain burned: Acme' }] }));
  assert.deepEqual([other.needsYou, other.next], [true, 'Read the alert “Domain burned: Acme” and mark it as seen']);
  // Nothing urgent: the calm sentence stays.
  const calm = simpleFor(base());
  assert.deepEqual([calm.needsYou, calm.next], [false, 'Nothing for you: replies and booked calls come to you as alerts']);
});

// ── 5. the legal to-do in plain words ────────────────────────────────────────

test('to-do legal: who wrote, when and their first line — never the reply id', () => {
  const client = { id: 'acme', name: 'Acme', state: 'sending', contactName: 'Ann Lee', legalHoldAt: '2026-10-28T14:40:00Z', legalHoldReply: 'r0eea7d9132c5cd6' };
  const reply = { id: 'r0eea7d9132c5cd6', kind: 'legal', leadEmail: 'alan@adamslaw.com', receivedAt: '2026-10-28T14:40:00Z', snippet: 'Forwarding this to our attorney. Cease and desist.\n\nAlan' };
  const legal = todosFor(base({ client, replies: [reply] })).find((t) => t.id === 'legal:acme');
  assert.equal(legal.detail, 'alan@adamslaw.com wrote on Wed 28 Oct, 8:10 pm (your time): “Forwarding this to our attorney. Cease and desist.”');
  assert.equal(legal.urgent, true);
  // The reply fell out of the newest 50: still plain words, still not the id.
  const gone = todosFor(base({ client, replies: [] })).find((t) => t.id === 'legal:acme');
  assert.match(gone.detail, /^A prospect replied with a legal threat/);
  assert.doesNotMatch(gone.detail, /r0eea7d/);
});

// ── 6. deciding ──────────────────────────────────────────────────────────────

test('deciding: its own step in plain words, the bonus deadline in Sri Lanka time with Eastern, the warm-up card kept', async () => {
  const client = { id: 'acme', name: 'Acme', state: 'deciding', contactName: 'Ann Lee' };
  const ctx = base({ client, trial: { bonusExpiresAt: '2026-11-20T14:00:00Z' } });
  const s = simpleFor(ctx);
  assert.deepEqual([s.step, s.label, s.next, s.needsYou], ['deciding', 'Trial finished — waiting for their decision', 'Nothing. Ann chooses on the decision page.', false]);
  assert.equal(simpleFor(base({ client: { ...client, contactName: '' } })).next, 'Nothing. They choose on the decision page.');
  assert.equal(stateLabelFor(ctx), 'Deciding — bonus until Fri 20 Nov, 7:30 pm Sri Lanka time (9:00 am Eastern)');
  // A different US day: the Eastern day is written out.
  assert.equal(ownerAndEastern('2026-11-20T03:00:00Z'), 'Fri 20 Nov, 8:30 am Sri Lanka time (Thu 19 Nov, 10:00 pm Eastern)');
  // "Talk to someone" pressed: the instruction, in red.
  const talk = simpleFor(base({ client, trial: { talkRequestedAt: '2026-11-19T15:00:00Z' } }));
  assert.deepEqual([talk.next, talk.needsYou], ['Call Ann Lee — they asked to talk', true]);
  // After the decision `finished` stays.
  assert.equal(simpleFor(base({ client: { ...client, state: 'converted' } })).step, 'finished');
  // The warm-up card does not vanish between Day 30 and their click.
  const w = warmupView({ client, inboxes: [{ email: 'a@acme-mail.com', passwordEnc: 'x', warmupStartedAt: '2026-10-07T12:00:00Z', inboxRate7d: '0.96', warmupReady: '1' }], now: new Date('2026-11-19T15:00:00Z'), s: await warmupHubSettings() });
  assert.deepEqual([w.status, w.label], ['ready', 'Warm-up done · 96% reach the inbox']);
});

// ── 7. the invoice ───────────────────────────────────────────────────────────

test('invoice: the contract shape (number, dueDate, remindersSent as a count) and a to-do that names the number', () => {
  const inv = invoiceView({ plan: 'starter', amount: '2497', calls: '10', bonus: '1', invoiceNo: 'AV-202611-acme', issuedAt: '2026-11-19T19:10:00.000Z', status: 'sent', sentAt: '2026-11-19T19:10:00.000Z', remindersSent: '[3]', blockedReason: '' });
  assert.deepEqual(inv, { number: 'AV-202611-acme', plan: 'starter', amount: 2497, calls: 10, bonus: true, status: 'sent', issuedAt: '2026-11-19T19:10:00.000Z', sentAt: '2026-11-19T19:10:00.000Z', paidAt: null, dueDate: '2026-11-19', remindersSent: 1, blockedReason: null });
  assert.equal(invoiceView(null), null);
  assert.equal(invoiceView({ remindersSent: '[]' }).remindersSent, 0);
  const converted = { id: 'acme', name: 'Acme', state: 'converted', contactName: 'Ann Lee' };
  const todo = todosFor(base({ client: converted, invoice: inv })).find((t) => t.id === 'invoice:acme');
  assert.equal(todo.text, 'Mark the month-one invoice paid when the money lands (AV-202611-acme)');
  const noNumber = todosFor(base({ client: converted, invoice: { ...inv, number: null } })).find((t) => t.id === 'invoice:acme');
  assert.equal(noNumber.text, 'Mark the month-one invoice paid when the money lands');
});

// ── 8. the buy to-do ─────────────────────────────────────────────────────────

test('to-do buy: plain words — "we connect everything by ourselves", not "the machine"', () => {
  const ctx = base({ client: { id: 'acme', name: 'Acme', state: 'awaiting_purchase' }, autobuy: { status: 'ready_to_buy', buy: { domain: 'acmehq.com', price: 9.99, mailboxes: [{}, {}], builtAt: '2026-10-23T14:00:00Z' } } });
  const buy = todosFor(ctx).find((t) => t.id === 'buy:acme');
  assert.equal(buy.detail, '$9.99 for the domain · we connect everything by ourselves after you buy');
  assert.doesNotMatch(buy.detail, /machine/);
});

// ── 9. alerts that piled up ──────────────────────────────────────────────────

test('digests: the new one acknowledges the earlier ones of its kind — one morning and one Monday digest open at most (before: 48 of 50 open alerts)', async () => {
  // alertOwner dedupes one alert a key per real day; the digests here are days apart on the machine's clock.
  const freshDay = () => kv.del(K.alertsDay(dayKeyIn(OWNER_TZ, new Date())));
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22']) { await freshDay(); assert.equal((await morningDigest({ now: new Date(`${d}T02:30:00Z`) })).sent, true); }
  await freshDay(); await mondayDigest({ now: new Date('2026-10-19T02:30:00Z') });
  await freshDay(); await mondayDigest({ now: new Date('2026-10-26T02:30:00Z') });
  const all = await log();
  assert.deepEqual(all.filter((a) => !a.acknowledged).map((a) => a.title).sort(), ['Monday KPIs — 2026-10-26', 'Morning digest — 2026-10-22']);
  const done = all.filter((a) => a.acknowledged);
  assert.equal(done.length, 3);
  assert.ok(done.every((a) => a.acknowledgedBy === 'machine' && a.ackReason === 'the next digest went out'));
});

test('handled alerts close: "wrote — needs your answer" when answered; "asked for … — say yes" when answered in the Calendar', async () => {
  // Their message, then the owner's (or the bot's) answer.
  await createClient('acme', { name: 'Acme', state: 'sending', contactName: 'Ann Lee', contactEmail: 'ann@acme.com' });
  await alertOwner('onboard_reply', { clientId: 'acme', vars: { person: 'Ann Lee' }, body: 'Ann wrote' });
  await noteInbound('acme', { at: '2026-10-26T14:12:00Z' });
  assert.equal((await log()).find((x) => x.key === 'onboard_reply').acknowledged, false);
  await noteAnswered('acme', '2026-10-26T14:30:00Z');
  const a = (await log()).find((x) => x.key === 'onboard_reply');
  assert.deepEqual([a.acknowledged, a.acknowledgedBy, a.ackReason], [true, 'machine', 'answered']);

  // A time asked for on the booking page, then the owner's answer in the Calendar.
  const MON = new Date('2026-10-05T14:00:00Z'); // Mon 10:00 am ET
  await createClient('ecreek', { name: 'eCreek IT', contactName: 'Sam Test', contactEmail: 'sam@ecreek.com', mainDomain: 'ecreek.com', website: 'https://ecreek.com', state: 'applied', source: 'website' });
  await kv.hset(K.application('ecreek'), { review: 'pending', mainDomain: 'ecreek.com', receivedAt: '2026-10-05T12:00:00Z', source: 'website' });
  assert.equal((await approveApplication('ecreek', { now: MON })).outcome, 'onboarding');
  const m = await requestMeeting('ecreek', { start: '2026-10-06T18:00:00.000Z' }, { now: MON, gotIt: false });
  const asked = (await log()).find((x) => x.key === 'meeting_requested');
  assert.ok(asked && !asked.acknowledged, 'the owner was asked');
  assert.equal((await calendarAction({ action: 'decline', id: m.id, reason: 'Travelling that day' }, { now: new Date(MON.getTime() + 3600e3) })).meeting.status, 'declined');
  const after = (await log()).find((x) => x.key === 'meeting_requested');
  assert.deepEqual([after.acknowledged, after.acknowledgedBy, after.ackReason], [true, 'machine', 'answered in the Calendar (decline)']);
});

// ── 10. meetLink on the onboarding call ──────────────────────────────────────

test('onboardCall.meetLink: the confirmed call\'s Google Meet link, from its meeting (null when there is none)', async () => {
  const now = new Date('2026-10-03T10:00:00Z');
  await createClient('acme', { name: 'Acme', state: 'onboarding', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', onboardCallSentAt: '2026-10-02T03:30:00Z' });
  await kv.hset(K.onboardCall('acme'), { sentAt: '2026-10-02T03:30:00Z', bookedAt: '2026-10-02T14:30:00Z', bookedFor: '2026-10-06T15:00:00Z', bookedBy: 'calendar', meetingId: 'mabc123def456' });
  await kv.hset(K.meetings(), { mabc123def456: JSON.stringify({ id: 'mabc123def456', clientId: 'acme', kind: 'onboarding', status: 'confirmed', start: '2026-10-06T15:00:00Z', minutes: 30, meetLink: 'https://meet.google.com/abc-defg-hij' }) });
  assert.equal((await onboardCallFor('acme', { now })).meetLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal((await hubClient('acme', { now })).onboardCall.meetLink, 'https://meet.google.com/abc-defg-hij');
  await kv.hdel(K.onboardCall('acme'), 'meetingId');
  assert.equal((await onboardCallFor('acme', { now })).meetLink, null);
});

// ── 2. links ─────────────────────────────────────────────────────────────────

test('links: the last onboarding / approval / decision link sent, only while its token still works (before: always {})', async () => {
  await createClient('acme', { name: 'Acme', state: 'warming', contactName: 'Ann Lee', contactEmail: 'ann@acme.com' });
  const approval = await approvalUrl('acme');
  const decision = await decisionLink('acme', 'mail', 30);
  // The LAST link of a purpose is the one kept; one whose token does not exist is not shown.
  await rememberLink('acme', 'onboarding', 'https://app.test/c/first-onboarding-token-1234567890/onboard');
  await rememberLink('acme', 'onboarding', 'https://app.test/c/no-such-token-abcdefghijklmnop/onboard');
  assert.deepEqual((await hubClient('acme')).links, { approval, decision });
  const tok = await mintToken('acme', 'onboarding:a2');
  await rememberLink('acme', 'onboarding', pageUrl(tok, 'onboard'));
  assert.equal(await approvalUrl('acme'), approval, 'a re-send reuses the approval link');
  assert.deepEqual((await hubClient('acme')).links, { onboarding: pageUrl(tok, 'onboard'), approval, decision });
  // An expired token drops out.
  await kv.del(K.token('acme', 'approval'));
  assert.deepEqual((await hubClient('acme')).links, { onboarding: pageUrl(tok, 'onboard'), decision });
  assert.deepEqual(await currentLinks('nobody'), {});
  // Only the three purposes the hub shows are kept.
  assert.equal(await rememberLink('acme', 'tap:b1', 'https://app.test/c/x/tap'), false);
});

// ── 1. warm-up before it really runs ─────────────────────────────────────────

test('autobuy: while the circle is short the card says what to add and "Warm-up started" is not done (before: "warm-up has started", done)', () => {
  const rec = { domain: 'acmehq.com', expected: 2, boughtAt: 'b', domainLiveAt: 'd', inboxesActiveAt: 'i', connectedAt: 'c', warmupAt: 'w', mailboxes: [{ email: 'a@acmehq.com', connectedAt: 'c' }, { email: 'b@acmehq.com', connectedAt: 'c' }] };
  const client = { id: 'acme', state: 'warming' };
  const short = autobuyView({ client, rec, connected: true, warmup: { status: 'waiting_for_helpers', helpersNeeded: 6 } });
  assert.equal(short.status, 'done');
  assert.equal(short.label, 'acmehq.com and 2 inboxes are ready — add 6 warm-up helpers to start warm-up');
  assert.deepEqual(short.steps.find((s) => s.key === 'warmup'), { key: 'warmup', label: 'Warm-up started', done: false, at: null });
  assert.ok(short.steps.filter((s) => s.key !== 'warmup').every((s) => s.done));
  assert.equal(autobuyView({ client, rec, connected: true, warmup: { status: 'waiting_for_helpers', helpersNeeded: 1 } }).label, 'acmehq.com and 2 inboxes are ready — add 1 warm-up helper to start warm-up');
  const running = autobuyView({ client, rec, connected: true, warmup: { status: 'warming', helpersNeeded: 0 } });
  assert.equal(running.label, 'acmehq.com and 2 inboxes are ready — warm-up has started');
  assert.equal(running.steps.find((s) => s.key === 'warmup').done, true);
});

test('warm-up card: day 0 and nothing due while the circle waits for helpers (before: day 1)', async () => {
  const s = await warmupHubSettings();
  const now = new Date('2026-10-07T13:40:00Z');
  const inboxes = [{ email: 'a@acme-mail.com', passwordEnc: 'x', warmupStartedAt: '2026-10-07T13:40:00Z' }, { email: 'b@acme-mail.com', passwordEnc: 'x', warmupStartedAt: '2026-10-07T13:40:00Z' }];
  const waiting = warmupView({ client: { id: 'acme', state: 'warming' }, inboxes, now, circle: { members: 2, min: 8, missing: 6 }, s });
  assert.equal(waiting.status, 'waiting_for_helpers');
  assert.deepEqual([waiting.day, waiting.readyBy, waiting.helpersNeeded], [0, null, 6]);
  assert.deepEqual(waiting.inboxes.map((i) => [i.day, i.quota]), [[0, 0], [0, 0]]);
  const running = warmupView({ client: { id: 'acme', state: 'warming' }, inboxes, now, circle: { members: 8, min: 8, missing: 0 }, s });
  assert.equal(running.status, 'warming');
  assert.deepEqual(running.inboxes.map((i) => i.day), [1, 1]);
  assert.ok(running.inboxes.every((i) => i.quota > 0));
});

// ── 11. client emails ────────────────────────────────────────────────────────

test('client emails: the approval email greets by first name; the full name only where a name is signed', async () => {
  await createClient('acme', { name: 'Acme', state: 'warming', contactName: 'Dana Whitfield', contactEmail: 'dana@acme.com' });
  const res = await notifyClient('acme', 'approval_link', { senderName: 'Dana Whitfield', approvalUrl: 'https://app.test/c/x/approve', day1Date: 'Wednesday, October 21', silenceDate: 'Monday, October 19', ownerName: 'Limeth Sith' }, { dedupe: null });
  assert.ok(res.sent);
  assert.match(res.text, /^Hi Dana,\n/);
  assert.match(res.text, /in Dana Whitfield's name/);
  assert.doesNotMatch(res.text, /Hi Dana Whitfield/);
  // Every email of the approval round greets the same way.
  const vars = { firstName: 'Dana', contactName: 'Dana Whitfield', approvalUrl: 'u', day1Date: 'd', silenceDate: 's', day30Date: 'd30', reason: 'r', waitingLine: 'w', ownerName: 'L' };
  for (const key of ['approval_reminder', 'approval_updated', 'approved_by_silence', 'day1_moved']) assert.match(renderTemplate(key, vars).text, /^Hi Dana,/, key);
});
