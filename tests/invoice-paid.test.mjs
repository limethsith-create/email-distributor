import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, getInquiry } from '@/lib/systems/inquiries';
import { invoicePaid, markPaid } from '@/lib/systems/invoice';
import { getAlertLog } from '@/lib/notify';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';

const NOW = new Date('2026-11-20T15:00:00.000Z');
let inqId, cid;

beforeEach(async () => {
  __reset();
  io.alertOwner = async () => ({ sent: true });
  io.notifyClient = async () => ({ sent: true });
  io.now = () => NOW;
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth') });
  const r = await saveInquiry({
    name: 'Sam Lee', email: 'sam@acme.test', company: 'Acme', website: 'acme.test', sells: 'Plumbing for property managers in Texas', plan: null,
    slotStart: '2026-11-23T15:00:00.000Z', slotEnd: '2026-11-23T15:15:00.000Z', theirTz: 'America/Chicago',
    whenTheirs: 'Monday at 9:00 AM CST', whenHost: 'Monday at 10:00 AM',
    role: 'Founder / CEO', dealSize: '$5,000 – $25,000', channel: 'Mostly referrals', capacity: 'Around 10', timing: 'As soon as possible',
  }, { now: NOW });
  assert.ok(r.id, JSON.stringify(r));
  inqId = r.id;
  cid = (await getInquiry(inqId)).clientId;
  assert.ok(cid, 'the booking made a client record');
  await kv.hset(K.client(cid), { name: 'Acme', contactName: 'Sam' });
  await kv.hset(K.invoice(cid), { plan: 'growth', amount: '1500', invoiceNo: 'INV-1', status: 'sent', issuedAt: NOW.toISOString() });
  const { patchInquiry } = await import('@/lib/systems/inquiries');
  await patchInquiry(inqId, { status: 'proposal' });
});

test('mark paid: one plain alert, booking moves to Won, and a second mark adds nothing', async () => {
  const one = await invoicePaid(cid, { now: NOW });
  assert.equal(one.first, true);
  assert.equal((await getInquiry(inqId)).status, 'won');
  let log = (await getAlertLog()).filter((a) => a.key === 'client_paid');
  assert.equal(log.length, 1);
  assert.match(log[0].title, /Sam from Acme paid the .* invoice — \$1,500/);
  const two = await markPaid(cid, new Date(NOW.getTime() + 1000));
  assert.equal(two.paid, true);
  log = (await getAlertLog()).filter((a) => a.key === 'client_paid');
  assert.equal(log.length, 1, 'no second alert');
});
