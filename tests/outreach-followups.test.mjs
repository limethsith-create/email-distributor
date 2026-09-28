// The owner's own outreach (legacy engine, /api/cron/auto-send): one email per
// person. Config OUTREACH_FOLLOWUPS (default false) keeps due follow-ups out of
// the queue — neither sent nor expired; true brings the old sequence back.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { __reset, kv } from '@vercel/kv';
import { partitionLeads, outreachFollowUpsOn } from '@/lib/outreach-queue';
import { defaultOf } from '@/lib/config';

beforeEach(() => { __reset(); });

const DAY = 86400e3;
function leads(now) {
  const iso = (ms) => new Date(now.getTime() - ms).toISOString();
  return {
    'due@a.test': { email: 'due@a.test', status: 'sent-d0', sent_at: iso(3.5 * DAY), account_used: 'me@aviance.test' },            // d3 due
    'late@b.test': { email: 'late@b.test', status: 'sent-d0', sent_at: iso(30 * DAY), account_used: 'me@aviance.test' },           // d3 long past due
    'd7@c.test': { email: 'd7@c.test', status: 'sent-d3', sent_at: iso(8 * DAY), d3_sent_at: iso(4.5 * DAY), account_used: 'me@aviance.test' },
    'new@d.test': { email: 'new@d.test', status: 'pending', company: 'D Co', industry: 'IT services', title: 'Owner', first_name: 'Dee', website: 'https://d.test' },
  };
}

test('follow-ups off by default: only first emails — due follow-ups are neither sent nor expired', async () => {
  assert.equal(defaultOf('OUTREACH_FOLLOWUPS'), false);
  assert.equal(await outreachFollowUpsOn(), false);
  const now = new Date('2026-09-28T15:00:00Z');
  const off = partitionLeads(leads(now), now, { followUps: false });
  assert.deepEqual(off.followUps, []);
  assert.deepEqual(off.expired, []);
  const on = partitionLeads(leads(now), now, { followUps: true });
  assert.deepEqual(on.followUps.map((f) => [f.lead.email, f.day]).sort(), [['d7@c.test', 7], ['due@a.test', 3]]);
  assert.deepEqual(on.expired.map((f) => f.lead.email), ['late@b.test']);
  assert.deepEqual(off.fresh, on.fresh, 'the first-email pool is the same either way');

  // turning it back on (config, /mc/config)
  await kv.hset('system:config', { OUTREACH_FOLLOWUPS: 'true' });
  assert.equal(await outreachFollowUpsOn(), true);

  // the sender reads the switch and passes it to the scan
  const src = readFileSync(new URL('../src/app/api/cron/auto-send/route.js', import.meta.url), 'utf8');
  assert.match(src, /const followUpsOn = await outreachFollowUpsOn\(\);\n\s+const \{ fresh, followUps, stuck, expired \} = partitionLeads\(leadsMap, now, \{ followUps: followUpsOn \}\);/);
});
