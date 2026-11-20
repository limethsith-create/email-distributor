// Cold-call booking: the owner books a sales call himself (POST /api/mc/inquiries bookCheck / book).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { websiteFromEmail, theirZoneFor, zoneForPhone, whenText, AREA_TZ } from '@/lib/systems/coldbook';
import { getInquiry } from '@/lib/systems/inquiries';
import { salesIo, runSalesReminders } from '@/lib/systems/salescall';
import { getMeeting } from '@/lib/systems/calendar';
import { io } from '@/lib/systems/intake-io';
import { getAlertLog } from '@/lib/notify';

const NOW = new Date('2026-11-19T08:00:00.000Z');
const TUE_10 = '2026-12-01T15:00:00.000Z'; // Tue 10:00 AM EST, inside call hours
const SAT = '2026-12-05T15:00:00.000Z';
const booking = (over = {}) => ({ name: 'Dana Reed', email: 'dana@reedplumbing.com', start: TUE_10, phone: '(512) 555-0101', notes: 'Call me back at 4.', ...over });
let sent = [];
let alerts = [];

beforeEach(async () => {
  __reset();
  sent = []; alerts = [];
  globalThis.__after = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth') });
  salesIo.sender = async () => ({ email: 'calls@aviance.test' });
  salesIo.send = async (account, mail) => { sent.push(mail); return { success: true, messageId: `<m${sent.length}@x>` }; };
  io.alertOwner = async (key, opts) => { alerts.push({ key, ...opts }); return { sent: true }; };
  io.notifyClient = async () => ({ sent: true });
  io.fetchExt = async () => ({ ok: true, status: 200, url: 'https://reedplumbing.com/', text: async () => '<title>Reed Plumbing</title>' });
  io.now = () => NOW;
});

const mc = async (body) => {
  const { POST } = await import('@/app/api/mc/inquiries/route');
  const res = await POST(new Request('http://x/api/mc/inquiries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};
// The route uses the real clock; the check refuses past times, so use a far-future call for those tests.
const future = (days = 400) => { let d = new Date(Date.now() + days * 86400e3); while (d.getUTCDay() !== 2) d = new Date(d.getTime() + 86400e3); d.setUTCHours(15, 0, 0, 0); return d.toISOString(); };

test('website from the email: the domain, skipped for free mail', () => {
  assert.equal(websiteFromEmail('dana@reedplumbing.com'), 'https://reedplumbing.com');
  for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'mail.com', 'yandex.com']) {
    assert.equal(websiteFromEmail(`x@${d}`), null, d);
  }
  assert.equal(websiteFromEmail('not an email'), null);
});

test('their time zone: entered, else state, else phone area code, else Eastern', () => {
  assert.deepEqual(theirZoneFor({ theirTz: 'America/Denver', state: 'TX', phone: '212-555-0100' }), { tz: 'America/Denver', from: 'entered' });
  assert.deepEqual(theirZoneFor({ state: 'Texas', phone: '212-555-0100' }), { tz: 'America/Chicago', from: 'state' });
  assert.deepEqual(theirZoneFor({ state: 'AZ' }), { tz: 'America/Phoenix', from: 'state' });
  assert.deepEqual(theirZoneFor({ phone: '+1 (310) 555-0100' }), { tz: 'America/Los_Angeles', from: 'phone' });
  assert.equal(zoneForPhone('808-555-0100'), 'Pacific/Honolulu');
  assert.equal(zoneForPhone('907 555 0100'), 'America/Anchorage');
  assert.equal(zoneForPhone('12125550100'), 'America/New_York');
  assert.deepEqual(theirZoneFor({ state: 'nowhere', phone: '555' }), { tz: 'America/New_York', from: 'default' });
  assert.ok(Object.keys(AREA_TZ).length > 330);
});

test('when text reads like the website booking', () => {
  assert.equal(whenText(Date.parse(TUE_10), 'America/Chicago'), 'Tuesday, December 1, 2026 at 9:00 AM CST');
  assert.equal(whenText(Date.parse(TUE_10), 'America/New_York', { zone: false }), 'Tuesday, December 1, 2026 at 10:00 AM');
});

test('bookCheck previews and warns, and saves nothing', async () => {
  const r = await mc({ action: 'bookCheck', booking: booking() });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.theirTz, 'America/Chicago');
  assert.equal(r.json.tzFrom, 'phone');
  assert.equal(r.json.website, 'https://reedplumbing.com');
  assert.equal(r.json.websiteFrom, 'email');
  assert.match(r.json.whenTheirs, /9:00 AM CST$/);
  assert.deepEqual(r.json.warnings, []);
  const g = await mc({ action: 'bookCheck', booking: booking({ email: 'dana@gmail.com', website: 'reed.com' }) });
  assert.equal(g.json.websiteFrom, 'entered');
  assert.equal((await mc({ action: 'bookCheck', booking: booking({ email: 'dana@gmail.com' }) })).json.website, null);
  assert.equal((await mc({ action: 'bookCheck', booking: booking({ start: SAT }) })).json.warnings[0].code, 'outside_hours');
  for (const bad of [{ name: '' }, { email: '' }, { email: 'nope' }, { start: '' }, { start: 'soon' }]) {
    const x = await mc({ action: 'bookCheck', booking: booking(bad) });
    assert.equal(x.status, 400);
    assert.ok(x.json.error);
  }
  assert.equal((await kv.lrange('inquiries:order', 0, 5)).length, 0, 'nothing saved');
});

test('book: 409 on a clash without force, saved with force', async () => {
  const start = future();
  const first = await mc({ action: 'book', booking: booking({ start, email: 'amy@gmail.com', name: 'Amy Lee' }) });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const clash = await mc({ action: 'bookCheck', booking: booking({ start }) });
  assert.equal(clash.json.warnings[0].code, 'clash');
  const no = await mc({ action: 'book', booking: booking({ start }) });
  assert.equal(no.status, 409);
  assert.equal(no.json.warnings[0].code, 'clash');
  const yes = await mc({ action: 'book', booking: booking({ start }), force: true });
  assert.equal(yes.status, 200);
  assert.ok(yes.json.id);
});

test('a saved cold-call booking: Booked, Cold call, notes, Calendar sales call, email, research, alert', async () => {
  const start = future();
  const r = await mc({ action: 'book', booking: booking({ start, company: 'Reed Plumbing' }) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.emailed, true);
  assert.equal(globalThis.__after.length, 1, 'the slow part runs after the answer');
  await globalThis.__after[0]();
  const q = await getInquiry(r.json.id);
  assert.equal(q.status, 'new');
  assert.equal(q.source, 'cold_call');
  assert.equal(q.cameFrom, 'Cold call');
  assert.equal(q.company, 'Reed Plumbing');
  assert.equal(q.website, 'https://reedplumbing.com');
  assert.equal(q.theirTz, 'America/Chicago');
  assert.equal(q.notes[0].text, 'Call me back at 4.');
  assert.equal(r.json.inquiry.id, q.id);
  const m = await getMeeting(q.meetingId);
  assert.equal(m.kind, 'sales');
  assert.equal(m.status, 'confirmed');
  assert.equal(m.inquiryId, q.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'dana@reedplumbing.com');
  assert.ok(q.clientId, 'a record is held for the call: research runs');
  assert.ok(alerts.some((a) => a.key === 'new_inquiry' && /Cold call/.test(a.body)) || (await getAlertLog()).some((a) => /Dana Reed/.test(JSON.stringify(a))));
});

test('without a website (free mail) nothing is researched; company falls back to the name', async () => {
  const r = await mc({ action: 'book', booking: booking({ start: future(), email: 'dana@gmail.com' }) });
  assert.equal(r.status, 200);
  for (const j of globalThis.__after) await j();
  const q = await getInquiry(r.json.id);
  assert.equal(q.clientId, undefined);
  assert.equal(q.company, 'Dana Reed');
});

test('the reminders job treats it like a website booking', async () => {
  const start = future();
  const r = await mc({ action: 'book', booking: booking({ start }) });
  const q = await getInquiry(r.json.id);
  sent.length = 0;
  const soon = new Date(Date.parse(start) - 40 * 60e3);
  const out = await runSalesReminders({ now: soon });
  assert.equal(out.sent, 1);
  assert.equal(sent[0].to, q.email);
  assert.ok((await getInquiry(q.id)).reminded_soon);
});
