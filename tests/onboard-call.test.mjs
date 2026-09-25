// Onboarding call (docs/ONBOARD-CALL.md): Approve → one accepted_call email
// from one inbox, tracking (opened / replied / booked / held …), reminders,
// overdue, the owner's replies from the hub, and the simple Trials status.
// SMTP is the nodemailer stub below and IMAP is io.scanMailbox: nothing
// leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { readToken } from '@/lib/pagetokens';
import { approveApplication } from '@/lib/systems/gatekeeper';
import {
  checkOnboardCalls, onboardCallFor, onboardCallView, normaliseSettings, readCall, readThread,
  dueByFrom, nextBusinessMoment, inUsBusinessHours, withSignOff, dueReminder,
} from '@/lib/systems/onboardcall';
import { simpleFor, todosFor, hubClient, hubBoard } from '@/lib/systems/hubview';

// ── stubs ──
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
process.env.SMTP_ACCOUNT_1 = 'onboard@aviance.test:app-pw2:Limeth Sith';
process.env.PUBLIC_BASE_URL = 'https://app.test';
delete process.env.OPEN_TRACKING;
let sent = [];
nodemailer.createTransport = (opts = {}) => ({
  async sendMail(m) { sent.push({ ...m, user: opts.auth?.user }); return { messageId: m.messageId, response: '250 OK' }; },
  async verify() { return true; },
  close() {},
});
let alerts = [];
let inbox = [];      // what the next scan returns
let scans = [];      // every scan: { account, opts }
const realNow = io.now;

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; inbox = []; scans = [];
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.scanMailbox = async (account, opts) => {
    scans.push({ account, opts });
    return { ok: true, messages: inbox.map((m) => ({ ...m })), uidState: { INBOX: { uidValidity: '1', lastUid: inbox.length } } };
  };
  io.now = realNow;
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
});

const ID = 'ecreek';
const SAM = 'sam@ecreek.com';
const SUBJECT = "You're in — let's book your onboarding call";
const MON = new Date('2026-10-05T14:00:00Z'); // Mon 10:00 ET
const at = (base, hours) => new Date(base.getTime() + hours * 3600e3);
const setting = (k, v) => kv.hset('system:config', { [`ONBOARDCALL.${k}`]: JSON.stringify(v) });
const toSam = () => sent.filter((m) => m.to === SAM);
const alertKeys = () => alerts.map((a) => a.key);

/** A website application waiting for the owner's review. */
async function pending(id = ID, email = SAM) {
  await createClient(id, { name: 'eCreek IT', contactName: 'Sam Test', contactEmail: email, mainDomain: `${id}.com`, website: `https://${id}.com`, state: 'applied', source: 'website' });
  await kv.hset(K.application(id), { review: 'pending', mainDomain: `${id}.com`, receivedAt: '2026-10-05T12:00:00Z', source: 'website' });
}

async function approved({ now = MON, bookingUrl = null } = {}) {
  await setting('inbox', 'onboard@aviance.test');
  if (bookingUrl) await setting('bookingUrl', bookingUrl);
  await pending();
  const r = await approveApplication(ID, { now });
  assert.equal(r.outcome, 'onboarding');
  return (await readCall(ID)).messageIds;
}

function reply(over = {}) {
  const acceptId = over.acceptId;
  return {
    uid: 7, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<CAF=Reply1+XyZ@mail.gmail.com>',
    from: SAM, fromName: 'Sam Test', to: ['onboard@aviance.test'], subject: `Re: ${SUBJECT}`, date: '2026-10-05T16:00:00.000Z',
    inReplyTo: acceptId ? [acceptId] : [], references: acceptId ? [acceptId] : [], threadIds: acceptId ? [acceptId] : [],
    kind: 'human', hasIcs: false,
    text: 'Hi Limeth,\n\nTuesday at 3pm Eastern works for me.\n\nOn Mon, Oct 5, 2026 at 10:00 AM Limeth Sith <onboard@aviance.test> wrote:\n> Good news: we would like to run your free 30-day trial',
    ...over,
  };
}

const ICS = (uid, start, { method = 'REQUEST', attendee = SAM, status = '' } = {}) => [
  'BEGIN:VCALENDAR', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, 'SUMMARY:Onboarding call',
  ...(status ? [`STATUS:${status}`] : []),
  'ORGANIZER;CN=Limeth Sith:mailto:onboard@aviance.test', `ATTENDEE;CN=Sam Test;PARTSTAT=ACCEPTED:mailto:${attendee}`,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const invite = (over = {}) => ({
  uid: 9, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<inv-1@google.com>', from: 'calendar-notification@google.com',
  subject: 'Invitation: Onboarding call @ Wed Oct 7, 2026 3pm', date: '2026-10-05T17:00:00.000Z', threadIds: [], kind: 'auto_ack',
  hasIcs: true, ics: [ICS('evt-1@google.com', '20261007T190000Z')], text: '', ...over,
});

// ── Approve → one email ──────────────────────────────────────────────────────

test('Approve sends exactly one accepted_call email from the ONBOARDCALL inbox, tracked and threaded', async () => {
  await approved({ bookingUrl: 'https://cal.com/limeth/onboarding' });
  assert.equal(toSam().length, 1, 'one email on a yes');
  const m = toSam()[0];
  assert.equal(m.subject, SUBJECT);
  assert.match(m.from, /<onboard@aviance\.test>$/);
  assert.equal(m.user, 'onboard@aviance.test', 'sent through the onboarding inbox itself');
  assert.match(m.text, /^Hi Sam,/);
  assert.match(m.text, /free 30-day trial for eCreek IT/);
  assert.match(m.text, /30-minute onboarding call/);
  assert.match(m.text, /Book a time that suits you: https:\/\/cal\.com\/limeth\/onboarding/);
  assert.match(m.text, /https:\/\/app\.test\/c\/[^/\s]+\/onboard — one page, your details and the agreement\./);
  assert.match(m.text, /Limeth Sith$/);
  // One open pixel (own purpose), clickable links, no unsubscribe headers (a 1:1 email).
  assert.equal((m.html.match(/<img /g) || []).length, 1);
  assert.match(m.html, /\/api\/track\/open\?t=v2\./);
  assert.match(m.html, /<a href="https:\/\/cal\.com\/limeth\/onboarding">/);
  assert.ok(!m.headers['List-Unsubscribe']);
  // The onboarding page link works.
  const token = m.text.match(/\/c\/([^/\s]+)\/onboard/)[1];
  assert.equal((await readToken(token, { purpose: 'onboarding' })).clientId, ID);
  // Tracking starts.
  const raw = await readCall(ID);
  assert.equal(raw.sentAt, MON.toISOString());
  assert.deepEqual(JSON.parse(raw.messageIds), [m.messageId]);
  assert.equal(raw.fromInbox, 'onboard@aviance.test');
  assert.equal(raw.dueBy, '2026-10-08T14:00:00.000Z', '3 business days, same clock time');
  const c = await getClient(ID);
  assert.equal(c.state, 'onboarding');
  assert.equal(c.onboardCallOpen, '1');
  const oc = await onboardCallFor(ID, { now: at(MON, 1) });
  assert.equal(oc.status, 'sent');
  assert.equal(oc.label, 'Email sent — waiting for them to book');
  assert.equal(oc.fromInbox, 'onboard@aviance.test');
  assert.equal(oc.bookingUrl, 'https://cal.com/limeth/onboarding');
  assert.equal(oc.nextReminderAt, '2026-10-06T14:00:00.000Z');
  assert.deepEqual(oc.thread.map((t) => [t.dir, t.kind]), [['out', 'acceptance']]);
  assert.deepEqual(oc.steps.map((s) => [s.key, s.done]), [['sent', true], ['opened', false], ['replied', false], ['booked', false], ['held', false]]);
  // A second Approve cannot happen; a retried startOnboarding would not resend.
  await assert.rejects(() => approveApplication(ID, { now: MON }), /not waiting for a review/);
  assert.equal(toSam().length, 1);
});

test('no ONBOARDCALL.inbox → the owner sender; no booking link → the machine\'s own booking page (docs/CALENDAR.md)', async () => {
  await pending();
  await approveApplication(ID, { now: MON });
  const m = toSam()[0];
  assert.match(m.from, /<owner@aviance\.test>$/);
  const link = m.text.match(/Book a time that suits you: https:\/\/app\.test\/c\/([^/\s]+)\/book\b/);
  assert.ok(link, 'the booking page, not "reply with times"');
  assert.equal((await readToken(link[1], { purpose: 'book' })).clientId, ID);
  assert.doesNotMatch(m.text, /Reply with two or three times/);
  assert.equal((await onboardCallFor(ID, { now: MON })).bookingUrl, null);
});

test('an ONBOARDCALL.inbox the machine cannot log into: nothing is sent and the application waits for Approve again', async () => {
  await setting('inbox', 'nobody@aviance.test');
  await pending();
  await assert.rejects(() => approveApplication(ID, { now: MON }), /not an inbox the machine can log into/);
  assert.equal(sent.length, 0);
  assert.equal((await getClient(ID)).state, 'applied');
  assert.equal((await kv.hgetall(K.application(ID))).review, 'pending');
  await setting('inbox', 'onboard@aviance.test');
  assert.equal((await approveApplication(ID, { now: MON })).outcome, 'onboarding');
  assert.equal(toSam().length, 1);
});

// ── tracking ─────────────────────────────────────────────────────────────────

test('the pixel: a person opening it marks opened; a scanner does not; cold-email opens are untouched', async () => {
  // Sent ten minutes ago on the real clock: the route measures "too soon" on real time.
  const sentAt = new Date(Date.now() - 10 * 60e3);
  await approved({ now: sentAt });
  const url = new URL(toSam()[0].html.match(/src="([^"]+\/api\/track\/open[^"]+)"/)[1].replace(/&amp;/g, '&'));
  const { GET } = await import('@/app/api/track/open/route');
  const hit = (ua) => GET(new Request(`http://x/api/track/open?t=${url.searchParams.get('t')}`, { headers: { 'user-agent': ua } }));
  const scanner = await hit('Mozilla/5.0 (compatible; Barracuda scanner)');
  assert.equal(scanner.headers.get('content-type'), 'image/gif');
  assert.equal((await readCall(ID)).openedAt, undefined);
  await hit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Thunderbird/128.0');
  const raw = await readCall(ID);
  assert.ok(raw.openedAt);
  const oc = await onboardCallFor(ID, { now: new Date() });
  assert.equal(oc.status, 'opened');
  assert.equal(oc.label, 'They opened the email — waiting for them to book');
  assert.equal(await kv.hgetall('email_opens'), null, 'the cold-email open store is not touched');
});

test('a reply from the applicant → replied, in the thread, one onboard_reply alert; a re-scan adds nothing', async () => {
  const [acceptId] = JSON.parse(await approved());
  inbox = [
    { uid: 3, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<n1@news.com>', from: 'news@shop.com', subject: 'Sale', date: '2026-10-05T15:00:00Z', threadIds: [], kind: 'bulk', hasIcs: false },
    reply({ acceptId: acceptId.replace(/^<|>$/g, '').toLowerCase() }),
    reply({ uid: 8, messageId: '<ooo@ecreek.com>', subject: 'Automatic reply: away', kind: 'ooo', text: 'I am away' }),
  ];
  const r = await checkOnboardCalls({ now: at(MON, 3), force: true });
  assert.deepEqual(r, { ok: true, checked: 1, newReplies: 1, booked: 0, remindersSent: 0 });
  // The configured inbox was read, bodies only for mail that matters.
  assert.equal(scans[0].account.email, 'onboard@aviance.test');
  assert.equal(scans[0].opts.wantBody(inbox[0]), false, 'unrelated mail is not downloaded');
  assert.equal(scans[0].opts.wantBody(inbox[1]), true);
  const oc = await onboardCallFor(ID, { now: at(MON, 3) });
  assert.equal(oc.status, 'replied');
  assert.equal(oc.needsReply, true);
  assert.equal(oc.label, 'They replied — answer them below');
  assert.equal(oc.lastReplyAt, '2026-10-05T16:00:00.000Z');
  assert.equal(oc.thread.length, 2);
  assert.deepEqual([oc.thread[1].dir, oc.thread[1].kind, oc.thread[1].from], ['in', 'reply', SAM]);
  assert.equal(oc.thread[1].text, 'Hi Limeth,\n\nTuesday at 3pm Eastern works for me.', 'quoted history is cut');
  assert.deepEqual(alertKeys(), ['onboard_reply']);
  assert.equal(alerts[0].vars.person, 'Sam Test');
  assert.match(alerts[0].body, /Tuesday at 3pm Eastern works for me/);
  assert.equal(alerts[0].url, `/#trial/${ID}`);
  // The same messages again (e.g. a watermark reset) change nothing.
  const again = await checkOnboardCalls({ now: at(MON, 4), force: true });
  assert.equal(again.newReplies, 0);
  assert.equal((await readThread(ID)).length, 2);
  assert.deepEqual(alertKeys(), ['onboard_reply']);
  // The row asks the owner to answer.
  const detail = await hubClient(ID, { now: at(MON, 4) });
  assert.equal(detail.onboardCall.thread.length, 2);
  assert.equal(detail.row.simple.step, 'accepted');
  assert.equal(detail.row.simple.label, 'They replied — answer them');
  assert.equal(detail.row.simple.needsYou, true);
  assert.ok(detail.row.todo.some((t) => t.id === `onboard-reply:${ID}` && t.urgent));
});

test('a reply from another address still counts when it answers our Message-ID', async () => {
  const [acceptId] = JSON.parse(await approved());
  inbox = [reply({ from: 'ops@ecreek.com', threadIds: [acceptId.replace(/^<|>$/g, '').toLowerCase()] })];
  const r = await checkOnboardCalls({ now: at(MON, 3), force: true });
  assert.equal(r.newReplies, 1);
  assert.equal((await readThread(ID))[1].from, 'ops@ecreek.com');
});

test('a calendar invite naming the applicant → booked at the right time + onboard_booked; reminders stop; a cancel undoes it', async () => {
  await approved();
  inbox = [invite()];
  const r = await checkOnboardCalls({ now: at(MON, 4), force: true });
  assert.equal(r.booked, 1);
  let oc = await onboardCallFor(ID, { now: at(MON, 4) });
  assert.equal(oc.status, 'booked');
  assert.equal(oc.bookedFor, '2026-10-07T19:00:00.000Z');
  assert.equal(oc.bookedBy, 'calendar');
  assert.equal(oc.nextReminderAt, null);
  assert.equal(oc.label, 'Call booked for Thu 8 Oct, 12:30 am (your time)');
  assert.deepEqual(alertKeys(), ['onboard_booked']);
  assert.equal(alerts[0].vars.when, 'Thu 8 Oct, 12:30 am your time');
  assert.equal(oc.thread.at(-1).kind, 'booking');
  // The day the reminder would have gone: none to book (booked), but the day-before reminder does.
  await checkOnboardCalls({ now: at(MON, 24), force: true });
  assert.deepEqual(toSam().map((m) => m.subject), [SUBJECT, 'Our onboarding call tomorrow']);
  assert.match(toSam()[1].text, /our 30-minute onboarding call is Wednesday, October 7 at 3:00 PM EDT\./);
  await checkOnboardCalls({ now: at(MON, 25), force: true });
  assert.equal(toSam().length, 2, 'the day-before reminder goes once');
  // The same invite again is a duplicate; a cancel from the calendar undoes the booking.
  inbox = [invite(), invite({ uid: 10, messageId: '<inv-2@google.com>', date: '2026-10-06T16:00:00.000Z', ics: [ICS('evt-1@google.com', '20261007T190000Z', { method: 'CANCEL', status: 'CANCELLED' })] })];
  await checkOnboardCalls({ now: at(MON, 27), force: true });
  oc = await onboardCallFor(ID, { now: at(MON, 27) });
  assert.equal(oc.status, 'sent', 'waiting for them to book again');
  assert.equal(oc.bookedFor, null);
  assert.deepEqual(alertKeys(), ['onboard_booked', 'onboard_cancelled']);
  assert.equal(toSam().length, 2, 'no reminder three hours after the day-before email');
});

test('a booking-tool email with their address and a time in it → booked (no .ics)', async () => {
  await approved();
  inbox = [{
    uid: 4, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<cal-1@calendly.com>', from: 'notifications@calendly.com',
    subject: 'New Event: Sam Test - 30 Minute Meeting', date: '2026-10-05T18:00:00Z', threadIds: [], kind: 'auto_ack', hasIcs: false,
    text: 'Invitee: Sam Test\nInvitee Email: sam@ecreek.com\nEvent Date/Time: Wednesday, October 7, 2026 3:00pm (Eastern Time - US & Canada)',
  }];
  assert.equal((await checkOnboardCalls({ now: at(MON, 5), force: true })).booked, 1);
  const oc = await onboardCallFor(ID, { now: at(MON, 5) });
  assert.equal(oc.bookedFor, '2026-10-07T19:00:00.000Z');
  // A booking for someone else is not theirs.
  __reset();
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await approved();
  inbox = [invite({ ics: [ICS('evt-9@google.com', '20261007T190000Z', { attendee: 'other@elsewhere.com' })] })];
  assert.equal((await checkOnboardCalls({ now: at(MON, 5), force: true })).booked, 0);
});

// ── reminders + overdue ──────────────────────────────────────────────────────

test('reminders at 24 h and 72 h while not booked, in the same thread, never twice; overdue alerts once', async () => {
  await approved();
  const check = (h) => checkOnboardCalls({ now: at(MON, h), force: true });
  assert.equal((await check(23)).remindersSent, 0);
  assert.equal((await check(24)).remindersSent, 1); // Tue 10:00 ET
  assert.equal((await check(24.5)).remindersSent, 0, 'never twice');
  const r1 = toSam()[1];
  assert.equal(r1.subject, `Re: ${SUBJECT}`);
  assert.equal(r1.inReplyTo, toSam()[0].messageId, 'threads under the acceptance email');
  assert.match(r1.text, /Just checking you saw my email about your trial/);
  assert.equal((await check(48)).remindersSent, 0);
  // Thu 10:00 ET: the 72 h reminder and, past dueBy, the overdue alert.
  assert.equal((await check(72.1)).remindersSent, 1);
  assert.deepEqual(alertKeys(), ['onboard_overdue']);
  assert.equal(alerts[0].vars.person, 'Sam Test');
  let oc = await onboardCallFor(ID, { now: at(MON, 73) });
  assert.equal(oc.status, 'overdue');
  assert.equal(oc.overdue, true);
  assert.equal(oc.remindersSent, 2);
  assert.equal(oc.nextReminderAt, null);
  assert.equal((await check(120)).remindersSent, 0, 'no third reminder');
  assert.deepEqual(alertKeys(), ['onboard_overdue'], 'overdue alerts once');
  assert.equal(toSam().length, 3);
  const row = (await hubBoard({ now: at(MON, 120) })).stages.find((s) => s.key === 'onboard').clients[0];
  assert.equal(row.simple.label, 'Accepted — the call is still not booked (overdue)');
  assert.equal(row.simple.needsYou, true);
  // Booking later clears it.
  inbox = [invite({ date: '2026-10-10T16:00:00.000Z', ics: [ICS('evt-2@google.com', '20261014T190000Z')] })];
  await check(121);
  oc = await onboardCallFor(ID, { now: at(MON, 121) });
  assert.equal(oc.status, 'booked');
  assert.equal(oc.overdue, false);
});

test('reminders only in US business hours; the latest due one wins; two reminders are never an hour apart', async () => {
  const FRI = new Date('2026-10-09T14:00:00Z'); // Fri 10:00 ET; Mon 12 Oct is a US holiday
  await approved({ now: FRI });
  const check = (d) => checkOnboardCalls({ now: new Date(d), force: true });
  assert.equal((await check('2026-10-10T14:00:00Z')).remindersSent, 0, 'Saturday');
  assert.equal((await check('2026-10-12T14:00:00Z')).remindersSent, 0, 'holiday');
  assert.equal((await check('2026-10-13T12:30:00Z')).remindersSent, 0, '08:30 ET, before hours');
  assert.equal((await check('2026-10-13T13:00:00Z')).remindersSent, 1, 'Tuesday 09:00 ET');
  assert.equal((await readCall(ID)).remindersSent, 2, 'both were due: one email, the second');
  assert.equal((await check('2026-10-14T14:00:00Z')).remindersSent, 0);
  assert.equal(toSam().length, 2);

  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await approved({ now: new Date('2026-10-02T14:00:00Z') }); // Fri 10:00 ET → 24 h falls on Saturday
  assert.equal((await check('2026-10-05T13:00:00Z')).remindersSent, 1, 'Mon 09:00 ET: the first');
  assert.equal((await check('2026-10-05T14:30:00Z')).remindersSent, 0, '72 h is due, but not an hour after the first');
  assert.equal((await onboardCallFor(ID, { now: new Date('2026-10-05T14:30:00Z') })).nextReminderAt, '2026-10-06T13:00:00.000Z');
  assert.equal((await check('2026-10-06T13:00:00Z')).remindersSent, 1);
});

test('no reminder after a reply, after stopReminders, or once they are past onboarding', async () => {
  const [acceptId] = JSON.parse(await approved());
  inbox = [reply({ acceptId: acceptId.replace(/^<|>$/g, '').toLowerCase() })];
  assert.equal((await checkOnboardCalls({ now: at(MON, 24), force: true })).remindersSent, 0);
  assert.equal((await onboardCallFor(ID, { now: at(MON, 24) })).nextReminderAt, null);

  __reset(); sent = []; alerts = []; inbox = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await approved();
  const { POST } = await import('@/app/api/mc/clients/[id]/onboard-call/route');
  io.now = () => at(MON, 2);
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'stopReminders' }) }), { params: { id: ID } });
  const body = await res.json();
  assert.equal(body.onboardCall.status, 'stopped');
  assert.equal(body.onboardCall.stopped, true);
  assert.equal((await checkOnboardCalls({ now: at(MON, 80), force: true })).remindersSent, 0);
  assert.deepEqual(alertKeys(), [], 'stopped is never overdue');

  // Signed and buying: still watched for replies and bookings, but no reminder to book goes.
  const raw = { sentAt: MON.toISOString(), remindersSent: 0 };
  assert.equal(dueReminder(raw, normaliseSettings(), at(MON, 25), 'onboarding'), 0);
  assert.equal(dueReminder(raw, normaliseSettings(), at(MON, 25), 'awaiting_purchase'), null);
  await kv.hset(K.client(ID), { state: 'awaiting_purchase' });
  assert.equal((await checkOnboardCalls({ now: at(MON, 90), force: true })).checked, 1);
  await kv.hset(K.client(ID), { state: 'warming' });
  const r = await checkOnboardCalls({ now: at(MON, 91), force: true });
  assert.equal(r.checked, 0, 'past onboarding and setup: no longer watched');
  assert.equal((await getClient(ID)).onboardCallOpen, '0');
});

// ── the owner's buttons ──────────────────────────────────────────────────────

test('the owner replies from the hub: same inbox, In-Reply-To their message, References the thread, shown as out', async () => {
  const [acceptId] = JSON.parse(await approved());
  inbox = [reply({ acceptId: acceptId.replace(/^<|>$/g, '').toLowerCase() })];
  await checkOnboardCalls({ now: at(MON, 3), force: true });
  const { POST } = await import('@/app/api/mc/clients/[id]/onboard-call/route');
  const call = (body) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: { id: ID } });
  io.now = () => at(MON, 4);
  assert.equal((await call({ action: 'reply', text: '   ' })).status, 400);
  const long = await call({ action: 'reply', text: 'x'.repeat(2001) });
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /under 2,000 characters/);
  const res = await call({ action: 'reply', text: 'Hi Sam,\n\nTuesday 3pm Eastern it is — I will send an invite.' });
  assert.equal(res.status, 200);
  const { onboardCall } = await res.json();
  const m = sent.at(-1);
  assert.equal(m.to, SAM);
  assert.match(m.from, /<onboard@aviance\.test>$/);
  assert.equal(m.subject, `Re: ${SUBJECT}`);
  assert.equal(m.inReplyTo, '<CAF=Reply1+XyZ@mail.gmail.com>', 'their Message-ID, case kept');
  assert.equal(m.references, `${acceptId} <CAF=Reply1+XyZ@mail.gmail.com>`);
  assert.equal(m.text, 'Hi Sam,\n\nTuesday 3pm Eastern it is — I will send an invite.\n\nLimeth Sith');
  assert.equal((m.html.match(/<img /g) || []).length, 0, 'no pixel on a personal reply');
  assert.deepEqual(onboardCall.thread.map((t) => [t.dir, t.kind]), [['out', 'acceptance'], ['in', 'reply'], ['out', 'owner_reply']]);
  assert.equal(onboardCall.needsReply, false);
  assert.equal(onboardCall.label, 'You answered — waiting for them to book');
  // A double click sends once.
  await call({ action: 'reply', text: 'Hi Sam,\n\nTuesday 3pm Eastern it is — I will send an invite.' });
  assert.equal(sent.filter((x) => x.subject === `Re: ${SUBJECT}`).length, 1);
  assert.equal(withSignOff('Thanks!\nLimeth', 'Limeth Sith'), 'Thanks!\nLimeth', 'no second sign-off');
});

test('markBooked / markNoShow / markHeld / resend from the hub', async () => {
  const firstIds = JSON.parse(await approved());
  const { POST } = await import('@/app/api/mc/clients/[id]/onboard-call/route');
  const call = async (body) => { const r = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: { id: ID } }); return { status: r.status, body: await r.json() }; };
  io.now = () => at(MON, 5);
  assert.equal((await call({ action: 'nope' })).status, 400);
  assert.equal((await call({ action: 'markNoShow' })).status, 409, 'nothing booked yet');
  assert.equal((await call({ action: 'markBooked', when: 'next tuesday' })).status, 400);
  let r = await call({ action: 'markBooked', when: '2026-10-07T19:00:00Z' });
  assert.equal(r.status, 200);
  assert.equal(r.body.onboardCall.status, 'booked');
  assert.equal(r.body.onboardCall.bookedBy, 'owner');
  assert.equal(r.body.onboardCall.bookedFor, '2026-10-07T19:00:00.000Z');
  assert.deepEqual(alertKeys(), [], 'no alert for what the owner did himself');
  // After the call time: the row asks him to mark it.
  const after = await hubClient(ID, { now: new Date('2026-10-07T20:00:00Z') });
  assert.equal(after.row.simple.label, 'Call booked — did it happen? Mark it');
  assert.equal(after.row.simple.needsYou, true);
  assert.ok(after.row.todo.some((t) => t.id === `onboard-mark:${ID}`));
  io.now = () => new Date('2026-10-07T20:00:00Z');
  r = await call({ action: 'markNoShow' });
  assert.equal(r.body.onboardCall.status, 'no_show');
  assert.equal(r.body.onboardCall.label, "They didn't show for the call");
  r = await call({ action: 'markBooked', when: '2026-10-09T15:00:00Z' });
  assert.equal(r.body.onboardCall.status, 'booked', 'rebooked');
  io.now = () => new Date('2026-10-09T16:00:00Z');
  r = await call({ action: 'markHeld' });
  assert.equal(r.body.onboardCall.status, 'held');
  assert.equal(r.body.onboardCall.label, 'Call done');
  assert.deepEqual(r.body.onboardCall.steps.map((s) => s.done), [true, true, false, true, true]);
  assert.equal((await getClient(ID)).onboardCallOpen, '0', 'the inbox is no longer read for them');
  const row = (await hubClient(ID, { now: new Date('2026-10-09T16:00:00Z') })).row;
  assert.equal(row.simple.step, 'call_booked');
  assert.equal(row.simple.label, 'Call done — waiting for them to finish the onboarding page');
  // Resend: the email again in the same thread, with a fresh link; the first link still works.
  sent = [];
  r = await call({ action: 'resend' });
  assert.equal(r.status, 200);
  assert.equal(toSam().length, 1);
  assert.equal(toSam()[0].subject, SUBJECT);
  assert.equal(toSam()[0].inReplyTo, firstIds[0]);
  const token = toSam()[0].text.match(/\/c\/([^/\s]+)\/onboard/)[1];
  assert.equal((await readToken(token, { purpose: 'onboarding' })).clientId, ID);
  assert.equal(r.body.onboardCall.thread.filter((t) => t.kind === 'acceptance').length, 2);
  assert.equal(r.body.onboardCall.sentAt, MON.toISOString(), 'sentAt stays the first email');
  // Past onboarding there is nothing to resend.
  await kv.hset(K.client(ID), { state: 'warming' });
  assert.equal((await call({ action: 'resend' })).status, 409);
});

// ── running without the heartbeat ────────────────────────────────────────────

test('POST /api/mc/onboard-calls/check is throttled to checkEveryMinutes; the job runs only while a call is open', async () => {
  await approved();
  const { POST } = await import('@/app/api/mc/onboard-calls/check/route');
  io.now = () => at(MON, 1);
  const first = await (await POST()).json();
  assert.deepEqual(first, { ok: true, checked: 1, newReplies: 0, booked: 0, remindersSent: 0 });
  io.now = () => at(MON, 1 + 1 / 60);
  assert.equal((await (await POST()).json()).skipped, 'too soon');
  io.now = () => at(MON, 1 + 2.5 / 60);
  assert.equal((await (await POST()).json()).skipped, undefined, 'after 2 minutes it runs again');
  assert.equal(scans.length, 2);

  const { JOBS } = await import('@/lib/jobs');
  const job = JOBS.find((j) => j.name === 'onboard-calls');
  assert.equal(job.scope, 'global');
  assert.equal(await job.due({ now: at(MON, 1), clients: [{ id: 'x', state: 'sending' }] }), null);
  assert.equal(await job.due({ now: new Date('2026-10-05T15:03:00Z'), clients: [{ id: ID, state: 'onboarding', onboardCallOpen: '1' }] }), '2026-10-05T11:02');
  const ran = await job.run({ now: at(MON, 3), clients: [await getClient(ID)] });
  assert.equal(ran.checked, 1);
});

test('Approve (the route) answers first and runs the check in after()', async () => {
  await setting('inbox', 'onboard@aviance.test');
  await pending();
  globalThis.__after = [];
  const { POST } = await import('@/app/api/mc/clients/[id]/intake/route');
  io.now = () => MON;
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'approveApplication' }) }), { params: { id: ID } });
  assert.equal((await res.json()).outcome, 'onboarding');
  assert.equal(globalThis.__after.length, 1);
  assert.equal(scans.length, 0, 'not before the answer');
  const r = await globalThis.__after[0]();
  assert.equal(r.checked, 1);
  assert.equal(scans.length, 1);
});

// ── pure parts ───────────────────────────────────────────────────────────────

test('business-day and business-hour arithmetic', () => {
  assert.equal(dueByFrom(new Date('2026-10-09T14:00:00Z'), 3).toISOString(), '2026-10-15T14:00:00.000Z', 'Fri + 3 skips the weekend and Columbus Day');
  assert.equal(inUsBusinessHours(new Date('2026-10-06T13:00:00Z')), true);
  assert.equal(inUsBusinessHours(new Date('2026-10-06T21:00:00Z')), false, '17:00 ET');
  assert.equal(nextBusinessMoment(new Date('2026-10-06T22:00:00Z')).toISOString(), '2026-10-07T13:00:00.000Z');
  assert.equal(nextBusinessMoment(new Date('2026-10-10T15:00:00Z')).toISOString(), '2026-10-13T13:00:00.000Z', 'Saturday → Tuesday (Monday is a holiday)');
  const s = normaliseSettings({ bookingUrl: 'not a url', reminderHours: [72, 24], callMinutes: 0 });
  assert.equal(s.bookingUrl, null);
  assert.deepEqual(s.reminderHours, [24, 72]);
  assert.equal(s.callMinutes, 30);
});

// The simple status, one per step (pure: fixtures → data).
const NOW = new Date('2026-10-20T15:00:00Z');
const base = (over = {}) => ({ client: { id: 'acme', name: 'Acme', state: 'sending', contactName: 'Ann Lee', stateChangedAt: '2026-10-01T00:00:00Z' }, trial: {}, profile: {}, domain: {}, checks: {}, shopping: {}, inboxes: [], leads: {}, lf: {}, approval: {}, sequence: {}, counters: {}, bookings: [], hot: [], invoice: null, promises: [], pacelog: [], reports: [], runState: {}, alerts: [], now: NOW, day: 12, minMarket: 1000, onboardCall: null, ...over });
const call = (raw, state = 'onboarding') => onboardCallView({ sentAt: '2026-10-20T14:00:00Z', dueBy: '2026-10-23T14:00:00Z', contactEmail: 'ann@acme.com', ...raw }, [], { now: NOW, settings: normaliseSettings(), clientState: state });
const simple = (over) => simpleFor(base(over));

test('simple: one plain status per step, and needsYou only when the owner must act', () => {
  let s = simple({ client: { id: 'acme', name: 'Acme', state: 'applied', contactName: 'Ann Lee' }, application: { review: 'pending', receivedAt: '2026-10-20T10:00:00Z' } });
  assert.deepEqual([s.step, s.label, s.needsYou, s.since, s.person, s.company, s.dayOf30], ['new', 'New application — read it and say yes or no', true, '2026-10-20T10:00:00Z', 'Ann Lee', 'Acme', null]);

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, onboardCall: call({}) });
  assert.deepEqual([s.step, s.label, s.needsYou], ['accepted', 'Accepted — waiting for them to book the call', false]);
  assert.equal(s.next, 'Nothing for you: we remind them tomorrow');

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, onboardCall: call({ openedAt: '2026-10-20T14:30:00Z' }) });
  assert.equal(s.label, 'Accepted — waiting for them to book the call (they opened the email)');

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, onboardCall: call({ lastReplyAt: '2026-10-20T14:40:00Z' }) });
  assert.deepEqual([s.step, s.label, s.needsYou], ['accepted', 'They replied — answer them', true]);

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, onboardCall: call({ dueBy: '2026-10-20T14:30:00Z' }) });
  assert.deepEqual([s.label, s.needsYou], ['Accepted — the call is still not booked (overdue)', true]);

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, onboardCall: call({ bookedAt: '2026-10-20T14:50:00Z', bookedFor: '2026-10-22T19:00:00Z' }) });
  assert.deepEqual([s.step, s.label, s.needsYou], ['call_booked', 'Call booked for Fri 23 Oct, 12:30 am your time', false]);
  assert.equal(s.next, 'Nothing for you until the call (on Fri 23 Oct)');

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, onboardCall: call({ bookedAt: '2026-10-19T14:50:00Z', bookedFor: '2026-10-20T13:00:00Z' }) });
  assert.deepEqual([s.label, s.needsYou], ['Call booked — did it happen? Mark it', true]);

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'onboarding' }, trial: { onboardingSentAt: '2026-10-19T00:00:00Z' } });
  assert.deepEqual([s.step, s.label], ['accepted', 'Accepted — waiting for them to fill in the onboarding page'], 'accepted before this feature: no onboarding call');

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'awaiting_purchase' }, shopping: { sentAt: '2026-10-20T14:00:00Z', chosenDomain: 'acme-team.com' } });
  assert.deepEqual([s.step, s.needsYou], ['setting_up', true]);
  assert.equal(s.next, 'Buy acme-team.com and 2 inboxes, then paste the logins');
  s = simple({ client: { id: 'acme', name: 'Acme', state: 'setup_check' } });
  assert.deepEqual([s.step, s.label, s.needsYou], ['setting_up', 'Setting up their emails — checking the new domain', false]);

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'warming' }, trial: { day1Date: '2026-10-26' } });
  assert.deepEqual([s.step, s.label, s.needsYou], ['warming_up', 'Warming up their inboxes — first emails on Monday 26 October', false]);

  s = simple({ counters: { booked: 2 } });
  assert.deepEqual([s.step, s.label, s.dayOf30, s.needsYou], ['sending', 'Sending — day 12 of 30, 2 calls booked', 12, false]);
  assert.equal(simple({ counters: {} }).label, 'Sending — day 12 of 30', 'a missing counter is left out, never 0');

  s = simple({ client: { id: 'acme', name: 'Acme', state: 'converted', paidAt: '2026-10-19T00:00:00Z' } });
  assert.deepEqual([s.step, s.label], ['finished', 'Finished — became a client']);
  s = simple({ client: { id: 'acme', name: 'Acme', state: 'declined' } });
  assert.deepEqual([s.step, s.label, s.needsYou], ['declined', 'Declined', false]);
  s = simple({ client: { id: 'acme', name: 'Acme', state: 'queued', queueExpectedDate: '2026-11-26' } });
  assert.deepEqual([s.step, s.label, s.needsYou], ['queued', 'In the queue — waiting for a free trial slot', false]);
  assert.equal(s.next, 'Nothing for you: they start when a slot opens (about Thursday 26 November)');

  // Anything the to-do list marks urgent turns the dot on (a legal hold while sending).
  const ctx = base({ client: { id: 'acme', name: 'Acme', state: 'sending', legalHoldAt: '2026-10-19T00:00:00Z' } });
  assert.equal(simpleFor(ctx, todosFor(ctx)).needsYou, true);
});
