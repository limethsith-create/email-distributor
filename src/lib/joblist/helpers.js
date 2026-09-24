/** Period helpers shared by every job file (SPEC §5). */
import { isWeekday } from '@/lib/time';
import { isUsHoliday } from '@/lib/config';
import { clientNow } from '@/lib/testclock';

/**
 * Run a client job on the client's own clock (SPEC §10.7 Test Mode): `due`
 * and `run` get `now` = clientNow(client, now) — the scaled clock for `_test`,
 * the real time for everyone else — and the real time as `realNow`.
 */
export function onClientClock(job) {
  if (job.scope !== 'client') return job;
  const wrap = (fn) => (ctx) => fn({ ...ctx, realNow: ctx.now, now: clientNow(ctx.client, ctx.now) });
  return { ...job, due: wrap(job.due), run: wrap(job.run) };
}

/** 'YYYY-MM-DDTHH:mm' — one run per minute. */
export const minuteKey = (p) => `${p.dayKey}T${p.hhmm}`;
/** Minute key rounded down to a bucket of `minutes`. */
export const bucketKey = (p, minutes) => {
  const m = Math.floor(p.minuteOfDay / minutes) * minutes;
  return `${p.dayKey}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
/** US business hours, ET parts: weekday, not a federal holiday, 08:00-19:00. */
export const usBusinessHours = (p) => isWeekday(p.weekday) && !isUsHoliday(p.dayKey) && p.hour >= 8 && p.hour < 19;
/** Daily job due at/after HH:MM (ET parts) → the day key, else null. */
export const dailyAt = (p, hhmm) => (p.hhmm >= hhmm ? p.dayKey : null);
