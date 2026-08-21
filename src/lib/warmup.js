/**
 * Warmup + Send-Time Scheduler
 * ------------------------------------------------------------
 * Single source of truth for:
 *   1) The 4-week warmup ramp (daily cap per inbox grows over time)
 *   2) The daily sending window (US Eastern business hours)
 *   3) Randomized spacing between sends so we never look robotic
 *
 * All times are computed in US Eastern time (America/New_York, DST-aware),
 * because the leads are US businesses — email should land in their workday.
 *
 * To set when warmup begins, set WARMUP_START_DATE=YYYY-MM-DD in env.
 */

const WARMUP_START_DATE = process.env.WARMUP_START_DATE || '2026-06-13';
const SEND_TZ = 'America/New_York';

// Sending window (US Eastern local time), inclusive start, exclusive end.
// A tight 9 AM – 5 PM ET (8-hour US workday) so the day's emails land inside
// core business hours and spread out to ~40 min apart per inbox. This matches
// the "8 hours / 12 emails ≈ 40-minute gaps" cadence we want.
export const SEND_WINDOW_START_HOUR = 8;   // 8 AM ET
export const SEND_WINDOW_END_HOUR = 19;   // 7 PM ET

/**
 * The 4-stage ramp. Caps are PER INBOX, PER DAY.
 * Edit these numbers in one place to change the whole ramp.
 */
export const WARMUP_STAGES = [
  { week: 1, minDay: 0, maxDay: 6, cap: 5 },
  { week: 2, minDay: 7, maxDay: 13, cap: 8 },
  { week: 3, minDay: 14, maxDay: 20, cap: 12 },
  { week: 4, minDay: 21, maxDay: Infinity, cap: 15 }, // steady state
];

/** How many whole days since warmup started (>= 0). */
export function getDaysElapsed(now = Date.now(), startDate = WARMUP_START_DATE) {
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
  return days < 0 ? 0 : days;
}

/** Current warmup stage object { week, cap, ... }. */
export function getWarmupStage(now = Date.now()) {
  const days = getDaysElapsed(now);
  return WARMUP_STAGES.find((s) => days >= s.minDay && days <= s.maxDay) || WARMUP_STAGES[WARMUP_STAGES.length - 1];
}

/** Daily cap per inbox for right now. */
export function getMaxPerAccountPerDay(now = Date.now()) {
  return getWarmupStage(now).cap;
}

/** Convert a Date to US Eastern local hour (0-23) and minutes-of-day (DST-aware). */
function etClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  let hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  return { hour, minuteOfDay: hour * 60 + minute };
}

/** US Eastern weekday short name ('Mon'..'Sun'), DST-aware. */
function etWeekday(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: SEND_TZ, weekday: 'short' }).format(now);
}

/**
 * True if current time is inside the US Eastern business-hours window AND it's a
 * weekday. B2B cold email opened on Sat/Sun is far lower and weekend sends read
 * as automated, so we only send Mon–Fri (Tue–Thu are strongest).
 */
export function isWithinSendingHours(now = new Date()) {
  const wd = etWeekday(now);
  if (wd === 'Sat' || wd === 'Sun') return false;
  const { hour } = etClock(now);
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

/** Minutes remaining in today's window (0 if outside it). */
function minutesLeftInWindow(now = new Date()) {
  const { minuteOfDay } = etClock(now);
  const endMinute = SEND_WINDOW_END_HOUR * 60;
  if (minuteOfDay < SEND_WINDOW_START_HOUR * 60) return endMinute - SEND_WINDOW_START_HOUR * 60;
  if (minuteOfDay >= endMinute) return 0;
  return endMinute - minuteOfDay;
}

/**
 * Pick a delay (ms) until this inbox should send its NEXT email.
 * We spread `remaining` sends evenly across the time left in the window, with
 * only light jitter (±10%) so the cadence is even, not clustered.
 */
export function computeNextSendDelayMs(remainingToday, now = new Date()) {
  const left = minutesLeftInWindow(now);
  // If we're outside the window or out of sends, push to "tomorrow-ish".
  if (left <= 0 || remainingToday <= 0) {
    return 8 * 60 * 60 * 1000; // ~8h; the window check will gate actual sends
  }
  const baseGap = left / Math.max(1, remainingToday); // minutes
  const jitter = 0.9 + Math.random() * 0.2;           // 0.9x – 1.1x (even, light)
  const gapMin = Math.max(6, baseGap * jitter);       // never less than 6 min apart
  return Math.round(gapMin * 60 * 1000);
}

/**
 * Even, self-pacing GLOBAL gap (ms) between ANY two sends across ALL inboxes,
 * so the whole day's remaining emails are spread evenly across the time left
 * in the window: gap = minutesLeft / totalRemaining. Light ±10% jitter only.
 *
 * Example: 24 emails left and 480 min (8 h) left → ~20 min between any two
 * sends. With two inboxes taking turns, each inbox fires ~40 min apart.
 */
export function computeEvenGapMs(totalRemaining, now = new Date()) {
  const left = minutesLeftInWindow(now); // minutes
  if (left <= 0 || totalRemaining <= 0) return 8 * 60 * 60 * 1000;
  const baseGap = left / totalRemaining;        // minutes between any two sends
  const jitter = 0.9 + Math.random() * 0.2;     // ±10% — keep it even
  const gapMin = Math.max(6, baseGap * jitter); // floor so we never burst
  return Math.round(gapMin * 60 * 1000);
}

/** Human-readable summary for the dashboard. */
export function getWarmupSummary(now = Date.now()) {
  const stage = getWarmupStage(now);
  const days = getDaysElapsed(now);
  return {
    startDate: WARMUP_START_DATE,
    daysElapsed: days,
    week: stage.week,
    capPerInbox: stage.cap,
    windowLabel: `${SEND_WINDOW_START_HOUR}:00 – ${SEND_WINDOW_END_HOUR}:00 (US Eastern), every day`,
    stages: WARMUP_STAGES.map((s) => ({ week: s.week, cap: s.cap })),
  };
}
