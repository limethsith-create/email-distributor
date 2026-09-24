/**
 * Ramp Planner (SPEC §7.7). Daily 00:05 ET: sets `dailyCap` and `rampStage`
 * on every inbox of a trial client.
 *
 *   sending day 1–2 = 8, 3–4 = 12, 5–6 = 16, 7+ = COLD_CAP (RAMP.caps)
 *   modifiers: inboxRate7d < WARMUP.lowRate → halve (+ alert inbox_rate_low)
 *              yesterday's bounces > BOUNCE.max of sends → halve
 *              client.emergencyHalved = '1' → halve   (written by Stage C)
 *              client.emergencyActive = '1' → 0       (written by Stage C)
 *              inbox.capOverride (owner, Inboxes page) → never above it
 *   never above 25 (HARD_COLD_CAP), whatever the config says.
 *
 * "Sending day" = US business days (Mon–Fri, not a federal holiday) from
 * day1Date to today inclusive; before Day 1 the cap is 0.
 */

import { cfg, HARD_COLD_CAP, isUsHoliday } from '@/lib/config';
import { getTrial } from '@/lib/db/client';
import { getInboxRecords, patchInbox } from '@/lib/db/inboxes';
import { getDay } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { ET, dayKeyIn, addDays, daysBetween } from '@/lib/time';

const WEEKDAY = (dayKey) => new Date(`${dayKey}T12:00:00Z`).getUTCDay();

export function isSendingDay(dayKey) {
  const w = WEEKDAY(dayKey);
  return w !== 0 && w !== 6 && !isUsHoliday(dayKey);
}

/** Business days from day1 to today inclusive (0 before Day 1). */
export function sendingDayNumber(day1Date, today) {
  if (!day1Date || today < day1Date) return 0;
  const span = daysBetween(day1Date, today);
  let n = 0;
  for (let i = 0; i <= span; i++) if (isSendingDay(addDays(day1Date, i))) n++;
  return n;
}

/** Table lookup: {'1-2': 8, '3-4': 12, '5-6': 16, '7+': 25}. */
export function baseCap(sendingDay, caps) {
  if (!sendingDay || sendingDay < 1) return 0;
  let cap = 0;
  for (const [range, n] of Object.entries(caps || {})) {
    const m = /^(\d+)(?:-(\d+)|\+)$/.exec(range);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : Infinity;
    if (sendingDay >= lo && sendingDay <= hi) cap = Number(n) || 0;
  }
  return cap;
}

/**
 * Pure cap computation for one inbox.
 * @returns {{cap, stage, reasons: string[]}}
 */
export function computeCap({ sendingDay, caps, coldCap = HARD_COLD_CAP, inboxRate = null, lowRate = 0.8, bounceRate = null, bounceMax = 0.02, emergencyActive = false, emergencyHalved = false, capOverride = null }) {
  const reasons = [];
  let cap = Math.min(baseCap(sendingDay, caps), coldCap, HARD_COLD_CAP);
  const stage = sendingDay < 1 ? 'pre-day1' : (Object.keys(caps || {}).find((r) => baseCap(sendingDay, { [r]: 1 }) === 1) || 'unknown');
  if (emergencyActive) return { cap: 0, stage, reasons: ['emergency'] };
  if (inboxRate != null && inboxRate < lowRate) { cap = Math.floor(cap / 2); reasons.push('inbox_rate_low'); }
  if (bounceRate != null && bounceRate > bounceMax) { cap = Math.floor(cap / 2); reasons.push('bounces_high'); }
  if (emergencyHalved) { cap = Math.floor(cap / 2); reasons.push('emergency_halved'); }
  if (capOverride != null && Number.isFinite(capOverride) && capOverride < cap) { cap = Math.max(0, Math.floor(capOverride)); reasons.push('owner_lowered'); }
  return { cap: Math.max(0, Math.min(cap, HARD_COLD_CAP)), stage, reasons };
}

export async function runRamp({ client, now = new Date() }) {
  const id = client.id;
  const trial = await getTrial(id);
  const today = dayKeyIn(ET, now);
  const sendingDay = sendingDayNumber(trial.day1Date, today);
  const caps = await cfg(id, 'RAMP.caps');
  const coldCap = await cfg(id, 'COLD_CAP');
  const lowRate = await cfg(id, 'WARMUP.lowRate');
  const bounceMax = await cfg(id, 'BOUNCE.max');
  const y = await getDay(id, addDays(today, -1));
  const bounceRate = y.sent > 0 ? (y.bounces || 0) / y.sent : null;
  const emergencyActive = client.emergencyActive === '1' || client.emergencyActive === 1;
  const emergencyHalved = client.emergencyHalved === '1' || client.emergencyHalved === 1;
  const out = [];
  for (const rec of await getInboxRecords(id)) {
    const inboxRate = rec.inboxRate7d === '' || rec.inboxRate7d == null ? null : Number(rec.inboxRate7d);
    const capOverride = rec.capOverride === '' || rec.capOverride == null ? null : Number(rec.capOverride);
    const r = computeCap({ sendingDay, caps, coldCap, inboxRate, lowRate, bounceRate, bounceMax, emergencyActive, emergencyHalved, capOverride });
    await patchInbox(id, rec.email, { dailyCap: String(r.cap), rampStage: r.stage, rampReasons: r.reasons.join(','), rampAt: now.toISOString() });
    if (r.reasons.includes('inbox_rate_low') && sendingDay >= 1) {
      await alertOwner('inbox_rate_low', { clientId: id, scope: `${id}:${rec.email}`, vars: { email: rec.email, rate: `${Math.round(inboxRate * 100)}%` }, body: `${rec.email} lands in the inbox ${Math.round(inboxRate * 100)}% of the time (7-day warm-up rate), under the ${Math.round(lowRate * 100)}% line.`, did: `Today's cap for this inbox was halved to ${r.cap}.` });
    }
    out.push({ email: rec.email, cap: r.cap, stage: r.stage, reasons: r.reasons });
  }
  await logEvent(id, 'ramp', 'caps_set', { sendingDay, bounceRate, inboxes: out });
  return { sendingDay, inboxes: out };
}
