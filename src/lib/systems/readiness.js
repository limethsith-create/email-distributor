/**
 * warming → ready (SPEC §4, §7.1, §7.7). The gate is green when
 *   approval  client:{id}:sequence.approvedAt is set (click or silence)
 *   list      ≥ LIST.startMin unsent contacts (listReady)
 *   inboxes   every inbox passed the warm-up readiness rule (≥ 0.90 on two
 *             consecutive daily checks and ≥ 14 days)
 *   canary    the latest canary (today/yesterday, from Day −3) has every
 *             inbox at ≥ CANARY.gate
 *   booking   the client tapped "It worked" on the Booking Link Tester
 *             (profile.bookingTested, SPEC §6.7 step 4: Day 1 waits for it)
 * Green → state `ready` (Stage C's Sender starts on day1Date).
 * Not green from Day −1 on → Day 1 slides one US sending day at a time (and
 * Day 30 with it), client email day1_moved, owner day1_slid; after
 * WARMUP.maxSlideDays slides Day 1 is held and the owner gets warmup_stalled
 * daily until the gate turns green, when Day 1 is set to the next sending day.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getTrial, getProfile, setState } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { alertOwner, notifyClient } from '@/lib/notify';
import { ET, dayKeyIn, trialDay, addDays } from '@/lib/time';
import { getStoredSequence } from '@/lib/systems/copy';
import { listReady } from '@/lib/systems/leadfinder';
import { inboxesReady } from '@/lib/systems/warmup';
import { latestCanary } from '@/lib/systems/canary';
import { isSendingDay } from '@/lib/systems/ramp';
import { approvalUrl, fmtDay } from '@/lib/systems/approval';

export function nextSendingDay(dayKey) {
  let d = addDays(dayKey, 1);
  for (let i = 0; i < 14 && !isSendingDay(d); i++) d = addDays(d, 1);
  return d;
}

export async function readinessGate(clientId, now = new Date()) {
  const [seq, list, inboxes, canary, profile] = await Promise.all([getStoredSequence(clientId), listReady(clientId), inboxesReady(clientId), latestCanary(clientId, now), getProfile(clientId)]);
  const gate = await cfg(clientId, 'CANARY.gate');
  const per = canary?.perInbox ? Object.values(canary.perInbox) : [];
  const canaryOk = Boolean(canary && per.length && per.every((r) => r.placement != null && r.placement >= gate) && inboxes.inboxes.every((i) => canary.perInbox[i.email]));
  const checks = {
    approval: { ok: Boolean(seq.approvedAt), mode: seq.approvalMode || null },
    list: list,
    inboxes,
    canary: { ok: canaryOk, day: canary?.day || null, min: canary?.min ?? null, gate },
    booking: { ok: ['1', 'true', 1, true].includes(profile.bookingTested), testedAt: profile.bookingTestedAt || null },
  };
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

function reasonsText(checks) {
  const r = [];
  if (!checks.approval.ok) r.push('the emails are still waiting for your OK');
  if (!checks.list.ok) r.push(`the list is still being built (${checks.list.unsent} of the ${checks.list.startMin} contacts we need to start)`);
  if (!checks.inboxes.ok) r.push('the new inboxes need a few more days of warm-up');
  if (!checks.canary.ok) r.push('the inbox placement test is not yet at our 85% line');
  if (checks.booking && !checks.booking.ok) r.push('your booking link test is not done yet (tap "It worked" in the test email)');
  return r.join('; ') || 'a final check did not pass';
}

async function setTrial(clientId, fields) {
  await kv.hset(K.trial(clientId), fields);
}

async function announceMove(clientId, trial, newDay1, gate, { held = false, deps = {} } = {}) {
  const newDay30 = addDays(newDay1, 29);
  await setTrial(clientId, { day1Date: newDay1, day30Date: newDay30, day1Original: trial.day1Original || trial.day1Date || '', day1MovedAt: new Date().toISOString() });
  const reason = reasonsText(gate.checks);
  const asks = [];
  if (!gate.checks.approval.ok) asks.push(`approve the emails here: ${await approvalUrl(clientId)}`);
  if (gate.checks.booking && !gate.checks.booking.ok) asks.push('do the 60-second booking link test from our earlier email and tap "It worked"');
  const waitingLine = !asks.length ? 'Nothing is needed from you.' : asks.length === 1 ? `One thing from you: ${asks[0]}` : `Two things from you: ${asks.join('; and ')}`;
  const ownerName = (await cfg(clientId, 'OWNER.signerName')) || 'The Aviance team';
  try {
    await (deps.notify || notifyClient)(clientId, 'day1_moved', { day1Date: fmtDay(newDay1), day30Date: fmtDay(newDay30), reason: held ? 'everything is now ready' : reason, waitingLine, ownerName }, { dedupe: `day1_moved:${newDay1}` });
  } catch (err) {
    await logEvent(clientId, 'readiness', 'day1_moved_email_failed', { error: err.message });
  }
  await alertOwner('day1_slid', { clientId, scope: `${clientId}:${newDay1}`, vars: { clientId, date: newDay1 }, body: `Day 1 is now ${newDay1} (was ${trial.day1Date}). Waiting on: ${reason}.`, did: 'The client was emailed the new dates; Day 30 moved with Day 1.' });
  await logEvent(clientId, 'readiness', 'day1_moved', { from: trial.day1Date, to: newDay1, reason });
}

/**
 * The `readiness` job (hourly from BUILD.readinessAt ET, client in `warming`).
 * Promotion can happen any hour; a slide happens at most once per ET day.
 */
export async function runReadiness({ client, now = new Date(), deps = {} }) {
  const id = client.id;
  if (client.state !== 'warming') return { skipped: client.state };
  const trial = await getTrial(id);
  const today = dayKeyIn(ET, now);
  const gate = await readinessGate(id, now);

  if (gate.ok) {
    // A held / passed Day 1 is reset to the next sending day.
    if (!trial.day1Date || trial.day1Date <= today) await announceMove(id, trial, nextSendingDay(today), gate, { held: true, deps });
    const moved = await setState(id, 'ready', 'readiness gate green (approval, list, warm-up, canary, booking link)');
    await setTrial(id, { day1Held: '', readyAt: now.toISOString() });
    return { ready: moved, checks: gate.checks };
  }

  const td = trialDay(trial, now);
  if (td == null || td < -1 || trial.slideCheckedDay === today) return { ready: false, checks: summarize(gate.checks) };
  await setTrial(id, { slideCheckedDay: today });
  const slides = Number(trial.day1Slides) || 0;
  const maxSlides = await cfg(id, 'WARMUP.maxSlideDays');
  if (slides >= maxSlides) {
    await setTrial(id, { day1Held: '1' });
    await alertOwner('warmup_stalled', { clientId: id, vars: { clientId: id }, body: `Day 1 has moved ${slides} times and is now held. Still waiting on: ${reasonsText(gate.checks)}.`, did: 'Day 1 is held (no further automatic moves); it is set to the next sending day as soon as every check is green.' });
    return { ready: false, held: true, checks: summarize(gate.checks) };
  }
  const base = trial.day1Date && trial.day1Date > today ? trial.day1Date : today;
  const newDay1 = nextSendingDay(base);
  await setTrial(id, { day1Slides: String(slides + 1) });
  await announceMove(id, trial, newDay1, gate, { deps });
  return { ready: false, slid: newDay1, checks: summarize(gate.checks) };
}

function summarize(checks) {
  return Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok]));
}
