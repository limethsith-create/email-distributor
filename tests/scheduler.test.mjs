import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { runTick } from '@/lib/scheduler';
import { JOBS } from '@/lib/jobs';
import { createClient } from '@/lib/db/client';

test('a job runs once per period even when two pingers hit the same minute', async () => {
  __reset();
  let runs = 0;
  JOBS.push({ name: 'probe', scope: 'global', cost: 0, due: async () => 'P1', run: async () => { runs++; return { ok: true }; } });
  const a = await runTick({ source: 'cronjob', only: 'probe' });
  const b = await runTick({ source: 'github', only: 'probe' });
  JOBS.pop();
  assert.equal(runs, 1);
  assert.equal(a.ran[0].job, 'probe:global');
  assert.equal(b.skipped[0].reason, 'claimed');
  assert.equal((await kv.hgetall('system:heartbeat')).lastTickSource, 'github');
});

test('three failures in a row raise job_failing; one client failing does not stop another', async () => {
  __reset();
  await createClient('good', { state: 'sending' });
  await createClient('bad', { state: 'sending' });
  let period = 0;
  const seen = [];
  JOBS.push({
    name: 'flaky', scope: 'client', cost: 0,
    due: async () => `P${period}`,
    run: async ({ clientId }) => { seen.push(clientId); if (clientId === 'bad') throw new Error('boom'); return 'ok'; },
  });
  for (period = 1; period <= 3; period++) await runTick({ source: 'test', only: 'flaky' });
  JOBS.pop();
  assert.equal(seen.filter((x) => x === 'good').length, 3);
  const log = await kv.lrange('system:alerts:log', 0, -1);
  assert.equal(log.length, 1);
  assert.equal(log[0].key, 'job_failing');
  assert.equal(log[0].clientId, 'bad');
  const events = await kv.lrange('client:bad:events', 0, -1);
  assert.ok(events.some((e) => e.event === 'job_error'));
});
