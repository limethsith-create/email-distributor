/**
 * Cron Job: Email Sender
 *
 * TWO MODES OF OPERATION:
 *
 * 1. Vercel Cron (daily): Starts the send cycle for the day
 *    - Processes first batch of due emails
 *    - Self-chains by calling itself after a delay to process the next batch
 *
 * 2. External trigger (e.g. cron-job.org every 5 min): Most reliable for 24/7
 *    - Just processes whatever is due right now
 *    - Free services: cron-job.org, easycron.com, UptimeRobot
 *    - URL to ping: https://email-distributor.vercel.app/api/cron/send
 *
 * Processes up to 5 emails per invocation to stay within Vercel's 60s timeout
 */

import { processSendQueue } from '@/lib/scheduler';
import { cleanQueue, getSendQueue } from '@/lib/leads-db';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  // Verify cron secret (if set)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Also allow query param for external cron services
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    if (tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    console.log('[cron/send] Processing send queue...');

    // Process up to 5 emails per run
    const result = await processSendQueue({
      maxPerRun: 5,
      dryRun: false,
    });

    // Clean up old queue items periodically
    if (Math.random() < 0.1) {
      await cleanQueue();
    }

    console.log(`[cron/send] Sent: ${result.sent}, Failed: ${result.failed}, Remaining: ${result.remaining}`);

    // Self-chain: if there are more items due, trigger another run after a delay
    // This allows 24/7 processing even with daily Vercel crons
    if (result.remaining > 0) {
      const queue = await getSendQueue();
      const now = Date.now();
      const nextDue = queue
        .filter(item => item.status === 'pending')
        .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];

      if (nextDue && nextDue.scheduledAt <= now + 5 * 60 * 1000) {
        // Next item is due within 5 minutes — chain immediately
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : process.env.NEXT_PUBLIC_APP_URL || 'https://email-distributor.vercel.app';

        const chainUrl = `${baseUrl}/api/cron/send${cronSecret ? `?token=${cronSecret}` : ''}`;

        // Fire and forget — don't await, let Vercel handle it
        fetch(chainUrl, { signal: AbortSignal.timeout(5000) }).catch(() => {});

        result.chained = true;
        result.nextDueAt = new Date(nextDue.scheduledAt).toISOString();
      }
    }

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result,
    });

  } catch (error) {
    console.error('[cron/send] Error:', error);
    return Response.json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
