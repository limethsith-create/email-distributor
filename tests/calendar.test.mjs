// The Calendar (docs/CALENDAR.md): open slots, time zones (US daylight saving,
// Sri Lanka none), the booking page, the owner's buttons, the emails with
// .ics invites, and the onboarding call kept in step. SMTP is the nodemailer
// stub below and IMAP is io.scanMailbox: nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { readToken } from '@/lib/pagetokens';
import { approveApplication, runOnboardingNudge } from '@/lib/systems/gatekeeper';
import { checkOnboardCalls, onboardCallFor, readCall, onboardPageClock } from '@/lib/systems/onboardcall';
import { hubClient } from '@/lib/systems/hubview';
import { parseIcs } from '@/lib/systems/bookings';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import {
  openSlots, normaliseCalendar, usAndOwner, theirWhen, slotLabel, zoneForState, applicantZone,
  buildIcs, calendarView, getMeeting, BOOK_TRIES_PER_HOUR,
} from '@/lib/systems/calendar';

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
const MON = new Date('2026-10-05T14:00:00Z'); // Mon 10:00 ET (EDT) = 7:30 pm Colombo
const TUE_2PM = '2026-10-06T18:00:00.000Z';   // Tue 2:00 pm EDT = 11:30 pm Colombo
const WED_10AM = '2026-10-07T14:00:00.000Z';  // Wed 10:00 am EDT = 7:30 pm Colombo
const at = (base, hours) => new Date(base.getTime() + hours * 3600e3);
const to = (email) => sent.filter((m) => m.to === email);
const toSam = () => to(SAM);
const alertKeys = () => alerts.map((a) => a.key);
const title = (a) => fill(`alert:${a.key}`, ALERTS[a.key].title, a.vars);
const setCal = (k, v) => kv.hset('system:config', { [`CALENDAR.${k}`]: JSON.stringify(v) });

/** An approved applicant (the one accepted_call email went); returns their booking-page token. */
async function approved({ id = ID, email = SAM, name = 'Sam Test', company = 'eCreek IT', now = MON, state = null } = {}) {
  await createClient(id, { name: company, contactName: name, contactEmail: email, mainDomain: `${id}.com`, website: `https://${id}.com`, state: 'applied', source: 'website' });
  await kv.hset(K.application(id), { review: 'pending', mainDomain: `${id}.com`, receivedAt: '2026-10-05T12:00:00Z', source: 'website', ...(state ? { web_state: state } : {}) });
  assert.equal((await approveApplication(id, { now })).outcome, 'onboarding');
  const mail = to(email)[0];
  const m = mail.text.match(/Book a time that suits you: https:\/\/app\.test\/c\/([^/\s]+)\/book/);
  assert.ok(m, 'the acceptance email links the booking page');
  return m[1];
}

async function ask(token, start, { note = '', form = false, tz = null } = {}) {
  const { POST } = await import('@/app/api/c/book/route');
  const req = form
    ? new Request('https://app.test/api/c/book', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, start, note, ...(tz ? { tz } : {}) }).toString() })
    : new Request('https://app.test/api/c/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, start, note, ...(tz ? { tz } : {}) }) });
  const res = await POST(req);
  return { status: res.status, headers: res.headers, body: form ? null : await res.json() };
}

async function hub(body) {
  const { POST } = await import('@/app/api/mc/calendar/route');
  const res = await POST(new Request('https://app.test/api/mc/calendar', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

async function page(token, qs = '') {
  const { GET } = await import('@/app/c/[token]/book/route');
  const res = await GET(new Request(`https://app.test/c/${token}/book${qs}`), { params: Promise.resolve({ token }) });
  return { status: res.status, type: res.headers.get('content-type'), html: await res.text() };
}

async function card(id, body) {
  const { POST } = await import('@/app/api/mc/clients/[id]/onboard-call/route');
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: { id } });
  return { status: res.status, body: await res.json() };
}

const icsOf = (m) => { assert.ok(m.icalEvent, 'an .ics goes with it'); return { raw: m.icalEvent.content, method: m.icalEvent.method, ev: parseIcs(m.icalEvent.content)[0] }; };

// ── open slots (pure) ────────────────────────────────────────────────────────

test('open slots: US-Eastern call hours, weekdays only, US holidays closed, notice, buffer, maxPerDay; a meeting takes its slot', () => {
  const s = normaliseCalendar({});
  const FRI = new Date('2026-10-09T12:00:00Z'); // Fri 08:00 ET; Mon 12 Oct is Columbus Day
  const slots = openSlots({ settings: s, now: FRI, from: FRI, to: at(FRI, 24 * 7) });
  const days = [...new Set(slots.map((x) => x.start.slice(0, 10)))];
  assert.deepEqual(days, ['2026-10-13', '2026-10-14', '2026-10-15'], 'Friday is inside the 12 h notice; the weekend and the holiday are closed');
  const tue = slots.filter((x) => x.start.startsWith('2026-10-13'));
  assert.equal(tue.length, 16, '09:00 … 16:30 ET, every 30 minutes, the call ends by 17:00');
  assert.equal(tue[0].start, '2026-10-13T13:00:00.000Z');
  assert.equal(tue.at(-1).start, '2026-10-13T20:30:00.000Z');
  assert.equal(tue[0].minutes, 30);

  // Notice: at 08:00 ET on Tuesday the first time offered is Wednesday 09:00 (12 h); with no notice, Tuesday 09:00.
  const TUE8 = new Date('2026-10-13T12:00:00Z');
  assert.equal(openSlots({ settings: s, now: TUE8, from: TUE8, to: at(TUE8, 48) })[0].start, '2026-10-14T13:00:00.000Z');
  assert.equal(openSlots({ settings: s, now: TUE8, from: TUE8, to: at(TUE8, 48), noticeHours: 0 })[0].start, '2026-10-13T13:00:00.000Z');

  // A confirmed 10:00–10:30 ET call keeps 15 minutes free after it — and after the one before it.
  const call = { id: 'm1', status: 'confirmed', start: '2026-10-13T14:00:00.000Z', minutes: 30 };
  const around = (meetings, settings = s) => openSlots({ settings, meetings, now: TUE8, from: TUE8, to: at(TUE8, 12), noticeHours: 0 }).map((x) => x.start.slice(11, 16));
  assert.deepEqual(around([call]).slice(0, 3), ['13:00', '15:00', '15:30'], '09:30, 10:00 and 10:30 ET are gone; 11:00 is open');
  assert.deepEqual(around([call], normaliseCalendar({ bufferMinutes: 0 })).slice(0, 3), ['13:00', '13:30', '14:30'], 'no buffer: only the call itself');
  // Requested and blocked times are busy too; declined and cancelled ones are not.
  assert.ok(!around([{ ...call, status: 'requested' }]).includes('14:00'));
  assert.ok(around([{ ...call, status: 'declined' }]).includes('14:00'));
  assert.ok(around([{ ...call, status: 'cancelled' }]).includes('14:00'));
  const busy = { id: 'b1', status: 'blocked', start: '2026-10-13T16:00:00.000Z', minutes: 120 }; // 12:00–14:00 ET
  const withBlock = around([busy]);
  for (const hh of ['15:30', '16:00', '17:30', '18:00']) assert.ok(!withBlock.includes(hh), hh);
  assert.ok(withBlock.includes('15:00') && withBlock.includes('18:30'));
  // A request with the owner's suggestion holds the suggested time, not the one they asked for.
  const suggested = { ...call, status: 'requested', proposed: '2026-10-13T19:00:00.000Z' };
  assert.ok(around([suggested]).includes('14:00'));
  assert.ok(!around([suggested]).includes('19:00'));
  // maxPerDay: a full day offers nothing; busy blocks do not count toward it.
  const two = [call, { id: 'm2', status: 'requested', start: '2026-10-13T18:00:00.000Z', minutes: 30 }];
  assert.equal(around(two, normaliseCalendar({ maxPerDay: 2 })).length, 0);
  assert.ok(around([busy, { ...busy, id: 'b2', start: '2026-10-13T19:00:00.000Z', minutes: 30 }], normaliseCalendar({ maxPerDay: 2 })).length > 0);
  // Its own meeting is ignored when they pick again.
  assert.ok(openSlots({ settings: s, meetings: [call], now: TUE8, from: TUE8, to: at(TUE8, 12), noticeHours: 0, exceptId: 'm1' }).some((x) => x.start === call.start));
  // A start every 15 minutes, the 30-minute call still ends by 17:00.
  const q = openSlots({ settings: normaliseCalendar({ slotMinutes: 15 }), now: TUE8, from: TUE8, to: at(TUE8, 12), noticeHours: 0 });
  assert.equal(q.length, 31, "09:00 … 16:30 every 15 minutes");
  assert.equal(q[1].start, '2026-10-13T13:15:00.000Z');
  // Broken settings fall back to the defaults (never "no calls").
  assert.deepEqual(normaliseCalendar({ hours: ['17:00', '09:00'], days: [], slotMinutes: 0, meetingLink: 'not a link' }).hours, ['09:00', '17:00']);
  assert.equal(normaliseCalendar({ meetingLink: 'http://localhost/x' }).meetingLink, null);
});

test('time zones: US daylight saving moves the Sri Lanka hours, Sri Lanka has none; the Colombo midnight crossover', () => {
  const s = normaliseCalendar({});
  // The same 09:00 Eastern is 13:00 UTC in summer time and 14:00 UTC after 1 Nov 2026.
  const firstOn = (day) => openSlots({ settings: s, now: new Date(`${day}T00:00:00Z`), from: new Date(`${day}T00:00:00Z`), to: new Date(`${day}T23:59:00Z`), noticeHours: 0 })[0].start;
  assert.equal(firstOn('2026-10-30'), '2026-10-30T13:00:00.000Z');
  assert.equal(firstOn('2026-11-02'), '2026-11-02T14:00:00.000Z');
  assert.equal(usAndOwner(Date.parse('2026-10-30T13:00:00Z'), s), 'Fri 30 Oct 9:00 am ET = 6:30 pm Colombo');
  assert.equal(usAndOwner(Date.parse('2026-11-02T14:00:00Z'), s), 'Mon 2 Nov 9:00 am ET = 7:30 pm Colombo');
  // Colombo passes midnight at 2:30 pm Eastern in summer, 1:30 pm in winter: the Sri Lanka day is written out.
  assert.equal(usAndOwner(Date.parse('2026-10-07T18:00:00Z'), s), 'Wed 7 Oct 2:00 pm ET = 11:30 pm Colombo');
  assert.equal(usAndOwner(Date.parse('2026-10-07T18:30:00Z'), s), 'Wed 7 Oct 2:30 pm ET = Thu 8 Oct 12:00 am Colombo');
  assert.equal(usAndOwner(Date.parse('2026-11-04T18:30:00Z'), s), 'Wed 4 Nov 1:30 pm ET = Thu 5 Nov 12:00 am Colombo');
  assert.equal(usAndOwner(Date.parse('2026-11-04T21:30:00Z'), s), 'Wed 4 Nov 4:30 pm ET = Thu 5 Nov 3:00 am Colombo');
  // Their own zone first, Eastern beside it; Arizona keeps standard time all year.
  assert.equal(theirWhen(Date.parse('2026-10-07T18:00:00Z'), 'America/New_York', s), 'Wednesday 7 October at 2:00 pm Eastern Time');
  assert.equal(theirWhen(Date.parse('2026-10-07T18:00:00Z'), 'America/Chicago', s), 'Wednesday 7 October at 1:00 pm Central Time (2:00 pm Eastern)');
  assert.equal(theirWhen(Date.parse('2026-10-07T18:00:00Z'), 'America/Denver', s), 'Wednesday 7 October at 12:00 pm Mountain Time (2:00 pm Eastern)');
  assert.equal(theirWhen(Date.parse('2026-10-07T18:00:00Z'), 'America/Phoenix', s), 'Wednesday 7 October at 11:00 am Arizona Time (2:00 pm Eastern)');
  assert.equal(theirWhen(Date.parse('2026-11-04T19:00:00Z'), 'America/Phoenix', s), 'Wednesday 4 November at 12:00 pm Arizona Time (2:00 pm Eastern)');
  assert.equal(theirWhen(Date.parse('2026-11-04T19:00:00Z'), 'America/Denver', s), 'Wednesday 4 November at 12:00 pm Mountain Time (2:00 pm Eastern)');
  assert.equal(theirWhen(Date.parse('2026-10-07T13:00:00Z'), 'Pacific/Honolulu', s), 'Wednesday 7 October at 3:00 am Hawaii Time (9:00 am Eastern)');
  assert.equal(theirWhen(Date.parse('2026-10-08T03:30:00Z'), 'America/Los_Angeles', s), 'Wednesday 7 October at 8:30 pm Pacific Time (11:30 pm Eastern)');
  assert.equal(theirWhen(Date.parse('2026-10-08T04:30:00Z'), 'America/Los_Angeles', s), 'Wednesday 7 October at 9:30 pm Pacific Time (Thu 8 Oct 12:30 am Eastern)', 'the Eastern day is written out when it is another day');
  assert.equal(slotLabel(Date.parse('2026-10-07T18:00:00Z'), 'America/New_York'), 'Wed 7 Oct · 2:00 pm');
  assert.equal(slotLabel(Date.parse('2026-10-07T12:00:00Z'), 'America/Los_Angeles'), 'Wed 7 Oct · 5:00 am');
  // Their zone comes from their state.
  assert.equal(zoneForState('TX'), 'America/Chicago');
  assert.equal(zoneForState('Texas'), 'America/Chicago');
  assert.equal(zoneForState('AZ'), 'America/Phoenix');
  assert.equal(zoneForState('HI'), 'Pacific/Honolulu');
  assert.equal(zoneForState('NY'), 'America/New_York');
  assert.equal(zoneForState('XX'), null);
  assert.equal(applicantZone({ application: { web_state: 'WA' } }), 'America/Los_Angeles');
  assert.equal(applicantZone({ application: { web_city: 'Austin, TX' } }), 'America/Chicago');
  assert.equal(applicantZone({ profile: { postalAddress: '1 Main St, Denver, CO 80202' } }), 'America/Denver');
  assert.equal(applicantZone({}), 'America/New_York');
});

test('.ics: UTC start and end, the meeting id as UID, organizer and attendee, folded lines, CANCEL', () => {
  const ics = buildIcs({ uid: 'mabc123456', sequence: 2, start: '2026-10-06T18:00:00.000Z', minutes: 30, title: 'Onboarding call — eCreek IT, Inc; the long title that needs folding because it is far longer than seventy-five octets', description: 'Line one\nLine two', organizer: { email: 'onboard@aviance.test', name: 'Limeth Sith' }, attendee: { email: SAM, name: 'Sam Test' }, now: MON });
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'every line folded at 75 octets');
  assert.match(ics, /\r\nMETHOD:REQUEST\r\n/);
  assert.match(ics, /\r\nDTSTART:20261006T180000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20261006T183000Z\r\n/);
  assert.match(ics, /\r\nSEQUENCE:2\r\n/);
  const [ev] = parseIcs(ics);
  assert.equal(ev.uid, 'mabc123456');
  assert.equal(ev.method, 'REQUEST');
  assert.equal(ev.start.toISOString(), '2026-10-06T18:00:00.000Z');
  assert.equal(ev.end.toISOString(), '2026-10-06T18:30:00.000Z');
  assert.equal(ev.organizer.email, 'onboard@aviance.test');
  assert.equal(ev.attendees[0].email, SAM);
  assert.equal(ev.summary, 'Onboarding call — eCreek IT, Inc; the long title that needs folding because it is far longer than seventy-five octets'.replace(/;/g, '\\;'));
  const cancel = buildIcs({ method: 'CANCEL', uid: 'mabc123456', sequence: 3, start: '2026-10-06T18:00:00.000Z', minutes: 30, title: 'x', organizer: { email: 'o@a.test' }, attendee: { email: SAM }, now: MON });
  assert.match(cancel, /METHOD:CANCEL/);
  assert.match(cancel, /STATUS:CANCELLED/);
  assert.equal(parseIcs(cancel)[0].method, 'CANCEL');
});

// ── the acceptance email → the booking page ──────────────────────────────────

test('the acceptance email and its reminders link the machine\'s own booking page; "reply with times" only when it cannot be made', async () => {
  const token = await approved();
  assert.equal((await readToken(token, { purpose: 'book' })).clientId, ID);
  assert.doesNotMatch(toSam()[0].text, /Reply with two or three times/);
  // The 24 h reminder carries a fresh booking-page link (the first one keeps working).
  await checkOnboardCalls({ now: at(MON, 24), force: true });
  const r = toSam()[1].text.match(/Book a time that suits you: https:\/\/app\.test\/c\/([^/\s]+)\/book/);
  assert.ok(r && r[1] !== token);
  assert.equal((await readToken(r[1], { purpose: 'book' })).clientId, ID);
  assert.equal((await readToken(token, { purpose: 'book' })).clientId, ID);
  // The owner's own booking link still wins when set.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.bookingUrl': JSON.stringify('https://cal.com/limeth/onboarding') });
  await createClient('acme', { name: 'Acme', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com', state: 'applied' });
  await kv.hset(K.application('acme'), { review: 'pending', mainDomain: 'acme.com' });
  await approveApplication('acme', { now: MON });
  assert.match(to('ann@acme.com')[0].text, /Book a time that suits you: https:\/\/cal\.com\/limeth\/onboarding/);
  // The page cannot be made (its link cannot be stored): the email asks for times instead of failing.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const real = kv.pipeline;
  kv.pipeline = () => {
    const inner = real();
    const keys = [];
    const wrap = new Proxy({}, { get(_t, name) {
      if (name === 'exec') return async () => { if (keys.some((k) => String(k).includes(':token:book'))) throw new Error('KV down'); return inner.exec(); };
      return (...a) => { keys.push(a[0]); inner[name](...a); return wrap; };
    } });
    return wrap;
  };
  try {
    await createClient('beta', { name: 'Beta', contactName: 'Bo Chen', contactEmail: 'bo@beta.io', mainDomain: 'beta.io', state: 'applied' });
    await kv.hset(K.application('beta'), { review: 'pending', mainDomain: 'beta.io' });
    await approveApplication('beta', { now: MON });
  } finally { kv.pipeline = real; }
  assert.match(to('bo@beta.io')[0].text, /Reply with two or three times that suit you and I'll confirm one\./);
});

// ── asking for a time ────────────────────────────────────────────────────────

test('asking for a time: the slot is held, the owner gets meeting_requested, they get "got it" in the same thread; the trial says "say yes in the Calendar"', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { GET } = await import('@/app/api/c/book/slots/route');
  const slots = await (await GET(new Request(`https://app.test/api/c/book/slots?token=${token}`))).json();
  assert.equal(slots.zone, 'America/New_York');
  assert.equal(slots.slots[0].start, '2026-10-06T13:00:00.000Z', '12 h notice: Tuesday 09:00 ET first');
  assert.equal(slots.slots[0].label, 'Tue 6 Oct · 9:00 am');
  assert.equal(slots.existing, null);

  const r = await ask(token, TUE_2PM, { note: 'Looking forward to it' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual([r.body.meeting.status, r.body.meeting.label, r.body.meeting.start], ['requested', 'Tue 6 Oct · 2:00 pm', TUE_2PM]);
  const m = await getMeeting(r.body.meeting.id);
  assert.deepEqual([m.clientId, m.company, m.person, m.email, m.kind, m.source, m.minutes, m.theirZone, m.note], [ID, 'eCreek IT', 'Sam Test', SAM, 'onboarding', 'booking_page', 30, 'America/New_York', 'Looking forward to it']);
  assert.equal(m.title, 'Onboarding call — eCreek IT');
  assert.deepEqual(m.history.map((h) => [h.what, h.by]), [['requested', 'them']]);

  // The owner: one alert, in his words.
  assert.deepEqual(alertKeys(), ['meeting_requested']);
  assert.equal(title(alerts[0]), 'Sam (eCreek IT) asked for Tue 6 Oct 2:00 pm ET = 11:30 pm Colombo — say yes in the Calendar');
  assert.match(alerts[0].body, /Their note: “Looking forward to it”/);
  assert.equal(alerts[0].url, '/#calendar');
  // Them: "got it", threaded under the acceptance email.
  const got = toSam().at(-1);
  assert.equal(got.subject, `Re: ${SUBJECT}`);
  assert.equal(got.inReplyTo, toSam()[0].messageId);
  assert.match(got.text, /^Hi Sam,\n\nGot it — you asked for Tuesday 6 October at 2:00 pm Eastern Time\. I'll confirm shortly\.\n\nIf you'd rather change it, pick another time here: https:\/\/app\.test\/c\/[^/\s]+\/book\n\nLimeth Sith$/);
  assert.match(got.from, /<onboard@aviance\.test>$/);
  assert.ok(!got.icalEvent, 'no invite before the owner says yes');

  // The trial: "they asked for … — say yes in the Calendar", a red dot and a to-do.
  const oc = await onboardCallFor(ID, { now: at(MON, 1) });
  assert.equal(oc.label, 'They asked for Tue 6 Oct, 11:30 pm (your time) — say yes in the Calendar');
  assert.equal(oc.requestedFor, TUE_2PM);
  assert.equal(oc.meetingId, m.id);
  assert.deepEqual([oc.thread.at(-1).dir, oc.thread.at(-1).kind], ['out', 'booking']);
  const detail = await hubClient(ID, { now: at(MON, 1) });
  assert.equal(detail.row.simple.label, 'They asked for Tue 6 Oct, 11:30 pm your time — say yes in the Calendar');
  assert.equal(detail.row.simple.needsYou, true);
  const todo = detail.row.todo.find((t) => t.id === `meeting-request:${ID}`);
  assert.ok(todo && todo.urgent);
  assert.deepEqual(todo.action, { type: 'view', view: 'calendar', clientId: ID, meetingId: m.id });

  // They did their part: no "did you see my email" reminder, never overdue while it waits.
  assert.equal((await checkOnboardCalls({ now: at(MON, 24), force: true })).remindersSent, 0);
  await checkOnboardCalls({ now: at(MON, 80), force: true });
  assert.deepEqual(alertKeys(), ['meeting_requested'], 'no onboard_overdue');
  // The hub's list of requests waiting for a yes.
  const view = await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 1) });
  assert.deepEqual(view.requests.map((x) => x.id), [m.id]);
  assert.deepEqual(view.requests[0].labels, { owner: 'Tue 6 Oct, 11:30 pm', eastern: 'Tue 6 Oct, 2:00 pm ET', theirs: 'Tue 6 Oct, 2:00 pm ET', proposed: null });
  assert.ok(!view.free.some((x) => x.start === TUE_2PM), 'their time is taken');
});

test('Yes: the confirmation has the time in their zone and a valid .ics in UTC; the onboarding call is booked', async () => {
  const token = await approved({ state: 'CO' });
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  io.now = () => at(MON, 2);
  const r = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.meeting.status, 'confirmed');
  assert.equal(r.body.meeting.labels.theirs, 'Tue 6 Oct, 12:00 pm MT');
  const mail = toSam().at(-1);
  assert.equal(mail.subject, 'Confirmed: our call on Tue 6 Oct at 12:00 pm MT');
  assert.equal(mail.text, `Hi Sam,\n\nConfirmed: our 30-minute call is Tuesday 6 October at 12:00 pm Mountain Time (2:00 pm Eastern).\n\nI'll send the link before the call.\n\nI've attached a calendar invite. If the time stops working, pick another here: ${mail.text.match(/https:\/\/app\.test\/c\/[^/\s]+\/book/)[0]}\n\nLimeth Sith`);
  assert.equal(mail.inReplyTo, toSam().at(-2).messageId, 'still in the onboarding conversation (answers the last email in it)');
  assert.ok(mail.references.split(' ').includes(toSam()[0].messageId));
  const { raw, method, ev } = icsOf(mail);
  assert.equal(method, 'REQUEST');
  assert.match(raw, /\r\nDTSTART:20261006T180000Z\r\n/);
  assert.match(raw, /\r\nDTEND:20261006T183000Z\r\n/);
  assert.deepEqual([ev.uid, ev.method, ev.start.toISOString(), ev.end.toISOString(), ev.organizer.email, ev.attendees[0].email], [meeting.id, 'REQUEST', TUE_2PM, '2026-10-06T18:30:00.000Z', 'onboard@aviance.test', SAM]);
  // The onboarding call: booked by the calendar, no alert for what the owner did himself.
  const oc = await onboardCallFor(ID, { now: at(MON, 2) });
  assert.deepEqual([oc.status, oc.bookedFor, oc.bookedBy, oc.requestedFor], ['booked', TUE_2PM, 'calendar', null]);
  assert.deepEqual(alertKeys(), ['meeting_requested']);
  assert.equal((await hubClient(ID, { now: at(MON, 2) })).row.simple.label, 'Call booked for Tue 6 Oct, 11:30 pm your time');
  // Saying yes twice is a 409; the meeting link goes in when set.
  assert.equal((await hub({ action: 'confirm', id: meeting.id })).status, 409);
  // The day-before reminder follows in their zone.
  await checkOnboardCalls({ now: at(MON, 3), force: true });
  assert.equal(toSam().at(-1).subject, 'Our onboarding call tomorrow');
  // One time style in every email to them (the Calendar's): their zone, Eastern beside it.
  assert.match(toSam().at(-1).text, /is Tuesday 6 October at 12:00 pm Mountain Time \(2:00 pm Eastern\)\./);
  // Their calendar accepting our invite (a REPLY for our UID) is no new booking.
  inbox = [{ uid: 5, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<acc-1@google.com>', from: SAM, subject: 'Accepted: Onboarding call — eCreek IT', date: at(MON, 3).toISOString(), threadIds: [], kind: 'auto_ack', hasIcs: true,
    ics: [['BEGIN:VCALENDAR', 'METHOD:REPLY', 'BEGIN:VEVENT', `UID:${meeting.id}`, 'DTSTART:20261006T180000Z', 'ORGANIZER:mailto:onboard@aviance.test', `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${SAM}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')] }];
  assert.equal((await checkOnboardCalls({ now: at(MON, 4), force: true })).booked, 0);
  assert.deepEqual(alertKeys(), ['meeting_requested']);
  assert.equal((await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 4) })).meetings.length, 1);
});

test('the meeting link from CALENDAR.meetingLink goes into the confirmation and the invite', async () => {
  await setCal('meetingLink', 'https://meet.google.com/abc-defg-hij');
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  await hub({ action: 'confirm', id: meeting.id });
  const mail = toSam().at(-1);
  assert.match(mail.text, /\n\nJoin here: https:\/\/meet\.google\.com\/abc-defg-hij\n\n/);
  assert.match(icsOf(mail).raw, /LOCATION:https:\/\/meet\.google\.com\/abc-defg-hij/);
});

test('Suggest another time: they get it with a one-click "Yes, that works"; their yes confirms it and tells the owner', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  io.now = () => at(MON, 2);
  const r = await hub({ action: 'suggest', id: meeting.id, start: WED_10AM });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.meeting.status, r.body.meeting.proposed, r.body.meeting.start], ['requested', WED_10AM, TUE_2PM]);
  const mail = toSam().at(-1);
  assert.equal(mail.subject, `Re: ${SUBJECT}`);
  assert.match(mail.text, /Thanks for picking a time\. Tuesday at 2:00 pm doesn't work for me, I'm afraid — how about Wednesday 7 October at 10:00 am Eastern Time\?/);
  const link = mail.text.match(/Yes, that works: https:\/\/app\.test\/c\/([^/\s]+)\/book\/accept\?m=(m[a-z0-9]+)/);
  assert.ok(link, 'the one-click link');
  assert.equal(link[2], meeting.id);
  assert.match(mail.text, /Or pick any other time here: https:\/\/app\.test\/c\/[^/\s]+\/book\n/);
  // The trial waits for them now; the suggested time is held, the asked one is free again.
  const oc = await onboardCallFor(ID, { now: at(MON, 2) });
  assert.equal(oc.label, 'You suggested Wed 7 Oct, 7:30 pm (your time) — waiting for them');
  assert.equal((await hubClient(ID, { now: at(MON, 2) })).row.simple.needsYou, false);
  const view = await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 2) });
  assert.ok(view.free.some((x) => x.start === TUE_2PM));
  assert.ok(!view.free.some((x) => x.start === WED_10AM));

  // Opening the link only shows the button (a scanner opening it accepts nothing).
  const acceptRoute = await import('@/app/c/[token]/book/accept/route');
  const url = `https://app.test/c/${link[1]}/book/accept?m=${link[2]}`;
  const shown = await acceptRoute.GET(new Request(url), { params: Promise.resolve({ token: link[1] }) });
  const html = await shown.text();
  assert.equal(shown.status, 200);
  assert.match(html, /Wed 7 Oct · 10:00 am/);
  assert.match(html, /<form method="post" action="\/c\/[^"]+\/book\/accept\?m=m[a-z0-9]+"><button class="go" type="submit">Yes, that works<\/button><\/form>/);
  assert.equal((await getMeeting(meeting.id)).status, 'requested');
  // Their one click.
  io.now = () => at(MON, 3);
  sent = [];
  const done = await acceptRoute.POST(new Request(url, { method: 'POST' }), { params: Promise.resolve({ token: link[1] }) });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /You're booked[\s\S]*Wed 7 Oct · 10:00 am/);
  const m = await getMeeting(meeting.id);
  assert.deepEqual([m.status, m.start, m.proposed], ['confirmed', WED_10AM, null]);
  assert.deepEqual(m.history.map((h) => h.what), ['requested', 'suggested', 'accepted', 'confirmed']);
  assert.equal(toSam().length, 1);
  assert.equal(icsOf(toSam()[0]).ev.start.toISOString(), WED_10AM);
  const acc = alerts.find((a) => a.key === 'meeting_accepted');
  assert.equal(title(acc), 'Sam (eCreek IT) said yes to Wed 7 Oct 10:00 am ET = 7:30 pm Colombo');
  assert.equal((await onboardCallFor(ID, { now: at(MON, 3) })).bookedFor, WED_10AM);
  // A second click (or a refresh) changes nothing and sends nothing.
  const again = await acceptRoute.POST(new Request(url, { method: 'POST' }), { params: Promise.resolve({ token: link[1] }) });
  assert.equal(again.status, 200);
  assert.equal(toSam().length, 1);
});

test('picking the suggested time from the list is their yes to it; a request whose time has passed no longer blocks the page', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  await hub({ action: 'suggest', id: meeting.id, start: WED_10AM });
  const r = await ask(token, WED_10AM);
  assert.deepEqual([r.status, r.body.meeting.id, r.body.meeting.status], [200, meeting.id, 'confirmed']);
  assert.deepEqual(alertKeys(), ['meeting_requested', 'meeting_accepted']);
  assert.equal(icsOf(toSam().at(-1)).ev.start.toISOString(), WED_10AM);

  // Another applicant whose request was never answered: once its time has passed, the page offers times again.
  const ann = await approved({ id: 'acme', email: 'ann@acme.com', name: 'Ann Lee', company: 'Acme' });
  await ask(ann, '2026-10-06T15:00:00Z');
  assert.match((await page(ann)).html, /Thanks — you asked for a time/);
  io.now = () => new Date('2026-10-06T16:00:00Z');
  const later = await page(ann);
  assert.match(later.html, /<h1>Pick a time for our call<\/h1>/);
  assert.match(later.html, /type="radio"/);
});

test('Decline with a short reason: they get it with the booking page, the time is free again', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  io.now = () => at(MON, 2);
  assert.equal((await hub({ action: 'decline', id: 'mnope12345678' })).status, 404);
  const r = await hub({ action: 'decline', id: meeting.id, reason: "I'm travelling that day" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.meeting.status, r.body.meeting.declineReason], ['declined', "I'm travelling that day."]);
  const mail = toSam().at(-1);
  assert.equal(mail.subject, `Re: ${SUBJECT}`);
  assert.match(mail.text, /^Hi Sam,\n\nSorry, I can't do Tuesday at 2:00 pm: I'm travelling that day\.\n\nPlease pick another time here: https:\/\/app\.test\/c\/[^/\s]+\/book\n\nLimeth Sith$/);
  assert.ok(!mail.icalEvent, 'nothing was in their calendar yet');
  const oc = await onboardCallFor(ID, { now: at(MON, 2) });
  assert.equal(oc.requestedFor, null);
  assert.equal(oc.status, 'sent');
  const view = await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 2) });
  assert.equal(view.requests.length, 0);
  assert.equal(view.meetings.length, 0, 'declined meetings are left out of the grid');
  assert.ok(view.free.some((x) => x.start === TUE_2PM));
  // They can pick again from the same link.
  assert.equal((await ask(token, TUE_2PM)).status, 200);
});

test('Move a confirmed call: the new time and the updated invite (same UID, next SEQUENCE); a clash is refused', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  assert.equal((await hub({ action: 'move', id: meeting.id, start: WED_10AM })).status, 409, 'a request is answered with Suggest, not moved');
  await hub({ action: 'confirm', id: meeting.id });
  await hub({ action: 'block', start: '2026-10-08T13:00:00Z', minutes: 60 });
  assert.equal((await hub({ action: 'move', id: meeting.id, start: '2026-10-08T13:30:00Z' })).status, 409, 'overlaps a busy block');
  assert.equal((await hub({ action: 'move', id: meeting.id, start: '2026-10-01T13:30:00Z' })).status, 400, 'in the past');
  const r = await hub({ action: 'move', id: meeting.id, start: '2026-10-08T15:00:00Z' });
  assert.equal(r.status, 200);
  const mail = toSam().at(-1);
  assert.equal(mail.subject, 'New time for our call: Thu 8 Oct at 11:00 am ET');
  assert.match(mail.text, /I've had to move our call\. The new time is Thursday 8 October at 11:00 am Eastern Time\./);
  const { raw, ev } = icsOf(mail);
  assert.match(raw, /\r\nSEQUENCE:1\r\n/);
  assert.deepEqual([ev.uid, ev.start.toISOString()], [meeting.id, '2026-10-08T15:00:00.000Z']);
  assert.equal((await onboardCallFor(ID, { now: at(MON, 2) })).bookedFor, '2026-10-08T15:00:00.000Z');
  assert.deepEqual((await getMeeting(meeting.id)).history.map((h) => h.what), ['requested', 'confirmed', 'moved']);
});

test('Cancel: they are told, the invite is cancelled in their calendar (METHOD:CANCEL), the call is not booked any more', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  await hub({ action: 'confirm', id: meeting.id });
  const r = await hub({ action: 'cancel', id: meeting.id, reason: 'Something came up on my side' });
  assert.equal(r.body.meeting.status, 'cancelled');
  const mail = toSam().at(-1);
  assert.equal(mail.subject, 'Cancelled: our call on Tue 6 Oct at 2:00 pm ET');
  assert.match(mail.text, /I'm sorry — I've had to cancel our call on Tuesday 6 October at 2:00 pm Eastern Time\. Something came up on my side\.\n\nWhen you're ready, pick a new time here: https:\/\/app\.test\/c\/[^/\s]+\/book/);
  const { raw, method, ev } = icsOf(mail);
  assert.equal(method, 'CANCEL');
  assert.match(raw, /\r\nMETHOD:CANCEL\r\n/);
  assert.match(raw, /\r\nSTATUS:CANCELLED\r\n/);
  assert.match(raw, /\r\nSEQUENCE:1\r\n/);
  assert.deepEqual([ev.uid, ev.method, ev.start.toISOString()], [meeting.id, 'CANCEL', TUE_2PM]);
  const oc = await onboardCallFor(ID, { now: at(MON, 1) });
  assert.deepEqual([oc.status, oc.bookedFor], ['sent', null]);
  assert.equal((await hub({ action: 'cancel', id: meeting.id })).status, 409);
});

test('Call done / no-show stay in step both ways between the Calendar and the onboarding card', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  await hub({ action: 'confirm', id: meeting.id });
  io.now = () => at(MON, 30);
  // Calendar → card.
  await hub({ action: 'noShow', id: meeting.id });
  assert.equal((await onboardCallFor(ID, { now: at(MON, 30) })).status, 'no_show');
  await hub({ action: 'held', id: meeting.id });
  let oc = await onboardCallFor(ID, { now: at(MON, 30) });
  assert.equal(oc.status, 'held');
  assert.equal((await getClient(ID)).onboardCallOpen, '0');
  // Card → calendar.
  assert.equal((await card(ID, { action: 'markNoShow' })).body.onboardCall.status, 'no_show');
  assert.equal((await getMeeting(meeting.id)).status, 'no_show');
  await card(ID, { action: 'markHeld' });
  const m = await getMeeting(meeting.id);
  assert.equal(m.status, 'held');
  assert.deepEqual(m.history.map((h) => [h.what, h.by]).slice(-4), [['no_show', 'owner'], ['held', 'owner'], ['no_show', 'owner'], ['held', 'owner']]);
  oc = await onboardCallFor(ID, { now: at(MON, 30) });
  assert.equal(oc.status, 'held');
  // The booking page is closed once the call is done.
  assert.match((await page(token)).html, /Our call is done/);
});

test('one meeting per onboarding call: "Mark call booked", calendar invites in the inbox and page requests never duplicate', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  // The card: a confirmed meeting in the calendar, no email to them.
  let r = await card(ID, { action: 'markBooked', when: '2026-10-07T19:00:00Z' });
  assert.equal(r.body.onboardCall.bookedBy, 'owner');
  const list = async () => (await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-20T00:00:00Z', now: at(MON, 1), all: true })).meetings;
  let ms = await list();
  assert.equal(ms.length, 1);
  assert.deepEqual([ms[0].status, ms[0].source, ms[0].start, ms[0].kind], ['confirmed', 'onboard_card', '2026-10-07T19:00:00.000Z', 'onboarding']);
  assert.equal(r.body.onboardCall.meetingId, ms[0].id);
  assert.equal(toSam().length, 1, 'nothing sent: the owner arranged it himself');
  // Marked again at another time: the same meeting moves.
  await card(ID, { action: 'markBooked', when: '2026-10-08T19:00:00Z' });
  ms = await list();
  assert.equal(ms.length, 1);
  assert.equal(ms[0].start, '2026-10-08T19:00:00.000Z');
  // A Calendly / Google invite for them: still the same meeting.
  inbox = [{ uid: 9, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<inv-1@google.com>', from: 'calendar-notification@google.com', subject: 'Invitation: Onboarding call', date: at(MON, 2).toISOString(), threadIds: [], kind: 'auto_ack', hasIcs: true,
    ics: [['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:evt-1@google.com', 'DTSTART:20261009T150000Z', 'ORGANIZER:mailto:onboard@aviance.test', `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${SAM}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')] }];
  assert.equal((await checkOnboardCalls({ now: at(MON, 3), force: true })).booked, 1);
  ms = await list();
  assert.equal(ms.length, 1);
  assert.equal(ms[0].start, '2026-10-09T15:00:00.000Z');
  assert.deepEqual(ms[0].history.at(-1), { at: at(MON, 3).toISOString(), what: 'moved', by: 'them', via: 'inbox', from: '2026-10-08T19:00:00.000Z' });
  // Their calendar cancels it: the meeting is cancelled too.
  inbox = [{ ...inbox[0], uid: 10, messageId: '<inv-2@google.com>', date: at(MON, 4).toISOString(), ics: [inbox[0].ics[0].replace('METHOD:REQUEST', 'METHOD:CANCEL')] }];
  await checkOnboardCalls({ now: at(MON, 5), force: true });
  ms = await list();
  assert.deepEqual(ms.map((m) => m.status), ['cancelled']);

  // A page request, then the same pick again: one meeting, one "got it".
  sent = []; alerts = [];
  const a = await ask(token, TUE_2PM);
  const b = await ask(token, TUE_2PM);
  assert.equal(a.body.meeting.id, b.body.meeting.id);
  assert.equal(toSam().length, 1);
  assert.deepEqual(alertKeys(), ['meeting_requested']);
  // A different pick replaces the time they asked for (still one meeting, the old time free).
  const c = await ask(token, WED_10AM);
  assert.equal(c.body.meeting.id, a.body.meeting.id);
  const open = (await list()).filter((m) => m.status === 'requested');
  assert.deepEqual(open.map((m) => m.start), [WED_10AM]);
  // Then "Mark call booked" confirms that same meeting at the owner's time.
  await card(ID, { action: 'markBooked', when: '2026-10-07T14:30:00Z' });
  const after = (await list()).filter((m) => m.status !== 'cancelled');
  assert.equal(after.length, 1);
  assert.deepEqual([after[0].id, after[0].status, after[0].start], [a.body.meeting.id, 'confirmed', '2026-10-07T14:30:00.000Z']);
});

test('asking to move a confirmed call makes it a request again at the new time; the owner is told it is a move', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  const { body: { meeting } } = await ask(token, TUE_2PM);
  await hub({ action: 'confirm', id: meeting.id });
  alerts = [];
  const page1 = await page(token);
  assert.match(page1.html, /You're booked/);
  assert.match(page1.html, /Ask for a different time/);
  assert.doesNotMatch(page1.html, /type="radio"/);
  assert.match((await page(token, '?change=1')).html, /type="radio"/);
  const r = await ask(token, WED_10AM);
  assert.equal(r.body.meeting.id, meeting.id);
  assert.equal(r.body.meeting.status, 'requested');
  assert.match(alerts[0].body, /asked to move the onboarding call to Wed 7 Oct 10:00 am ET = 7:30 pm Colombo/);
  const oc = await onboardCallFor(ID, { now: at(MON, 1) });
  assert.deepEqual([oc.status, oc.bookedFor, oc.requestedFor], ['sent', null, WED_10AM]);
  // Yes → the invite in their calendar is updated (next SEQUENCE).
  await hub({ action: 'confirm', id: meeting.id });
  const { raw, ev } = icsOf(toSam().at(-1));
  assert.match(raw, /\r\nSEQUENCE:1\r\n/);
  assert.equal(ev.start.toISOString(), WED_10AM);
});

test('409 when the slot was just taken; 400 with no time; 401 with a bad link; the form post goes back to the page', async () => {
  const sam = await approved();
  const ann = await approved({ id: 'acme', email: 'ann@acme.com', name: 'Ann Lee', company: 'Acme' });
  io.now = () => at(MON, 1);
  assert.equal((await ask(sam, TUE_2PM)).status, 200);
  const taken = await ask(ann, TUE_2PM);
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.body, { ok: false, error: 'Sorry — that time was just taken. Please pick another.' });
  assert.equal((await ask(ann, '2026-10-06T17:30:00Z')).status, 409, 'would run into their call');
  assert.equal((await ask(ann, '2026-10-06T18:30:00Z')).status, 409, 'inside the 15-minute buffer after it');
  assert.equal((await ask(ann, '2026-10-06T19:00:00Z')).status, 200);
  assert.equal((await ask(ann, '2026-10-10T14:00:00Z')).status, 409, 'Saturday is never offered');
  assert.equal((await ask(ann, '')).status, 400);
  assert.equal((await ask('not-a-real-token-at-all-000000', TUE_2PM)).status, 401);
  // The page's own form: 303 back to the page with one line to show.
  const form = await ask(ann, TUE_2PM, { form: true, tz: 'America/Chicago' });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), `https://app.test/c/${ann}/book?flash=taken&tz=America%2FChicago`);
  assert.match((await page(ann, '?flash=taken')).html, /Sorry — that time was just taken\. Please pick another\./);
  const ok = await ask(ann, '2026-10-07T15:00:00Z', { form: true });
  assert.equal(ok.headers.get('location'), `https://app.test/c/${ann}/book?flash=sent`);
});

test('the booking page limits tries per link', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  for (let i = 0; i < BOOK_TRIES_PER_HOUR; i++) assert.equal((await ask(token, 'nope')).status, 400);
  assert.equal((await ask(token, TUE_2PM)).status, 429);
  assert.equal((await ask(token, TUE_2PM, { form: true })).headers.get('location'), `https://app.test/c/${token}/book?flash=limit`);
  assert.equal(await getMeeting('mnothing00000'), null);
});

test('the booking page: plain HTML with the open times in their own zone, a zone switcher, a note box and one button', async () => {
  const token = await approved({ state: 'CO', name: '<b>Sam</b> Test' });
  io.now = () => at(MON, 1);
  const p = await page(token);
  assert.equal(p.status, 200);
  assert.equal(p.type, 'text/html; charset=utf-8');
  assert.match(p.html, /<h1>Pick a time for our call<\/h1>/);
  assert.match(p.html, /Hi &lt;b&gt;Sam&lt;\/b&gt; — choose a time that suits you for our 30-minute onboarding call\./, 'everything escaped');
  assert.match(p.html, /<option value="America\/Denver" selected>Mountain Time<\/option>/);
  assert.match(p.html, /<h2>Tuesday 6 October<\/h2>/);
  assert.match(p.html, /<input type="radio" name="start" value="2026-10-06T13:00:00\.000Z" required><span>7:00 am<\/span>/);
  assert.doesNotMatch(p.html, /Saturday 10 October|Sunday 11 October|Monday 12 October/, 'weekend and Columbus Day closed');
  assert.match(p.html, /<form method="post" action="\/api\/c\/book">/);
  assert.match(p.html, /<textarea id="note" name="note" maxlength="500"><\/textarea>/);
  assert.equal((p.html.match(/<button class="go" type="submit">/g) || []).length, 1, 'one button');
  assert.match(p.html, /Times are in Mountain Time\./);
  // The switcher (only the listed zones).
  const chi = await page(token, '?tz=America/Chicago');
  assert.match(chi.html, /value="2026-10-06T13:00:00\.000Z" required><span>8:00 am<\/span>/);
  assert.match(chi.html, /<option value="America\/Chicago" selected>Central Time<\/option>/);
  assert.match((await page(token, '?tz=Evil/Zone')).html, /<option value="America\/Denver" selected>/);
  // After asking: their time instead of the list, with a way to change it.
  await ask(token, TUE_2PM, { tz: 'America/Denver' });
  const mine = await page(token);
  assert.match(mine.html, /Thanks — you asked for a time/);
  assert.match(mine.html, /Tue 6 Oct · 12:00 pm/);
  assert.match(mine.html, /Mountain Time\. I'll confirm by email shortly\./);
  assert.doesNotMatch(mine.html, /type="radio"/);
  assert.match(mine.html, /href="\/c\/[^"]+\/book\?change=1&amp;tz=America%2FDenver">Ask for a different time/);
  assert.match((await page(token, '?change=1')).html, /Ask for this time instead/);
  // A bad link, a closed trial.
  const bad = await page('not-a-real-token-at-all-000000');
  assert.equal(bad.status, 404);
  assert.match(bad.html, /This link has expired/);
  await kv.hset(K.client(ID), { state: 'sending' });
  assert.match((await page(token)).html, /This page is closed/);
});

// ── the hub API ──────────────────────────────────────────────────────────────

test('GET /api/mc/calendar: meetings, waiting requests, settings, free times; add, block and unblock', async () => {
  const token = await approved();
  io.now = () => at(MON, 1);
  await ask(token, TUE_2PM);
  const { GET } = await import('@/app/api/mc/calendar/route');
  const res = await GET(new Request('https://app.test/api/mc/calendar?from=2026-10-05T00:00:00Z&to=2026-10-12T00:00:00Z'));
  const v = await res.json();
  assert.equal(v.requests.length, 1);
  assert.equal(v.meetings.length, 1);
  assert.deepEqual(Object.keys(v.meetings[0]).filter((k) => ['id', 'clientId', 'company', 'person', 'email', 'kind', 'title', 'start', 'minutes', 'status', 'source', 'theirZone', 'note', 'declineReason', 'proposed', 'createdAt', 'confirmedAt', 'history'].includes(k)).length, 18, 'every field of the contract');
  assert.equal(v.meetings[0].end, '2026-10-06T18:30:00.000Z');
  assert.deepEqual(v.settings.hours, ['09:00', '17:00']);
  assert.deepEqual(v.settings.days, [1, 2, 3, 4, 5]);
  assert.deepEqual([v.settings.slotMinutes, v.settings.ownerZone, v.settings.usZone, v.settings.meetingLink], [30, 'Asia/Colombo', 'America/New_York', null]);
  assert.ok(v.free.some((x) => x.start === '2026-10-05T16:00:00.000Z'), 'the owner sees today too (no notice period for him)');
  assert.ok(!v.free.some((x) => x.start === TUE_2PM));
  assert.equal((await GET(new Request('https://app.test/api/mc/calendar?from=2026-10-12T00:00:00Z&to=2026-10-05T00:00:00Z'))).status, 400);

  // The owner's own meeting (confirmed, nobody emailed) and a busy block.
  const before = sent.length;
  let r = await hub({ action: 'add', clientId: null, title: 'Dentist', start: '2026-10-07T13:00:00Z', minutes: 60 });
  assert.deepEqual([r.status, r.body.meeting.status, r.body.meeting.source, r.body.meeting.kind, r.body.meeting.title], [200, 'confirmed', 'owner', 'other', 'Dentist']);
  assert.equal(sent.length, before);
  assert.equal((await hub({ action: 'add', title: 'Clash', start: '2026-10-07T13:30:00Z', minutes: 30 })).status, 409);
  assert.equal((await hub({ action: 'add', clientId: 'nobody', title: 'x', start: '2026-10-07T20:00:00Z' })).status, 404);
  r = await hub({ action: 'block', start: '2026-10-08T13:00:00Z', minutes: 120 });
  assert.deepEqual([r.body.meeting.status, r.body.meeting.title, r.body.meeting.clientId], ['blocked', 'Busy', null]);
  assert.equal((await hub({ action: 'block', start: '2026-10-06T17:00:00Z', minutes: 120 })).status, 409, 'not over a client meeting');
  let view = await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 1) });
  assert.ok(!view.free.some((x) => x.start === '2026-10-08T14:00:00.000Z'));
  assert.equal((await hub({ action: 'unblock', id: view.requests[0].id })).status, 409, 'only a block can be unblocked');
  await hub({ action: 'unblock', id: r.body.meeting.id });
  view = await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 1) });
  assert.ok(view.free.some((x) => x.start === '2026-10-08T14:00:00.000Z'));
  assert.deepEqual(view.meetings.map((m) => m.title).sort(), ['Dentist', 'Onboarding call — eCreek IT']);
  assert.equal((await hub({ action: 'nope' })).status, 400);
  // An onboarding meeting added by hand books the onboarding call (one per call).
  await hub({ action: 'decline', id: view.requests[0].id, reason: 'x' });
  r = await hub({ action: 'add', clientId: ID, kind: 'onboarding', start: '2026-10-09T15:00:00Z', minutes: 30 });
  assert.equal(r.body.meeting.title, 'Onboarding call — eCreek IT');
  assert.equal((await onboardCallFor(ID, { now: at(MON, 1) })).bookedFor, '2026-10-09T15:00:00.000Z');
  assert.equal((await hub({ action: 'add', clientId: ID, kind: 'onboarding', start: '2026-10-09T18:00:00Z' })).status, 409);
});

// ── the onboarding page: one reminder track, the Day +7 close waits ──────────

test('one reminder track: while the onboarding call is to happen only its own reminders go; the page reminders follow the call', async () => {
  await approved();
  const day = (d) => new Date(MON.getTime() + d * 864e5);
  for (const d of [1, 2, 3, 4, 5, 6]) await runOnboardingNudge({ clientId: ID, now: day(d) });
  assert.equal(toSam().filter((m) => m.subject === 'Your trial page is still open').length, 0, 'no Day +2 / +4 page reminders');
  // Silence still closes on Day +7 (the call's reminders went, then the overdue alert).
  const r = await runOnboardingNudge({ clientId: ID, now: day(7) });
  assert.equal(r.closed, true);
  assert.equal((await getClient(ID)).state, 'closed_silent');

  // Once the call is done, the page reminders run, counted from the call.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await approved();
  io.now = () => day(1);
  await card(ID, { action: 'markBooked', when: day(2).toISOString() });
  io.now = () => day(2.1);
  await card(ID, { action: 'markHeld' });
  const res = [];
  for (const d of [3, 4, 5, 6, 7, 8]) res.push((await runOnboardingNudge({ clientId: ID, now: day(d) })).sent ?? null);
  assert.deepEqual(res, [null, 2, null, 4, null, null], 'Day +2 and +4 after the call');
  assert.equal(toSam().filter((m) => m.subject === 'Your trial page is still open').length, 2);
  assert.equal((await runOnboardingNudge({ clientId: ID, now: day(9) })).closed, true, 'Day +7 after the call');
});

test('the Day +7 close never takes an applicant whose call is asked for, booked or done, or who replied — it is extended', async () => {
  const day = (d) => new Date(MON.getTime() + d * 864e5);
  // They asked for a time: never closed while it waits for the owner.
  const token = await approved();
  io.now = () => day(1);
  // (a far time: the booking page only offers the next 14 days)
  await ask(token, '2026-10-07T14:00:00Z');
  for (const d of [7, 10, 20]) {
    const r = await runOnboardingNudge({ clientId: ID, now: day(d) });
    assert.equal(r.closed, undefined, `day ${d}`);
    assert.equal(r.extended, true);
  }
  assert.equal((await getClient(ID)).state, 'onboarding');
  assert.equal((await kv.hgetall(K.trial(ID))).onboardingClosesOn, 'held');

  // A booked call ahead: not before the call + 7 days.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await approved();
  io.now = () => day(1);
  await card(ID, { action: 'markBooked', when: day(9).toISOString() });
  assert.equal((await runOnboardingNudge({ clientId: ID, now: day(7) })).closed, undefined);
  assert.equal((await runOnboardingNudge({ clientId: ID, now: day(15) })).closed, undefined);
  assert.equal((await runOnboardingNudge({ clientId: ID, now: day(16) })).closed, true);

  // A reply on day 2: the close moves to day 9.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await approved();
  await kv.hset(K.onboardCall(ID), { lastReplyAt: day(2).toISOString(), firstReplyAt: day(2).toISOString() });
  const r7 = await runOnboardingNudge({ clientId: ID, now: day(7) });
  assert.deepEqual([r7.closed, r7.extended], [undefined, true]);
  assert.equal((await kv.hgetall(K.trial(ID))).onboardingClosesOn, '2026-10-14');
  assert.equal((await runOnboardingNudge({ clientId: ID, now: day(9) })).closed, true);

  // The clock itself (pure).
  const sentAt = MON.toISOString();
  assert.deepEqual(onboardPageClock({}, sentAt, day(3)), { from: sentAt, hold: null, reminders: true }, 'no onboarding call: the old clock');
  assert.deepEqual(onboardPageClock({ sentAt }, sentAt, day(3)), { from: sentAt, hold: null, reminders: false });
  assert.equal(onboardPageClock({ sentAt, heldAt: day(4).toISOString() }, sentAt, day(5)).from, day(4).toISOString());
  assert.equal(onboardPageClock({ sentAt, heldAt: day(4).toISOString(), stoppedAt: day(1).toISOString() }, sentAt, day(5)).reminders, false, 'stopped stays stopped');
  assert.equal(onboardPageClock({ sentAt, bookedAt: day(1).toISOString(), bookedFor: day(3).toISOString(), noShowAt: day(3).toISOString() }, sentAt, day(5)).hold, null, 'a missed call is not a hold');
});

test('settings: CALENDAR is a machine setting with safe fallbacks; the booking page follows it', async () => {
  await setCal('hours', ['10:00', '12:00']);
  await setCal('days', [2]);
  await setCal('daysAhead', 7);
  const token = await approved();
  io.now = () => at(MON, 1);
  const { GET } = await import('@/app/api/c/book/slots/route');
  const { slots } = await (await GET(new Request(`https://app.test/api/c/book/slots?token=${token}`))).json();
  assert.deepEqual(slots.map((x) => x.label), ['Tue 6 Oct · 10:00 am', 'Tue 6 Oct · 10:30 am', 'Tue 6 Oct · 11:00 am', 'Tue 6 Oct · 11:30 am'], 'Tuesdays only, 10–12, one week');
  const r = await readCall(ID);
  assert.ok(r.sentAt);
});
