/**
 * Leads API — View leads, stats, and manage the outreach pipeline
 */

import { getAllLeads, getStats, getSendQueue } from '@/lib/leads-db';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';

  try {
    switch (action) {
      case 'stats': {
        const stats = await getStats();
        const queue = await getSendQueue();
        const pendingInQueue = queue.filter(q => q.status === 'pending').length;
        const sentToday = queue.filter(q => q.status === 'sent').length;

        return Response.json({
          ...stats,
          queuePending: pendingInQueue,
          sentToday,
          timestamp: new Date().toISOString(),
        });
      }

      case 'queue': {
        const queue = await getSendQueue();
        return Response.json({
          total: queue.length,
          pending: queue.filter(q => q.status === 'pending').length,
          sent: queue.filter(q => q.status === 'sent').length,
          failed: queue.filter(q => q.status === 'failed').length,
          items: queue.slice(0, 50).map(q => ({
            to: q.email,
            from: q.accountEmail,
            scheduledAt: new Date(q.scheduledAt).toISOString(),
            status: q.status,
            sequenceDay: q.sequenceDay,
            sentAt: q.sentAt,
            error: q.error,
          })),
        });
      }

      case 'list':
      default: {
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '50', 10);
        const status = searchParams.get('status');

        let leads = await getAllLeads();

        // Filter by status if specified
        if (status) {
          leads = leads.filter(l => l.status === status);
        }

        // Sort by most recent first
        leads.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        // Paginate
        const start = (page - 1) * limit;
        const paginatedLeads = leads.slice(start, start + limit);

        return Response.json({
          total: leads.length,
          page,
          limit,
          leads: paginatedLeads.map(l => ({
            email: l.email,
            company_name: l.company_name,
            industry: l.industry,
            city: l.city,
            ai_score: l.ai_score,
            status: l.status,
            source: l.source,
            sent_at: l.sent_at,
            replied_at: l.replied_at,
            sequence_day: l.sequence_day,
          })),
        });
      }
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
