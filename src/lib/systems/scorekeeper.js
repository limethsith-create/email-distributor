/**
 * Call Scorekeeper (SPEC §8.5) — turns client taps into booking statuses and
 * counters (booked / held / qualified / noshows / wrongfit), applies the
 * Qualified Call Definition with its edge cases, runs disputes and the
 * no-show ladder.
 *
 * Qualified (all four, from "11 - The Qualified Call Definition"):
 *   company matches the approved profile   → the lead is on the client's approved list
 *                                            (and its host is not on the blocklist: a
 *                                            competitor never counts)
 *   attendee holds an approved title       → lead / attendee title ∈ profile.titles and
 *                                            not ∈ profile.excludedTitles; with no title
 *                                            known, the client tapped Showed undisputed
 *   they attended                          → status held
 *   booked in response to the outreach     → source ∈ {link, reply}
 * Edge cases: late join counts (Showed); client cancel/reschedule counts on
 * the original date (tap "I could not make it"); a prospect reschedule once
 * counts when held; a colleague with an approved title counts; a no-show
 * re-booked and held counts once.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getProfile, getTrial } from '@/lib/db/client';
import { getLead, hostOf } from '@/lib/db/leads';
import { bump, getTotals } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { trialDay, ET } from '@/lib/time';
import { getBookings, saveBooking } from '@/lib/systems/bookings';
import { sendToProspect, notifyClientSafe } from '@/lib/systems/outbound';
import { alert, isTrialClient, lower, listField, namedSlots, formatWhen, businessHoursBetween, ccfg } from '@/lib/systems/stagec-common';

export const TAP_ACTIONS = ['showed', 'noshow', 'wrongfit', 'dispute', 'client_noshow'];
export const DISPUTE_REASONS = {
  profile: 'The company does not match the approved profile',
  title: 'The person does not hold an approved title',
  attended: 'They did not attend',
  outreach: 'They did not book in response to the outreach',
};

// ─── Qualified rule ──────────────────────────────────────────────────────────

export function titleApproved(title, profile) {
  const t = lower(title);
  if (!t) return null; // unknown
  const excluded = listField(profile.excludedTitles).map(lower);
  if (excluded.some((x) => x && t.includes(x))) return false;
  const approved = listField(profile.titles).map(lower);
  if (!approved.length) return null;
  return approved.some((x) => x && (t.includes(x) || x.includes(t)));
}

/**
 * Pure check → { qualified, reason }.
 * @param {object} o { booking, lead, profile, blocklisted }
 */
export function evaluateQualified({ booking, lead, profile = {}, blocklisted = false }) {
  if (!booking || booking.status !== 'held') return { qualified: false, reason: 'not held' };
  if (booking.disputeResolution === 'upheld' || booking.disputeResolution === 'upheld_auto') return { qualified: false, reason: 'dispute upheld' };
  if (!lead) return { qualified: false, reason: 'not matched to a lead on the approved list' };
  if (blocklisted) return { qualified: false, reason: 'competitor / blocklisted company' };
  if (!['link', 'reply'].includes(booking.source)) return { qualified: false, reason: `source ${booking.source}` };
  const title = booking.colleague ? booking.attendeeTitle : (booking.attendeeTitle || lead.title);
  const ok = titleApproved(title, profile);
  if (ok === false) return { qualified: false, reason: `title "${title}" not approved` };
  if (ok === null && !(booking.attendedTapAt && !booking.disputedAt)) return { qualified: false, reason: 'no title known and no undisputed Showed tap' };
  return { qualified: true, reason: ok === null ? 'no title known; client tapped Showed' : 'all four criteria met' };
}

async function isBlocklistedHost(clientId, email) {
  if (!email) return false;
  const p = kv.pipeline();
  p.sismember(K.blocklist(clientId), lower(email));
  p.sismember(K.blocklist(clientId), hostOf(email));
  const [a, b] = await p.exec();
  return a === 1 || b === 1;
}

/** Other bookings of the same lead already counted held / qualified (a re-book counts once). */
function alreadyCounted(all, booking, field) {
  if (!booking.leadEmail) return false;
  return Object.values(all).some((b) => b.id !== booking.id && lower(b.leadEmail) === lower(booking.leadEmail) && b[field]);
}

/** Recompute qualified for a booking and keep the counter in step (+1 / −1). */
export async function rescore(clientId, bookingId, now = new Date()) {
  const all = await getBookings(clientId);
  const b = all[bookingId];
  if (!b) return null;
  const [profile, lead] = await Promise.all([getProfile(clientId), b.leadEmail ? getLead(clientId, b.leadEmail) : null]);
  const blocklisted = await isBlocklistedHost(clientId, b.leadEmail || b.attendeeEmail);
  const res = evaluateQualified({ booking: b, lead, profile, blocklisted });
  const was = Boolean(b.qualifiedCounted);
  const should = res.qualified && (was || !alreadyCounted(all, b, 'qualifiedCounted'));
  if (should !== was) await bump(clientId, 'qualified', should ? 1 : -1, now);
  await saveBooking(clientId, bookingId, { qualified: res.qualified, qualifiedReason: res.reason, qualifiedCounted: should });
  if (blocklisted && b.status === 'held' && !b.competitorAlertAt) {
    await saveBooking(clientId, bookingId, { competitorAlertAt: now.toISOString() });
    await alert('competitor_booked', { clientId, scope: `${clientId}:${bookingId}`, vars: { clientId }, body: `Booking ${bookingId} (${b.leadEmail || b.attendeeEmail}) is with a company on the client's blocklist — it never counts and is replaced.`, did: 'Marked not qualified.' });
  }
  return res;
}

async function markHeld(clientId, b, now) {
  const all = await getBookings(clientId);
  const counted = b.heldCounted || alreadyCounted(all, b, 'heldCounted');
  if (!counted) await bump(clientId, 'held', 1, now);
  return saveBooking(clientId, b.id, { status: 'held', heldCounted: true, heldAt: b.heldAt || now.toISOString() });
}

// ─── Taps ────────────────────────────────────────────────────────────────────

/**
 * Apply a client tap. action ∈ TAP_ACTIONS. `reason` (a DISPUTE_REASONS key)
 * is required for 'dispute'. Returns { ok, error?, booking }.
 */
export async function applyTap(clientId, bookingId, action, { reason = null, note = null, now = new Date() } = {}) {
  if (!TAP_ACTIONS.includes(action)) return { ok: false, error: 'unknown action' };
  const all = await getBookings(clientId);
  let b = all[bookingId];
  if (!b) return { ok: false, error: 'booking not found' };
  const at = now.toISOString();
  await kv.hset(K.trial(clientId), { lastClientActivityAt: at });
  if (note) b = await saveBooking(clientId, bookingId, { clientNote: String(note).slice(0, 1000) });

  if (action === 'dispute') {
    if (!DISPUTE_REASONS[reason]) return { ok: false, error: 'a reason is required: profile, title, attended or outreach' };
    const windowH = await ccfg(clientId, 'DISPUTE.windowBusinessHours');
    const since = b.scheduledAt ? businessHoursBetween(Date.parse(b.scheduledAt), now.getTime()) : 0;
    if (b.scheduledAt && since > windowH) return { ok: false, error: `the dispute window (${windowH} business hours after the call) has closed` };
    if (b.disputedAt) return { ok: true, booking: b, already: true };
    b = await saveBooking(clientId, bookingId, { status: 'disputed', disputedAt: at, disputeReason: reason, disputeNote: note || null, statusBeforeDispute: b.status });
    await rescore(clientId, bookingId, now);
    await alert('dispute', { clientId, scope: `${clientId}:${bookingId}`, vars: { clientId }, body: `The client disputed booking ${bookingId} (${b.leadEmail || b.attendeeEmail || 'unmatched'}, ${formatWhen(b.scheduledAt) || 'no time'}).\nReason: ${DISPUTE_REASONS[reason]}${note ? `\nNote: ${note}` : ''}`, did: 'Excluded from qualified. Uphold or overturn in Mission Control; it is upheld automatically after 48 h.' });
    await logEvent(clientId, 'scorekeeper', 'disputed', { bookingId, reason });
    return { ok: true, booking: b };
  }
  if (b.disputedAt && !b.disputeResolution) return { ok: false, error: 'this call is under dispute; the owner decides it' };
  const same = { showed: 'held', noshow: 'noshow', wrongfit: 'wrongfit' }[action];
  if (same && b.status === same && !(action === 'showed' && b.clientNoshowAt)) return { ok: true, booking: b, already: true };
  // A correction: undo the counters of the previous tap first.
  if (b.status === 'noshow' && action !== 'noshow') { await bump(clientId, 'noshows', -1, now); b = await saveBooking(clientId, bookingId, { noshowAt: null }); }
  if (b.status === 'wrongfit' && action !== 'wrongfit') await bump(clientId, 'wrongfit', -1, now);

  if (action === 'showed') {
    b = await saveBooking(clientId, bookingId, { attendedTapAt: at });
    b = await markHeld(clientId, b, now);
    await rescore(clientId, bookingId, now);
    await maybeQuoteRequest(clientId, bookingId, now);
  } else if (action === 'client_noshow') {
    // Client-side no-show / client cancel: counts as held on the original date.
    b = await saveBooking(clientId, bookingId, { clientNoshowAt: at, attendedTapAt: null });
    b = await markHeld(clientId, b, now);
    await rescore(clientId, bookingId, now);
    const lead = b.leadEmail ? await getLead(clientId, b.leadEmail) : null;
    if (lead) {
      const [s1, s2] = namedSlots(lead.tz || ET, now);
      await sendToProspect(clientId, 'apology_reschedule', { lead, vars: { missedWhen: formatWhen(b.scheduledAt, lead.tz || ET), slot1: s1.label, slot2: s2.label }, thread: { subject: lead.original_subject, messageId: lead.original_message_id, references: [lead.original_message_id].filter(Boolean) }, dedupe: `apology_reschedule:${bookingId}` });
    }
    await alert('client_noshow', { clientId, scope: `${clientId}:${bookingId}`, vars: { clientId }, body: `The client missed (or cancelled) the call with ${b.leadEmail || b.attendeeEmail || 'an unmatched attendee'} on ${formatWhen(b.scheduledAt) || '?'}.`, did: 'The prospect got an apology with two new slots; the call counts as held for the guarantee.' });
  } else if (action === 'noshow') {
    const wasHeld = b.heldCounted;
    b = await saveBooking(clientId, bookingId, { status: 'noshow', noshowAt: at, rebookAttempts: 0, rebookEmails: 0, heldCounted: false, attendedTapAt: null });
    if (wasHeld) await bump(clientId, 'held', -1, now);
    await bump(clientId, 'noshows', 1, now);
    await rescore(clientId, bookingId, now);
    await ladderStep(clientId, bookingId, now);
  } else if (action === 'wrongfit') {
    b = await saveBooking(clientId, bookingId, { attendedTapAt: at, wrongfitAt: at });
    b = await markHeld(clientId, b, now);
    await saveBooking(clientId, bookingId, { status: 'wrongfit' });
    await bump(clientId, 'wrongfit', 1, now);
    await rescore(clientId, bookingId, now);
  }
  await logEvent(clientId, 'scorekeeper', 'tap', { bookingId, action });
  return { ok: true, booking: (await getBookings(clientId))[bookingId] };
}

async function maybeQuoteRequest(clientId, bookingId, now) {
  const all = await getBookings(clientId);
  if (Object.values(all).some((b) => b.quoteRequestedAt)) return;
  const b = all[bookingId];
  const lead = b.leadEmail ? await getLead(clientId, b.leadEmail) : null;
  const r = await notifyClientSafe(clientId, 'quote_request', { Name: lead?.name || lead?.first_name || b.attendeeEmail || 'the prospect', Company: lead?.company || 'their company' }, { from: 'trial', dedupe: 'quote_request' });
  if (r.sent) await saveBooking(clientId, bookingId, { quoteRequestedAt: now.toISOString(), quoteRequestMessageId: r.messageId || null });
}

/** Owner decision on a dispute (Mission Control). */
export async function resolveDispute(clientId, bookingId, decision, { now = new Date(), by = 'owner' } = {}) {
  const all = await getBookings(clientId);
  const b = all[bookingId];
  if (!b || !b.disputedAt) return { ok: false, error: 'no dispute on this booking' };
  if (b.disputeResolution) return { ok: true, already: true, booking: b };
  if (!['uphold', 'overturn'].includes(decision)) return { ok: false, error: 'decision must be uphold or overturn' };
  const at = now.toISOString();
  if (decision === 'uphold') {
    await saveBooking(clientId, bookingId, { disputeResolution: by === 'auto' ? 'upheld_auto' : 'upheld', disputeResolvedAt: at });
  } else {
    const back = b.statusBeforeDispute && b.statusBeforeDispute !== 'booked' ? b.statusBeforeDispute : 'held';
    await saveBooking(clientId, bookingId, { disputeResolution: 'overturned', disputeResolvedAt: at, status: back, disputedAt: null });
  }
  await rescore(clientId, bookingId, now);
  await logEvent(clientId, 'scorekeeper', 'dispute_resolved', { bookingId, decision, by });
  return { ok: true, booking: (await getBookings(clientId))[bookingId] };
}

// ─── No-show ladder + hourly checks ──────────────────────────────────────────

/** Send the next re-book email if due; close after the window. */
async function ladderStep(clientId, bookingId, now) {
  const b = (await getBookings(clientId))[bookingId];
  if (!b || b.status !== 'noshow' || !b.noshowAt) return null;
  const days = await ccfg(clientId, 'NOSHOW_EMAIL_DAYS');
  const maxEmails = await ccfg(clientId, 'NOSHOW.emails');
  const maxAttempts = await ccfg(clientId, 'NOSHOW.attempts');
  const windowDays = await ccfg(clientId, 'NOSHOW.windowDays');
  const since = (now.getTime() - Date.parse(b.noshowAt)) / 864e5;
  if (since >= windowDays) {
    await saveBooking(clientId, bookingId, { status: 'closed_noshow', closedNoshowAt: now.toISOString() });
    await logEvent(clientId, 'scorekeeper', 'closed_noshow', { bookingId });
    return { closed: true };
  }
  const sent = Number(b.rebookEmails) || 0;
  if (sent >= Math.min(maxEmails, days.length) || since < days[sent]) return null;
  const lead = b.leadEmail ? await getLead(clientId, b.leadEmail) : null;
  if (!lead) return null;
  const [s1, s2] = namedSlots(lead.tz || ET, now);
  const r = await sendToProspect(clientId, 'rebook_email', {
    lead, vars: { missedWhen: formatWhen(b.scheduledAt, lead.tz || ET), slot1: s1.label, slot2: s2.label },
    thread: { subject: lead.original_subject, messageId: lead.original_message_id, references: [lead.original_message_id].filter(Boolean) },
    dedupe: `rebook:${bookingId}:${sent}`,
  });
  if (r.sent || r.deduped) {
    await saveBooking(clientId, bookingId, { rebookEmails: sent + 1, rebookAttempts: Math.min(maxAttempts, sent + 1), lastRebookAt: now.toISOString() });
  }
  return { sent: r.sent };
}

/** Hourly `noshow` job: ladder, auto-uphold disputes, Day-29 unconfirmed, no-show rate. */
export async function runScorekeeper(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const all = await getBookings(clientId);
  const out = { ladder: 0, autoUpheld: 0, unconfirmed: 0 };
  const autoH = await ccfg(clientId, 'DISPUTE.autoUpholdHours');
  const trial = await getTrial(clientId);
  const day = trialDay(trial, now);
  for (const b of Object.values(all)) {
    if (b.status === 'noshow') { const r = await ladderStep(clientId, b.id, now); if (r) out.ladder++; }
    if (b.disputedAt && !b.disputeResolution && now.getTime() - Date.parse(b.disputedAt) >= autoH * 3600e3) {
      await resolveDispute(clientId, b.id, 'uphold', { now, by: 'auto' });
      out.autoUpheld++;
    }
    // No tap by Day 29 → counted held for the report, flagged unconfirmed (not qualified).
    if (day !== null && day >= 29 && b.status === 'booked' && b.scheduledAt && Date.parse(b.scheduledAt) + 3600e3 < now.getTime() && !b.attendedTapAt && !b.cancelledAt) {
      await markHeld(clientId, b, now);
      await saveBooking(clientId, b.id, { unconfirmed: true });
      out.unconfirmed++;
    }
  }
  const totals = await getTotals(clientId);
  const high = await ccfg(clientId, 'NOSHOW.highRate');
  if (Number(totals.booked) > 0 && Number(totals.noshows) / Number(totals.booked) > high) {
    await alert('noshow_high', { clientId, vars: { clientId }, body: `${totals.noshows} of ${totals.booked} booked calls were no-shows (${Math.round((totals.noshows / totals.booked) * 100)}%).`, did: 'Reminders and the re-book ladder are running; check the reminder settings and the booking tool.' });
    out.noshowHigh = true;
  }
  return out;
}

