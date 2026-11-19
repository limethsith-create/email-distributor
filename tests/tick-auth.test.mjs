import { test } from 'node:test';
import assert from 'node:assert/strict';

// Only the auth gate: a wrong or missing key is refused before any tick work starts.
const { GET } = await import('@/app/api/cron/tick/route');
const req = (auth) => new Request('https://x.test/api/cron/tick?source=cronjob', { headers: auth ? { authorization: auth } : {} });

test('the tick takes CRON_SECRET or the separate TICK_SECRET, and nothing else', async () => {
  process.env.CRON_SECRET = 'cron-secret-value';
  process.env.TICK_SECRET = 'a-long-pinger-only-key-123';
  assert.equal((await GET(req(null))).status, 401);
  assert.equal((await GET(req('Bearer wrong'))).status, 401);
  assert.equal((await GET(req('Bearer a-long-pinger-only-key-12'))).status, 401);
  assert.notEqual((await GET(req('Bearer a-long-pinger-only-key-123'))).status, 401, 'TICK_SECRET gets in');
  assert.notEqual((await GET(req('Bearer cron-secret-value'))).status, 401, 'CRON_SECRET still gets in');
  // A too-short TICK_SECRET is ignored (never a weak way in).
  process.env.TICK_SECRET = 'short';
  assert.equal((await GET(req('Bearer short'))).status, 401);
  delete process.env.TICK_SECRET;
});

test('a TICK_SECRET pasted with a stray space, line break or "Bearer " in front still works', async () => {
  process.env.CRON_SECRET = 'cron-secret-value';
  for (const pasted of ['  a-long-pinger-only-key-123\n', 'Bearer a-long-pinger-only-key-123', 'a-long-pinger-only-key-123\r\n']) {
    process.env.TICK_SECRET = pasted;
    assert.notEqual((await GET(req('Bearer a-long-pinger-only-key-123'))).status, 401, JSON.stringify(pasted));
    assert.equal((await GET(req('Bearer something-else-entirely-xyz'))).status, 401);
  }
  delete process.env.TICK_SECRET;
});

test('through the middleware too (the real request path): TICK_SECRET gets to the tick, nowhere else', async () => {
  const { middleware } = await import('@/middleware');
  process.env.CRON_SECRET = 'cron-secret-value';
  process.env.TICK_SECRET = 'a-long-pinger-only-key-123\n';
  const mw = (path, auth) => { const url = `https://email-distributor.vercel.app${path}`; return middleware({ url, method: 'GET', nextUrl: new URL(url), headers: new Headers(auth ? { authorization: auth } : {}), cookies: { get: () => undefined } }); };
  const through = (r) => r.headers.get('x-middleware-next') === '1';
  assert.ok(through(await mw('/api/cron/tick?source=cronjob', 'Bearer a-long-pinger-only-key-123')), 'the pinger gets through');
  assert.equal((await mw('/api/cron/tick', 'Bearer wrong-wrong-wrong-wrong')).status, 401);
  assert.equal((await mw('/api/cron/tick', null)).status, 401);
  assert.equal((await mw('/api/admin/export', 'Bearer a-long-pinger-only-key-123')).status, 401, 'TICK_SECRET opens nothing but the tick');
  assert.ok(through(await mw('/api/admin/export', 'Bearer cron-secret-value')), 'CRON_SECRET unchanged');
  delete process.env.TICK_SECRET;
});
