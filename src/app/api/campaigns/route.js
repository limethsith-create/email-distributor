/**
 * Campaigns API — the two campaigns that run simultaneously.
 *
 *   'free-leads' — goodwill hook: 5 researched leads, free, on a "SEND IT" reply
 *   'offer'      — direct pitch: guaranteed booked calls, in writing (default)
 *
 * GET  → per-campaign stats (from the leads hash) + a live day-0 copy preview
 * POST → { action: 'assign', campaign, count } moves up to `count` unsent
 *        leads into the given campaign (sets lead.campaign; nothing is sent).
 */

import { kv } from '@vercel/kv';
import { generateEmailSequence } from '@/lib/personalize';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LEADS_KEY = 'leads';
const CAMPAIGNS = ['free-leads', 'offer'];

function campaignOf(lead) {
  return String(lead?.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer';
}

function isUnsent(lead) {
  const st = String(lead?.status || '').toLowerCase();
  return !lead?.sent_at && (st === '' || st === 'new' || st === 'pending' || st === 'qualified');
}

export async function GET() {
  try {
    let leads = {};
    try { leads = (await kv.hgetall(LEADS_KEY)) || {}; } catch {}

    const stats = {
      'free-leads': { total: 0, queued: 0, contacted: 0, replied: 0, opened: 0, openRate: 0, replyRate: 0 },
      'offer': { total: 0, queued: 0, contacted: 0, replied: 0, opened: 0, openRate: 0, replyRate: 0 },
    };

    for (const lead of Object.values(leads)) {
      if (!lead) continue;
      const c = campaignOf(lead);
      const st = String(lead.status || '').toLowerCase();
      stats[c].total++;
      if (isUnsent(lead)) stats[c].queued++;
      if (lead.sent_at || st === 'sent' || st === 'sequence_complete' || st === 'replied') stats[c].contacted++;
      if (st === 'replied') stats[c].replied++;
      if (lead.opened_at) stats[c].opened++;
    }

    // Rates over contacted leads (a lead can't open or reply before it's emailed).
    for (const c of CAMPAIGNS) {
      const s = stats[c];
      s.openRate = s.contacted ? Math.round((s.opened / s.contacted) * 1000) / 10 : 0;
      s.replyRate = s.contacted ? Math.round((s.replied / s.contacted) * 1000) / 10 : 0;
    }

    // Which inboxes send each campaign (an unassigned inbox defaults to 'offer').
    const inboxesByCampaign = { 'free-leads': [], 'offer': [] };
    try {
      let campaignMap = {};
      let enabledMap = {};
      try { campaignMap = (await kv.hgetall('inbox_campaigns')) || {}; } catch {}
      try { enabledMap = (await kv.hgetall('inbox_enabled')) || {}; } catch {}
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

    let leads = {};
    try { leads = (await kv.hgetall(LEADS_KEY)) || {}; } catch {}

    const updates = {};
    let assigned = 0;
    for (const [email, lead] of Object.entries(leads)) {
      if (assigned >= count) break;
      if (!lead || !isUnsent(lead)) continue;
      if (campaignOf(lead) === campaign) continue;
      updates[email] = { ...lead, campaign, updatedAt: new Date().toISOString() };
      assigned++;
    }
    if (assigned > 0) await kv.hset(LEADS_KEY, updates);

    return Response.json({ success: true, assigned, campaign });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
