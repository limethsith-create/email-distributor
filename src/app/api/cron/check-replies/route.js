/**
 * Reply Checker Cron Endpoint
 *
 * Connects to every sending inbox via IMAP, checks for replies to outreach
 * emails, classifies them (human / OOO / auto-ack / bounce) and updates lead
 * status in the database. The scan itself is bounded by a deadline so the
 * auto-reply phase always finishes inside the function's budget.
 *
 * Trigger:
 * - GET /api/cron/check-replies?token=CRON_SECRET  (or Authorization: Bearer CRON_SECRET)
 * - n8n or external cron (every 1-2 hours)
 */

import { checkAllReplies } from '@/lib/reply-checker';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const RUN_BUDGET_MS = 100_000;

export async function GET(request) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    const authHeader = request.headers.get('authorization');

    if (authHeader !== `Bearer ${cronSecret}` && tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await checkAllReplies({ deadlineMs: Date.now() + RUN_BUDGET_MS });

    // Another scan (heartbeat piggyback or a parallel cron hit) holds the lock:
    // nothing to do, and that is not an error.
    if (result && result.skipped === 'locked') {
      return Response.json({
        success: true,
        skipped: 'locked',
        note: 'Another reply scan is already running; try again in a minute.',
        ...result,
      });
    }

    return Response.json({
      success: true,
      ...result,
    });
  } catch (err) {
    return Response.json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
