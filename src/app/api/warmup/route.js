/**
 * Warmup status API — powers the dashboard.
 * Returns the current warmup stage, the daily cap per inbox, the sending
 * window, and today's send count for each configured inbox.
 */

import { kv } from '@vercel/kv';
import { getSmtpAccounts } from '@/lib/smtp-accounts';
import {
  getWarmupSummary,
  getMaxPerAccountPerDay,
  isWithinSendingHours,
} from '@/lib/warmup';

export const dynamic = 'force-dynamic';

function getTodayKey() {
  const slTime = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return slTime.toISOString().split('T')[0];
}

export async function GET() {
  try {
    const summary = getWarmupSummary();
    const cap = getMaxPerAccountPerDay();
    const accounts = getSmtpAccounts();
    const today = getTodayKey();

    const inboxes = [];
    let sentToday = 0;

    for (const acc of accounts) {
      let sent = 0;
      try {
        const c = await kv.hget('daily_sends', `${acc.email}:${today}`);
        sent = parseInt(c || '0');
      } catch {
        sent = 0;
      }
      sentToday += sent;
      inboxes.push({
        email: acc.email,
        displayName: acc.displayName,
        sentToday: sent,
        capPerInbox: cap,
        remaining: Math.max(0, cap - sent),
      });
    }

    return Response.json({
      success: true,
      ...summary,
      windowOpenNow: isWithinSendingHours(),
      inboxCount: accounts.length,
      sentToday,
      dailyCapacity: cap * accounts.length,
      inboxes,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
