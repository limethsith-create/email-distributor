/**
 * Leads API — View leads, stats, sent log, and manage the outreach pipeline
 */

import { kv } from '@vercel/kv';
import { getAllLeads, getStats, getSentLog, bulkUpsertLeads, getLeadsByEmail, newLeadRecord } from '@/lib/leads-db';
import { qualifyLeads } from '@/lib/qualify';
import { mergeOpens, isSendable, isValidEmail, normalizeEmail, campaignOf } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SUPPRESSION_KEY = 'suppression';
const MAX_LIMIT = 20000;

/** One lead as the dashboard / Leads / Offer pages consume it. */
function project(l, opensMap) {
  const o = mergeOpens(l, opensMap);
  const replyKind = l.reply_kind || null;
  const humanReply = !replyKind || replyKind === 'human';
  return {
    email: l.email,
    company_name: l.company_name,
    industry: l.industry,
    city: l.city,
    ai_score: l.ai_score,
    status: l.status,
    source: l.source,
    account_used: l.account_used,
    campaign: campaignOf(l),
    sent_at: l.sent_at,
    d3_sent_at: l.d3_sent_at || null,
    d7_sent_at: l.d7_sent_at || null,
    // Only a human reply counts as "replied"; auto-responders are exposed
    // separately so the dashboard's reply rate stays honest.
    replied_at: humanReply ? l.replied_at : null,
    replied_at_any: l.replied_at || null,
    opened_at: o.opened_at,
    open_count: o.open_count,
    sequence_day: l.sequence_day,
    send_count: l.send_count,
    createdAt: l.createdAt,
    quality_score: l.quality_score,
    quality_reason: l.quality_reason,
    quality_engine: l.quality_engine,
    verified_at: l.verified_at,
    // ── additive ──
    opened_any_at: o.opened_any_at,
    last_opened_at: o.last_opened_at,
    human_open_count: o.human_open_count,
    open_class: o.open_class,
    open_country: o.open_country,
    first_name: l.first_name || null,
    name: l.name || null,
    title: l.title || null,
    country: l.country || null,
    website: l.website || null,
    reply_kind: replyKind,
    reply_intent: l.reply_intent || null,
    reply_sentiment: l.reply_sentiment || null,
    reply_touch: l.reply_touch || null,
    reply_latency_ms: l.reply_latency_ms ?? null,
    first_replied_at: l.first_replied_at || null,
    last_replied_at: l.last_replied_at || null,
    reply_count: Number(l.reply_count) || 0,
    bounced_at: l.bounced_at || null,
    bounce_reason: l.bounce_reason || null,
    unsubscribed_at: l.unsubscribed_at || null,
    followup_hold_until: l.followup_hold_until || null,
    ooo_until: l.ooo_until || null,
    sendable: isSendable(l),
    updatedAt: l.updatedAt || null,
    subject_variant: l.subject_variant || null,
    original_subject: l.original_subject || null,
  };
}

/**
 * Which of these records are new inserts (not stored, not suppressed)? Used
 * to report how many of the leads just added the sender will actually pick up.
 */
async function newInserts(records) {
  const emails = [...new Set(records.map((r) => r.email))];
  if (!emails.length) return [];
  const existing = await getLeadsByEmail(emails);
  const suppressed = new Set();
  for (let i = 0; i < emails.length; i += 400) {
    const part = emails.slice(i, i + 400);
    try {
      const flags = (await kv.smismember(SUPPRESSION_KEY, part)) || [];
      part.forEach((e, j) => { if (flags[j] === 1 || flags[j] === true) suppressed.add(e); });
    } catch {}
  }
  return records.filter((r) => !existing[r.email] && !suppressed.has(r.email));
}

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
        const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '100', 10) || 100), 5000);
        const log = await getSentLog(limit);
        return Response.json({ log, total: log.length });
      }

      case 'list':
      default: {
        const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
        const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50), MAX_LIMIT);
        const status = searchParams.get('status');

        // Opens are merged from the email_opens store (the pixel never writes
        // the lead record), so fetch both in parallel.
        const [allLeads, opensRaw] = await Promise.all([
          getAllLeads(),
          kv.hgetall('email_opens').catch(() => ({})),
        ]);
        const opensMap = opensRaw && typeof opensRaw === 'object' ? opensRaw : {};

        let leads = allLeads;
        if (status) {
          leads = leads.filter((l) => l.status === status);
        }

        // Newest first; the sort key is computed once per lead.
        const keyed = leads.map((l) => ({ l, k: Date.parse(l.updatedAt || l.createdAt || '') || 0 }));
        keyed.sort((a, b) => b.k - a.k);

        const start = (page - 1) * limit;
        const pageLeads = keyed.slice(start, start + limit).map((x) => x.l);

        return Response.json({
          total: leads.length,
          page,
          limit,
          leads: pageLeads.map((l) => project(l, opensMap)),
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
        const now = new Date().toISOString();
        // Invalid addresses are passed through so bulkUpsertLeads counts them.
        const toAdd = leads
          .filter((lead) => lead && typeof lead === 'object')
          .map((lead) => ({
            ...lead,
            email: normalizeEmail(lead.email),
            status: 'qualified',
            ai_score: lead.ai_score || 8,
            source: lead.source || 'manual',
            qualified_at: now,
          }));
        const valid = toAdd.filter((lead) => isValidEmail(lead.email)).map((lead) => newLeadRecord(lead, 'manual'));
        const inserts = await newInserts(valid);
        const sendable = inserts.filter(isSendable).length;
        const result = await bulkUpsertLeads(toAdd, { source: 'manual' });
        return Response.json({ success: true, ...result, sendable });
      }

      case 'qualify_and_add': {
        const leads = Array.isArray(body.leads) ? body.leads : [body];
        const qualified = qualifyLeads(leads, { minScore: body.minScore || 5, maxLeads: leads.length });
        const result = await bulkUpsertLeads(qualified, { source: 'manual' });
        return Response.json({ success: true, qualified: qualified.length, ...result });
      }

      default:
        return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
