// The website's "Book a call": the free/busy times it reads (GET /api/booking/availability), and the server
// refusing a time that is taken or outside the call hours (POST /api/inquiry → saveInquiry → bookSalesCall strict),
// with the slow work (paid application, research, owner alerts) after the answer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, listInquiries, getInquiry } from '@/lib/systems/inquiries';
import { salesIo } from '@/lib/systems/salescall';
import { getMeeting, calendarAction, publicAvailability, inCallHours, salesSlotProblem, normaliseCalendar } from '@/lib/systems/calendar';
import { io } from '@/lib/systems/intake-io';
import { pushIo, savePushSub } from '@/lib/push';

const NOW = new Date('2026-11-19T08:00:00.000Z');
// Tue 1 Dec 2026 10:00 AM EST = 15:00 UTC (the time the owner's test booked twice).
const TUE_10 = '2026-12-01T15:00:00.000Z';
const plus = (iso, min) => new Date(Date.parse(iso) + min * 60e3).toISOString();
const site = (over = {}) => ({
  name: 'Bob Stone', email: 'bob@stoneroofing.com', company: 'Stone Roofing', website: '',
  sells: 'Commercial roofing', plan: null, slotStart: TUE_10, slotEnd: plus(TUE_10, 15), theirTz: 'America/Chicago',
  whenTheirs: 'Tuesday, December 1, 2026 at 9:00 AM CST', whenHost: 'Tuesday, December 1, 2026 at 8:30 PM', ...over,
});
let sent = [];
let alerts = [];
let pushed = [];

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; pushed = [];
  globalThis.__after = [];
  process.env.VAPID_PUBLIC_KEY = 'BPUB'; process.env.VAPID_PRIVATE_KEY = 'priv';
  pushIo.send = async (sub, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; };
  await savePushSub({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }, 'iPhone');
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth') });
  salesIo.sender = async () => ({ email: 'calls@aviance.test' });
  salesIo.send = async (account, mail) => { sent.push(mail); return { success: true, messageId: `<m${sent.length}@x>` }; };
  io.alertOwner = async (key, opts) => { alerts.push({ key, ...opts }); return { sent: true }; };
  io.notifyClient = async () => ({ sent: true });
  io.fetchExt = async () => ({ ok: true, status: 200, url: 'https://stoneroofing.com/', text: async () => '<title>Stone Roofing</title>' });
  io.now = () => NOW;
});

const post = async (body) => {
  const { POST } = await import('@/app/api/inquiry/route');
  return POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) }));
};

// ── call hours (pure) ─────────────────────────────────────────────────────────

test('call hours: Mon–Fri 9:00–17:00 US Eastern, the whole call inside, US holidays closed', () => {
  const s = normaliseCalendar();
  assert.equal(inCallHours(Date.parse('2026-12-01T14:00:00Z'), 15, s), true, '9:00 am EST');
  assert.equal(inCallHours(Date.parse('2026-12-01T13:45:00Z'), 15, s), false, '8:45 am EST');
  assert.equal(inCallHours(Date.parse('2026-12-01T21:45:00Z'), 15, s), true, '4:45 pm EST ends at 5');
  assert.equal(inCallHours(Date.parse('2026-12-01T22:00:00Z'), 15, s), false, '5:00 pm EST');
  assert.equal(inCallHours(Date.parse('2026-12-02T01:45:00Z'), 15, s), false, '8:45 pm EST (the old last slot)');
  assert.equal(inCallHours(Date.parse('2026-12-05T15:00:00Z'), 15, s), false, 'Saturday');
  assert.equal(inCallHours(Date.parse('2026-11-26T15:00:00Z'), 15, s), false, 'Thanksgiving');
  assert.equal(inCallHours(Date.parse('2026-07-01T13:00:00Z'), 15, s), true, '9:00 am EDT in summer');
  const meetings = [{ id: 'm1', status: 'confirmed', start: TUE_10, minutes: 15 }];
  assert.equal(salesSlotProblem({ startMs: Date.parse(TUE_10), meetings, settings: s, now: NOW }).code, 'slot_taken');
  assert.equal(salesSlotProblem({ startMs: Date.parse(TUE_10), meetings: [{ ...meetings[0], status: 'cancelled' }], settings: s, now: NOW }), null);
  assert.equal(salesSlotProblem({ startMs: Date.parse('2026-11-18T15:00:00Z'), settings: s, now: NOW }).code, 'slot_in_past');
});

// ── the endpoint ──────────────────────────────────────────────────────────────

test('GET /api/booking/availability: busy times only (no names or emails), the call hours and the holidays; short cache', async () => {
  assert.equal((await saveInquiry(site(), { now: NOW })).ok, true);
  await calendarAction({ action: 'block', start: '2026-12-02T18:00:00Z', minutes: 60 }, { now: NOW });
  const later = await saveInquiry(site({ email: 'amy@x.com', name: 'Amy Lee', company: 'Amy Co', slotStart: '2026-12-03T16:00:00.000Z', slotEnd: '2026-12-03T16:15:00.000Z' }), { now: NOW });
  await calendarAction({ action: 'cancel', id: (await getInquiry(later.id)).meetingId, reason: 'x' }, { now: NOW });

  const { GET } = await import('@/app/api/booking/availability/route');
  const res = await GET(new Request('http://x/api/booking/availability?from=2026-11-19T00:00:00Z&to=2026-12-10T00:00:00Z'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=15/);
  const text = await res.text();
  const j = JSON.parse(text);
  assert.equal(j.ok, true);
  assert.equal(j.zone, 'America/New_York');
  assert.deepEqual(j.hours, ['09:00', '17:00']);
  assert.deepEqual(j.days, [1, 2, 3, 4, 5]);
  assert.ok(j.closed.includes('2026-11-26'), 'Thanksgiving is closed');
  assert.deepEqual(j.busy, [
    { start: TUE_10, end: plus(TUE_10, 15) },
    { start: '2026-12-02T18:00:00.000Z', end: '2026-12-02T19:00:00.000Z' },
  ], 'the booked call and the busy block; the cancelled call is free again');
  for (const leak of ['Bob', 'bob@', 'Stone', 'Amy', 'Busy', 'Sales call', 'calls@']) assert.ok(!text.includes(leak), `no ${leak}`);
  // A broken window is a 400, never a crash.
  const bad = await GET(new Request('http://x/api/booking/availability?from=2026-12-10T00:00:00Z&to=2026-12-01T00:00:00Z'));
  assert.equal(bad.status, 400);
  // The window is capped.
  const wide = await publicAvailability({ from: '2026-11-19T00:00:00Z', to: '2027-11-19T00:00:00Z', now: NOW });
  assert.ok(Date.parse(wide.to) - Date.parse(wide.from) <= 62 * 864e5);
});

test('middleware: the availability is public, with CORS for the website only', async () => {
  process.env.ADMIN_SECRET = 'admin-secret-for-tests';
  const { middleware } = await import('@/middleware');
  const req = (method, origin) => {
    const url = 'https://email-distributor.vercel.app/api/booking/availability';
    return { url, method, nextUrl: new URL(url), headers: new Headers(origin ? { origin } : {}), cookies: { get: () => undefined } };
  };
  for (const o of ['https://www.aviance.online', 'https://aviance.online']) {
    const res = await middleware(req('GET', o));
    assert.equal(res.headers.get('x-middleware-next'), '1', 'let through without a sign-in');
    assert.equal(res.headers.get('access-control-allow-origin'), o);
    const pre = await middleware(req('OPTIONS', o));
    assert.equal(pre.status, 204);
  }
  const other = await middleware(req('GET', 'https://evil.example'));
  assert.equal(other.headers.get('x-middleware-next'), '1');
  assert.equal(other.headers.get('access-control-allow-origin'), null, 'no CORS for anyone else');
  assert.equal((await middleware(req('GET', null))).headers.get('x-middleware-next'), '1');
});

// ── the server refuses taken times and times outside the call hours ───────────

test('a time already booked is refused (slot_taken): nothing saved, no second email, no second meeting', async () => {
  assert.equal((await saveInquiry(site(), { now: NOW })).ok, true);
  assert.equal(sent.length, 1);
  const again = await saveInquiry(site({ email: 'amy@x.com', name: 'Amy Lee' }), { now: NOW });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'slot_taken');
  assert.match(again.error, /someone just booked that time/);
  // An overlapping start is refused too; the next free time is fine.
  assert.equal((await saveInquiry(site({ email: 'cy@x.com', slotStart: plus(TUE_10, 10), slotEnd: plus(TUE_10, 25) }), { now: NOW })).code, 'slot_taken');
  assert.equal((await saveInquiry(site({ email: 'cy@x.com', slotStart: plus(TUE_10, 15), slotEnd: plus(TUE_10, 30) }), { now: NOW })).ok, true);
  const { inquiries } = await listInquiries();
  assert.equal(inquiries.length, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['bob@stoneroofing.com', 'cy@x.com']);
  // The refused person can still book another time (their duplicate guard was released).
  assert.equal((await saveInquiry(site({ email: 'amy@x.com', name: 'Amy Lee', slotStart: plus(TUE_10, 60), slotEnd: plus(TUE_10, 75) }), { now: NOW })).ok, true);
});

test('a busy block or an onboarding call holds its time too', async () => {
  await calendarAction({ action: 'block', start: TUE_10, minutes: 60 }, { now: NOW });
  assert.equal((await saveInquiry(site({ slotStart: plus(TUE_10, 30), slotEnd: plus(TUE_10, 45) }), { now: NOW })).code, 'slot_taken');
  assert.equal((await listInquiries()).inquiries.length, 0);
});

test('outside the call hours, on a weekend, a holiday or in the past: refused (outside_hours / slot_in_past)', async () => {
  const at = (start) => saveInquiry(site({ email: `p${Math.random()}@x.com`, slotStart: start, slotEnd: plus(start, 15) }), { now: NOW });
  assert.equal((await at('2026-12-02T01:45:00.000Z')).code, 'outside_hours', '8:45 pm Eastern');
  assert.equal((await at('2026-12-01T22:00:00.000Z')).code, 'outside_hours', '5:00 pm Eastern');
  assert.equal((await at('2026-12-01T13:45:00.000Z')).code, 'outside_hours', '8:45 am Eastern');
  assert.equal((await at('2026-12-05T15:00:00.000Z')).code, 'outside_hours', 'Saturday');
  assert.equal((await at('2026-11-26T15:00:00.000Z')).code, 'outside_hours', 'Thanksgiving');
  assert.equal((await at('2026-11-18T15:00:00.000Z')).code, 'slot_in_past');
  assert.equal((await listInquiries()).inquiries.length, 0);
  assert.equal(sent.length, 0);
  assert.equal((await at('2026-12-01T21:45:00.000Z')).ok, true, '4:45 pm Eastern ends at 5');
});

test('the owner moving hours in Settings moves what is accepted', async () => {
  await kv.hset('system:config', { 'CALENDAR.hours': JSON.stringify(['10:00', '18:00']) });
  assert.equal((await saveInquiry(site({ slotStart: plus(TUE_10, -15), slotEnd: TUE_10 }), { now: NOW })).code, 'outside_hours', '9:45 am is before 10:00');
  assert.equal((await saveInquiry(site({ email: 'z@x.com', slotStart: plus(TUE_10, 450), slotEnd: plus(TUE_10, 465) }), { now: NOW })).ok, true, '5:30 pm is inside 10–6');
  const a = await publicAvailability({ now: NOW });
  assert.deepEqual(a.hours, ['10:00', '18:00']);
});

test('two people pressing Confirm on the same time at once: exactly one gets it', async () => {
  const people = ['a', 'b', 'c', 'd'].map((x) => site({ email: `${x}@x.com`, name: `${x.toUpperCase()} Person` }));
  const out = await Promise.all(people.map((p) => saveInquiry(p, { now: NOW })));
  assert.equal(out.filter((r) => r.ok).length, 1);
  assert.equal(out.filter((r) => r.code === 'slot_taken').length, 3);
  assert.equal(sent.length, 1);
  const { inquiries } = await listInquiries();
  assert.equal(inquiries.length, 1);
  const m = await getMeeting(inquiries[0].meetingId);
  assert.equal(m.inquiryId, inquiries[0].id);
});

test('POST /api/inquiry: a taken time is a 409 with its code', async () => {
  assert.equal((await (await post(site())).json()).ok, true);
  const res = await post(site({ email: 'amy@x.com' }));
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.code, 'slot_taken');
  assert.match(j.error, /pick another/);
  const late = await post(site({ email: 'cy@x.com', slotStart: '2026-12-02T01:45:00.000Z', slotEnd: '2026-12-02T02:00:00.000Z' }));
  assert.equal(late.status, 409);
  assert.equal((await late.json()).code, 'outside_hours');
});

// ── the answer comes first; the slow work after it ────────────────────────────

test('POST /api/inquiry answers once the booking is saved and emailed; the application, research and alerts run after', async () => {
  let researchStarted = 0;
  io.fetchExt = async () => { researchStarted++; return { ok: true, status: 200, url: 'https://stoneroofing.com/', text: async () => '<title>Stone Roofing</title>' }; };
  const res = await post(site({ website: 'stoneroofing.com', plan: 'growth' }));
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.emailed, true, 'the confirmation went before the answer');
  assert.equal(sent.length, 1);
  const q = await getInquiry(j.id);
  assert.ok(q.meetingId, 'the call is in the Calendar before the answer');
  assert.equal(q.clientId, undefined, 'no paid application yet');
  assert.equal(alerts.length, 0, 'no owner alert yet');
  assert.equal(researchStarted, 0, 'no research before the answer');
  assert.equal(globalThis.__after.length, 1, 'the rest is queued for after the answer');
  // After the answer (as Vercel runs it): the paid application, linked to the meeting, the owner told.
  for (const fn of globalThis.__after.splice(0)) await fn();
  const q2 = await getInquiry(j.id);
  assert.ok(q2.clientId, 'the paid application was made');
  assert.equal((await getMeeting(q2.meetingId)).linkedClientId, q2.clientId);
  assert.ok(alerts.some((a) => a.key === 'new_application'), 'the owner hears about it');
  assert.ok(researchStarted > 0, 'the website was researched after the answer');
});

test('no website: the owner alert goes after the answer and still says whether the email went', async () => {
  const res = await post(site());
  const j = await res.json();
  assert.equal(j.emailed, true);
  assert.equal(pushed.length, 0, 'no alert before the answer');
  for (const fn of globalThis.__after.splice(0)) await fn();
  const a = pushed.find((x) => /New plan inquiry: Stone Roofing/.test(x.title));
  assert.ok(a, 'the owner is alerted after the answer');
});

test('the email failing is still reported honestly (emailed: false), with the alert after', async () => {
  salesIo.send = async () => ({ success: false, error: 'auth failed' });
  const j = await (await post(site())).json();
  assert.equal(j.ok, true);
  assert.equal(j.emailed, false);
  assert.match((await getInquiry(j.id)).confirmationError, /auth failed/);
  for (const fn of globalThis.__after.splice(0)) await fn();
  assert.ok(pushed.find((x) => /New plan inquiry/.test(x.title)));
});
