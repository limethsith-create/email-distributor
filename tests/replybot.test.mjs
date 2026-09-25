// Messages + the reply bot (docs/REPLYBOT-MEET.md §1–2): one conversation per
// client (every email to their contact, every email from them), the owner's
// reply to any client, and the fixed-rule bot — each rule on real emails, the
// rule order, the calendar for proposed times (free → a request; taken → the
// nearest times), time zones, and every case where it must NOT answer. SMTP is
// the nodemailer stub below and IMAP is io.scanMailbox: nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { DEFAULTS } from '@/lib/config';
import { createClient, getClient } from '@/lib/db/client';
import { readToken } from '@/lib/pagetokens';
import { notifyClient } from '@/lib/notify';
import { stripQuotedReply } from '@/lib/mail-utils';
import { approveApplication } from '@/lib/systems/gatekeeper';
import { checkOnboardCalls, readCall, readThread, onboardCallFor } from '@/lib/systems/onboardcall';
import { getMeeting, calendarAction } from '@/lib/systems/calendar';
import { hubClient, hubBoard } from '@/lib/systems/hubview';
import { conversationFor, needsReplyFor } from '@/lib/systems/conversation';
import { classify, readTimes, fillAnswer, nearestTimes, nextDayTimes, isThanks, plain } from '@/lib/systems/replybot';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';

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
let inbox = [];
const realNow = io.now;

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; inbox = [];
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.scanMailbox = async () => ({ ok: true, messages: inbox.map((m) => ({ ...m })), uidState: { INBOX: { uidValidity: '1', lastUid: inbox.length } } });
  io.now = realNow;
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
});

const ID = 'ecreek';
const SAM = 'sam@ecreek.com';
const SUBJECT = "You're in — let's book your onboarding call";
const MON = new Date('2026-10-05T14:00:00Z');   // Mon 10:00 ET (EDT) — the acceptance email
const AT = '2026-10-05T15:00:00.000Z';          // Mon 11:00 ET — their message
const AFTER = '2026-10-05T15:05:00.000Z';       // the next check, past the 3-minute delay
const TUE_2PM_ET = '2026-10-06T18:00:00.000Z';
const TUE_2PM_CT = '2026-10-06T19:00:00.000Z';
const toSam = () => sent.filter((m) => m.to === SAM);
const alertKeys = () => alerts.map((a) => a.key);
const setting = (k, v) => kv.hset('system:config', { [k]: JSON.stringify(v) });
const check = (at) => checkOnboardCalls({ now: new Date(at), force: true });
const title = (a) => fill(`alert:${a.key}`, ALERTS[a.key].title, a.vars);

/** An approved applicant: the one accepted_call email went. → the acceptance Message-ID ('<…>'). */
async function approved({ id = ID, email = SAM, name = 'Sam Test', company = 'eCreek IT', now = MON, state = null } = {}) {
  await createClient(id, { name: company, contactName: name, contactEmail: email, mainDomain: `${id}.com`, website: `https://${id}.com`, state: 'applied', source: 'website' });
  await kv.hset(K.application(id), { review: 'pending', mainDomain: `${id}.com`, receivedAt: '2026-10-05T12:00:00Z', source: 'website', ...(state ? { web_state: state } : {}) });
  assert.equal((await approveApplication(id, { now })).outcome, 'onboarding');
  return JSON.parse((await readCall(id)).messageIds)[0];
}

let uid = 100;
/** A message from them in the ONBOARDCALL inbox, answering the acceptance email unless told otherwise. */
function mail(text, { at = AT, from = SAM, subject = `Re: ${SUBJECT}`, kind = 'human', acceptId = null, messageId = null } = {}) {
  uid++;
  const ids = acceptId ? [acceptId.replace(/^<|>$/g, '').toLowerCase()] : [];
  return {
    uid, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: messageId || `<Reply${uid}.X@mail.ecreek.com>`, from, fromName: 'Sam Test',
    to: ['onboard@aviance.test'], subject, date: new Date(at).toISOString(), inReplyTo: ids, references: ids, threadIds: ids, kind, hasIcs: false, text,
  };
}

async function messages(id, body) {
  const route = await import('@/app/api/mc/clients/[id]/messages/route');
  const res = body
    ? await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
    : await route.GET(new Request('http://x'), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

const Q = '\n\nOn Mon, Oct 5, 2026 at 10:00 AM Limeth Sith <onboard@aviance.test> wrote:\n> Good news: we would like to run your free 30-day trial.\n> How much does it cost? Not interested? Tuesday at 2pm? What do you need?';

// ── the rules (pure) ─────────────────────────────────────────────────────────

test('the rules on real emails, in the contract order; quoted history below the reply never counts', () => {
  const ctx = { now: MON, zone: 'America/New_York', canBook: true, ownPage: true, openMeeting: null, booked: false, names: ['Sam Test', 'Limeth'] };
  const rule = (text, over = {}) => classify(stripQuotedReply(text), { ...ctx, ...over }).rule;

  // not_interested — and it comes first.
  assert.equal(rule(`Hi Limeth,\n\nThanks for this, but we've changed our minds and won't go ahead.\n\nSam${Q}`), 'not_interested');
  assert.equal(rule('We are no longer interested — please cancel the trial.'), 'not_interested');
  assert.equal(rule('Please remove me from your list.'), 'not_interested');
  assert.equal(rule('STOP'), 'not_interested', '"stop" as the whole message');
  assert.equal(rule("I'm not interested in rescheduling, Tuesday at 2pm is fine"), 'not_interested', 'first rule wins');
  assert.equal(rule('Tuesday no longer works for me — could we do Wednesday at 10am instead?'), 'proposes_time', '"no longer works" is not a no');
  assert.notEqual(rule("Please don't stop — I just need a moment."), 'not_interested');

  // reschedule — before a time they propose.
  assert.equal(rule(`Something came up on my end, can we reschedule?${Q}`), 'reschedule');
  assert.equal(rule("Sorry, I can’t make it on Tuesday. Could we move the call to Thursday at 11am?"), 'reschedule', 'curly apostrophe, and before proposes_time');
  assert.equal(rule('We are in a different time zone, is 3pm Eastern on Tuesday ok?'), 'proposes_time', '"different time zone" is not a reschedule');

  // proposes_time — before wants_time ("works for me").
  assert.equal(rule(`Hi Limeth,\n\nTuesday at 2pm works for me.\n\nBest,\nSam${Q}`), 'proposes_time');
  assert.deepEqual(classify('Tuesday at 2pm works for me.', ctx).times, [TUE_2PM_ET]);
  assert.equal(rule('Tuesday at 2pm works for me.', { ownPage: false }), null, 'an outside booking link: no calendar to ask, and a readable time is no "what times"');
  assert.equal(rule('See you Tuesday at 2pm!', { openMeeting: { status: 'confirmed', start: TUE_2PM_ET }, booked: true }), null, 'the time already confirmed is no proposal');

  // wants_time — only while nothing is booked or asked for.
  assert.equal(rule(`Sounds good! What times work for you this week?${Q}`), 'wants_time');
  assert.equal(rule('Happy to jump on a call.\n\nSam Test | eCreek IT\nOffice hours Mon-Fri 9am-5pm EST'), 'wants_time', 'office hours in a signature are no proposal');
  assert.equal(rule('Sounds good, thanks!', { openMeeting: { status: 'confirmed', start: TUE_2PM_ET }, booked: true }), 'thanks', 'booked: "sounds good" is a thank-you');
  assert.equal(rule('When are you free?', { canBook: false }), null, 'the call is done: the booking rules are off');

  // price, what_needed, thanks.
  assert.equal(rule(`Before we book — how much does this cost after the trial? What's the catch?${Q}`), 'price');
  assert.equal(rule('Is it really free?'), 'price');
  assert.equal(rule("Great — let's catch up next week."), null, '"catch up" is no price question');
  assert.equal(rule('How much time do you need from me?'), null, '"how much time" is no price question');
  assert.equal(rule(`What do you need from me before the call?${Q}`), 'what_needed');
  assert.equal(rule('Anything I need to prepare?'), 'what_needed');
  assert.equal(rule(`Thanks!${Q}`), 'thanks');
  assert.equal(rule('Great, thanks Limeth\n\nSam'), 'thanks');
  assert.equal(rule('Perfect, see you then.'), 'thanks');
  assert.equal(rule('Thanks — but what is the price?'), 'price', 'price comes before thanks');
  assert.equal(rule('Thanks, will fill in the page tonight and send the logo.'), null, 'more than a thank-you');
  assert.equal(isThanks(plain('ok?'), []), false, 'a question is no thank-you');

  // no rule.
  assert.equal(rule(`Can you tell me more about how the emails are written?${Q}`), null);
  assert.equal(rule(Q.trim()), null, 'only quoted history: nothing');
});

test('reading a day and a time: the NEXT such weekday in their zone, dates, today/tomorrow, US zones, ranges; "after 2pm" is no time', () => {
  const read = (text, zone = 'America/New_York', now = MON) => readTimes(text, { now, zone }).map((x) => x.start);
  assert.deepEqual(read('Tuesday 2pm', 'America/Chicago'), [TUE_2PM_CT], 'a Central client: 2 pm their time');
  assert.deepEqual(read('Oct 7 3:30 pm ET', 'America/Los_Angeles'), ['2026-10-07T19:30:00.000Z'], 'the zone they name wins');
  assert.deepEqual(read('tomorrow 11am CST'), ['2026-10-06T16:00:00.000Z'], 'CST = Central (daylight saving now)');
  assert.deepEqual(read('10/8 at 1pm PT'), ['2026-10-08T20:00:00.000Z']);
  assert.deepEqual(read('Wednesday, October 7, 2026 at 3:00pm (Eastern Time)'), ['2026-10-07T19:00:00.000Z']);
  assert.deepEqual(read('How about 2-3pm on Thursday?'), ['2026-10-08T18:00:00.000Z'], 'a range: its start');
  assert.deepEqual(read('11-1pm Thursday'), ['2026-10-08T15:00:00.000Z'], '11 before 1 pm is the morning');
  assert.deepEqual(read('Friday at 3'), ['2026-10-09T19:00:00.000Z'], 'no am/pm: 3 in business hours is the afternoon');
  assert.deepEqual(read('Thursday 14:30'), ['2026-10-08T18:30:00.000Z']);
  assert.deepEqual(read('Tuesday at noon'), ['2026-10-06T16:00:00.000Z']);
  assert.deepEqual(read('Nov 3 at 10am ET'), ['2026-11-03T15:00:00.000Z'], 'after the clocks go back: EST');
  assert.deepEqual(read('Tuesday 2pm MT', 'America/Phoenix'), ['2026-10-06T21:00:00.000Z'], 'MT from Arizona = Arizona time (no daylight saving)');
  assert.deepEqual(read('Tuesday 2pm MT', 'America/Chicago'), ['2026-10-06T20:00:00.000Z'], 'MT elsewhere = Mountain (MDT)');
  // Today is Tuesday: "Tuesday" is next week's.
  assert.deepEqual(read('Tuesday at 2pm', 'America/New_York', new Date('2026-10-06T14:00:00Z')), ['2026-10-13T18:00:00.000Z']);
  // Two proposals, in the order written.
  assert.deepEqual(read('Tuesday at 2pm or Wednesday at 10am'), [TUE_2PM_ET, '2026-10-07T14:00:00.000Z']);
  // Not a time they propose.
  assert.deepEqual(read('Tuesday after 2pm works'), []);
  assert.deepEqual(read('any time before 11 on Friday'), []);
  assert.deepEqual(read('2pm works'), [], 'a time with no day');
  assert.deepEqual(read('Tuesday works'), [], 'a day with no time');
  assert.deepEqual(read('Office hours Mon-Fri 9am-5pm EST'), [], 'a range of days names no day');
  assert.deepEqual(read('We have 24/7 support at 3 locations'), []);
});

test('answers: slots filled, an empty {times} drops its paragraph, an unknown {slot} stops the answer; the defaults name no price', () => {
  const vars = { firstName: 'Sam', ownerName: 'Limeth Sith', bookingLink: 'https://app.test/c/t/book', times: '• Tue 6 Oct at 9:00 am ET' };
  const full = fillAnswer(DEFAULTS.REPLYBOT.answers.wants_time, vars);
  assert.match(full, /^Hi Sam,\n\nHappy to\. Pick any time that suits you here: https:\/\/app\.test\/c\/t\/book\n\nThe next open times \(your time\):\n• Tue 6 Oct at 9:00 am ET\nOr just reply with the one that suits you\.\n\nLimeth Sith$/);
  const none = fillAnswer(DEFAULTS.REPLYBOT.answers.wants_time, { ...vars, times: '' });
  assert.doesNotMatch(none, /open times|Or just reply/, 'no free times: that paragraph is left out');
  assert.match(none, /book\n\nLimeth Sith$/);
  assert.equal(fillAnswer('Hi {firstName}, the price is {price}.', vars), null, 'a slot the bot does not know: nothing is sent');
  for (const [rule, text] of Object.entries(DEFAULTS.REPLYBOT.answers)) {
    assert.match(text, /^Hi \{firstName\},\n\n/, `${rule} greets them`);
    assert.match(text, /\n\n\{ownerName\}$/, `${rule} is signed like the owner`);
    assert.doesNotMatch(text, /\$|£|€|\d+\s*(usd|dollars|per month|\/mo)/i, `${rule} names no price`);
  }
  assert.match(DEFAULTS.REPLYBOT.answers.price, /free: no card, nothing to pay\. The one thing I ask in return is an honest review/);
  // Nearest times either side, one per day for "what times".
  const open = ['2026-10-06T16:30:00.000Z', '2026-10-06T17:00:00.000Z', '2026-10-06T19:30:00.000Z', '2026-10-07T13:00:00.000Z'].map((start) => ({ start }));
  assert.deepEqual(nearestTimes(open, TUE_2PM_ET, 3), ['2026-10-06T16:30:00.000Z', '2026-10-06T17:00:00.000Z', '2026-10-06T19:30:00.000Z']);
  assert.deepEqual(nextDayTimes(open, 3), ['2026-10-06T16:30:00.000Z', '2026-10-07T13:00:00.000Z']);
});

// ── proposes_time ────────────────────────────────────────────────────────────

test('proposes_time, free: a meeting request (source reply_bot) + "works on my side", threaded, one bot_replied; no "got it", no onboard_reply', async () => {
  const acceptId = await approved();
  inbox = [mail(`Hi Limeth,\n\nTuesday at 2pm works for me.\n\nBest,\nSam${Q}`, { acceptId })];
  const r = await check(AFTER);
  assert.equal(r.newReplies, 1);
  assert.equal(r.botReplies, 1);
  const bot = toSam().slice(1);
  assert.equal(bot.length, 1, 'one email: the bot answer (the calendar sends no separate "got it")');
  const m = bot[0];
  assert.equal(m.subject, `Re: ${SUBJECT}`);
  assert.match(m.from, /<onboard@aviance\.test>$/);
  assert.equal(m.inReplyTo, inbox[0].messageId, 'In-Reply-To their message (case kept)');
  assert.equal(m.references, `${acceptId} ${inbox[0].messageId}`, 'References the whole conversation');
  assert.equal(m.text, "Hi Sam,\n\nTuesday 6 October at 2:00 pm your time works on my side — I'll confirm it shortly.\n\nLimeth Sith");
  // The request waits for the owner's yes.
  const raw = await readCall(ID);
  const meeting = await getMeeting(raw.meetingId);
  assert.deepEqual([meeting.status, meeting.start, meeting.source, meeting.kind], ['requested', TUE_2PM_ET, 'reply_bot', 'onboarding']);
  assert.match(meeting.note, /^By email: “Hi Limeth, Tuesday at 2pm works for me\.”$/);
  assert.equal(meeting.history[0].via, 'reply_bot');
  assert.deepEqual(alertKeys(), ['meeting_requested', 'bot_replied']);
  assert.match(alerts[0].body, /in an email \(the reply bot read it/);
  assert.deepEqual(alerts[1].vars, { who: 'Sam (eCreek IT)', did: 'their time Tue 6 Oct 2:00 pm ET = 11:30 pm Colombo is free — asked for it in the Calendar; say yes there' });
  assert.equal(alerts[1].url, '/#calendar');
  assert.equal(title(alerts[1]), 'Auto-replied to Sam (eCreek IT): their time Tue 6 Oct 2:00 pm ET = 11:30 pm Colombo is free — asked for it in the Calendar; say yes there');
  // The conversation: acceptance → their message (the rule read) → the bot's answer.
  const detail = await hubClient(ID, { now: new Date(AFTER) });
  const c = detail.conversation;
  assert.deepEqual(c.thread.map((t) => [t.dir, t.kind, t.auto, t.rule]), [['out', 'acceptance', false, null], ['in', 'reply', false, 'proposes_time'], ['out', 'auto_reply', true, 'proposes_time']]);
  assert.equal(c.thread[1].text, 'Hi Limeth,\n\nTuesday at 2pm works for me.', 'quoted history cut');
  assert.equal(c.needsReply, false);
  assert.deepEqual(c.bot, { enabled: true, sentToday: 1, maxPerDay: 3, everyone: true, forClient: true, answersNow: true, why: null, pending: null });
  assert.deepEqual([c.canReply, c.fromInbox, c.lastInAt, c.lastOutAt], [true, 'onboard@aviance.test', AT, AFTER]);
  assert.equal(detail.onboardCall.thread.length, 3, 'onboardCall.thread is the same list');
  assert.equal(detail.onboardCall.needsReply, false);
  assert.match(detail.onboardCall.label, /^They asked for Tue 6 Oct, 11:30 pm \(your time\) — say yes in the Calendar$/);
  assert.equal(detail.row.simple.needsReply, false);
  // A re-scan changes nothing.
  await check('2026-10-05T15:30:00Z');
  assert.equal(toSam().length, 2);
  assert.deepEqual(alertKeys(), ['meeting_requested', 'bot_replied']);
});

test('proposes_time, taken: the three nearest free times in their zone + the booking page; no request', async () => {
  const acceptId = await approved();
  await calendarAction({ action: 'block', start: TUE_2PM_ET, minutes: 60 }, { now: MON });
  inbox = [mail('Could we do Tuesday at 2pm?', { acceptId })];
  await check(AFTER);
  const m = toSam()[1];
  assert.match(m.text, /^Hi Sam,\n\nThanks — I'm afraid Tuesday 6 October at 2:00 pm your time isn't free on my side\. The nearest times I have \(your time\):\n• Tue 6 Oct at 12:30 pm ET\n• Tue 6 Oct at 1:00 pm ET\n• Tue 6 Oct at 3:30 pm ET\n\nOr pick any time that suits you here: https:\/\/app\.test\/c\/([^/\s]+)\/book\n\nLimeth Sith$/);
  const token = m.text.match(/\/c\/([^/\s]+)\/book/)[1];
  assert.equal((await readToken(token, { purpose: 'book' })).clientId, ID);
  assert.equal((await readCall(ID)).meetingId, undefined, 'nothing asked for in the Calendar');
  assert.deepEqual(alertKeys(), ['bot_replied']);
  assert.match(alerts[0].vars.did, /^Tue 6 Oct 2:00 pm ET = 11:30 pm Colombo isn't free — sent the 3 nearest free times and the booking link$/);
});

test('zones: a Central client writing "Tuesday 2pm" gets 2 pm Central; "what times" lists one time a day in their zone', async () => {
  const acceptId = await approved({ state: 'TX' });
  inbox = [mail('Tuesday 2pm is good for me', { acceptId })];
  await check(AFTER);
  const m = await getMeeting((await readCall(ID)).meetingId);
  assert.deepEqual([m.start, m.theirZone], [TUE_2PM_CT, 'America/Chicago']);
  assert.match(toSam()[1].text, /Tuesday 6 October at 2:00 pm your time works on my side/);

  __reset(); sent = []; alerts = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  const id2 = await approved({ state: 'TX' });
  inbox = [mail('Sounds good — what times work for you?', { acceptId: id2 })];
  await check(AFTER);
  const w = toSam()[1];
  assert.match(w.text, /^Hi Sam,\n\nHappy to\. Pick any time that suits you here: https:\/\/app\.test\/c\/[^/\s]+\/book\n\nThe next open times \(your time\):\n• Tue 6 Oct at 8:00 am CT\n• Wed 7 Oct at 8:00 am CT\n• Thu 8 Oct at 8:00 am CT\nOr just reply with the one that suits you\.\n\nLimeth Sith$/);
  assert.equal(alerts.at(-1).vars.did, 'sent the booking link and the next open times');
});

test('their yes by email to the time the owner suggested confirms it (the calendar sends the invite); the bot adds nothing', async () => {
  const acceptId = await approved();
  inbox = [mail('Tuesday at 2pm?', { acceptId })];
  await check(AFTER);
  const mid = (await readCall(ID)).meetingId;
  await calendarAction({ action: 'suggest', id: mid, start: '2026-10-07T14:00:00Z' }, { now: new Date('2026-10-05T16:00:00Z') });
  const before = toSam().length;
  inbox.push(mail('Wednesday at 10am works, thanks!', { at: '2026-10-05T17:00:00Z', acceptId }));
  const r = await check('2026-10-05T17:05:00Z');
  assert.equal(r.botReplies, 1);
  const m = await getMeeting(mid);
  assert.deepEqual([m.status, m.start], ['confirmed', '2026-10-07T14:00:00.000Z']);
  const after = toSam().slice(before);
  assert.equal(after.length, 1, 'only the confirmation');
  assert.match(after[0].subject, /^Confirmed: our call on Wed 7 Oct at 10:00 am ET$/);
  assert.ok(after[0].icalEvent, 'with the invite');
  assert.deepEqual(alertKeys().slice(-2), ['meeting_accepted', 'bot_replied']);
  const c = await conversationFor(ID, { now: new Date('2026-10-05T17:05:00Z') });
  assert.equal(c.needsReply, false);
  assert.equal(c.bot.sentToday, 2);
  assert.equal((await onboardCallFor(ID, { now: new Date('2026-10-05T17:05:00Z') })).status, 'booked');
});

// ── the other rules ──────────────────────────────────────────────────────────

test('reschedule: the booking page, the booked call stays; price, what_needed: fixed answers; a new subject threads as "Re: " it', async () => {
  const acceptId = await approved();
  const card = await import('@/app/api/mc/clients/[id]/onboard-call/route');
  io.now = () => new Date('2026-10-05T14:30:00Z');
  await card.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'markBooked', when: '2026-10-07T19:00:00Z' }) }), { params: { id: ID } });
  io.now = realNow;
  const booked = (await readCall(ID)).meetingId;
  inbox = [mail("Hi Limeth, something came up and I can't make it on Wednesday. Can we reschedule?", { acceptId })];
  await check(AFTER);
  assert.match(toSam()[1].text, /^Hi Sam,\n\nNo problem at all — pick any other time that suits you here:\nhttps:\/\/app\.test\/c\/[^/\s]+\/book\n\nI'll confirm the new time by email\.\n\nLimeth Sith$/);
  assert.equal((await getMeeting(booked)).status, 'confirmed', 'the booking stays until they pick');
  assert.equal(alerts.at(-1).vars.did, 'sent the booking link to pick another time');

  // price, in a new thread with its own subject.
  inbox.push(mail("What's the catch? How much does it cost after the 30 days?", { at: '2026-10-05T16:00:00Z', subject: 'Question about the trial' }));
  await check('2026-10-05T16:05:00Z');
  const p = toSam()[2];
  assert.equal(p.subject, 'Re: Question about the trial');
  assert.equal(p.inReplyTo, inbox[1].messageId);
  assert.equal(p.text, "Hi Sam,\n\nGood question — the 30-day trial is free: no card, nothing to pay. The one thing I ask in return is an honest review at the end.\n\nIf you'd like to keep going after the trial, we'll go through the plans together on the call.\n\nLimeth Sith");

  // what_needed: the onboarding page link (a fresh, valid token).
  inbox.push(mail('What do you need from me before the call?', { at: '2026-10-05T17:00:00Z', acceptId }));
  await check('2026-10-05T17:05:00Z');
  const w = toSam()[3];
  assert.match(w.text, /^Hi Sam,\n\nNothing to prepare — the call is 30 minutes and we go through who you sell to and who you'd like to reach\.\n\nIf you have a moment before it, this is the one page with your details and the agreement: https:\/\/app\.test\/c\/([^/\s]+)\/onboard\n\nLimeth Sith$/);
  assert.equal((await readToken(w.text.match(/\/c\/([^/\s]+)\/onboard/)[1], { purpose: 'onboarding' })).clientId, ID);
  const c = await conversationFor(ID, { now: new Date('2026-10-05T17:05:00Z') });
  assert.deepEqual(c.thread.filter((t) => t.auto).map((t) => t.rule), ['reschedule', 'price', 'what_needed']);
  assert.equal(c.bot.sentToday, 3);
});

test('not_interested: a polite close, the reminders stop (call stopped), the owner is told', async () => {
  const acceptId = await approved();
  inbox = [mail(`Hi Limeth, thanks but we're no longer interested.\n\nSam${Q}`, { acceptId })];
  await check(AFTER);
  assert.equal(toSam()[1].text, "Hi Sam,\n\nNo problem at all — I've closed it on my side and stopped the reminders. If anything changes, just reply to this email.\n\nThanks for letting me know.\n\nLimeth Sith");
  const oc = await onboardCallFor(ID, { now: new Date(AFTER) });
  assert.equal(oc.status, 'stopped');
  assert.deepEqual(alertKeys(), ['bot_replied']);
  assert.equal(alerts[0].vars.did, "said they're not interested — sent a polite close and stopped the reminders");
  assert.match(alerts[0].did, /Stopped the reminders to book/);
  const r = await check('2026-10-06T15:00:00Z');
  assert.equal(r.remindersSent, 0, 'no reminder the next day');
  assert.equal(toSam().length, 2);
});

test('thanks: nothing is sent, nobody is alerted, nothing waits for an answer', async () => {
  const acceptId = await approved();
  inbox = [mail(`Great, thanks Limeth!\n\nSam${Q}`, { acceptId })];
  const r = await check(AFTER);
  assert.equal(r.newReplies, 1);
  assert.equal(toSam().length, 1);
  assert.deepEqual(alertKeys(), []);
  const detail = await hubClient(ID, { now: new Date(AFTER) });
  assert.equal(detail.conversation.thread[1].rule, 'thanks');
  assert.equal(detail.conversation.needsReply, false);
  assert.equal(detail.onboardCall.needsReply, false);
  assert.equal(detail.row.simple.needsReply, false);
  assert.ok(!detail.row.todo.some((t) => /^(onboard-reply|message-reply):/.test(t.id)));
});

test('no rule: no reply, onboard_reply as before; needsReply true in the conversation AND on the board row (red), until the owner answers', async () => {
  const acceptId = await approved();
  inbox = [mail(`Can you tell me more about how the emails are written?${Q}`, { acceptId })];
  await check(AFTER);
  assert.equal(toSam().length, 1, 'nothing sent');
  assert.deepEqual(alertKeys(), ['onboard_reply']);
  assert.equal(title(alerts[0]), 'Sam Test wrote — needs your answer');
  assert.doesNotMatch(alerts[0].body, /reply bot/, 'no rule: the alert reads as before');
  let detail = await hubClient(ID, { now: new Date(AFTER) });
  assert.equal(detail.conversation.needsReply, true);
  assert.equal(detail.conversation.thread[1].rule, null);
  assert.equal(detail.row.simple.needsReply, true);
  assert.equal(detail.row.simple.needsYou, true);
  const row = (await hubBoard({ now: new Date(AFTER) })).stages.find((s) => s.key === 'onboard').clients[0];
  assert.deepEqual([row.id, row.simple.needsReply, row.simple.needsYou], [ID, true, true], 'the Trials list row: "Sam wrote — answer them"');
  // The owner answers from Messages → answered everywhere.
  io.now = () => new Date('2026-10-05T15:30:00Z');
  const res = await messages(ID, { action: 'reply', text: 'Hi Sam,\n\nHappy to — I write them with you on the call.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.conversation.needsReply, false);
  assert.deepEqual(res.body.conversation.thread.map((t) => t.kind), ['acceptance', 'reply', 'owner_reply']);
  const m = toSam()[1];
  assert.equal(m.inReplyTo, inbox[0].messageId);
  assert.equal(m.subject, `Re: ${SUBJECT}`);
  assert.match(m.text, /on the call\.\n\nLimeth Sith$/);
  detail = await hubClient(ID, { now: new Date('2026-10-05T15:30:00Z') });
  assert.equal(detail.row.simple.needsReply, false);
  assert.equal((await hubBoard({ now: new Date('2026-10-05T15:30:00Z') })).stages.find((s) => s.key === 'onboard').clients[0].simple.needsReply, false);
  assert.equal(needsReplyFor(await getClient(ID), await readCall(ID)), false);
});

// ── never answer ─────────────────────────────────────────────────────────────

test('never answers: the bot off (everyone / this client), automatic or no-reply mail, a message over 3 days old, one the owner already answered', async () => {
  // Off for everyone.
  let acceptId = await approved();
  await setting('REPLYBOT.enabled', false);
  inbox = [mail('What times work?', { acceptId })];
  await check(AFTER);
  assert.equal(toSam().length, 1);
  assert.deepEqual(alertKeys(), ['onboard_reply']);
  let c = await conversationFor(ID, { now: new Date(AFTER) });
  assert.deepEqual([c.bot.enabled, c.bot.everyone, c.bot.answersNow], [false, false, false]);
  assert.equal(c.thread[1].rule, null, 'the bot read nothing');

  // Off for this client (the Messages switch), then on again.
  const reset = async () => {
    __reset(); sent = []; alerts = []; inbox = [];
    await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
    return approved();
  };
  acceptId = await reset();
  let res = await messages(ID, { action: 'botOff' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.conversation.bot.enabled, res.body.conversation.bot.forClient, res.body.conversation.bot.everyone], [false, false, true]);
  assert.equal(res.body.conversation.bot.why, 'You turned the reply bot off for this client.');
  inbox = [mail('How much does it cost?', { acceptId })];
  await check(AFTER);
  assert.equal(toSam().length, 1);
  assert.deepEqual(alertKeys(), ['onboard_reply']);
  res = await messages(ID, { action: 'botOn' });
  assert.equal(res.body.conversation.bot.enabled, true);
  io.now = () => new Date('2026-10-05T15:20:00Z');
  await messages(ID, { action: 'reply', text: 'It is free.' });
  io.now = realNow;
  inbox.push(mail('And what do you need from me?', { at: '2026-10-05T16:00:00Z', acceptId }));
  await check('2026-10-05T16:05:00Z');
  assert.match(toSam().at(-1).text, /Nothing to prepare/, 'back on: it answers');

  // A no-reply sender answering our Message-ID, and an out-of-office.
  acceptId = await reset();
  inbox = [mail('Tuesday at 2pm', { acceptId, from: 'no-reply@ecreek.com' }), mail('I am away until Monday. Tuesday at 2pm', { at: '2026-10-05T15:01:00Z', kind: 'ooo', subject: 'Automatic reply: away' })];
  await check(AFTER);
  assert.equal(toSam().length, 1, 'no bot email to automatic mail');
  assert.deepEqual(alertKeys(), ['onboard_reply'], 'the no-reply message is the owner\'s; the out-of-office is not even a reply');
  assert.equal((await readCall(ID)).meetingId, undefined);

  // Older than 3 days when the inbox first shows it.
  acceptId = await reset();
  inbox = [mail('What times work?', { acceptId })];
  await check('2026-10-08T16:00:00Z');
  assert.equal(toSam().filter((m) => /Happy to/.test(m.text)).length, 0);
  assert.ok(alertKeys().includes('onboard_reply'));
  assert.match(alerts.find((a) => a.key === 'onboard_reply').body, /The reply bot left this one to you: the message is more than 3 days old\./);

  // The owner already answered (the inbox was read late).
  acceptId = await reset();
  io.now = () => new Date('2026-10-05T16:00:00Z');
  await messages(ID, { action: 'reply', text: 'Here are some times: Tuesday 2pm or Wednesday 10am.' });
  io.now = realNow;
  inbox = [mail('How much does it cost?', { acceptId })];
  await check('2026-10-05T17:00:00Z');
  assert.equal(toSam().length, 2, 'the acceptance and the owner\'s reply only');
  assert.match(alerts.find((a) => a.key === 'onboard_reply').body, /you answered after it was written/);
});

test('delay: answered only on a check delayMinutes after it arrived, and not at all if the owner answers meanwhile; two quick messages are the owner\'s', async () => {
  const acceptId = await approved();
  inbox = [mail('How much does it cost?', { acceptId })];
  assert.equal((await check('2026-10-05T15:01:00Z')).botReplies, undefined);
  assert.equal(toSam().length, 1, 'too soon');
  assert.deepEqual(alertKeys(), [], 'no "needs your answer": the bot has it');
  let c = await conversationFor(ID, { now: new Date('2026-10-05T15:01:00Z') });
  assert.deepEqual(c.bot.pending, { rule: 'price', messageAt: AT, answerAfter: '2026-10-05T15:03:00.000Z' });
  assert.equal(c.needsReply, true, 'not answered yet');
  await check('2026-10-05T15:02:59Z');
  assert.equal(toSam().length, 1);
  assert.equal((await check('2026-10-05T15:03:00Z')).botReplies, 1);
  assert.equal(toSam().length, 2);

  // The owner answers during the wait: the bot says nothing.
  inbox.push(mail('What do you need from me?', { at: '2026-10-05T16:00:00Z', acceptId }));
  await check('2026-10-05T16:01:00Z');
  io.now = () => new Date('2026-10-05T16:02:00Z');
  await messages(ID, { action: 'reply', text: 'Just 30 minutes of your time.' });
  io.now = realNow;
  await check('2026-10-05T16:10:00Z');
  assert.equal(toSam().length, 3, 'the owner\'s reply only');
  assert.deepEqual(alertKeys(), ['bot_replied']);
  c = await conversationFor(ID, { now: new Date('2026-10-05T16:10:00Z') });
  assert.equal(c.bot.pending, null);

  // Two messages before it answered: both are the owner's.
  inbox.push(mail('How much does it cost?', { at: '2026-10-05T17:00:00Z', acceptId }), mail('And what should I prepare?', { at: '2026-10-05T17:01:00Z', acceptId }));
  await check('2026-10-05T17:10:00Z');
  assert.equal(toSam().length, 3);
  assert.deepEqual(alertKeys(), ['bot_replied', 'onboard_reply']);
  assert.match(alerts[1].body, /they wrote again before it answered their last message, so both are yours/);
});

test('hours: outside US business hours the answer waits for 9:00 am ET on the next business day; hours "any" answers at once; maxPerDay hands over', async () => {
  const acceptId = await approved({ now: new Date('2026-10-09T14:00:00Z') });
  inbox = [mail('How much does it cost?', { acceptId, at: '2026-10-09T22:00:00Z' })]; // Fri 6 pm ET; Mon 12 Oct is a US holiday
  await check('2026-10-09T22:05:00Z');
  await check('2026-10-10T15:00:00Z');
  await check('2026-10-12T15:00:00Z');
  await check('2026-10-13T12:59:00Z');
  assert.equal(toSam().length, 1, 'the weekend, the holiday and before 9:00 ET: waiting');
  assert.deepEqual(alertKeys(), []);
  assert.equal((await check('2026-10-13T13:00:00Z')).botReplies, 1, 'Tuesday 9:00 ET');
  assert.equal(toSam().length, 2);

  // 'any': at once, at night.
  await setting('REPLYBOT.hours', 'any');
  inbox.push(mail('What do you need from me?', { acceptId, at: '2026-10-14T02:00:00Z' }));
  assert.equal((await check('2026-10-14T02:05:00Z')).botReplies, 1);

  // maxPerDay 1: the second one that day is the owner's.
  await setting('REPLYBOT.maxPerDay', 1);
  inbox.push(mail('Is it really free?', { acceptId, at: '2026-10-14T15:00:00Z' }));
  assert.equal((await check('2026-10-14T15:05:00Z')).botReplies, 1, 'a new US day');
  inbox.push(mail('What info do you need?', { acceptId, at: '2026-10-14T16:00:00Z' }));
  await check('2026-10-14T16:05:00Z');
  assert.equal(toSam().length, 4);
  assert.equal(alerts.at(-1).key, 'onboard_reply');
  assert.match(alerts.at(-1).body, /it already sent 1 email to them today/);
  assert.equal((await conversationFor(ID, { now: new Date('2026-10-14T16:05:00Z') })).bot.sentToday, 1);
});

// ── one conversation per client ──────────────────────────────────────────────

test('every email to their contact is in the conversation (system templates too); mail to another address is not', async () => {
  await approved();
  io.now = () => new Date('2026-10-05T15:00:00Z');
  await notifyClient(ID, 'setup_in_progress', { firstName: 'Sam', ownerName: 'Limeth Sith' });
  await notifyClient(ID, 'queued_position', { firstName: 'Sam', ownerName: 'Limeth Sith', position: 1, expectedLine: '' }, { to: 'boss@ecreek.com' });
  io.now = realNow;
  const t = await readThread(ID);
  assert.deepEqual(t.map((e) => [e.dir, e.kind, e.template || null]), [['out', 'acceptance', null], ['out', 'system', 'setup_in_progress']]);
  const c = await conversationFor(ID);
  assert.deepEqual(c.thread.map((e) => e.template), [null, 'setup_in_progress']);
  assert.equal(c.thread[1].subject, 'Your trial — setup has started');
  assert.equal(c.thread[1].from, 'owner@aviance.test');
  assert.equal(c.thread[1].at, '2026-10-05T15:00:00.000Z');
});

test('a client past onboarding: their reply lands in the conversation (no bot), the board row goes red, Messages answers them threaded; the endpoint\'s errors', async () => {
  await createClient('acme', { name: 'Acme IT', contactName: 'Pat Lee', contactEmail: 'pat@acme.com', mainDomain: 'acme.com', state: 'sending', createdAt: '2026-09-01T00:00:00Z' });
  io.now = () => new Date('2026-10-02T14:00:00Z');
  await notifyClient('acme', 'setup_in_progress', { firstName: 'Pat', ownerName: 'Limeth Sith' });
  io.now = realNow;
  inbox = [mail('How much does it cost to keep going after the trial?', { from: 'pat@acme.com', subject: 'Re: Your trial — setup has started' })];
  const r = await check(AFTER);
  assert.equal(r.checked, 0, 'no onboarding call');
  assert.equal(r.newReplies, 1);
  assert.equal(sent.filter((m) => m.to === 'pat@acme.com').length, 1, 'no bot answer outside onboarding');
  assert.deepEqual(alertKeys(), ['onboard_reply']);
  assert.match(alerts[0].body, /^Pat Lee \(pat@acme\.com\) from Acme IT wrote to you:/);
  const detail = await hubClient('acme', { now: new Date(AFTER) });
  const c = detail.conversation;
  assert.deepEqual(c.thread.map((e) => [e.dir, e.kind]), [['out', 'system'], ['in', 'reply']]);
  assert.equal(c.needsReply, true);
  assert.equal(c.bot.answersNow, false);
  assert.match(c.bot.why, /only answers while they are onboarding/);
  assert.equal(detail.onboardCall, null);
  assert.equal(detail.row.simple.needsReply, true);
  assert.equal(detail.row.simple.needsYou, true);
  assert.equal(detail.row.simple.next, "Answer Pat's message");
  assert.ok(detail.row.todo.some((t) => t.id === 'message-reply:acme' && t.urgent && t.action.section === 'conversation'));

  // The owner's reply: the ONBOARDCALL inbox, In-Reply-To their message, "Re: " their subject, signed.
  const bad = await messages('acme', { action: 'reply', text: '  ' });
  assert.equal(bad.status, 400);
  assert.equal((await messages('acme', { action: 'nope' })).status, 400);
  assert.equal((await messages('nobody', { action: 'botOff' })).status, 404);
  assert.equal((await messages('nobody')).status, 404);
  io.now = () => new Date('2026-10-05T16:00:00Z');
  const res = await messages('acme', { action: 'reply', text: 'Hi Pat,\n\nWe go through the plans on a short call at the end — no surprises.' });
  io.now = realNow;
  assert.equal(res.status, 200);
  const m = sent.filter((x) => x.to === 'pat@acme.com').at(-1);
  assert.match(m.from, /<onboard@aviance\.test>$/);
  assert.equal(m.subject, 'Re: Your trial — setup has started');
  assert.equal(m.inReplyTo, inbox[0].messageId);
  assert.match(m.references, new RegExp(`${inbox[0].messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.match(m.text, /no surprises\.\n\nLimeth Sith$/);
  assert.deepEqual(res.body.conversation.thread.map((e) => e.kind), ['system', 'reply', 'owner_reply']);
  assert.equal(res.body.conversation.needsReply, false);
  const again = await messages('acme');
  assert.equal(again.status, 200);
  assert.equal(again.body.conversation.lastOutAt, '2026-10-05T16:00:00.000Z');
  assert.equal((await hubClient('acme', { now: new Date('2026-10-05T16:00:00Z') })).row.simple.needsReply, false);
});

test('alerts: bot_replied is quiet and never urgent; onboard_reply says it needs an answer', () => {
  assert.deepEqual(ALERTS.bot_replied, { urgent: false, quiet: true, title: 'Auto-replied to {who}: {did}' });
  assert.equal(fill('alert:bot_replied', ALERTS.bot_replied.title, { who: 'Sam (eCreek IT)', did: 'sent the booking link' }), 'Auto-replied to Sam (eCreek IT): sent the booking link');
  assert.equal(ALERTS.onboard_reply.urgent, false);
});
