import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, getInquiry, setInquiryStatus } from '@/lib/systems/inquiries';
import { salesIo } from '@/lib/systems/salescall';
import { chaseBookingInvoices, bookingPaid } from '@/lib/systems/agreementsend';
import { io } from '@/lib/systems/intake-io';

// After the yes, the invoice lives on the booking (no client yet): 24 hours unpaid → one reminder + one
// "not paid yet" alert; paid → one "paid" alert, onboarding starts, the booking is Won.
const YES = new Date('2026-11-20T10:00:00.000Z');
const at = (h) => new Date(YES.getTime() + h * 3600e3);
let sent = []; let alerts = []; let clientMails = [];

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; clientMails = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth'), 'PAYMENT.paypalMe': JSON.stringify('https://paypal.me/aviance') });
  salesIo.sender = async () => ({ email: 'calls@aviance.test' });
  salesIo.send = async (account, mail) => { sent.push(mail); return { success: true, messageId: `<m${sent.length}@x>` }; };
  io.alertOwner = async (key, o) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.notifyClient = async (clientId, key) => { clientMails.push(key); return { sent: true }; };
  io.now = () => YES;
});

const yes = async () => {
  const r = await saveInquiry({
    name: 'Bob Stone', email: 'bob@stoneroofing.com', company: 'Stone Roofing', website: 'stoneroofing.com',
    sells: 'Commercial roofing for property managers in Texas', plan: 'growth',
    slotStart: '2026-11-18T15:00:00.000Z', slotEnd: '2026-11-18T15:15:00.000Z', theirTz: 'America/Chicago',
  }, { now: new Date('2026-11-16T08:00:00.000Z') });
  await setInquiryStatus(r.id, 'agreement_sent', '', { now: YES });
  sent = []; alerts = [];
  return r.id;
};

test('unpaid 24 hours after the agreement: one reminder email and one hub alert, once', async () => {
  const id = await yes();
  assert.deepEqual(await chaseBookingInvoices({ now: at(23) }), { reminded: 0, held: 0 });
  assert.equal(sent.length, 0);
  assert.equal((await chaseBookingInvoices({ now: at(25) })).reminded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'bob@stoneroofing.com');
  assert.match(sent[0].subject, /^Quick note about invoice AV-/);
  assert.match(sent[0].text, /^Hi Bob,/);
  assert.match(sent[0].text, /paypal\.me\/aviance/);
  assert.deepEqual(alerts.map((a) => a.key), ['invoice_not_paid_yet']);
  await chaseBookingInvoices({ now: at(26) });
  await chaseBookingInvoices({ now: at(80) });
  assert.equal(sent.length, 1, 'only one reminder');
  assert.equal(alerts.length, 1, 'only one alert');
  assert.ok((await getInquiry(id)).invoice.remindedAt);
});

test('paid: one "paid" alert, onboarding starts, the booking is Won; marking again does nothing new', async () => {
  const id = await yes();
  const r = await bookingPaid(id, { now: at(5) });
  assert.equal(r.first, true);
  const rec = await getInquiry(id);
  assert.equal(rec.status, 'won');
  assert.ok(rec.clientId, 'they are a client now');
  assert.ok(rec.invoice.paidAt);
  assert.deepEqual(alerts.map((a) => a.key), ['client_paid']);
  assert.match(alerts[0].vars.text, /^Bob Stone from Stone Roofing paid the Growth invoice — \$3,997$/);
  const again = await bookingPaid(id, { now: at(6) });
  assert.equal(again.first, false);
  assert.equal(alerts.length, 1);
  assert.deepEqual(await chaseBookingInvoices({ now: at(30) }), { reminded: 0, held: 0 }, 'a paid booking is never chased');
});
