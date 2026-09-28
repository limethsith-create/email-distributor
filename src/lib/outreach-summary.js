/** Totals across every day of the /api/daily-log report (the hub's My stats, /api/mc/outreach). */
export function summarize(days) {
  const totals = { sent: 0, newSends: 0, followUps: 0, opens: 0, uniqueOpens: 0, replies: 0, bounces: 0, days: 0, firstDay: null, lastDay: null };
  const inboxes = {};
  const byTouch = {};
  const byCampaign = {};
  for (const d of days) {
    const s = d.summary || {};
    totals.sent += s.totalSent || 0;
    totals.newSends += s.newSends || 0;
    totals.followUps += s.followUps || 0;
    totals.opens += s.totalOpens || 0;
    totals.uniqueOpens += s.uniqueOpens || 0;
    totals.replies += s.totalReplies || 0;
    totals.bounces += s.totalBounces || 0;
    if (s.totalSent) {
      totals.days += 1;
      if (!totals.firstDay || d.date < totals.firstDay) totals.firstDay = d.date;
      if (!totals.lastDay || d.date > totals.lastDay) totals.lastDay = d.date;
    }
    for (const [k, n] of Object.entries(d.accountBreakdown || {})) inboxes[k] = (inboxes[k] || 0) + n;
    for (const [k, n] of Object.entries(d.byTouch || {})) byTouch[k] = (byTouch[k] || 0) + n;
    for (const [k, n] of Object.entries(d.byCampaign || {})) byCampaign[k] = (byCampaign[k] || 0) + n;
  }
  return {
    totals,
    inboxes: Object.entries(inboxes).map(([email, sent]) => ({ email, sent })).sort((a, b) => b.sent - a.sent),
    byTouch,
    byCampaign,
  };
}
