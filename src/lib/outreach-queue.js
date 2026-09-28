/**
 * The owner's own outreach queue (the legacy engine, /api/cron/auto-send):
 * one scan of the `leads` hash → the fresh day-0 pools (per campaign, best
 * score first), the due follow-ups (oldest due first), follow-ups too far
 * past due, and stuck claims.
 *
 * OUTREACH_FOLLOWUPS (config, default false): one email per person. With it
 * off, due follow-ups are left out of both `followUps` and `expired` — they
 * are neither sent nor retired, the lead simply stays as it is.
 */

import { cfg } from '@/lib/config';
import { campaignOf, isSendable, leadScore } from '@/lib/metrics';

// Sequence timing.
export const D3_AFTER_MS = 3 * 24 * 60 * 60 * 1000;   // day 3 = 3 days after day 0
export const D7_AFTER_MS = 4 * 24 * 60 * 60 * 1000;   // day 7 = 4 days after day 3
export const D10_AFTER_MS = 3 * 24 * 60 * 60 * 1000;  // day 10 = 3 days after day 7 (SPEC SEQUENCE.gaps)
export const STALE_CLAIM_MS = 30 * 60 * 1000;
export const FOLLOWUP_GRACE_MS = (parseInt(process.env.FOLLOWUP_GRACE_DAYS || '7', 10) || 7) * 24 * 60 * 60 * 1000;

const lower = (s) => String(s || '').trim().toLowerCase();

/** Are follow-ups on for the owner's own outreach? (config OUTREACH_FOLLOWUPS, default false) */
export async function outreachFollowUpsOn() {
  return (await cfg('aviance', 'OUTREACH_FOLLOWUPS')) === true;
}

/**
 * From one leads scan, derive both the fresh pool (per campaign, best score
 * first) and the due follow-ups (oldest due first), plus stuck claims.
 * `followUps: false` → no follow-ups and no expiries at all.
 */
export function partitionLeads(leadsMap, now, { followUps: followUpsOn = true } = {}) {
  const fresh = { 'free-leads': [], offer: [] };
  const followUps = [];
  const stuck = [];
  const expired = [];
  const nowMs = now.getTime();
  const pushDue = (lead, day, due) => {
    if (nowMs < due) return;
    if (nowMs - due > FOLLOWUP_GRACE_MS) expired.push({ lead, day, dueAt: due });
    else followUps.push({ lead, day, dueAt: due });
  };
  for (const lead of Object.values(leadsMap || {})) {
    if (!lead || !lead.email) continue;
    const status = lower(lead.status);

    if (status === 'sending') {
      const ts = lead.updatedAt ? new Date(lead.updatedAt).getTime() : 0;
      if (!ts || nowMs - ts > STALE_CLAIM_MS) stuck.push(lead);
      continue;
    }

    if (isSendable(lead)) {
      fresh[campaignOf(lead)].push(lead);
      continue;
    }

    if (!followUpsOn || !lead.sent_at) continue;
    const hold = lead.followup_hold_until ? new Date(lead.followup_hold_until).getTime() : 0;
    if (hold && hold > nowMs) continue;
    if (status === 'sent-d0') {
      pushDue(lead, 3, new Date(lead.sent_at).getTime() + D3_AFTER_MS);
    } else if (status === 'sent-d3') {
      const base = lead.d3_sent_at ? new Date(lead.d3_sent_at).getTime() : new Date(lead.sent_at).getTime() + D3_AFTER_MS;
      pushDue(lead, 7, base + D7_AFTER_MS);
    } else if (status === 'sent-d7') {
      const d7At = lead.d7_sent_at || lead.d7_skipped_at;
      const base = d7At ? new Date(d7At).getTime() : new Date(lead.sent_at).getTime() + D3_AFTER_MS + D7_AFTER_MS;
      pushDue(lead, 10, base + D10_AFTER_MS);
    }
  }
  for (const c of Object.keys(fresh)) {
    for (const l of fresh[c]) l.__jitter = Math.random();
    fresh[c].sort((a, b) => (leadScore(b) - leadScore(a)) || (a.__jitter - b.__jitter));
    for (const l of fresh[c]) delete l.__jitter;
  }
  followUps.sort((a, b) => a.dueAt - b.dueAt);
  return { fresh, followUps, stuck, expired };
}
