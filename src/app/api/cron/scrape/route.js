/**
 * Cron Job: Daily Lead Scraper
 * Runs once per day — scrapes business directories, qualifies leads, builds send queue
 *
 * Vercel Cron Schedule: Every day at 3:30 AM Sri Lanka time (UTC+5:30 = 22:00 UTC previous day)
 * This runs before the daily send queue starts processing
 */

import { scrapeLeads } from '@/lib/scraper';
import { qualifyLeads } from '@/lib/qualify';
import { bulkUpsertLeads } from '@/lib/leads-db';
import { createDailyQueue } from '@/lib/scheduler';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  // Verify cron secret (prevents unauthorized triggers)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('[cron/scrape] Starting daily scrape run...');

    // Step 1: Scrape leads from directories
    const rawLeads = await scrapeLeads({
      maxLeadsPerRun: 200,
      delayBetweenRequests: 2000,
    });
    console.log(`[cron/scrape] Scraped ${rawLeads.length} raw leads`);

    // Step 2: Qualify and score leads
    const qualifiedLeads = qualifyLeads(rawLeads, {
      minScore: 7,
      maxLeads: 150, // Max we can send in a day (30 x 5 accounts)
    });
    console.log(`[cron/scrape] Qualified ${qualifiedLeads.length} leads`);

    // Step 3: Save to database (with deduplication)
    const dbResult = await bulkUpsertLeads(qualifiedLeads);
    console.log(`[cron/scrape] DB: ${dbResult.added} added, ${dbResult.skipped} duplicates skipped`);

    // Step 4: Build daily send queue with randomized schedule
    const queueResult = await createDailyQueue();
    console.log(`[cron/scrape] Queue: ${queueResult.totalQueued || 0} emails scheduled`);

    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      scrape: {
        rawLeads: rawLeads.length,
        qualifiedLeads: qualifiedLeads.length,
      },
      database: dbResult,
      queue: {
        totalQueued: queueResult.totalQueued || 0,
        firstSendAt: queueResult.firstSendAt,
        lastSendAt: queueResult.lastSendAt,
      },
    };

    console.log('[cron/scrape] Daily scrape complete:', JSON.stringify(result));
    return Response.json(result);

  } catch (error) {
    console.error('[cron/scrape] Error:', error);
    return Response.json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
