import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __reset } from '@vercel/kv';
import { upsertLead } from '@/lib/leads-db';
import { summarize } from '@/lib/outreach-summary';

test('My stats: /api/mc/outreach reports the pre-trial sends (lead records) with totals, inboxes and touches, newest day first', async () => {
  __reset();
  await upsertLead({ email: 'a@acme.com', company: 'Acme', status: 'sent-d3', account_used: 'me@getaviance.site', sent_at: '2026-06-01T14:00:00.000Z', d3_sent_at: '2026-06-04T14:00:00.000Z', original_subject: 'Quick idea' });
  await upsertLead({ email: 'b@beta.com', company: 'Beta', status: 'replied', account_used: 'you@getaviance.site', sent_at: '2026-06-01T15:00:00.000Z', replied_at: '2026-06-02T09:00:00.000Z', reply_kind: 'human', reply_preview: 'Tell me more' });
  await upsertLead({ email: 'c@gamma.com', company: 'Gamma', status: 'bounced', account_used: 'me@getaviance.site', sent_at: '2026-06-02T15:00:00.000Z', bounced_at: '2026-06-02T15:05:00.000Z', bounce_reason: 'no such user' });
  const { GET } = await import('@/app/api/mc/outreach/route');
  const res = await GET();
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.deepEqual(d.totals, { sent: 4, newSends: 3, followUps: 1, opens: 0, uniqueOpens: 0, replies: 1, bounces: 1, days: 3, firstDay: '2026-06-01', lastDay: '2026-06-04' });
  assert.deepEqual(d.inboxes, [{ email: 'me@getaviance.site', sent: 3 }, { email: 'you@getaviance.site', sent: 1 }]);
  assert.equal(d.byTouch.d0, 3); assert.equal(d.byTouch.d3, 1);
  assert.deepEqual(d.days.map((x) => x.date), ['2026-06-04', '2026-06-02', '2026-06-01']);
  assert.ok(d.days.every((x) => !('opens' in x)), 'per-open rows left out');
  assert.equal(d.days[2].sent.find((s) => s.to === 'a@acme.com').subject, 'Quick idea');
  assert.equal(d.days[1].replies[0].snippet, 'Tell me more');
  assert.equal(d.days[1].bounces[0].reason, 'no such user');
});

test('My stats: summarize on no history is all zeros', () => {
  assert.deepEqual(summarize([]), { totals: { sent: 0, newSends: 0, followUps: 0, opens: 0, uniqueOpens: 0, replies: 0, bounces: 0, days: 0, firstDay: null, lastDay: null }, inboxes: [], byTouch: {}, byCampaign: {} });
});
