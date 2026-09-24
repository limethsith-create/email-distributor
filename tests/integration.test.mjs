// Integration pass: the seams between Stages A–D (shared jobs, clocks,
// suppression, converted sending, digests). Fake KV, no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient, getClient, holdSending, SENDING_STATES } from '@/lib/db/client';
import { saveInbox } from '@/lib/db/inboxes';
import { insertLeads } from '@/lib/db/leads';
import { initCounters } from '@/lib/db/counters';
import { setDeps, resetDeps } from '@/lib/systems/stagec-common';

process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.CRON_SECRET = process.env.CRON_SECRET || 'integration-secret';

beforeEach(() => { __reset(); resetDeps(); });

test('job names are unique across every stage file; aviance jobs refuse any other client', async () => {
  const { JOBS, duplicateJobNames } = await import('@/lib/jobs');
  assert.deepEqual(duplicateJobNames(), []);
  for (const name of ['aviance-send', 'aviance-replies', 'aviance-eod-report']) {
    const job = JOBS.find((j) => j.name === name);
    assert.ok(job, name);
    assert.deepEqual(await job.run({ clientId: 'acme', client: { id: 'acme', state: 'sending' }, now: new Date(), deadline: Date.now() + 1000 }), { skipped: 'aviance engine only' });
  }
});

test('every client job of Stages A–C sees the Test Mode clock; others see real time', async () => {
  const { JOBS } = await import('@/lib/jobs');
  const { onClientClock } = await import('@/lib/joblist/helpers');
  const seen = [];
  const probe = onClientClock({ name: 'probe', scope: 'client', async due(ctx) { seen.push(ctx.now.toISOString()); return null; }, async run() {} });
  const real = new Date('2026-10-06T15:00:00Z');
  const origin = '2026-10-06T14:00:00Z';
  await probe.due({ client: { id: '_test', clockScale: '24', clockOrigin: origin, clockOffsetMs: '0' }, now: real });
  await probe.due({ client: { id: 'acme' }, now: real });
  assert.equal(seen[0], new Date(Date.parse(origin) + 3600e3 * 24).toISOString()); // one real hour = one day
  assert.equal(seen[1], real.toISOString());
  // The A/B/C lists are wrapped (their client jobs are not the raw objects).
  const { JOBS: C } = await import('@/lib/joblist/stage-c');
  assert.ok(C.filter((j) => j.scope === 'client').every((j) => JOBS.includes(j)));
});

test('/api/unsubscribe adds the address to suppression:global and the legacy set', async () => {
  const { buildUnsubscribeToken } = await import('@/lib/tokens');
  const { GET } = await import('@/app/api/unsubscribe/route');
  const t = buildUnsubscribeToken('Pat@Example.com');
  const res = await GET(new Request(`https://x.test/api/unsubscribe?t=${encodeURIComponent(t)}`));
  assert.equal(res.status, 200);
  assert.equal(await kv.sismember(K.suppression(), 'pat@example.com'), 1);
  assert.equal(await kv.sismember('suppression', 'pat@example.com'), 1);
});

test('converted keeps sending on the trial pair; emergency or a send hold stops it without a state change', async () => {
  assert.ok(SENDING_STATES.has('converted'));
  const sent = [];
  setDeps({
    sendEmail: async (account, opts) => { sent.push(opts); return { success: true, messageId: `<c${sent.length}@t>` }; },
    alertOwner: async () => ({ sent: true }),
    verifyEmail: async () => ({ valid: true }),
  });
  await createClient('acme', { state: 'converted', name: 'Acme IT', contactEmail: 'boss@acmeit.com' });
  await kv.hset(K.profile('acme'), { senderName: 'Jane Doe', postalAddress: '1 Main St, Dover, DE 19901' });
  await kv.hset(K.trial('acme'), { day1Date: '2026-09-01', firstSendAt: '2026-09-01T13:00:00Z' });
  await saveInbox('acme', { email: 'jane@acme-team.com', password: 'pw', displayName: 'Jane Doe', enabled: true, dailyCap: '25' });
  const seq = { footer: '{SenderName}\n{postalAddress}\n\nNot the right fit? Just reply STOP and I will not email you again.', touches: [{ touch: 'd0', thread: 'new', subject: 'Idea for {Company}', body: 'Hi {FirstName},\n\nA note for {Company}. Worth a chat?' }, { touch: 'd3', thread: 'd0', body: 'Following up. Worth a chat?' }, { touch: 'd7', thread: 'new', subject: 'Quick one', body: 'One more. Open to it?' }, { touch: 'd10', thread: 'd7', body: 'Closing the file. Should I?' }] };
  await kv.hset(K.sequence('acme'), { variantA: JSON.stringify(seq), variantB: JSON.stringify(seq), active: 'both', version: 1 });
  await initCounters('acme');
  await kv.hset(K.sendState('acme'), { smokeClearedAt: '2026-09-02T00:00:00Z' });
  await insertLeads('acme', [{ email: 'ann@alpha.com', first_name: 'Ann', company: 'Alpha Inc', tz: 'America/New_York', riskLevel: 'safe' }, { email: 'bob@beta.com', first_name: 'Bob', company: 'Beta Inc', tz: 'America/New_York', riskLevel: 'safe' }]);
  const { runSender } = await import('@/lib/systems/sender');
  const NOW = new Date('2026-10-06T15:00:00Z');
  assert.equal((await runSender('acme', { now: NOW })).sent, 1);
  await kv.del(K.pacing('acme'));
  await kv.hset(K.client('acme'), { emergencyActive: '1' });
  assert.match((await runSender('acme', { now: NOW })).skipped, /emergency/);
  await kv.hset(K.client('acme'), { emergencyActive: '0' });
  assert.equal(await holdSending('acme', 'blacklisted'), 'held');
  assert.equal((await getClient('acme')).state, 'converted');
  assert.match((await runSender('acme', { now: NOW })).skipped, /held/);
  assert.equal(sent.length, 1);
});

test('morning digest leads with Price Scout escalations and untested booking links', async () => {
  const { morningDigest } = await import('@/lib/systems/digests');
  await createClient('buyme', { state: 'awaiting_purchase', name: 'Buy Me Co' });
  await kv.hset(K.shopping('buyme'), { sentAt: '2026-10-01T10:00:00Z', escalatedAt: '2026-10-03T10:00:00Z', chosenDomain: 'getbuyme.com' });
  await createClient('warmco', { state: 'warming', name: 'Warm Co' });
  await kv.hset(K.profile('warmco'), { bookingRequestSentAt: '2026-10-05T10:00:00Z' });
  await kv.hset(K.trial('warmco'), { signedDay: '2026-09-25', day1Date: '2026-10-09' });
  await createClient('okco', { state: 'warming', name: 'OK Co' });
  await kv.hset(K.profile('okco'), { bookingRequestSentAt: '2026-10-05T10:00:00Z', bookingTested: '1' });
  const r = await morningDigest({ now: new Date('2026-10-06T02:30:00Z'), send: false });
  const lines = r.body.split('\n');
  assert.match(lines[0], /^NOT BOUGHT: Buy Me Co — shopping list sent 112 h ago \(getbuyme\.com\)/);
  assert.match(lines[1], /^Booking link untested: Warm Co \(Day -4\)/);
  assert.doesNotMatch(r.body, /OK Co/);
  assert.equal(r.allGreen, false);
});

test('Test Mode: a scaled _test client runs its Stage A–C jobs on the virtual clock', async () => {
  const { startTest } = await import('@/lib/systems/testmode');
  const { runTick } = await import('@/lib/scheduler');
  const { minuteKey } = await import('@/lib/joblist/helpers');
  const { partsIn, ET } = await import('@/lib/time');
  setDeps({ alertOwner: async () => ({ sent: true }), sendEmail: async () => ({ success: true, messageId: '<x@t>' }), verifyEmail: async () => ({ valid: true }) });
  process.env.OWNER_EMAIL = 'owner@aviance.test';
  const origin = new Date('2026-10-06T04:00:00Z'); // Tue 00:00 ET — no sending hours in real time
  await startTest({ from: 'sending', now: origin }); // clockScale 24: one real hour = one day
  const real = new Date(origin.getTime() + 30 * 60_000); // 00:30 real → 12:00 ET virtual
  await runTick({ source: 'test', now: real, only: 'send', clientId: '_test' });
  const c = await getClient('_test');
  assert.equal(c['jp:send'], minuteKey(partsIn(ET, new Date(origin.getTime() + 12 * 3600e3))));
});
