/**
 * Daily Activity Log API — the report itself is built in lib/daily-log.js
 * (shared with /api/mc/outreach and the outreach archive).
 */

import { buildDailyLog } from '@/lib/daily-log';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  try {
    const { days, timestamp } = await buildDailyLog();
    return Response.json({
      success: true,
      totalDays: days.length,
      days,
      timestamp,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
