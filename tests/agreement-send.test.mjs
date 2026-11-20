import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, getInquiry, setInquiryStatus, STAGE_WORDS } from '@/lib/systems/inquiries';
import { salesIo } from '@/lib/systems/salescall';
import { startOnboardingAfterPayment } from '@/lib/systems/agreementsend';
import { getClient } from '@/lib/db/client';
import { getInvoice } from '@/lib/systems/invoice';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';

// The owner's yes after a sales call: the agreement and the invoice go now; onboarding waits for payment.
const NOW = new Date('2026-11-20T10:00:00.000Z');
const site = (over = {}) => ({
  name: 'Bob Stone', email: 'bob@stoneroofing.com', company: 'Stone Roofing', website: 'stoneroofing.com',
  sells: 'Commercial roofing for property managers in Texas', plan: 'growth',
  slotStart: '2026-11-18T15:00:00.000Z', slotEnd: '2026-11-18T15:15:00.000Z', theirTz: 'America/Chicago',
  whenTheirs: 'Wednesday at 9:00 AM CST', whenHost: 'Wednesday at 8:30 PM',
  ...over,
});
let sent = [];
let clientMails = [];

beforeEach(async () => {
  __reset();
  sent = []; clientMails = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth'), 'PAYMENT.paypalMe': JSON.stringify('https://paypal.me/aviance') });
  salesIo.sender = async () => ({ email: 'calls@aviance.test' });
  salesIo.send = async (account, mail) => { sent.push({ from: account.email, ...mail }); return { success: true, messageId: `<m${sent.length}@x>` }; };
  io.alertOwner = async () => ({ sent: true });
  io.notifyClient = async (clientId, key) => { clientMails.push(key); return { sent: true }; };
  io.now = () => NOW;
});

const booked = async (over) => {
  const r = await saveInquiry(site(over), { now: new Date('2026-11-16T08:00:00.000Z') });
  sent = []; clientMails = [];
  return r.id;
};

test('the yes: agreement and invoice are emailed at once, the stage moves, onboarding does not start', async () => {
  assert.equal(STAGE_WORDS.agreement_sent, 'Agreement and invoice sent');
  const id = await booked();
  const held = (await getInquiry(id)).clientId;
  const rec = await setInquiryStatus(id, 'agreement_sent', '', { now: NOW });
  assert.equal(rec.status, 'agreement_sent');

  assert.equal(sent.length, 2, 'two emails: the agreement and the invoice');
  const [agr, inv] = sent;
  assert.equal(agr.to, 'bob@stoneroofing.com');
  assert.equal(agr.from, 'calls@aviance.test');
  assert.equal(agr.subject, 'Your Aviance agreement');
  assert.match(agr.text, /^Hi Bob,/);
  assert.match(agr.text, /Growth plan: 20 booked calls a month for \$3,997 a month/);
  assert.match(agr.text, /Aviance Client Service Agreement/);
  assert.match(agr.text, /For Aviance Inc\.: Limeth, Founder/);
  assert.equal(agr.attachments.length, 1);
  assert.match(agr.attachments[0].filename, /^Aviance-Service-Agreement-AG-202611-.+\.html$/);
  assert.match(agr.attachments[0].content, /Stone Roofing/);
  assert.match(inv.subject, /^Invoice AV-202611-/);
  assert.match(inv.text, /Total due: \$3,997/);
  assert.match(inv.text, /PayPal: https:\/\/paypal\.me\/aviance\/3997USD/);
  assert.ok(sent.every((m) => m.transactional && m.noTrack));

  const q = await getInquiry(id);
  assert.equal(q.agreement.plan, 'growth');
  assert.ok(q.agreement.sentAt && q.agreement.hash);
  assert.deepEqual([q.invoice.status, q.invoice.amount, q.invoice.calls], ['sent', 3997, 20]);

  // Onboarding has not started: no accepted_call email, the held record is still waiting.
  assert.deepEqual(clientMails, []);
  if (held) assert.equal((await getClient(held)).state, 'applied');

  // Pressing it again sends nothing new.
  await setInquiryStatus(id, 'agreement_sent', '', { now: NOW });
  assert.equal(sent.length, 2);
});

test('the yes needs the payment details and the signer: nothing is sent and the booking stays put', async () => {
  const id = await booked();
  await kv.hdel('system:config', 'PAYMENT.paypalMe');
  await assert.rejects(() => setInquiryStatus(id, 'agreement_sent', '', { now: NOW }), /No payment method is set/);
  assert.equal(sent.length, 0);
  assert.equal((await getInquiry(id)).status, 'new');
});

test('a failed invoice email: the agreement is kept as sent, a retry sends only the invoice', async () => {
  const id = await booked();
  const ok = salesIo.send;
  salesIo.send = async (account, mail) => (/^Invoice/.test(mail.subject) ? { success: false, error: 'smtp down' } : ok(account, mail));
  await assert.rejects(() => setInquiryStatus(id, 'agreement_sent', '', { now: NOW }), /smtp down/);
  assert.equal((await getInquiry(id)).status, 'new');
  assert.equal(sent.length, 1);
  salesIo.send = ok;
  await setInquiryStatus(id, 'agreement_sent', '', { now: NOW });
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /^Invoice/);
  assert.equal((await getInquiry(id)).status, 'agreement_sent');
});

test('payment received: onboarding starts then (one accepted_call), the invoice is paid on the client, no second invoice', async () => {
  const id = await booked();
  await setInquiryStatus(id, 'agreement_sent', '', { now: NOW });
  const r = await startOnboardingAfterPayment(id, { now: NOW });
  assert.ok(r.clientId);
  assert.equal(r.inquiry.status, 'won');
  assert.deepEqual(clientMails, ['accepted_call']);
  assert.equal((await getInquiry(id)).invoice.status, 'paid');
  const inv = await getInvoice(r.clientId);
  assert.equal(inv.status, 'paid');
  assert.ok(inv.paidAt);
  // The onboarding page's month-one invoice is then a no-op.
  const { createInvoice } = await import('@/lib/systems/invoice');
  assert.equal((await createInvoice(r.clientId, 'growth', { now: NOW })).status, 'paid');
  assert.ok(await kv.hgetall(K.invoice(r.clientId)));
  // Twice is safe.
  const again = await startOnboardingAfterPayment(id, { now: NOW });
  assert.equal(again.clientId, r.clientId);
  assert.deepEqual(clientMails, ['accepted_call']);
});
