/**
 * Send window — the single source of truth for WHEN the sender may send.
 *
 * All times are computed in US Eastern (America/New_York, DST-aware) because
 * the leads are US businesses: email should land inside their workday.
 * Weekends are excluded (B2B cold email opened on Sat/Sun is far lower and
 * weekend sends read as automated).
 *
 * Pacing itself (how far apart sends are) lives with the sender: every inbox
 * keeps its own next-send time in the `pacing` KV hash, computed from the
 * minutes left in this window divided by the emails it still has to send.
 * Per-inbox daily caps are set on the Inboxes page (that is the warm-up ramp).
 */

import { etParts, SEND_TZ } from '@/lib/metrics';

// Sending window (US Eastern local time), inclusive start, exclusive end.
export const SEND_WINDOW_START_HOUR = 8;   // 8 AM ET
export const SEND_WINDOW_END_HOUR = 19;   // 7 PM ET
export const SEND_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

/**
 * True if `now` is inside the US Eastern business-hours window on a weekday.
 */
export function isWithinSendingHours(now = new Date()) {
  const { weekday, hour } = etParts(now);
  if (!SEND_DAYS.has(weekday)) return false;
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

/** Minutes remaining in today's window (0 if outside it or on a weekend). */
export function minutesLeftInWindow(now = new Date()) {
  const { weekday, minuteOfDay } = etParts(now);
  if (!SEND_DAYS.has(weekday)) return 0;
  const endMinute = SEND_WINDOW_END_HOUR * 60;
  if (minuteOfDay < SEND_WINDOW_START_HOUR * 60) return endMinute - SEND_WINDOW_START_HOUR * 60;
  if (minuteOfDay >= endMinute) return 0;
  return endMinute - minuteOfDay;
}

/** Human-readable window label for APIs. */
export function sendingWindowLabel() {
  const fmt = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
  return `${fmt(SEND_WINDOW_START_HOUR)} – ${fmt(SEND_WINDOW_END_HOUR)} ET, Mon–Fri`;
}

export { SEND_TZ };
