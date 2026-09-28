/**
 * Your own outreach so far, for the hub's My stats page (docs/HUB-API.md).
 *
 * The pre-trial engine (/api/cron/auto-send) records its sends on the lead
 * records and in sent_log / daily_sends, not in the per-client counters the
 * hub's `aviance` row reads, so those emails never showed in the hub. This is
 * the same day-by-day report /activity uses (/api/daily-log), reachable with
 * the hub's sign-in because it lives under /api/mc/, plus the totals across
 * every day:
 *
 *   { totals: {sent, newSends, followUps, opens, uniqueOpens, replies, bounces,
 *              days, firstDay, lastDay},
 *     inboxes: [{email, sent}],           // most sent first
 *     byTouch: {d0, d3, d7}, byCampaign: {...},
 *     days: [{date, summary, accountBreakdown, byTouch, sent, replies, bounces}],  // newest first
 *     timestamp }
 *
 * Per-open rows are left out of `days` (only the day's open counts, in
 * summary) to keep the answer small.
 */

import { GET as dailyLog } from '@/app/api/daily-log/route';
import { summarize } from '@/lib/outreach-summary';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const res = await dailyLog();
  const data = await res.json();
  if (!res.ok || !data.success) return Response.json({ error: data.error || 'Could not read the sending history.' }, { status: res.status >= 400 ? res.status : 500 });
  const days = (data.days || []).map(({ opens, ...d }) => d);
  return Response.json({ ...summarize(days), days, timestamp: data.timestamp });
}
