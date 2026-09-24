/**
 * Review request + follow-up ladder (SPEC §9.6), run from the day-jobs by
 * "ladder day": the trial day shifted so the decision day counts as Day 30
 * (a trial that decided on Day 47 after an extension gets its Day 31 review
 * request on Day 48).
 *
 *   ≥31 once   review_request (≥1 qualified) or review_request_zero
 *   31         testimonial_approval when a captured quote is waiting (≥1 qualified only)
 *   33         ladder_33 (review link again; with the quote draft when there is one)
 *   ≥33 once   exit_interview for not_now
 *   37         ladder_37 — the open conversations, no ask (skipped if there are none)
 *   44         ladder_44 — "domain retires tomorrow"
 *   ≥45        deciding with no click → not_now; not_now → retire (wrapup.js)
 *   winback    WINBACK.days after endedAt (retired / deleted)
 *
 * The Clutch link comes from REVIEW.clutchUrl; while unset the review mail
 * is held and the owner gets config_missing.
 */

import { cfg } from '@/lib/config';
import { getClient, getTrial, updateClient } from '@/lib/db/client';
import { requireCounters } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { notifyClient } from '@/lib/notify';
import { dayKeyIn, ET } from '@/lib/time';
import { gatherData } from '@/lib/systems/reports';
import { expireDecision } from '@/lib/systems/decision';
import { retireClient } from '@/lib/systems/wrapup';
import { getBookings, patchTrial, requireSetting, ownerName, fmtDay } from '@/lib/systems/dshared';

export const LADDER_STATES = new Set(['deciding', 'converted', 'not_now']);

export function ladderDayOf(trial, day) {
  if (day == null) return null;
  const decisionDay = Number(trial.decisionDay) || 30;
  return day - (decisionDay - 30);
}

async function pendingQuote(clientId) {
  const b = (await getBookings(clientId)).find((x) => x.quote && !x.quoteApprovedAt);
  if (!b) return null;
  const when = b.quoteAt || b.attendedTapAt || b.scheduledAt;
  return { draft: String(b.quote).trim().replace(/[.\s]+$/, '') + '.', quoteDate: when ? fmtDay(String(when).slice(0, 10)) : 'the call' };
}

/**
 * Run the ladder for one client. `ladderDay` from ladderDayOf. Returns a
 * list of what was sent / held / done.
 */
export async function runLadder(clientId, { ladderDay, now = new Date() }) {
  const client = await getClient(clientId);
  const trial = await getTrial(clientId);
  const out = [];
  if (!client || ladderDay == null) return out;
  const state = client.state;
  const [d33, d37, d44] = await cfg(clientId, 'TRIAL.ladderDays');
  const retireDay = await cfg(clientId, 'TRIAL.retireDay');

  if (LADDER_STATES.has(state)) {
    const gate = await requireCounters(clientId, ['qualified']);
    const zero = gate.ok ? gate.values.qualified === 0 : null;

    // Review request (once).
    if (ladderDay >= 31 && !trial.reviewRequestedAt) {
      if (zero === null) out.push({ held: 'review_request', reason: 'qualified counter missing' });
      else {
        const url = await requireSetting(clientId, 'REVIEW.clutchUrl', 'The review request');
        const sig = url && (await ownerName(clientId, 'The review request'));
        if (url && sig) {
          await notifyClient(clientId, zero ? 'review_request_zero' : 'review_request', { clutchUrl: url, ownerName: sig }, { dedupe: 'review_request' });
          await patchTrial(clientId, { reviewRequestedAt: now.toISOString(), reviewLink: url });
          out.push({ sent: zero ? 'review_request_zero' : 'review_request' });
        } else out.push({ held: 'review_request', reason: url ? 'OWNER.signerName' : 'REVIEW.clutchUrl' });
      }
    }

    // Testimonial approval (never for a zero-call trial).
    if (ladderDay === 31 && zero === false && !trial.testimonialSentAt) {
      const q = await pendingQuote(clientId);
      const sig = q && (await ownerName(clientId, 'The testimonial approval'));
      if (q && sig) {
        await notifyClient(clientId, 'testimonial_approval', { ...q, ownerName: sig }, { dedupe: 'testimonial_approval' });
        await patchTrial(clientId, { testimonialSentAt: now.toISOString() });
        out.push({ sent: 'testimonial_approval' });
      }
    }

    if (state !== 'converted') {
      if (ladderDay === d33 && !trial.ladder33At) {
        const q = zero === false ? await pendingQuote(clientId) : null;
        if (!trial.reviewCapturedAt || q) {
          const url = await requireSetting(clientId, 'REVIEW.clutchUrl', 'The Day 33 follow-up');
          const sig = url && (await ownerName(clientId, 'The Day 33 follow-up'));
          if (url && sig) {
            await notifyClient(clientId, q ? 'ladder_33_quote' : 'ladder_33', { clutchUrl: url, ownerName: sig, ...(q || {}) }, { dedupe: 'ladder_33' });
            await patchTrial(clientId, { ladder33At: now.toISOString() });
            out.push({ sent: q ? 'ladder_33_quote' : 'ladder_33' });
          }
        } else out.push({ skipped: 'ladder_33', reason: 'review already captured' });
      }
      if (state === 'not_now' && ladderDay >= d33 && !trial.exitInterviewSentAt) {
        const url = await requireSetting(clientId, 'REVIEW.clutchUrl', 'The exit interview');
        const sig = url && (await ownerName(clientId, 'The exit interview'));
        if (url && sig) {
          const res = await notifyClient(clientId, 'exit_interview', { clutchUrl: url, ownerName: sig }, { dedupe: 'exit_interview' });
          await patchTrial(clientId, { exitInterviewSentAt: now.toISOString(), exitInterviewMessageId: res.messageId || '' });
          out.push({ sent: 'exit_interview' });
        }
      }
      if (ladderDay === d37 && !trial.ladder37At) {
        const data = await gatherData(clientId, now);
        if (data.open.length) {
          const sig = await ownerName(clientId, 'The Day 37 follow-up');
          if (sig) {
            const openList = data.open.map((r) => `• ${r.lead?.company || r.leadEmail} (${r.leadEmail}) — ${r.kind}${r.snippet ? `: “${String(r.snippet).slice(0, 120)}”` : ''}`).join('\n');
            await notifyClient(clientId, 'ladder_37', { openList, ownerName: sig }, { dedupe: 'ladder_37' });
            await patchTrial(clientId, { ladder37At: now.toISOString() });
            out.push({ sent: 'ladder_37' });
          }
        } else {
          await patchTrial(clientId, { ladder37At: now.toISOString() });
          await logEvent(clientId, 'ladder', 'ladder_37_skipped', { reason: 'no open conversations' });
          out.push({ skipped: 'ladder_37', reason: 'no open conversations' });
        }
      }
      if (ladderDay === d44 && !trial.ladder44At) {
        const sig = await ownerName(clientId, 'The Day 44 follow-up');
        if (sig) {
          await notifyClient(clientId, 'ladder_44', { ownerName: sig }, { dedupe: 'ladder_44' });
          await patchTrial(clientId, { ladder44At: now.toISOString() });
          out.push({ sent: 'ladder_44' });
        }
      }
      if (ladderDay >= retireDay) {
        if (state === 'deciding') { await expireDecision(clientId, now); out.push({ done: 'not_now (no click)' }); }
        const r = await retireClient(clientId, { now, reason: 'day45' });
        out.push({ done: 'retired', ...r });
      }
    }
  }
  if (out.length) await logEvent(clientId, 'ladder', 'ladder_ran', { ladderDay, out });
  return out;
}

/** 90-day win-back (Offboarding SOP), for retired or deleted clients. */
export async function runWinback(clientId, { now = new Date() } = {}) {
  const client = await getClient(clientId);
  if (!client || !['retired', 'deleted'].includes(client.state)) return { skipped: 'state' };
  const winbackAt = client.winbackAt;
  if (!winbackAt || winbackAt > dayKeyIn(ET, now)) return { skipped: 'not due' };
  if (client.winbackSentAt) return { skipped: 'sent' };
  const whatsNew = await requireSetting(clientId, 'WINBACK_TEXT.whatsNew', 'The 90-day win-back');
  const sig = whatsNew && (await ownerName(clientId, 'The 90-day win-back'));
  if (!whatsNew || !sig) return { held: whatsNew ? 'OWNER.signerName' : 'WINBACK_TEXT.whatsNew' };
  await notifyClient(clientId, 'winback_90', { whatsNew, ownerName: sig }, { dedupe: 'winback_90' });
  await updateClient(clientId, { winbackSentAt: now.toISOString() });
  await logEvent(clientId, 'ladder', 'winback_sent', {});
  return { sent: 'winback_90' };
}
