/**
 * Leads API — View leads, stats, sent log, and manage the outreach pipeline
 */

import { getAllLeads, getStats, getSentLog, bulkUpsertLeads, upsertLead } from '@/lib/leads-db';
import { qualifyLeads } from '@/lib/qualify';
import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';

  try {
    switch (action) {
      case 'stats': {
        const stats = await getStats();
        return Response.json({
          ...stats,
          timestamp: new Date().toISOString(),
        });
      }

      case 'sent_log': {
        const limit = parseInt(searchParams.get('limit') || '100', 10);
        const log = await getSentLog(limit);
        return Response.json({ log, total: log.length });
      }

      case 'list':
      default: {
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '50', 10);
        const status = searchParams.get('status');

        let leads = await getAllLeads();

        if (status) {
          leads = leads.filter(l => l.status === status);
        }

        leads.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

        const start = (page - 1) * limit;
        const paginatedLeads = leads.slice(start, start + limit);

        // Merge open-tracking data from the email_opens store (source of truth
        // for opens) so the dashboard reflects every recorded open even if the
        // lead record's own opened_at wasn't written.
        let opensMap = {};
        try { opensMap = (await kv.hgetall('email_opens')) || {}; } catch {}

        return Response.json({
          total: leads.length,
          page,
          limit,
          leads: paginatedLeads.map(l => {
            const o = opensMap[(l.email || '').toLowerCase()] || null;
            return {
              email: l.email,
              company_name: l.company_name,
              industry: l.industry,
              city: l.city,
              ai_score: l.ai_score,
              status: l.status,
              source: l.source,
              account_used: l.account_used,
              sent_at: l.sent_at,
              replied_at: l.replied_at,
              opened_at: l.opened_at || (o && (o.openedAt || o.lastOpenedAt)) || null,
              open_count: l.open_count || (o && o.count) || 0,
              sequence_day: l.sequence_day,
              send_count: l.send_count,
              createdAt: l.createdAt,
              quality_score: l.quality_score,
              quality_reason: l.quality_reason,
              quality_engine: l.quality_engine,
              verified_at: l.verified_at,
            };
          }),
        });
      }
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = body.action || 'add_direct';

    switch (action) {
      case 'add_direct': {
        const leads = Array.isArray(body.leads) ? body.leads : [body];
        const toAdd = leads.map(lead => ({
          ...lead,
          email: lead.email.toLowerCase().trim(),
          status: 'qualified',
          ai_score: lead.ai_score || 8,
          source: lead.source || 'manual',
          qualified_at: new Date().toISOString(),
        }));
        const result = await bulkUpsertLeads(toAdd);
        return Response.json({ success: true, ...result });
      }

      case 'qualify_and_add': {
        const leads = Array.isArray(body.leads) ? body.leads : [body];
        const qualified = qualifyLeads(leads, { minScore: body.minScore || 5 });
        const result = await bulkUpsertLeads(qualified);
        return Response.json({ success: true, qualified: qualified.length, ...result });
      }

      default:
        return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
