/**
 * Test Mode clock (SPEC §10.7). The `_test` client runs on a scaled clock so a
 * whole trial fits in an afternoon: with clockScale 24, one real hour is one
 * trial day.
 *
 * Stored on the `_test` client hash:
 *   clockScale    how many virtual seconds pass per real second (24 = 1 day/hour)
 *   clockOrigin   real ISO time the scaled clock started
 *   clockOffsetMs extra virtual milliseconds added by "jump to Day N"
 *
 * virtual = origin + offset + (real − origin) × scale
 *
 * Every other client (and `_test` without a clock) gets the real time back,
 * so callers can use `clientNow(client, now)` unconditionally.
 */

import { trialDay, ET, dayKeyIn, addDays } from '@/lib/time';

export function hasScaledClock(client) {
  return Boolean(client && client.id === '_test' && Number(client.clockScale) > 0 && client.clockOrigin);
}

/** The time as this client sees it. */
export function clientNow(client, now = new Date()) {
  if (!hasScaledClock(client)) return now;
  const origin = Date.parse(client.clockOrigin);
  if (!Number.isFinite(origin)) return now;
  const scale = Number(client.clockScale);
  const offset = Number(client.clockOffsetMs) || 0;
  return new Date(origin + offset + (now.getTime() - origin) * scale);
}

/** trialDay on the client's own clock. */
export function clientTrialDay(client, trial, now = new Date()) {
  return trialDay(trial, clientNow(client, now));
}

/**
 * Offset that makes the client's clock read `target` right now.
 * Returns the clockOffsetMs to store.
 */
export function offsetFor(client, target, now = new Date()) {
  const origin = Date.parse(client.clockOrigin);
  const scale = Number(client.clockScale) || 1;
  return target.getTime() - origin - (now.getTime() - origin) * scale;
}

/**
 * Real Date that is 09:05 US Eastern on trial day N (for "jump to Day N").
 * Needs trial.day1Date (or signedDay for negative days).
 */
export function instantForTrialDay(trial, n) {
  let dayKey;
  if (n >= 1 && trial.day1Date) dayKey = addDays(trial.day1Date, n - 1);
  else if (trial.signedDay) dayKey = addDays(trial.signedDay, n + 14);
  else if (trial.day1Date) dayKey = addDays(trial.day1Date, n);
  else return null;
  // 09:05 ET: try both UTC offsets (EDT −4 / EST −5) and keep the one that lands on dayKey 09:05.
  for (const off of [4, 5]) {
    const d = new Date(`${dayKey}T${String(9 + off).padStart(2, '0')}:05:00Z`);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', hour12: false }).format(d);
    if (parseInt(p, 10) % 24 === 9 && dayKeyIn(ET, d) === dayKey) return d;
  }
  return new Date(`${dayKey}T13:05:00Z`);
}

