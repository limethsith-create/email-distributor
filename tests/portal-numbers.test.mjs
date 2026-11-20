import crypto from 'node:crypto';
process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { createClient, updateClient } from '@/lib/db/client';
import { saveInbox, patchInbox } from '@/lib/db/inboxes';
import { K } from '@/lib/db/keys';
import { dayKeyIn, addDays, ET } from '@/lib/time';
import { GET } from '@/app/api/mc/portal/numbers/route';

beforeEach(() => { __reset(); });
const call = (qs, headers = {}) => GET(new Request(`http://x/api/mc/portal/numbers${qs}`, { headers }));
const today = () => dayKeyIn(ET, new Date());

async function seed(id, name) {
  await createClient(id, { name, contactEmail: `o@${id}.com`, mainDomain: `${id}.com`, plan: 'growth', state: 'sending' });
  await kv.hset(K.countersDay(id, today()), { sent: 12, replies: 3, positive: 2, booked: 1 });
  await kv.hset(K.countersDay(id, addDays(today(), -2)), { sent: 8, replies: 1 });
  await saveInbox(id, { email: `a@${id}.com`, password: 'x', enabled: true });
  await patchInbox(id, `a@${id}.com`, { dailyCap: '25', warmupStartedAt: new Date(Date.now() - 20 * 86400e3).toISOString() });
  await saveInbox(id, { email: `b@${id}.com`, password: 'x', enabled: false });
  await kv.hincrby(K.inboxSends(id, today()), `a@${id}.com`, 12);
}

test('numbers: contract shape, 30 days filled, totals and inboxes', async () => {
  await seed('oak', 'Oak Legal');
  const r = await call('?clientId=oak');
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.deepEqual(Object.keys(v).sort(), ['client', 'days', 'inboxes', 'next', 'ok', 'sources', 'today', 'totals', 'updatedAt', 'warmup']);
  assert.equal(v.client.name, 'Oak Legal');
  assert.equal(v.days.length, 30);
  assert.equal(v.days[29].day, today());
  assert.deepEqual(v.today, { sent: 12, replies: 3, interested: 2, booked: 1 });
  assert.equal(v.days[0].sent, 0, 'empty days are zeros');
  assert.equal(v.totals.sent, 20);
  assert.equal(v.totals.replyRate, 0.2);
  assert.deepEqual(v.sources, [{ name: 'Aviance', kind: 'native' }]);
  const a = v.inboxes.find((i) => i.email.startsWith('a@'));
  const b = v.inboxes.find((i) => i.email.startsWith('b@'));
  assert.equal(a.health, 'good'); assert.equal(a.healthWords, 'Healthy'); assert.equal(a.sentToday, 12); assert.equal(a.limit, 25);
  assert.equal(b.health, 'paused'); assert.equal(b.healthWords, 'Paused');
  await patchInbox('oak', b.email, { disabledReason: 'login failed' });
  assert.equal((await (await call('?clientId=oak')).json()).inboxes.find((i) => i.email.startsWith('b@')).health, 'problem');
});

test('numbers: a brand-new client is all zeros and a client header beats the query', async () => {
  await createClient('elm', { name: 'Elm', contactEmail: 'e@elm.com', mainDomain: 'elm.com', plan: 'trial', state: 'warming' });
  const v = await (await call('?clientId=elm')).json();
  assert.equal(v.days.length, 30);
  assert.ok(v.days.every((d) => d.sent === 0 && d.replies === 0));
  assert.equal(v.totals.replyRate, 0);
  assert.equal(v.warmup.state, 'warming');
  await seed('oak', 'Oak Legal');
  const w = await (await call('?clientId=oak', { 'x-hub-role': 'client', 'x-hub-client': 'elm' })).json();
  assert.equal(w.client.name, 'Elm');
  assert.equal((await call('', { 'x-hub-role': 'client' })).status, 403);
  assert.equal((await call('')).status, 400);
  assert.equal((await call('?clientId=nobody')).status, 404);
});

test('numbers: nothing unsafe leaves', async () => {
  await seed('oak', 'Oak Legal');
  await updateClient('oak', { fitScore: '9', internalNotes: 'secret', invoiceTotal: '900', mrr: '500' }).catch(() => {});
  const v = await (await call('?clientId=oak')).json();
  const keys = new Set();
  (function walk(o) { if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { keys.add(k); walk(x); } })(v);
  for (const k of keys) assert.ok(!/price|cost|money|invoice|note|fit|grade|lead|password|mrr|revenue|paid/i.test(k), 'unsafe key ' + k);
  const text = JSON.stringify(v);
  assert.ok(!/secret|passwordEnc|900/.test(text));
  assert.deepEqual(Object.keys(v.inboxes[0]).sort(), ['email', 'health', 'healthWords', 'limit', 'sentToday', 'warmupDay', 'warmupOf']);
});
