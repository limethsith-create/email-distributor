/**
 * Campaigns API — the two campaigns that run simultaneously.
 *
 *   'free-leads' — goodwill hook: 5 researched leads, free, on a "SEND IT" reply
 *   'offer'      — direct pitch: guaranteed booked calls, in writing (default)
 *
 * GET  → per-campaign stats (same rules as the dashboard: campaign-start
 *        cutoff, tracking-gap exclusion from the open-rate denominator,
 *        skipped/bounced excluded) + a live day-0 copy preview
 * POST → { action: 'assign', campaign, count } moves up to `count` unsent
 *        leads into the given campaign (sets lead.campaign; nothing is sent).
 */

import { kv } from '@vercel/kv';
import { generateEmailSequence } from '@/lib/personalize';
import { getSmtpAccounts } from '@/lib/smtp-accounts';
import { getAllLeads, getLeadsByEmail } from '@/lib/leads-db';
import { CAMPAIGNS, campaignOf, summarizeLeads, UNSENT_STATUSES } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LEADS_KEY = 'leads';

function isUnsent(lead) {
  const st = String(lead?.status || '').toLowerCase();
  return Boolean(lead) && !lead.sent_at && !lead.account_used && UNSENT_STATUSES.has(st);
}

function campaignStats(leads, opensMap) {
  const s = summarizeLeads(leads, opensMap);
  return {
    total: s.total,
    queued: s.queued,
    contacted: s.contacted,
    replied: s.replied,
    opened: s.opened,
    openRate: s.openRate,
    replyRate: s.replyRate,
    // additive
    sendable: s.sendable,
    touches: s.touches,
    humanReplied: s.humanReplied,
    positiveReplied: s.positiveReplied,
    positiveReplyRate: s.positiveReplyRate,
    untracked: s.untracked,
    bounced: s.bounced,
    skipped: s.skipped,
    unsubscribed: s.unsubscribed,
  };
}

export async function GET() {
  try {
    const [leads, opensRaw, campaignRaw, enabledRaw] = await Promise.all([
      getAllLeads(),
      kv.hgetall('email_opens').catch(() => ({})),
      kv.hgetall('inbox_campaigns').catch(() => ({})),
      kv.hgetall('inbox_enabled').catch(() => ({})),
    ]);
    const opensMap = opensRaw && typeof opensRaw === 'object' ? opensRaw : {};
    const campaignMap = campaignRaw && typeof campaignRaw === 'object' ? campaignRaw : {};
    const enabledMap = enabledRaw && typeof enabledRaw === 'object' ? enabledRaw : {};

    const stats = {};
    for (const c of CAMPAIGNS) {
      stats[c] = campaignStats(leads.filter((l) => campaignOf(l) === c), opensMap);
    }

    // Which inboxes send each campaign (an unassigned inbox defaults to 'offer').
    const inboxesByCampaign = { 'free-leads': [], 'offer': [] };
    try {
      for (const a of getSmtpAccounts()) {
        const key = (a.email || '').toLowerCase();
        const c = String(campaignMap[key] || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer';
        const on = enabledMap[key] === '1' || enabledMap[key] === 1 || enabledMap[key] === true;
        inboxesByCampaign[c].push({ email: a.email, enabled: !!on });
      }
    } catch {}

    // Live day-0 previews straight from the engine, so what you read here is
    // exactly what a lead receives.
    const sample = { first_name: 'Jordan', company_name: 'Meridian Partners', industry: 'consulting' };
    const previews = {
      'free-leads': generateEmailSequence({ ...sample, campaign: 'free-leads' }).day0,
      'offer': generateEmailSequence({ ...sample, campaign: 'offer' }).day0,
    };

    return Response.json({ success: true, stats, inboxes: inboxesByCampaign, previews, timestamp: new Date().toISOString() });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action !== 'assign') {
      return Response.json({ success: false, error: 'unknown action' }, { status: 400 });
    }
    const campaign = String(body.campaign || '').toLowerCase();
    if (!CAMPAIGNS.includes(campaign)) {
      return Response.json({ success: false, error: 'campaign must be free-leads or offer' }, { status: 400 });
    }
    const count = Math.max(1, Math.min(500, parseInt(body.count) || 0));

    const leads = await getAllLeads();
    const picks = [];
    for (const lead of leads) {
      if (picks.length >= count) break;
      if (!isUnsent(lead) || campaignOf(lead) === campaign) continue;
      if (lead.email) picks.push(String(lead.email).toLowerCase());
    }

    // Re-read each chunk immediately before writing so a lead the sender
    // claimed (or that changed campaign) since the scan is never clobbered.
    let assigned = 0;
    for (let i = 0; i < picks.length; i += 100) {
      const part = picks.slice(i, i + 100);
      const fresh = await getLeadsByEmail(part);
      const updates = {};
      const now = new Date().toISOString();
      for (const email of part) {
        const lead = fresh[email];
        if (!lead || !isUnsent(lead) || campaignOf(lead) === campaign) continue;
        updates[email] = { ...lead, email, campaign, updatedAt: now };
      }
      const keys = Object.keys(updates);
      if (keys.length) {
        await kv.hset(LEADS_KEY, updates);
        assigned += keys.length;
      }
    }

    return Response.json({ success: true, assigned, campaign });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
