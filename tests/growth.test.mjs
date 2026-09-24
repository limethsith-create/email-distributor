import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { createClient } from '@/lib/db/client';
import { growthFor } from '@/lib/systems/growth';
import { addDays, dayKeyIn, ET } from '@/lib/time';

test('growth: daily history from stored counters, nulls where nothing was recorded', async () => {
  __reset();
  await createClient('acme', { name: 'Acme', state: 'sending' });
  await kv.sadd('client:acme:inboxes', 'a@x.com');
  await kv.hset('inbox:acme:a@x.com', { email: 'a@x.com', dailyCap: '12', warmupStartedAt: '2026-01-01T00:00:00Z' });
  const now = new Date();
  const today = dayKeyIn(ET, now);
  const y = addDays(today, -1);
  await kv.hset(`client:acme:counters:${today}`, { sent: 20, replies: 1, bounces: 0 });
  await kv.hset(`warmup:stats:a@x.com:${y}`, { sent: 8, inbox: 9, spam: 1 });
  await kv.hset(`warmup:stats:a@x.com:${today}`, { sent: 8, inbox: 10, spam: 0 });
  await kv.hset(`client:acme:canary:${today}`, { phase: 'done', doneAt: now.toISOString(), result: JSON.stringify({ overall: 0.9, min: 0.8, perProvider: { gmail: 1 } }) });

  const g = await growthFor('acme', { days: 10, now });
  assert.equal(g.days.length, 10);
  assert.equal(g.days[9], today);
  assert.equal(g.email.sent[9], 20);
  assert.equal(g.email.sent[8], null, 'a day with nothing recorded is null, not 0');
  assert.equal(g.email.positive[9], 0, 'on a recorded day, a counter that did not move is 0');
  assert.equal(g.warmup.sent[8], 8);
  assert.equal(g.warmup.rate[9], 0.95); // (9+10)/(9+10+1)
  assert.equal(g.inboxes[0].dailyCap, 12);
  assert.equal(g.inboxes[0].rate[8], 0.9);
  assert.equal(g.placement.length, 1);
  assert.equal(g.placement[0].inboxRate, 0.9);
  assert.equal(await growthFor('nobody'), null);
});
