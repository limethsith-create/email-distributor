/**
 * warming → ready (SPEC §4, §7.1, §7.7). The gate is green when
 *   approval  client:{id}:sequence.approvedAt is set (click or silence)
 *   list      ≥ LIST.startMin unsent contacts (listReady)
 *   inboxes   every inbox passed the warm-up readiness rule (≥ 0.90 on two
 *             consecutive daily checks and ≥ 14 days)
 *   canary    the latest canary (today/yesterday, from Day −3), pooled with
 *             the run before it, has every inbox and the whole run at ≥
 *             CANARY.gate, and no inbox under CANARY.emergency in the latest
 *             run alone (canary.js gateCanary)
 *   spamTest  every inbox's latest spam test (mail-tester ≥ PLACEMENT.minScore
 *             of 10, or dkimvalidator within PLACEMENT.maxSpamAssassin with
 *             DKIM + SPF pass) passed within PLACEMENT.maxAgeDays — off with
 *             PLACEMENT.gate = false (systems/placement.js)
 *   booking   the client tapped "It worked" on the Booking Link Tester
 *             (profile.bookingTested, SPEC §6.7 step 4: Day 1 waits for it)
 * Green → state `ready` (Stage C's Sender starts on day1Date) and Day 1 is
 * fixed: the "we start on …" email goes (welcome_two_dates, once per Day 1,
 * in their daytime — systems/startemail.js, docs/IMPROVE-PASS.md C.3).
 * Not green on the morning of Day 1 → Day 1 slides one US sending day at a time (and
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
import { inboxesReady, warmupDays } from '@/lib/systems/warmup';
import { getInboxRecords } from '@/lib/db/inboxes';
import { latestCanary, priorCanary, gateCanary } from '@/lib/systems/canary';
import { spamTestGate } from '@/lib/systems/placement';
import { isSendingDay } from '@/lib/systems/ramp';
import { approvalUrl, fmtDay } from '@/lib/systems/approval';
import { sendStartEmail, startVars } from '@/lib/systems/startemail';

export function nextSendingDay(dayKey) {
  let d = addDays(dayKey, 1);
  for (let i = 0; i < 14 && !isSendingDay(d); i++) d = addDays(d, 1);
  return d;
}

export async function readinessGate(clientId, now = new Date()) {
  const [seq, list, inboxes, canary, profile] = await Promise.all([getStoredSequence(clientId), listReady(clientId), inboxesReady(clientId), latestCanary(clientId, now), getProfile(clientId)]);
  const gate = await cfg(clientId, 'CANARY.gate');
  // The latest run pooled with the one before it (a handful of seeds per inbox is noisy — canary.js gateCanary).
  const prior = canary ? await priorCanary(clientId, canary.day) : null;
  const read = gateCanary(canary, prior, { gate, emergency: await cfg(clientId, 'CANARY.emergency') });
  const canaryOk = Boolean(canary && read.ok && inboxes.inboxes.every((i) => canary.perInbox[i.email]));
  const spam = await spamTestGate(clientId, now, { inboxes: inboxes.inboxes.map((i) => i.email) });
  const checks = {
    approval: { ok: Boolean(seq.approvedAt), mode: seq.approvalMode || null },
    list: list,
    inboxes,
    // seeds / note: how many mailboxes the seed test used, and its plain note when that was thin (canary.js).
    canary: { ok: canaryOk, day: canary?.day || null, min: canary?.min ?? null, gate, seeds: canary?.seeds ?? null, note: canary?.note || null, pooledWith: read.pooled ? prior.day : null, pooledMin: Object.values(read.perInbox).reduce((m, x) => (x.pooled == null ? m : m == null ? x.pooled : Math.min(m, x.pooled)), null) },
    spamTest: spam,
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
  if (checks.spamTest && !checks.spamTest.ok) r.push('the spam-filter check on the new inboxes has not passed yet');
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
  // The same facts as the "we start on …" email (docs/IMPROVE-PASS.md C.3): the start in their zone, the window, the inbox.
  let facts = {};
  try { facts = await startVars(clientId, newDay1, { day30Date: newDay30 }); } catch { facts = {}; }
  try {
    await (deps.notify || notifyClient)(clientId, 'day1_moved', { day1Date: fmtDay(newDay1), day30Date: fmtDay(newDay30), startWhen: fmtDay(newDay1), ...facts, reason: held ? 'everything is now ready' : reason, waitingLine, ownerName }, { dedupe: `day1_moved:${newDay1}` });
    // Moved as the gate turned green: this email is the "we start on …" email for the new Day 1.
    if (held) await setTrial(clientId, { startEmailFor: newDay1 });
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
    // Green on Day 1 itself: the Sender starts today (its window opens 09:00
    // ET). Only a Day 1 already in the past (held / slid) is reset.
    const reset = !trial.day1Date || trial.day1Date < today;
    if (reset) await announceMove(id, trial, nextSendingDay(today), gate, { held: true, deps });
    const moved = await setState(id, 'ready', 'readiness gate green (approval, list, warm-up, seed + spam tests, booking link)');
    await setTrial(id, { day1Held: '', readyAt: now.toISOString() });
    // Day 1 is fixed: "we start on …" (after a reset, day1_moved above already said it).
    if (moved && !reset) {
      try { await (deps.startEmail || sendStartEmail)(id, { now, notify: deps.notify || null }); } catch (err) {
        await logEvent(id, 'readiness', 'start_email_failed', { error: String(err?.message || err).slice(0, 200) });
      }
    }
    return { ready: moved, checks: gate.checks };
  }

  // The day before Day 1 with only tonight's warm-up check left: the "we start on …" email goes now (their daytime),
  // not the morning of Day 1. Once per Day 1 (sendStartEmail keeps `startEmailFor`); the gate turning green tonight
  // then sends nothing more, and a failed check moves Day 1 with day1_moved.
  if (trial.day1Date && trial.day1Date > today && nextSendingDay(today) === trial.day1Date && trial.startEmailFor !== trial.day1Date) {
    const [recs, readyRate, need, minDays] = await Promise.all([getInboxRecords(id), cfg(id, 'WARMUP.readyRate'), cfg(id, 'WARMUP.readyConsecutiveDays'), cfg(id, 'BUILD.warmupReadyMinDays')]);
    if (onlyTonightLeft(gate, recs, { today, readyRate, need, minDays, now })) {
      try {
        const r = await (deps.startEmail || sendStartEmail)(id, { now, notify: deps.notify || null, dayBefore: true });
        if (r?.sent) await logEvent(id, 'readiness', 'start_email_day_before', { day1: trial.day1Date });
      } catch (err) {
        await logEvent(id, 'readiness', 'start_email_failed', { error: String(err?.message || err).slice(0, 200) });
      }
    }
  }

  // Warm-up readiness is decided by the daily check (23:45, or the warm-up
  // run that sees the day's warm-up over — warmup.js readinessCheckpoint, which
  // also calls this gate at once), so the last chance for Day 1 is that check
  // on Day −1: the slide decision waits for Day 1's first readiness run
  // (00:30), instead of sliding on Day −1 while the final warm-up check is
  // still to come (it made every Day 1 slide once).
  const td = trialDay(trial, now);
  if (td == null || td < 1 || trial.slideCheckedDay === today) return { ready: false, checks: summarize(gate.checks) };
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

/**
 * Only tonight's warm-up check stands between the trial and Day 1 (pure):
 * every other check of the gate is green, and each inbox not ready yet
 * reaches its day `minDays` today, passed its last daily check yesterday
 * (rate ≥ `readyRate`) and needs just one more passing check. Then the
 * "we start on …" email can go today, in their daytime — a day's notice —
 * instead of the morning of Day 1 (the last check runs at 23:30 ET, after
 * their evening). If tonight's check fails, Day 1 moves and `day1_moved` says so.
 */
export function onlyTonightLeft(gate, recs = [], { today, readyRate = 0.9, need = 2, minDays = 14, now = new Date() } = {}) {
  if (!gate?.checks || gate.ok) return false;
  if (!Object.entries(gate.checks).every(([k, c]) => k === 'inboxes' || !c || c.ok)) return false;
  const warming = (recs || []).filter((r) => r && r.passwordEnc && r.warmupEnabled !== '0');
  if (!warming.length) return false;
  const yesterday = addDays(today, -1);
  return warming.every((r) => {
    if (r.warmupReady === '1') return true;
    if (!r.warmupStartedAt || r.warmupAwaitingFirstSend === '1') return false;
    const rate = r.inboxRate7d === '' || r.inboxRate7d == null ? null : Number(r.inboxRate7d);
    return warmupDays(r, now) >= minDays && r.readyCheckedDay === yesterday && (Number(r.readyStreak) || 0) >= need - 1 && rate != null && rate >= readyRate;
  });
}

function summarize(checks) {
  return Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok]));
}
