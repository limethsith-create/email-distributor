/**
 * Discovery-Call Calendar — Aviance
 * ------------------------------------------------------------
 * A lightweight, dependency-free scheduling core.
 *
 *  - You keep a weekly AVAILABILITY (recurring windows) defined in US Eastern
 *    business hours, because the calls are with US prospects. Every time is
 *    ALSO shown in your Sri Lanka time (Asia/Colombo) so you always know what
 *    the slot means for you.
 *  - OPEN SLOTS are generated from that availability for the next N days, minus
 *    anything already booked or held.
 *  - BOOKINGS live in the KV hash `calendar_bookings`, keyed by the slot's UTC
 *    instant. Each is either 'proposed' (the bot offered it, awaiting your
 *    confirmation) or 'confirmed' (locked in).
 *
 * All instants are stored as UTC ISO strings so nothing drifts across DST.
 */

import { kv } from '@vercel/kv';

export const US_TZ = 'America/New_York'; // prospect-facing business hours
export const SL_TZ = 'Asia/Colombo';     // your local time (UTC+5:30)

const AVAIL_KEY = 'calendar_availability';
const BOOKINGS_KEY = 'calendar_bookings';

// Weekday index: 0 = Sunday … 6 = Saturday. Windows are [startHHMM, endHHMM]
// in US EASTERN wall-clock time. Default: Mon–Fri, 9:00 AM – 3:30 PM ET, which
// is 6:30 PM – 1:00 AM your time — US mornings + early afternoon, capped so it
// never runs past ~1 AM in Sri Lanka.
export const DEFAULT_AVAILABILITY = {
  slotMinutes: 30,
  windows: {
    0: [],
    1: [['09:00', '15:30']],
    2: [['09:00', '15:30']],
    3: [['09:00', '15:30']],
    4: [['09:00', '15:30']],
    5: [['09:00', '15:30']],
    6: [],
  },
};

// ---------------------------------------------------------------------------
// Timezone helpers (no external libraries)
// ---------------------------------------------------------------------------

/** Offset (ms) of a timezone at a given UTC instant: tzWallClock - utc. */
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // some environments emit 24 for midnight
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, hour, +map.minute, +map.second);
  return asUTC - utcMs;
}

/** Convert a wall-clock time in a timezone to the absolute UTC Date. */
export function zonedWallToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Correct twice — handles the rare case where the guess lands on the wrong
  // side of a DST transition.
  let offset = tzOffsetMs(guess, tz);
  let result = guess - offset;
  offset = tzOffsetMs(result, tz);
  return new Date(guess - offset);
}

/** The Y/M/D calendar date for `date` as seen in `tz`. */
function tzDateParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return { y: +map.year, m: +map.month, d: +map.day };
}

/** Format an instant as a time string in a timezone, e.g. "9:00 AM". */
export function fmtTime(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

/** Format an instant as a weekday + date, e.g. "Thu, Aug 14". */
export function fmtDate(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
  }).format(date);
}

/** Rich dual-timezone label for one instant. */
export function labelInstant(date) {
  return {
    iso: date.toISOString(),
    usDate: fmtDate(date, US_TZ),
    usTime: fmtTime(date, US_TZ),
    slDate: fmtDate(date, SL_TZ),
    slTime: fmtTime(date, SL_TZ),
  };
}

// ---------------------------------------------------------------------------
// Availability storage
// ---------------------------------------------------------------------------

export async function getAvailability() {
  try {
    const saved = await kv.get(AVAIL_KEY);
    if (saved && saved.windows) return saved;
  } catch {}
  return DEFAULT_AVAILABILITY;
}

export async function saveAvailability(avail) {
  const clean = {
    slotMinutes: Math.max(15, Math.min(120, parseInt(avail.slotMinutes) || 30)),
    windows: {},
  };
  for (let d = 0; d <= 6; d++) {
    const raw = Array.isArray(avail.windows?.[d]) ? avail.windows[d] : [];
    clean.windows[d] = raw
      .filter((w) => Array.isArray(w) && /^\d{2}:\d{2}$/.test(w[0]) && /^\d{2}:\d{2}$/.test(w[1]) && w[0] < w[1])
      .slice(0, 4);
  }
  await kv.set(AVAIL_KEY, clean);
  return clean;
}

// ---------------------------------------------------------------------------
// Bookings storage
// ---------------------------------------------------------------------------

export async function getBookings() {
  try {
    return (await kv.hgetall(BOOKINGS_KEY)) || {};
  } catch {
    return {};
  }
}

/** Create or overwrite a booking at a slot instant. */
export async function setBooking(iso, data) {
  const entry = {
    start: iso,
    prospectEmail: data.prospectEmail || '',
    company: data.company || '',
    leadEmail: (data.leadEmail || data.prospectEmail || '').toLowerCase(),
    status: data.status === 'confirmed' ? 'confirmed' : 'proposed',
    note: data.note || '',
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kv.hset(BOOKINGS_KEY, { [iso]: entry });
  return entry;
}

export async function updateBookingStatus(iso, status) {
  const existing = await kv.hget(BOOKINGS_KEY, iso);
  if (!existing) return null;
  const entry = { ...existing, status, updatedAt: new Date().toISOString() };
  await kv.hset(BOOKINGS_KEY, { [iso]: entry });
  return entry;
}

export async function removeBooking(iso) {
  try { await kv.hdel(BOOKINGS_KEY, iso); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Slot generation
// ---------------------------------------------------------------------------

function hhmmToParts(s) {
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return { h, m };
}

/**
 * Generate open slots from availability for the next `days` days.
 * Excludes any instant already present in `bookings` and any slot in the past.
 * Returns an array of labelled slot objects, soonest first.
 */
export function computeOpenSlots(availability, bookings, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const days = opts.days || 14;
  const limit = opts.limit || 60;
  const slotMin = availability.slotMinutes || 30;
  const taken = new Set(Object.keys(bookings || {}));
  const out = [];

  for (let i = 0; i < days && out.length < limit; i++) {
    // The ET calendar date `i` days ahead of now.
    const probe = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const { y, m, d } = tzDateParts(probe, US_TZ);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const windows = availability.windows?.[weekday] || [];

    for (const [startStr, endStr] of windows) {
      const start = hhmmToParts(startStr);
      const end = hhmmToParts(endStr);
      const startMin = start.h * 60 + start.m;
      const endMin = end.h * 60 + end.m;

      for (let t = startMin; t + slotMin <= endMin; t += slotMin) {
        const hh = Math.floor(t / 60);
        const mm = t % 60;
        const inst = zonedWallToUtc(y, m, d, hh, mm, US_TZ);
        if (inst.getTime() <= now.getTime()) continue; // no past slots
        const iso = inst.toISOString();
        if (taken.has(iso)) continue;                  // already booked/held
        out.push({ ...labelInstant(inst), durationMin: slotMin });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }

  out.sort((a, b) => a.iso.localeCompare(b.iso));
  return out;
}

/**
 * Convenience for the bot: fetch the next `count` open slots and, optionally,
 * HOLD them (mark as 'proposed') for a given lead so they can't be offered to
 * anyone else. Returns the labelled slots it proposed.
 */
export async function proposeSlotsForLead(leadEmail, company, count = 3) {
  const [availability, bookings] = await Promise.all([getAvailability(), getBookings()]);
  const open = computeOpenSlots(availability, bookings, { days: 14, limit: count });
  const chosen = open.slice(0, count);
  for (const slot of chosen) {
    await setBooking(slot.iso, {
      prospectEmail: leadEmail,
      leadEmail,
      company,
      status: 'proposed',
      note: 'Auto-proposed by reply bot',
    });
  }
  return chosen;
}
