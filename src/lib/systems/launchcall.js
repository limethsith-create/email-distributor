/**
 * The launch call (docs/LAUNCH-CALL.md) — the owner's words: "I want
 * confirmation with the customer about the email copy before we send. I need
 * another call in the system: the first is the onboarding call; the second
 * explains the lead list and the email copy and gets their OK. While warm-up
 * runs, tell them we are researching their business and building an offer."
 *
 *  - sendNextSteps: the ONE "what happens now" email — after the onboarding
 *    call is held, or at the agreement when that came first (it then carries
 *    the setup news, so `setup_in_progress` does not go too). The Day 1 in it
 *    is only ever the ramp's estimate; nothing known → "in about three weeks".
 *  - readyForLaunch: the invite may go when the list has LIST.startMin
 *    sendable contacts, the sequence is built and passes the Copy Checker,
 *    and warm-up is at day LAUNCH.earliestWarmupDay or later.
 *  - sendLaunchInvite: `launch_invite` from the onboarding-call inbox — the
 *    booking page for a launch call and, below it, the approval page link —
 *    tracked like the acceptance email (open pixel, Message-IDs, dueBy) and
 *    followed by the owner alert `launch_ready`.
 *  - runLaunchStep: what the hourly `approval` job asks first — invite, wait,
 *    or hand back to the plain approval email (LAUNCH.fallbackDay reached, a
 *    link that already went, or a client with no warm-up records at all).
 *  - approvedOnCall / skipCall / noteApprovedOnPage: the owner's two extra
 *    buttons and the page's own approval, on the launch call's hash.
 *  - launchCallFor / launchCallAction: the hub's `launchCall` and its POST.
 *
 * The tracking itself — states, reminders, overdue, the inbox, the calendar
 * meeting (kind 'launch'), the reply bot on its thread — is
 * systems/onboardcall.js with kind 'launch': two calls, one machinery.
 * Storage: client:{id}:launchcall (the same fields as the onboarding call
 * plus approvedOnCall, approvedOnPage, skipped) and two flags on the client
 * hash the tick reads: launchCallSentAt, launchCallOpen. No AI anywhere.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getTrial, getProfile, updateClient } from '@/lib/db/client';
import { getInboxRecords } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { renderTemplate } from '@/lib/templates/client';
import { dayKeyIn, ET, addDays } from '@/lib/time';
import { warmupDays } from '@/lib/systems/warmup';
import { listReady } from '@/lib/systems/leadfinder';
import { getStoredSequence, buildSequence, checkVariant, sampleLead } from '@/lib/systems/copy';
import { approvalUrl, approveAllOnCall, noteLinkInInvite } from '@/lib/systems/approval';
import { io, sendClient, firstNameOf, ownerName, formatDay, nextUsBusinessDay } from '@/lib/systems/intake-io';
import { lower, shortHash } from '@/lib/systems/stagec-common';
import * as conv from '@/lib/systems/conversation';
import * as call from '@/lib/systems/onboardcall';

const SYSTEM = 'launchcall';
const KIND = 'launch';
const flag = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0';
const ms = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** Owner alert that never throws (the email already went). */
async function alert(key, opts) {
  try { return await io.alertOwner(key, opts); } catch (err) { console.error('[launchcall] alert failed', key, err?.message); return { sent: false }; }
}
const person = (client) => client.contactName || client.contactEmail || client.name || client.id;

// ─── the Day 1 estimate (pure) ───────────────────────────────────────────────

/**
 * The Day 1 the client may be told, from the ramp and nothing else: the
 * trial's day1Date once the setup checks set it; else the slowest inbox's
 * first warm-up day + BUILD.warmupReadyMinDays, moved to the next US business
 * day; else null — nothing has started, so "in about three weeks".
 */
export function day1Estimate({ trial = {}, inboxes = [], minDays = 14 } = {}) {
  if (trial?.day1Date) return trial.day1Date;
  const starts = (inboxes || []).map((r) => r?.warmupStartedAt).filter(Boolean).map((v) => dayKeyIn(ET, new Date(v))).sort();
  if (!starts.length) return null;
  return nextUsBusinessDay(addDays(starts[starts.length - 1], Number(minDays) || 14));
}

/** 'about Wednesday 21 October' — or, with no estimate, 'in about three weeks'. */
export const day1Line = (dayKey) => (dayKey ? `about ${formatDay(dayKey)}` : 'in about three weeks');

// ─── "what happens now" ──────────────────────────────────────────────────────

/**
 * The one `next_steps` email (docs/LAUNCH-CALL.md §1). `moment`: 'call' (the
 * onboarding call was just held) or 'agreement' (the agreement came first: the
 * plan carries the setup news). Sent once per client whatever the moment.
 * → { sent, already?, day1 }
 */
export async function sendNextSteps(clientId, { now = io.now(), moment = 'call' } = {}) {
  assertClientId(clientId);
  const [client, trial] = await Promise.all([getClient(clientId), getTrial(clientId)]);
  if (!client || !client.contactEmail) return { sent: false, reason: 'no contact email' };
  if (trial?.nextStepsSentAt) return { sent: false, already: true };
  const [inboxes, minDays, listSize, callMinutes] = await Promise.all([
    getInboxRecords(clientId).catch(() => []), cfg(clientId, 'BUILD.warmupReadyMinDays'), cfg(clientId, 'LIST.need'), cfg(clientId, 'LAUNCH.callMinutes'),
  ]);
  const day1 = day1Estimate({ trial: trial || {}, inboxes, minDays });
  const vars = {
    firstName: firstNameOf(client.contactName) || 'there',
    ownerName: await ownerName(clientId),
    opening: moment === 'agreement' ? 'Your agreement is in and your market check passed, so we are going ahead.' : 'Good to talk with you today — thank you for your time.',
    listSize: Number(listSize) || 400,
    callMinutes,
    day1Line: day1Line(day1),
  };
  const res = await sendClient(clientId, 'next_steps', vars, { dedupe: 'next_steps', thread: false, now, moment });
  const at = now.toISOString();
  await kv.hset(K.trial(clientId), { nextStepsSentAt: at, nextStepsMoment: moment });
  if (!res.deduped) {
    const copy = res.subject && res.text ? res : renderTemplate('next_steps', { clientName: client.name, contactName: client.contactName, ...vars });
    await conv.pushEntry(clientId, { id: `out-${shortHash(res.messageId || `${at}|next_steps`)}`, dir: 'out', at, from: res.from || null, to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'next_steps' });
    if (res.messageId) {
      const c = await conv.readConvo(clientId);
      await conv.patchConvo(clientId, { messageIds: JSON.stringify(conv.withId(c.messageIds, res.messageId)) });
    }
  }
  await logEvent(clientId, SYSTEM, 'next_steps_sent', { moment, day1, deduped: Boolean(res.deduped) || undefined });
  return { sent: !res.deduped, day1 };
}

// ─── ready for the launch call? ──────────────────────────────────────────────

/** The Copy Checker over both variants for a sample lead → { ok, built, failures: ['A d0: spam_words', …] }. */
async function copyGreen(clientId, seq, profile) {
  if (!seq.variantA || !seq.variantB) return { ok: false, built: false, failures: [] };
  const lead = await sampleLead(clientId);
  if (!lead) return { ok: false, built: true, failures: ['no sample lead to check the emails with'] };
  const maxWords = await cfg(clientId, 'COPY.maxWords');
  const failures = [];
  for (const [label, v] of [['A', seq.variantA], ['B', seq.variantB]]) {
    for (const r of checkVariant(v, profile, lead, { maxWords })) if (!r.ok) failures.push(`${label} ${r.touch}: ${r.failures.map((f) => f.rule).join(', ')}`);
  }
  return { ok: failures.length === 0, built: true, failures };
}

/**
 * May the launch invite go (docs/LAUNCH-CALL.md §2)? Warm-up day = the
 * slowest inbox's (as the warm-up card counts it). `build`: write the
 * sequence first when it is missing and the list is in (the job does; a
 * read-only look does not).
 * → { ok, checks: { warmup, list, copy }, reasons: [plain words] }
 */
export async function readyForLaunch(clientId, { now = io.now(), build = false } = {}) {
  const s = await call.onboardSettings();
  const [inboxes, list, profile] = await Promise.all([getInboxRecords(clientId).catch(() => []), listReady(clientId, { now }), getProfile(clientId)]);
  const on = inboxes.filter((r) => r.warmupStartedAt && r.warmupEnabled !== '0');
  const day = on.length ? Math.min(...on.map((r) => warmupDays(r, now))) : 0;
  const warmup = { ok: on.length > 0 && day >= s.launch.earliestWarmupDay, day, need: s.launch.earliestWarmupDay, started: on.length > 0 };
  let seq = await getStoredSequence(clientId);
  if (build && !seq.variantA && list.ok) {
    const built = await buildSequence(clientId);
    if (built.ok) seq = await getStoredSequence(clientId);
  }
  const copy = await copyGreen(clientId, seq, profile);
  const reasons = [];
  if (!warmup.ok) reasons.push(warmup.started ? `warm-up is on day ${day} of at least ${warmup.need}` : 'warm-up has not started');
  if (!list.ok) reasons.push(`the list has ${list.unsent} of the ${list.startMin} contacts we need`);
  if (!copy.ok) reasons.push(copy.built ? `the Copy Checker failed on ${copy.failures.join('; ')}` : 'the emails are not written yet');
  return { ok: reasons.length === 0, checks: { warmup, list: { ok: list.ok, unsent: list.unsent, startMin: list.startMin }, copy }, reasons };
}

// ─── the invite ──────────────────────────────────────────────────────────────

/**
 * Send `launch_invite` (email first, records second: a failed send throws and
 * nothing is marked). A second call without `resend` does nothing. `resend`
 * sends it again in the same thread and restarts the reminders and the
 * booking clock from now. The approval page link inside it is the same page
 * as always (the client may approve there without a call).
 */
export async function sendLaunchInvite(clientId, { now = io.now(), resend = false } = {}) {
  assertClientId(clientId);
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  if (!client.contactEmail) throw new Error(`no contact email for ${clientId}`);
  const raw = await call.readCall(clientId, KIND);
  if (flag(raw.sentAt) && !resend) return { already: true };
  const s = call.settingsFor(await call.onboardSettings(), KIND);
  const n = (Number(raw.sends) || 0) + 1;
  const [profile, trial, inboxes, minDays, onboardRaw] = await Promise.all([getProfile(clientId), getTrial(clientId), getInboxRecords(clientId).catch(() => []), cfg(clientId, 'BUILD.warmupReadyMinDays'), call.readCall(clientId)]);
  const vars = {
    firstName: firstNameOf(client.contactName) || 'there', ownerName: await ownerName(clientId),
    senderName: profile.senderName || client.name || clientId, callMinutes: s.callMinutes,
    bookingLine: call.bookingLine(s, await call.ownBookingLink(clientId, s, `l${n}`, KIND)),
    approvalUrl: await approvalUrl(clientId),
    day1Line: day1Line(day1Estimate({ trial: trial || {}, inboxes, minDays })),
  };
  const res = await sendClient(clientId, 'launch_invite', vars, {
    dedupe: n === 1 ? 'launch_invite' : `launch_invite:${n}`,
    thread: false, // its own entry below (kind 'launch_invite')
    pixel: 'launch', // the call's own pixel, also naming this email (delivery monitoring)
    now,
    resend: flag(raw.sentAt), // for the delivery watch's retry
    linkify: true,
    ...(flag(raw.sentAt) ? call.threadHeaders(raw) : {}),
  });
  const at = now.toISOString();
  const copy = res.subject && res.text ? res : renderTemplate('launch_invite', { clientName: client.name, contactName: client.contactName, ...vars });
  const fromInbox = res.from || null;
  await call.patchCall(clientId, {
    ...(flag(raw.sentAt) ? {} : { sentAt: at, subject: copy.subject }),
    lastSentAt: at,
    sends: n,
    fromInbox,
    contactEmail: lower(client.contactEmail),
    messageIds: JSON.stringify(conv.withId(raw.messageIds, res.messageId)),
    dueBy: call.dueByFrom(now, s.bookWithinDays).toISOString(),
    remindersSent: 0,
    overdueAt: null,
    // Their zone as the Calendar learnt it on the onboarding call (the day-before reminder and the labels use it).
    theirZone: raw.theirZone || onboardRaw.theirZone || null,
  }, KIND);
  await conv.pushEntry(clientId, { id: `out-${shortHash(res.messageId || `${at}|launch_invite`)}`, dir: 'out', at, from: fromInbox, to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'launch_invite' });
  await updateClient(clientId, { ...(client.launchCallSentAt ? {} : { launchCallSentAt: at }), launchCallOpen: '1' });
  if (!flag(raw.sentAt)) await noteLinkInInvite(clientId, now);
  await logEvent(clientId, SYSTEM, resend ? 'invite_resent' : 'invite_sent', { messageId: res.messageId || null, from: fromInbox, deduped: Boolean(res.deduped) || undefined });
  return { sent: true, messageId: res.messageId || null, from: fromInbox };
}

/**
 * The `approval` job's first question (docs/LAUNCH-CALL.md §2): does the
 * launch call carry the approval for this client now?
 *  - the invite already went → yes: the call's own reminders and overdue run,
 *    the page's reminders and the silence rule do not;
 *  - the plain approval link already went (before this call) → no;
 *  - no inbox in warm-up at all (a client from before warm-up records) → no:
 *    the path from before this call;
 *  - ready → the invite goes now (+ `launch_ready`);
 *  - not ready and LAUNCH.fallbackDay reached → no, with `fallback` saying why
 *    (the plain link goes);
 *  - else → yes, waiting.
 * → { handled: bool, result?, fallback? }
 */
export async function runLaunchStep({ client, trial = {}, td = null, approval = {}, now = io.now() }) {
  const id = client.id;
  const raw = await call.readCall(id, KIND);
  if (flag(raw.sentAt)) return { handled: true, result: { launch: call.statusOf(raw, { now, clientState: client.state, kind: KIND }) } };
  if (approval.sentAt) return { handled: false };
  const inboxes = await getInboxRecords(id).catch(() => []);
  if (!inboxes.some((r) => r.warmupStartedAt)) return { handled: false };
  const ready = await readyForLaunch(id, { now, build: true });
  if (ready.ok) {
    const sent = await sendLaunchInvite(id, { now });
    if (sent.sent) {
      await alert('launch_ready', {
        clientId: id,
        vars: { clientId: id },
        body: `${client.name || id} is ready for the launch call: ${ready.checks.list.unsent} contacts on the list, the four emails pass the Copy Checker, warm-up day ${ready.checks.warmup.day}. The invite went to ${person(client)} with the booking page and the approval page.`,
        did: 'Nothing for you until they pick a time (it comes to your Calendar) or approve on the page. On the call, press Approved on the call in the hub.',
        url: `/#trial/${id}`,
      });
    }
    return { handled: true, result: { launchInvite: sent } };
  }
  const s = await call.onboardSettings();
  const fallbackDay = s.launch.fallbackDay;
  if (fallbackDay != null && td != null && td >= fallbackDay) {
    await logEvent(id, SYSTEM, 'fallback_to_approval_link', { td, reasons: ready.reasons });
    return { handled: false, fallback: ready.reasons.join('; ') };
  }
  return { handled: true, result: { waiting: `launch call: ${ready.reasons.join('; ')}` } };
}

// ─── the OK ──────────────────────────────────────────────────────────────────

/**
 * They approved every section on the page while the launch call was in play:
 * the call is optional now (docs/LAUNCH-CALL.md §3). Called by
 * approval.approveSection; nothing when no invite went.
 */
export async function noteApprovedOnPage(clientId, at) {
  const raw = await call.readCall(clientId, KIND);
  if (!flag(raw.sentAt) || flag(raw.approvedOnPage) || flag(raw.approvedOnCall)) return false;
  await call.patchCall(clientId, { approvedOnPage: at }, KIND);
  await logEvent(clientId, SYSTEM, 'approved_on_page', {});
  return true;
}

async function requireInvite(clientId) {
  assertClientId(clientId);
  const client = await getClient(clientId);
  if (!client) throw new call.OnboardCallError('not found', 404);
  const raw = await call.readCall(clientId, KIND);
  if (!flag(raw.sentAt)) throw new call.OnboardCallError('No launch invite went to them yet — it goes by itself once the list and the emails are ready.', 409);
  return { client, raw };
}

/**
 * "Approved on the call": every section approved with approvalMode 'call'
 * (the readiness gate turns green on it) and the call marked held. Pressing it
 * again changes nothing.
 */
export async function approvedOnCall(clientId, { now = io.now() } = {}) {
  const { raw } = await requireInvite(clientId);
  if (flag(raw.skipped)) throw new call.OnboardCallError('The call was skipped — they had approved on the page already.', 409);
  if (flag(raw.approvedOnCall)) return { approved: false, already: true };
  const approved = await approveAllOnCall(clientId, { now, by: await ownerName(clientId).catch(() => 'owner') });
  if (!flag(raw.heldAt)) await call.markHeld(clientId, { now, kind: KIND });
  await call.patchCall(clientId, { approvedOnCall: now.toISOString() }, KIND);
  await updateClient(clientId, { launchCallOpen: '0' });
  await logEvent(clientId, SYSTEM, 'approved_on_call', { sequenceApproved: approved });
  return { approved };
}

/**
 * "Skip the call": only once they approved on the page, and never while a
 * time is booked or waits for the owner's answer (cancel or decline that in
 * the Calendar first — they get a note there; skipping is silent).
 */
export async function skipCall(clientId, { now = io.now() } = {}) {
  const { raw } = await requireInvite(clientId);
  if (flag(raw.skipped)) return { already: true };
  if (flag(raw.heldAt)) throw new call.OnboardCallError('The call already happened — nothing to skip.', 409);
  if (!flag(raw.approvedOnPage)) throw new call.OnboardCallError('Skip the call only once they approved on the page — until then the call is where they give the OK.', 409);
  if (call.requestPending(raw)) throw new call.OnboardCallError('They asked for a time — answer it in the Calendar first (Decline tells them), then skip.', 409);
  if (flag(raw.bookedAt) && (ms(raw.bookedFor) || 0) > now.getTime()) throw new call.OnboardCallError('A call is booked with them — cancel it in the Calendar first (they get a note), then skip.', 409);
  await call.patchCall(clientId, { skipped: now.toISOString() }, KIND);
  await updateClient(clientId, { launchCallOpen: '0' });
  await logEvent(clientId, SYSTEM, 'skipped', {});
  return { skipped: true };
}

/** "Send the invite again": same thread, reminders and the booking clock restart. Only while the call is still to happen. */
export async function resendInvite(clientId, { now = io.now() } = {}) {
  const { client, raw } = await requireInvite(clientId);
  if (!call.launchOpen(raw, client.state)) throw new call.OnboardCallError(flag(raw.heldAt) ? 'The call already happened — nothing to resend.' : flag(raw.skipped) ? 'The call was skipped — nothing to resend.' : `They are past warm-up (${client.state}) — nothing to resend.`, 409);
  return sendLaunchInvite(clientId, { now, resend: true });
}

// ─── the hub ─────────────────────────────────────────────────────────────────

/** The hub's `launchCall` (docs/LAUNCH-CALL.md §5): null until the invite is sent. */
export async function launchCallFor(clientId, { now = io.now(), client = null, settings = null } = {}) {
  const c = client || await getClient(clientId);
  if (!c || !flag(c.launchCallSentAt)) return null;
  let url = null;
  try { url = await approvalUrl(clientId); } catch { url = null; }
  return call.onboardCallFor(clientId, { now, client: c, kind: KIND, approvalUrl: url, settings });
}

/** POST /api/mc/clients/{id}/launch-call → { ok, launchCall }. */
export async function launchCallAction(clientId, body = {}, { now = io.now() } = {}) {
  switch (body.action) {
    case 'reply': await call.ownerReply(clientId, body.text, { now, kind: KIND }); break;
    case 'markBooked': await call.markBooked(clientId, body.when, { now, kind: KIND }); break;
    case 'markHeld': await call.markHeld(clientId, { now, kind: KIND }); break;
    case 'markNoShow': await call.markNoShow(clientId, { now, kind: KIND }); break;
    case 'resend': await resendInvite(clientId, { now }); break;
    case 'stopReminders': await call.stopReminders(clientId, { now, kind: KIND }); break;
    case 'approvedOnCall': await approvedOnCall(clientId, { now }); break;
    case 'skip': await skipCall(clientId, { now }); break;
    default: throw new call.OnboardCallError('Unknown action — use reply, markBooked, markHeld, markNoShow, resend, stopReminders, approvedOnCall or skip.');
  }
  return { ok: true, launchCall: await launchCallFor(clientId, { now }) };
}
