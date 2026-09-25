import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { savePushSub, removePushSub, pushStatus, pushToOwner, pushIo, vapid } from '@/lib/push';
import { alertOwner } from '@/lib/notify';

const sub = (n) => ({ endpoint: `https://web.push.apple.com/abc${n}`, keys: { p256dh: 'BPk' + n, auth: 'au' + n } });
let sent = [];

beforeEach(() => {
  __reset();
  sent = [];
  process.env.VAPID_PUBLIC_KEY = 'BPUBLICKEYxx';
  process.env.VAPID_PRIVATE_KEY = 'privatekeyxx';
  pushIo.send = async (s, payload, opts) => {
    if (s.endpoint.endsWith('gone')) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
    sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), opts });
    return { statusCode: 201 };
  };
});

test('subscribe, status, unsubscribe', async () => {
  assert.deepEqual(await savePushSub(sub(1), 'iPhone · Safari'), { count: 1 });
  await savePushSub(sub(1), 'iPhone · Safari'); // same phone again: still one
  assert.deepEqual(await pushStatus(sub(1).endpoint), { subscribed: true, count: 1 });
  await assert.rejects(() => savePushSub({ endpoint: 'http://insecure', keys: {} }), /not a push subscription/);
  await removePushSub(sub(1).endpoint);
  assert.deepEqual(await pushStatus(sub(1).endpoint), { subscribed: false, count: 0 });
});

test('push goes to every phone; a gone phone is removed; no keys = not configured', async () => {
  await savePushSub(sub(1));
  await savePushSub({ ...sub(2), endpoint: 'https://fcm.googleapis.com/x/gone' });
  const r = await pushToOwner({ title: 'T', body: 'B', url: '/#alerts', tag: 'k', urgent: true });
  assert.equal(r.sent, 1);
  assert.equal(r.removed, 1);
  assert.equal(sent[0].payload.title, 'T');
  assert.equal(sent[0].opts.urgency, 'high');
  assert.equal((await pushStatus()).count, 1);
  delete process.env.VAPID_PRIVATE_KEY;
  assert.equal(vapid(), null);
  assert.equal((await pushToOwner({ title: 'x' })).error, 'push not configured');
});

test('every owner alert pops up on the phone, linked to the trial', async () => {
  await savePushSub(sub(1));
  const r = await alertOwner('new_application', { clientId: 'acme', vars: { company: 'Acme Plumbing' }, body: 'Ann Lee applied for a trial.', did: 'Held for review.' });
  assert.equal(r.channels.push, 'ok');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Urgent: New trial application: Acme Plumbing');
  assert.equal(sent[0].payload.url, '/#trial/acme');
  assert.match(sent[0].payload.body, /Ann Lee applied/);
  // Non-urgent alerts go to the phone too, without the "Urgent" prefix.
  await alertOwner('usage_80', { vars: { service: 'places', pct: 81 }, body: 'places: 810 of 1000.' });
  assert.equal(sent[1].payload.title, 'places at 81% of the free monthly limit');
  assert.equal(sent[1].payload.url, '/#alerts');
});
