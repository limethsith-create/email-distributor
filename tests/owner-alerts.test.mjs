import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset } from '@vercel/kv';
import * as notify from '@/lib/notify';

beforeEach(() => __reset());

test('an owner alert is only recorded for the hub: no email, phone or Telegram', async () => {
  assert.equal(notify.sendOwnerEmail, undefined);
  assert.equal(notify.sendTelegram, undefined);
  const realFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = async () => { outside++; return new Response('{}'); };
  try {
    const r = await notify.alertOwner('usage_80', { vars: { service: 'places', pct: 81 }, body: 'places: 810 of 1000.', did: 'Nothing yet.' });
    assert.equal(r.sent, true);
    assert.equal(outside, 0, 'nothing leaves the machine');
  } finally { globalThis.fetch = realFetch; }
  const [a] = await notify.getAlertLog();
  assert.equal(a.key, 'usage_80');
  assert.equal(a.acknowledged, false);
  assert.equal(a.body, 'places: 810 of 1000.');
  assert.equal(a.channels, undefined);
  // Same alert again the same day: deduped, still one in the list.
  assert.equal((await notify.alertOwner('usage_80', { vars: { service: 'places', pct: 81 } })).deduped, true);
  assert.equal((await notify.getAlertLog()).length, 1);
});
