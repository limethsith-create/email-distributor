/**
 * Daily Activity Log API
 *
 * Returns email activity grouped by day:
 * - Emails sent (with account breakdown)
 * - Opens tracked
 * - Replies received
 * - Bounces detected
 */

import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [sentLog, allLeads, emailOpens, replies, bounces] = await Promise.all([
      kv.lrange('sent_log', 0, 499).catch(() => []),
      kv.hgetall('leads').catch(() => ({})),
      kv.hgetall('email_opens').catch(() => ({})),
      kv.hgetall('replies').catch(() => ({})),
      kv.hgetall('bounces').catch(() => ({})),
    ]);

    const leadsArr = allLeads ? Object.values(allLeads) : [];
    const opensArr = emailOpens ? Object.values(emailOpens) : [];
    const repliesArr = replies ? Object.values(replies) : [];
    const bouncesArr = bounces ? Object.values(bounces) : [];

    const dayMap = {};

    function ensureDay(dateStr) {
      const day = dateStr ? dateStr.split('T')[0] : 'unknown';
      if (!dayMap[day]) {
        dayMap[day] = { date: day, sent: [], opens: [], replies: [], bounces: [], accountBreakdown: {} };
      }
      return dayMap[day];
    }

    // Process sent log
    for (const entry of (sentLog || [])) {
      const ts = entry.timestamp || entry.sentAt || entry.createdAt;
      const dayEntry = ensureDay(ts);
      dayEntry.sent.push({
        to: entry.to, from: entry.from, company: entry.company,
        industry: entry.industry, subject: entry.subject, status: entry.status, timestamp: ts,
      });
      const accKey = entry.from || 'unknown';
      dayEntry.accountBreakdown[accKey] = (dayEntry.accountBreakdown[accKey] || 0) + 1;
    }

    // Check leads with sent_at for sends not in sent_log
    for (const lead of leadsArr) {
      if (lead.sent_at && lead.status && lead.status.startsWith('sent')) {
        const day = lead.sent_at.split('T')[0];
        const dayEntry = ensureDay(day);
        const alreadyLogged = dayEntry.sent.some(s => s.to === lead.email);
        if (!alreadyLogged) {
          dayEntry.sent.push({
            to: lead.email, from: lead.account_used || 'unknown',
            company: lead.company || lead.company_name, industry: lead.industry,
            subject: '', status: 'sent', timestamp: lead.sent_at,
          });
          const accKey = lead.account_used || 'unknown';
          dayEntry.accountBreakdown[accKey] = (dayEntry.accountBreakdown[accKey] || 0) + 1;
        }
      }
    }

    // Process opens
    for (const open of opensArr) {
      const ts = open.openedAt || open.lastOpenedAt;
      if (ts) {
        const dayEntry = ensureDay(ts);
        dayEntry.opens.push({
          email: open.email, count: open.count || 1,
          openedAt: open.openedAt, lastOpenedAt: open.lastOpenedAt,
        });
      }
    }

    // Process replies
    for (const reply of repliesArr) {
      const ts = reply.repliedAt || reply.receivedAt || reply.timestamp;
      if (ts) {
        const dayEntry = ensureDay(ts);
        dayEntry.replies.push({
          from: reply.from || reply.email, subject: reply.subject,
          snippet: reply.snippet || reply.preview, repliedAt: ts, account: reply.account,
        });
      }
    }

    // Check leads with replied status
    for (const lead of leadsArr) {
      if (lead.status === 'replied' && lead.replied_at) {
        const day = lead.replied_at.split('T')[0];
        const dayEntry = ensureDay(day);
        const alreadyLogged = dayEntry.replies.some(r => r.from === lead.email);
        if (!alreadyLogged) {
          dayEntry.replies.push({
            from: lead.email, subject: '', snippet: '',
            repliedAt: lead.replied_at, company: lead.company || lead.company_name,
          });
        }
      }
    }

    // Process bounces
    for (const bounce of bouncesArr) {
      const ts = bounce.bouncedAt;
      if (ts) {
        const dayEntry = ensureDay(ts);
        dayEntry.bounces.push({
          email: bounce.email, reason: bounce.reason,
          account: bounce.account, bouncedAt: ts,
        });
      }
    }

    // Check leads with bounced status
    for (const lead of leadsArr) {
      if (lead.status === 'bounced' && lead.bounced_at) {
        const day = lead.bounced_at.split('T')[0];
        const dayEntry = ensureDay(day);
        const alreadyLogged = dayEntry.bounces.some(b => b.email === lead.email);
        if (!alreadyLogged) {
          dayEntry.bounces.push({
            email: lead.email, reason: lead.bounce_reason || 'Unknown',
            account: lead.bounce_account, bouncedAt: lead.bounced_at,
          });
        }
      }
    }

    // Convert to sorted array (newest first)
    const days = Object.values(dayMap)
      .filter(d => d.date !== 'unknown')
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(day => ({
        ...day,
        summary: {
          totalSent: day.sent.length,
          totalOpens: day.opens.length,
          totalReplies: day.replies.length,
          totalBounces: day.bounces.length,
          uniqueOpens: day.opens.filter(o => o.count === 1).length,
          accountsUsed: Object.keys(day.accountBreakdown).length,
        },
      }));

    return Response.json({ success: true, totalDays: days.length, days, timestamp: new Date().toISOString() });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
