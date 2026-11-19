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
