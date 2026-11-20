import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { createClient } from '@/lib/db/client';
import { previewCleanup, applyCleanup, clientTestReasons, bookingTestReasons } from '@/lib/systems/cleanup';

beforeEach(() => __reset());

async function seed() {
  await createClient('stone-roofing', { name: 'Stone Roofing', contactEmail: 'bob@stoneroofing.com', state: 'sending' });
  await createClient('demo-harbor-dental', { name: 'Harbor Dental', contactEmail: 'a@harbor.example', demo: '1' });
  await createClient('_test', { name: 'Test Mode' });
  await createClient('acme-test-prep', { name: 'Test Prep Pros', contactEmail: 'sam@testprep.com' });
  await createClient('zed-co', { name: 'Test', contactEmail: 'x@example.com' });
  await createClient('aviance', { name: 'Aviance' });
  for (const id of ['stone-roofing', 'demo-harbor-dental', '_test', 'zed-co']) await kv.hset(`client:${id}:profile`, { note: id });
  await kv.hset('inbox:demo-harbor-dental:x@harbor.example', { a: 1 });
  await kv.hset('inbox:stone-roofing:s@stone.com', { a: 1 });
  await kv.set('client:demo-harbor-dental:token:dashboard', { hash: 'abc' });
  await kv.set('tokenidx:abc', { clientId: 'demo-harbor-dental' });
  const rows = {
    b1: { id: 'b1', name: 'Bob Stone', email: 'bob@stoneroofing.com', company: 'Stone Roofing', status: 'new' },
    b2: { id: 'b2', name: 'Tess', email: 'tess@example.com', company: 'Acme', status: 'new' },
    b3: { id: 'b3', name: 'Test', email: 'real@gmail.com', company: 'Test', status: 'new' },
  };
  await kv.hset('inquiries', rows);
  await kv.rpush('inquiries:order', 'b1', 'b2', 'b3');
  await kv.sadd('demo:keys', 'client:demo-harbor-dental', 'tokenidx:abc'); await kv.hset('demo:meta', { loadedAt: 'x' });
}

test('matchers: clear test records only', () => {
  assert.equal(clientTestReasons('stone-roofing', { name: 'Stone Roofing', contactEmail: 'b@stone.com' }).reasons.length, 0);
  assert.equal(clientTestReasons('acme', { name: 'Test Prep Pros' }).reasons.length, 0);
  assert.equal(clientTestReasons('aviance', { demo: '1' }).reasons.length, 0);
  assert.ok(clientTestReasons('demo-x', {}).strong);
  assert.equal(clientTestReasons('x', { name: 'Test' }).strong, false);
  assert.equal(bookingTestReasons({ email: 'a@gmail.com', name: 'Test Person', company: 'Test Roofing' }).reasons.length, 0);
});

test('preview lists only test records, with reasons, and changes nothing', async () => {
  await seed();
  const before = JSON.stringify(await kv.hgetall('client:stone-roofing'));
  const p = await previewCleanup();
  const ids = p.clients.map((c) => c.id).sort();
  assert.deepEqual(ids, ['_test', 'demo-harbor-dental', 'zed-co']);
  assert.ok(p.clients.every((c) => c.reasons.length && c.label));
  assert.equal(p.clients.find((c) => c.id === 'zed-co').strong, false);
  assert.equal(p.clients.find((c) => c.id === 'demo-harbor-dental').strong, true);
  assert.deepEqual(p.bookings.map((b) => b.id).sort(), ['b2', 'b3']);
  assert.equal(p.keys.length, 1);
  assert.equal(JSON.stringify(await kv.hgetall('client:stone-roofing')), before);
  assert.equal(await kv.exists('client:demo-harbor-dental'), 1);
});

test('apply removes exactly the confirmed ids and skips real or stale ones', async () => {
  await seed();
  const r = await applyCleanup(['client:demo-harbor-dental', 'client:stone-roofing', 'booking:b2', 'booking:b1', 'client:nope']);
  assert.deepEqual(r.removed.map((x) => x.id).sort(), ['b2', 'demo-harbor-dental']);
  assert.deepEqual(r.skipped.map((x) => x.id).sort(), ['b1', 'nope', 'stone-roofing']);
  assert.equal(await kv.exists('client:demo-harbor-dental', 'inbox:demo-harbor-dental:x@harbor.example', 'tokenidx:abc', 'client:demo-harbor-dental:profile'), 0);
  assert.equal(await kv.exists('client:stone-roofing'), 1);
  assert.equal(await kv.exists('inbox:stone-roofing:s@stone.com'), 1);
  assert.equal(await kv.exists('client:_test'), 1, 'not confirmed, so kept');
  assert.ok(!(await kv.smembers('clients')).includes('demo-harbor-dental'));
  assert.ok((await kv.smembers('clients')).includes('stone-roofing'));
  assert.deepEqual(await kv.lrange('inquiries:order', 0, -1), ['b1', 'b3']);
  assert.equal(await kv.hget('inquiries', 'b2'), null);
  assert.ok(await kv.hget('inquiries', 'b1'));
  assert.equal((await applyCleanup([])).ok, false);
});

test('the route: owner only', async () => {
  await seed();
  const { POST } = await import('@/app/api/mc/cleanup/route');
  const mk = (role, body) => new Request('http://x/api/mc/cleanup', { method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { 'x-hub-role': role } : {}) }, body: JSON.stringify(body) });
  assert.equal((await POST(mk('employee', { action: 'preview' }))).status, 403);
  assert.equal((await POST(mk(null, { action: 'preview' }))).status, 403);
  const res = await POST(mk('admin', { action: 'preview' }));
  assert.equal((await res.json()).counts.clients, 3);
  const ap = await (await POST(mk('admin', { action: 'apply', ids: ['client:zed-co'] }))).json();
  assert.equal(ap.removed.length, 1);
  assert.equal((await POST(mk('admin', { action: 'x' }))).status, 400);
});
