/**
 * Reply Checker Cron Endpoint
 *
 * Connects to all Gmail accounts via IMAP, checks for replies
 * to outreach emails, and updates lead status in the database.
 *
 * Trigger:
 * - GET /api/cron/check-replies?token=CRON_SECRET
 * - n8n or external cron (every 1-2 hours)
 */

import { checkAllReplies } from '@/lib/reply-checker';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

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
    const result = await checkAllReplies();

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
