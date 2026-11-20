import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, getInquiry, setInquiryStatus, listInquiries, STATUSES, STAGE_WORDS, answersText } from '@/lib/systems/inquiries';
import { salesIo, dueSalesReminder, runSalesReminders, planLineFor } from '@/lib/systems/salescall';
import { getMeeting, calendarAction, calendarView } from '@/lib/systems/calendar';
import { hubBoard } from '@/lib/systems/hubview';
import { io } from '@/lib/systems/intake-io';
import { JOBS } from '@/lib/jobs';
import { pushIo, savePushSub } from '@/lib/push';

// What the website's "Book a call" form sends now (with the five quick questions).
const NOW = new Date('2026-11-16T08:00:00.000Z');
const site = (over = {}) => ({
  name: 'Bob Stone', email: 'bob@stoneroofing.com', company: 'Stone Roofing', website: '',
  sells: 'Commercial roofing for property managers in Texas', plan: null,
  slotStart: '2026-11-18T15:00:00.000Z', slotEnd: '2026-11-18T15:15:00.000Z', theirTz: 'America/Chicago',
  whenTheirs: 'Wednesday, November 18, 2026 at 9:00 AM CST', whenHost: 'Wednesday, November 18, 2026 at 8:30 PM',
  role: 'Founder / CEO', dealSize: '$5,000 – $25,000', channel: 'Mostly referrals', capacity: 'Around 10', timing: 'As soon as possible',
  ...over,
});
let sent = [];
let alerts = [];
let pushed = [];

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; pushed = [];
  process.env.VAPID_PUBLIC_KEY = 'BPUB'; process.env.VAPID_PRIVATE_KEY = 'priv';
  pushIo.send = async (sub, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; };
  await savePushSub({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }, 'iPhone');
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth') });
  salesIo.sender = async () => ({ email: 'calls@aviance.test' });
  salesIo.send = async (account, mail) => { sent.push({ from: account.email, ...mail }); return { success: true, messageId: `<m${sent.length}@x>` }; };
  io.alertOwner = async (key, opts) => { alerts.push({ key, ...opts }); return { sent: true }; };
  io.notifyClient = async () => ({ sent: true });
  io.now = () => NOW;
});

test('a website booking lands in the Calendar as a confirmed sales call and they get the confirmation with an invite', async () => {
  const r = await saveInquiry(site(), { now: NOW });
  assert.equal(r.ok, true);
  const q = await getInquiry(r.id);
  // The five answers are kept.
  assert.equal(q.role, 'Founder / CEO');
  assert.equal(q.capacity, 'Around 10');
  assert.equal(q.status, 'new');
  // In the Calendar, confirmed, linked both ways.
  assert.ok(q.meetingId);
  const m = await getMeeting(q.meetingId);
  assert.equal(m.kind, 'sales');
  assert.equal(m.status, 'confirmed');
  assert.equal(m.inquiryId, r.id);
  assert.equal(m.start, '2026-11-18T15:00:00.000Z');
  assert.equal(m.minutes, 15);
  assert.equal(m.title, 'Sales call — Stone Roofing');
  assert.equal(m.theirZone, 'America/Chicago');
  const view = await calendarView({ from: '2026-11-17T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z', now: NOW });
  assert.ok(view.meetings.some((x) => x.id === m.id && x.kind === 'sales'));
  // The confirmation: to them, in their zone, with the plan from "Around 10", the guarantee, and an .ics.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'bob@stoneroofing.com');
  assert.equal(sent[0].subject, 'Confirmed: our call Wed 18 Nov at 9:00 am CT');
  assert.match(sent[0].text, /Hi Bob,/);
  assert.match(sent[0].text, /Wednesday 18 November at 9:00 am Central Time/);
  assert.match(sent[0].text, /Growth is 10 booked calls a month/);
  assert.match(sent[0].text, /month one, we refund double/);
  assert.match(sent[0].text, /Limeth/);
  assert.ok(sent[0].icalEvent && /BEGIN:VCALENDAR/.test(sent[0].icalEvent.content));
  assert.ok(q.confirmationSentAt);
  // The owner's alert carries the answers and says the email went.
  assert.ok(pushed.find((x) => /New plan inquiry: Stone Roofing/.test(x.title)), 'the owner is alerted');
  assert.match(answersText(q), /Deal size: \$5,000 – \$25,000/);
  assert.match(answersText(q), /Calls a month they can take: Around 10/);
  // A double submit: no second meeting, no second email.
  assert.equal((await saveInquiry(site(), { now: NOW })).duplicate, true);
  assert.equal(sent.length, 1);
});

test('when the email cannot go, the inquiry says why and the owner is told', async () => {
  salesIo.send = async () => ({ success: false, error: 'auth failed' });
  const r = await saveInquiry(site(), { now: NOW });
  const q = await getInquiry(r.id);
  assert.ok(q.meetingId, 'still in the Calendar');
  assert.match(q.confirmationError, /auth failed/);
  assert.ok(pushed.find((x) => /New plan inquiry/.test(x.title)));
  assert.equal(q.confirmationSentAt, undefined);
});

test('reminders: the day before and an hour before, once each, only while still Booked', async () => {
  const r = await saveInquiry(site(), { now: NOW });
  const q = await getInquiry(r.id);
  let m = await getMeeting(q.meetingId);
  assert.equal(dueSalesReminder(m, NOW), null, 'nothing right after booking');
  // 23 hours before → the "tomorrow" email.
  const dayBefore = new Date(Date.parse(m.start) - 23 * 3600e3);
  assert.equal(dueSalesReminder(m, dayBefore).key, 'sales_call_tomorrow');
  let out = await runSalesReminders({ now: dayBefore });
  assert.equal(out.sent, 1);
  assert.equal(sent.at(-1).subject, 'Our call tomorrow');
  assert.equal((await runSalesReminders({ now: new Date(dayBefore.getTime() + 60e3) })).sent, 0, 'never twice');
  // 50 minutes before → "in 1 hour".
  const hourBefore = new Date(Date.parse(m.start) - 50 * 60e3);
  out = await runSalesReminders({ now: hourBefore });
  assert.equal(out.sent, 1);
  assert.equal(sent.at(-1).subject, 'Our call in 1 hour');
  m = await getMeeting(q.meetingId);
  assert.ok(m.reminders.tomorrow && m.reminders.soon);
  assert.ok((await getInquiry(r.id)).reminded_soon);
  assert.equal(sent.length, 3);
});

test('no reminders once the owner moved them on, and a booking made the same day skips the day-before one', async () => {
  const late = await saveInquiry(site({ email: 'amy@x.com', name: 'Amy', slotStart: '2026-11-16T20:00:00.000Z', slotEnd: '2026-11-16T20:15:00.000Z' }), { now: NOW });
  const lm = await getMeeting((await getInquiry(late.id)).meetingId);
  assert.equal(dueSalesReminder(lm, new Date('2026-11-16T09:00:00.000Z')), null, 'booked 12 h ahead: no "tomorrow"');
  assert.equal(dueSalesReminder(lm, new Date('2026-11-16T19:10:00.000Z')).key, 'sales_call_soon');
  await setInquiryStatus(late.id, 'lost', 'Not a fit', { now: NOW });
  const before = sent.length;
  await runSalesReminders({ now: new Date('2026-11-16T19:10:00.000Z') });
  assert.equal(sent.length, before);
});

test('stages: Calendar buttons move the inquiry, and Inquiries moves the Calendar', async () => {
  assert.deepEqual(STATUSES, ['new', 'held', 'no_show', 'contacted', 'agreement_sent', 'won', 'lost']);
  // Won needs their website (it makes them a client).
  const r = await saveInquiry(site({ website: 'stoneroofing.com' }), { now: NOW });
  const q = await getInquiry(r.id);
  await calendarAction({ action: 'held', id: q.meetingId }, { now: new Date('2026-11-18T15:20:00.000Z') });
  assert.equal((await getInquiry(r.id)).status, 'held');
  await setInquiryStatus(r.id, 'agreement_sent', 'Sent the Growth proposal', { now: NOW });
  await setInquiryStatus(r.id, 'won', '', { now: NOW });
  const done = await getInquiry(r.id);
  assert.equal(done.status, 'won');
  assert.equal((await getMeeting(q.meetingId)).status, 'held', 'the call was held (Call done before Won)');
  assert.deepEqual(done.stageHistory.map((h) => h.to), ['held', 'agreement_sent', 'won']);
  // The other way: No-show in Inquiries marks the meeting.
  const r2 = await saveInquiry(site({ email: 'cy@x.com', slotStart: '2026-11-19T15:00:00.000Z', slotEnd: '2026-11-19T15:15:00.000Z' }), { now: NOW });
  const q2 = await getInquiry(r2.id);
  await setInquiryStatus(r2.id, 'no_show', '', { now: NOW });
  assert.equal((await getMeeting(q2.meetingId)).status, 'no_show');
  const { counts } = await listInquiries();
  assert.equal(counts.won, 1);
  assert.equal(counts.no_show, 1);
});

test('moving the call in the Calendar emails the new time and restarts the reminders', async () => {
  const r = await saveInquiry(site(), { now: NOW });
  const q = await getInquiry(r.id);
  await calendarAction({ action: 'move', id: q.meetingId, start: '2026-11-19T16:00:00.000Z' }, { now: NOW });
  assert.equal(sent.at(-1).subject, 'New time: Thu 19 Nov at 10:00 am CT');
  assert.equal((await getInquiry(r.id)).slotStart, '2026-11-19T16:00:00.000Z');
});

test('the hub to-do is calm while the call is ahead and urgent once it has passed', async () => {
  const ahead = await saveInquiry(site({ slotStart: '2099-01-01T15:00:00.000Z', slotEnd: '2099-01-01T15:15:00.000Z' }), { now: NOW });
  const board = await hubBoard();
  const t = board.todos.find((x) => x.id === `inquiry:${ahead.id}`);
  assert.equal(t.urgent, false);
  assert.match(t.text, /is booked/);
});

test('plan line and the reminder job is registered', () => {
  assert.match(planLineFor({ plan: 'scale' }), /Scale is 15/);
  assert.match(planLineFor({ capacity: 'Around 5' }), /Starter is 5/);
  assert.match(planLineFor({}), /5, 10 or 15/);
  assert.ok(JOBS.some((j) => j.name === 'sales-reminders' && j.scope === 'global'));
});

test('a held confirmation goes on a later tick once the cause is fixed, and only once', async () => {
  salesIo.send = async () => ({ success: false, error: 'OWNER.signerName is not set' });
  const r = await saveInquiry(site(), { now: NOW });
  assert.equal(r.emailed, false, 'the website is told it did not go');
  // The owner fixes it; the next tick sends it.
  salesIo.send = async (account, mail) => { sent.push({ from: account.email, ...mail }); return { success: true, messageId: `<m${sent.length}@x>` }; };
  const out = await runSalesReminders({ now: NOW });
  assert.equal(out.retried, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].icalEvent, 'with the calendar invite');
  const q = await getInquiry(r.id);
  assert.ok(q.confirmationSentAt);
  assert.equal(q.confirmationError, null);
  // No second copy later.
  await kv.del(`sales:retry:${q.meetingId}`);
  assert.equal((await runSalesReminders({ now: NOW })).retried, 0);
  assert.equal(sent.length, 1);
});

test('the website is told when the confirmation did go', async () => {
  const r = await saveInquiry(site(), { now: NOW });
  assert.equal(r.emailed, true);
  assert.equal((await saveInquiry(site({ slotStart: null, slotEnd: null, email: 'x@y.com' }), { now: NOW })).emailed, null);
});

test('5 minutes before: a short "starting in 5 minutes" email, once, after the day-before and 1-hour ones', async () => {
  const r = await saveInquiry(site(), { now: NOW });
  const q = await getInquiry(r.id);
  const start = Date.parse((await getMeeting(q.meetingId)).start);
  await runSalesReminders({ now: new Date(start - 23 * 3600e3) });
  await runSalesReminders({ now: new Date(start - 50 * 60e3) });
  // 8 minutes out: the hour reminder has closed and the 5-minute one is not open yet.
  assert.equal(dueSalesReminder(await getMeeting(q.meetingId), new Date(start - 8 * 60e3)), null);
  const fiveOut = new Date(start - 5 * 60e3 + 20e3);
  const out = await runSalesReminders({ now: fiveOut });
  assert.equal(out.sent, 1);
  const mail = sent.at(-1);
  assert.equal(mail.subject, 'Starting in 5 minutes');
  assert.match(mail.text, /^Hi Bob,/);
  assert.match(mail.text, /our call starts in 5 minutes/);
  assert.match(mail.text, /reply to this email and I'll send it straight away/, 'no "I\'ll send the link before the call" five minutes out');
  assert.equal((await runSalesReminders({ now: new Date(fiveOut.getTime() + 60e3) })).sent, 0, 'never twice');
  assert.ok((await getInquiry(r.id)).reminded_now);
  assert.deepEqual(sent.map((s) => s.subject).slice(1), ['Our call tomorrow', 'Our call in 1 hour', 'Starting in 5 minutes']);
});

test('ten calls at once: each gets its own 5-minute reminder, once', async () => {
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const startAt = new Date(Date.parse('2026-11-18T15:00:00.000Z') + i * 15 * 60e3);
    const r = await saveInquiry(site({ email: `p${i}@x.com`, name: `Person${i} X`, slotStart: startAt.toISOString(), slotEnd: new Date(startAt.getTime() + 15 * 60e3).toISOString() }), { now: NOW });
    ids.push(r.id);
  }
  const confirmations = sent.length;
  // Walk the clock minute by minute through all ten calls.
  for (let t = Date.parse('2026-11-18T14:50:00.000Z'); t <= Date.parse('2026-11-18T17:30:00.000Z'); t += 60e3) await runSalesReminders({ now: new Date(t) });
  const fiveMin = sent.slice(confirmations).filter((s) => s.subject === 'Starting in 5 minutes');
  assert.equal(fiveMin.length, 10);
  assert.deepEqual(new Set(fiveMin.map((s) => s.to)).size, 10, 'one each, nobody twice');
});

test('a run every minute for the whole hour before the call: each of the three reminders goes exactly once', async () => {
  const r = await saveInquiry(site(), { now: NOW });
  const q = await getInquiry(r.id);
  const start = Date.parse((await getMeeting(q.meetingId)).start);
  const before = sent.length;
  // The job is due every minute (a new period each minute), like the heartbeat tick.
  const job = JOBS.find((j) => j.name === 'sales-reminders');
  const p1 = await job.due({ now: new Date(start - 30 * 60e3) });
  const p2 = await job.due({ now: new Date(start - 29 * 60e3) });
  assert.notEqual(p1, p2, 'a new period every minute while a call is near');
  assert.equal(await job.due({ now: new Date(start - 6 * 3600e3 + 60e3) }), await job.due({ now: new Date(start - 6 * 3600e3 + 120e3) }), 'every 15 minutes when no call is near');
  // Day-before window (opens 24 h out) through the call itself, once a minute.
  for (let t = start - 24 * 3600e3; t <= start + 5 * 60e3; t += 60e3) await runSalesReminders({ now: new Date(t) });
  const mails = sent.slice(before);
  assert.deepEqual(mails.map((s) => s.subject), ['Our call tomorrow', 'Our call in 1 hour', 'Starting in 5 minutes'], 'each once, in order');
  // And once more through the last hour on its own, every minute, nothing repeats.
  for (let t = start - 60 * 60e3; t <= start; t += 60e3) await runSalesReminders({ now: new Date(t) });
  assert.equal(sent.slice(before).length, 3);
});

test('designed emails: the confirmation and all three reminders go out branded, each with its own big button', async () => {
  const r = await saveInquiry(site({ company: 'Acme <Roofing>' }), { now: NOW });
  const q = await getInquiry(r.id);
  const start = Date.parse((await getMeeting(q.meetingId)).start);
  await runSalesReminders({ now: new Date(start - 23 * 3600e3) });
  await runSalesReminders({ now: new Date(start - 50 * 60e3) });
  await runSalesReminders({ now: new Date(start - 5 * 60e3 + 20e3) });
  const [confirmed, tomorrow, soon, now] = sent.slice(-4);
  for (const m of [confirmed, tomorrow, soon, now]) {
    assert.match(m.html, /logo-180\.png/, 'the cube logo');
    assert.match(m.html, /#E0290F/i, 'the brand red');
    assert.ok(m.text && !/</.test(m.text.slice(0, 5)), 'the plain-text part is still there');
  }
  assert.match(confirmed.html, /You’re booked\./);
  assert.match(confirmed.html, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE/, 'Add-to-calendar opens Google Calendar with the call filled in');
  assert.match(confirmed.html, /Acme &lt;Roofing&gt;/, 'their text is escaped, never raw HTML');
  assert.ok(!/Acme <Roofing>/.test(confirmed.html));
  assert.ok(confirmed.icalEvent, 'the .ics invite is still attached');
  assert.match(tomorrow.html, /See you <span[^>]*>tomorrow\./);
  assert.match(tomorrow.html, /I’ll be there/);
  assert.match(tomorrow.html, /href="mailto:[^"]+\?subject=See%20you%20tomorrow"/, 'the button replies to our inbox');
  assert.match(soon.html, />1h</);
  assert.match(now.html, />5:00</);
  // No video link yet: the join buttons ask for it by reply instead of pointing nowhere.
  assert.match(soon.html, /Send me the video link/);
  assert.match(now.html, /href="mailto:[^"]+\?subject=Video%20link%20for%20our%20call"/);
});

test('designed emails: with a video link, the reminders\' big button joins the call', async () => {
  const { designedSalesHtml, googleCalendarUrl } = await import('@/lib/templates/client/salesDesigned');
  const ctx = { firstName: 'Bob', when: 'Tuesday 24 November at 10:00 am ET', whenShort: 'Tue 24 Nov 10:00 am ET', minutes: 15, link: 'https://meet.google.com/abc-defg-hij', replyTo: 'x@y.com', start: '2026-11-24T15:00:00.000Z', end: '2026-11-24T15:15:00.000Z' };
  for (const k of ['sales_call_soon', 'sales_call_now']) {
    const h = designedSalesHtml(k, ctx);
    assert.match(h, /href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
    assert.ok(!/Send me the video link/.test(h));
  }
  assert.equal(designedSalesHtml('sales_call_moved', ctx), null, 'other emails keep the plain design');
  const u = new URL(googleCalendarUrl({ start: ctx.start, end: ctx.end, title: 'Aviance call' }));
  assert.equal(u.searchParams.get('dates'), '20261124T150000Z/20261124T151500Z');
});

test('old "proposal" / "proposal_sent" records read as agreement_sent', async () => {
  assert.equal(STAGE_WORDS.agreement_sent, 'Agreement and invoice sent');
  const r = await saveInquiry(site({ email: 'old@x.com' }), { now: NOW });
  await kv.hset('inquiries', { [r.id]: { ...(await getInquiry(r.id)), status: 'proposal_sent', stageHistory: [{ at: NOW.toISOString(), to: 'proposal' }] } });
  assert.equal((await getInquiry(r.id)).status, 'agreement_sent');
  assert.equal((await getInquiry(r.id)).stageHistory[0].to, 'agreement_sent');
  const list = await listInquiries();
  assert.equal(list.counts.agreement_sent, 1);
  const moved = await setInquiryStatus(r.id, 'proposal', '', { now: NOW });
  assert.equal(moved.status, 'agreement_sent');
});
