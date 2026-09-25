/**
 * The Calendar (docs/CALENDAR.md) — the owner's words: "a big calendar with
 * every meeting; they ask for a time, we say yes, and it's entered in our
 * calendar; I don't know how to make it work — just make it work."
 *
 *  - openSlots: the times the booking page offers (pure). US-Eastern call
 *    hours on open days (US holidays closed), a start every slotMinutes, the
 *    whole call plus bufferMinutes free, maxPerDay, minNoticeHours, daysAhead.
 *    Requested, confirmed and blocked meetings take their time.
 *  - requestMeeting: the applicant picked a time on /c/{token}/book → the
 *    meeting is `requested` (the slot is theirs until the owner answers), the
 *    owner gets `meeting_requested` on his phone, they get "got it".
 *  - the owner's buttons (calendarAction): confirm (→ confirmation + .ics, the
 *    onboarding call becomes booked), suggest (→ "how about …?" with a
 *    one-click accept link), decline, move, held, noShow, cancel, add, block,
 *    unblock. Every change appends to the meeting's `history`.
 *  - acceptSuggestion: their "Yes, that works" on an owner's suggestion.
 *  - syncFromOnboardCall: "Mark call booked" / "Call done" / "They didn't show"
 *    on the onboarding card and calendar invites found in the inbox land in the
 *    same calendar (one meeting per client's onboarding call, no emails).
 *
 * Times are stored in UTC ISO and turned into wall clocks only with
 * Intl.DateTimeFormat + timeZone (zonedToUtc for the other way), so US
 * daylight saving is always right; Sri Lanka has none.
 *
 * Storage: `meetings` (hash id → meeting JSON) + `meetings:byStart` (sorted
 * set, score = the start of the time the meeting holds). One writer at a time
 * (`meetings:lock`), so a slot can never be given twice. The onboarding
 * meeting of a client is linked from client:{id}:onboardcall (`meetingId`).
 *
 * No AI anywhere: slots are arithmetic, zones come from the state they gave.
 */

import crypto from 'node:crypto';
import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { DEFAULTS, globalOverrides, isUsHoliday } from '@/lib/config';
import { getClient, getProfile } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { mintToken, pageUrl } from '@/lib/pagetokens';
import { onboardSender } from '@/lib/notify';
import { zonedToUtc } from '@/lib/systems/stagec-common';
import { io, firstNameOf, ownerName, asObject, isPublicUrl, weekdayOf } from '@/lib/systems/intake-io';
import { STATES, stateCode, stateOfCity } from '@/lib/systems/usgeo';
import { partsIn, addDays, hhmmToMin, tzForState } from '@/lib/time';
import * as call from '@/lib/systems/onboardcall';

const SYSTEM = 'calendar';
const DAY_MS = 864e5;
const NOTE_MAX = 500;
const REASON_MAX = 300;
const TITLE_MAX = 120;
/** Booking-page links live this long (the page shows two weeks; a reschedule may come later). */
export const BOOK_TTL = 30 * 86400;
/** Booking-page tries (asks + accepts) per link per hour. */
export const BOOK_TRIES_PER_HOUR = 10;

/** Statuses that hold their time on the calendar. */
export const BUSY = new Set(['requested', 'confirmed', 'blocked']);
/** Statuses that count toward maxPerDay (a busy block does not). */
const COUNTED = new Set(['requested', 'confirmed']);
/** An onboarding meeting still ahead: the one a new time replaces. */
const OPEN = new Set(['requested', 'confirmed']);
const STATUS_WORDS = { requested: 'waiting for your yes', confirmed: 'confirmed', held: 'done', no_show: 'a no-show', declined: 'declined', cancelled: 'cancelled', blocked: 'a busy block' };

/** A mistake in what was asked (routes answer with `status` and the plain message). */
export class CalendarError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ─── settings ────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz) }); return String(tz); } catch { return null; } };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * CALENDAR in one Redis read (a leaf override wins over a whole-block one,
 * as /mc/config writes both), plus ONBOARDCALL.callMinutes: the length of
 * the onboarding call the booking page books.
 */
export async function calendarSettings() {
  let o = {};
  try { o = await globalOverrides(); } catch {}
  const whole = isObj(o.CALENDAR) ? o.CALENDAR : {};
  const pick = (k) => (o[`CALENDAR.${k}`] !== undefined ? o[`CALENDAR.${k}`] : whole[k] !== undefined ? whole[k] : DEFAULTS.CALENDAR[k]);
  const s = Object.fromEntries(Object.keys(DEFAULTS.CALENDAR).map((k) => [k, pick(k)]));
  s.callMinutes = o['ONBOARDCALL.callMinutes'] ?? (isObj(o.ONBOARDCALL) ? o.ONBOARDCALL.callMinutes : undefined) ?? DEFAULTS.ONBOARDCALL.callMinutes;
  return normaliseCalendar(s);
}

/** Settings → safe values (a broken value falls back to the default, never to "no calls"). */
export function normaliseCalendar(s = {}) {
  const d = DEFAULTS.CALENDAR;
  const int = (v, def, min, max) => { const n = Math.round(Number(v)); return v !== null && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : def; };
  const hours = Array.isArray(s.hours) && s.hours.length === 2 && HHMM.test(s.hours[0]) && HHMM.test(s.hours[1]) && hhmmToMin(s.hours[0]) < hhmmToMin(s.hours[1]) ? s.hours.map(String) : d.hours;
  const days = [...new Set((Array.isArray(s.days) ? s.days : d.days).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const link = String(s.meetingLink || '').trim();
  return {
    hours,
    days: days.length ? days : d.days,
    slotMinutes: int(s.slotMinutes, d.slotMinutes, 5, 120),
    bufferMinutes: int(s.bufferMinutes, d.bufferMinutes, 0, 120),
    maxPerDay: int(s.maxPerDay, d.maxPerDay, 1, 50),
    minNoticeHours: int(s.minNoticeHours, d.minNoticeHours, 0, 24 * 14),
    daysAhead: int(s.daysAhead, d.daysAhead, 1, 60),
    meetingLink: link && isPublicUrl(link) ? link : null,
    ownerZone: validZone(s.ownerZone || d.ownerZone) || d.ownerZone,
    usZone: validZone(s.usZone || d.usZone) || d.usZone,
    callMinutes: int(s.callMinutes, DEFAULTS.ONBOARDCALL.callMinutes, 5, 240),
  };
}

// ─── time zones and words (pure) ─────────────────────────────────────────────

/** The zones the booking page offers (their own first). */
export const US_ZONES = [
  { tz: 'America/New_York', name: 'Eastern Time', short: 'ET' },
  { tz: 'America/Chicago', name: 'Central Time', short: 'CT' },
  { tz: 'America/Denver', name: 'Mountain Time', short: 'MT' },
  { tz: 'America/Phoenix', name: 'Arizona Time', short: 'Arizona time' },
  { tz: 'America/Los_Angeles', name: 'Pacific Time', short: 'PT' },
  { tz: 'America/Anchorage', name: 'Alaska Time', short: 'Alaska time' },
  { tz: 'Pacific/Honolulu', name: 'Hawaii Time', short: 'Hawaii time' },
];
const OTHER_ZONES = { 'Asia/Colombo': { name: 'Sri Lanka time', short: 'Colombo' } };

export function zoneInfo(tz) {
  const us = US_ZONES.find((z) => z.tz === tz);
  if (us) return us;
  if (OTHER_ZONES[tz]) return { tz, ...OTHER_ZONES[tz] };
  const city = String(tz || '').split('/').pop().replace(/_/g, ' ');
  return { tz, name: `${city} time`, short: city };
}
/** Only the zones the page lists may come from an address bar. */
export const pickZone = (tz) => (US_ZONES.some((z) => z.tz === tz) ? tz : null);

// Arizona keeps standard time all year; Alaska and Hawaii are their own zones.
const STATE_ZONE = { AZ: 'America/Phoenix', AK: 'America/Anchorage', HI: 'Pacific/Honolulu' };
/** 'TX' → 'America/Chicago' (null when it is not a US state). */
export function zoneForState(state) {
  const code = stateCode(state);
  return code ? STATE_ZONE[code] || tzForState(code) : null;
}
/** A state named in a city or postal address ("Austin, TX", "1 Main St, Denver, CO 80202"). */
function stateIn(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const m = s.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  if (m && stateCode(m[1])) return m[1];
  const city = stateOfCity(s);
  if (city) return city;
  const lower = s.toLowerCase();
  const named = Object.entries(STATES).find(([, name]) => new RegExp(`(^|[^a-z])${name.toLowerCase()}([^a-z]|$)`).test(lower));
  return named ? named[0] : null;
}
/** Their zone: the state on their application, else the one in their city or postal address, else US Eastern. */
export function applicantZone({ application = {}, profile = {} } = {}, fallback = DEFAULTS.CALENDAR.usZone) {
  for (const v of [application?.web_state, stateIn(application?.web_city), stateIn(profile?.postalAddress)]) {
    const z = zoneForState(v);
    if (z) return z;
  }
  return fallback;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmts = new Map();
/** Wall-clock parts of an instant in `tz` (Intl does the daylight-saving work). */
function wall(t, tz) {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }));
  const p = Object.fromEntries(fmts.get(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, day: Number(p.day), month: Number(p.month), year: Number(p.year), clock: `${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()}` };
}
const msOf = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => new Date(t).toISOString();

/** '2:00 pm' */
export const clockIn = (t, tz) => wall(t, tz).clock;
/** 'Tue 30 Sep' */
export function shortDay(t, tz) { const w = wall(t, tz); return `${w.weekday} ${w.day} ${MONTHS[w.month - 1]}`; }
/** 'Tuesday 30 September' */
export function longDay(t, tz) { const w = wall(t, tz); return `${DAYS_LONG[w.weekday]} ${w.day} ${MONTHS_LONG[w.month - 1]}`; }
/** The booking page's button text: 'Tue 30 Sep · 2:00 pm'. */
export const slotLabel = (t, tz) => `${shortDay(t, tz)} · ${clockIn(t, tz)}`;
const dayKeyOf = (t, tz) => partsIn(tz, new Date(t)).dayKey;

/**
 * For the owner: 'Tue 30 Sep 2:00 pm ET = 11:30 pm Colombo'. The Colombo day
 * is written out when it is not the US day (after 1:30 pm EDT it already is
 * tomorrow in Sri Lanka): 'Tue 30 Sep 3:00 pm ET = Wed 1 Oct 12:30 am Colombo'.
 */
export function usAndOwner(t, s = normaliseCalendar()) {
  const us = `${shortDay(t, s.usZone)} ${clockIn(t, s.usZone)} ${zoneInfo(s.usZone).short}`;
  const same = dayKeyOf(t, s.usZone) === dayKeyOf(t, s.ownerZone);
  return `${us} = ${same ? '' : `${shortDay(t, s.ownerZone)} `}${clockIn(t, s.ownerZone)} ${zoneInfo(s.ownerZone).short}`;
}

/**
 * For them: 'Tuesday 30 September at 1:00 pm Central Time (2:00 pm Eastern)' —
 * their zone first, Eastern beside it unless they are on Eastern time.
 */
export function theirWhen(t, tz, s = normaliseCalendar()) {
  const base = `${longDay(t, tz)} at ${clockIn(t, tz)} ${zoneInfo(tz).name}`;
  if (tz === s.usZone) return base;
  const other = dayKeyOf(t, tz) === dayKeyOf(t, s.usZone) ? '' : `${shortDay(t, s.usZone)} `;
  return `${base} (${other}${clockIn(t, s.usZone)} ${zoneInfo(s.usZone).name.replace(/ Time$/, '')})`;
}
/** 'Tue 30 Sep at 1:00 pm CT' — for subjects. */
export const theirShort = (t, tz) => `${shortDay(t, tz)} at ${clockIn(t, tz)} ${zoneInfo(tz).short}`;
/** 'Tuesday at 1:00 pm' — the time they asked for, in a sentence. */
export const theirAsked = (t, tz) => `${DAYS_LONG[wall(t, tz).weekday]} at ${clockIn(t, tz)}`;

// ─── open slots (pure) ───────────────────────────────────────────────────────

/** The time a meeting holds: an owner's suggestion holds the suggested time, not the one they asked for. */
export function heldInterval(m) {
  const start = msOf(m?.status === 'requested' && m.proposed ? m.proposed : m?.start);
  return start == null ? null : { start, end: start + (Number(m.minutes) || 30) * 60e3 };
}

/** 'HH:MM' on a US-Eastern day → the instant (DST-aware). */
function atMinute(dayKey, minuteOfDay, tz) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedToUtc(y, m, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, tz).getTime();
}

/**
 * The open times between `from` and `to` (ms or ISO), pure. A start every
 * slotMinutes inside the call hours (US Eastern) on open days that are not US
 * holidays; the whole call (`minutes`, default the onboarding call) must end
 * by the close of hours, start at least `noticeHours` from now, and keep
 * bufferMinutes free after it and after every busy meeting; a day with
 * maxPerDay calls is full. `exceptId` ignores one meeting (their own, when
 * they pick again). → [{ start: ISO, minutes }]
 */
export function openSlots({ settings, meetings = [], now = new Date(), from, to, minutes = null, noticeHours = null, exceptId = null }) {
  const s = settings || normaliseCalendar();
  const lenMin = Number(minutes) || s.callMinutes;
  const len = lenMin * 60e3;
  const buf = s.bufferMinutes * 60e3;
  const fromMs = msOf(from) ?? now.getTime();
  const toMs = msOf(to) ?? fromMs + s.daysAhead * DAY_MS;
  const earliest = Math.max(fromMs, now.getTime() + (noticeHours ?? s.minNoticeHours) * 3600e3);
  const busy = [];
  const perDay = new Map();
  for (const m of meetings) {
    if (!m || m.id === exceptId || !BUSY.has(m.status)) continue;
    const h = heldInterval(m);
    if (!h) continue;
    busy.push(h);
    if (COUNTED.has(m.status)) { const d = dayKeyOf(h.start, s.usZone); perDay.set(d, (perDay.get(d) || 0) + 1); }
  }
  const [open, close] = s.hours.map(hhmmToMin);
  const out = [];
  const last = dayKeyOf(toMs, s.usZone);
  for (let day = dayKeyOf(earliest, s.usZone), i = 0; day <= last && i < 400; day = addDays(day, 1), i++) {
    if (!s.days.includes(WD[weekdayOf(day)]) || isUsHoliday(day)) continue;
    if ((perDay.get(day) || 0) >= s.maxPerDay) continue;
    for (let min = open; min + lenMin <= close; min += s.slotMinutes) {
      const start = atMinute(day, min, s.usZone);
      if (start < earliest || start >= toMs) continue;
      const end = start + len;
      if (busy.some((b) => start < b.end + buf && b.start < end + buf)) continue;
      out.push({ start: iso(start), minutes: lenMin });
    }
  }
  return out;
}

/** The booking page's window: from now to the end of the US day daysAhead − 1 days from today. */
export function bookingWindow(s, now) {
  const last = addDays(dayKeyOf(now, s.usZone), s.daysAhead);
  return { from: now.getTime(), to: atMinute(last, 0, s.usZone) };
}

/** Does [start, start+minutes) overlap a busy meeting (no buffer — the owner's own choice)? → that meeting or null. */
export function clashWith(meetings, startMs, minutes, exceptId = null) {
  const end = startMs + minutes * 60e3;
  return meetings.find((m) => m && m.id !== exceptId && BUSY.has(m.status) && (() => { const h = heldInterval(m); return h && startMs < h.end && h.start < end; })()) || null;
}

// ─── .ics (pure) ─────────────────────────────────────────────────────────────

const icsText = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsParam = (v) => { const s = String(v ?? '').replace(/["\r\n]/g, '').trim(); return /[:;,]/.test(s) ? `"${s}"` : s; };
const icsDate = (t) => iso(t).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Fold a content line at 75 octets (RFC 5545 §3.1), never inside a character. */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * A calendar invite: METHOD:REQUEST (new or changed time — same UID, higher
 * SEQUENCE) or METHOD:CANCEL. Times are UTC ("Z"), so every calendar app
 * shows them in its own zone. UID = the meeting id.
 */
export function buildIcs({ method = 'REQUEST', uid, sequence = 0, start, minutes, title, description = '', location = '', organizer, attendee, now = new Date() }) {
  const t = msOf(start);
  const cancel = method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Aviance//Calendar//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${cancel ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${Number(sequence) || 0}`,
    `DTSTAMP:${icsDate(now.getTime())}`,
    `DTSTART:${icsDate(t)}`,
    `DTEND:${icsDate(t + (Number(minutes) || 30) * 60e3)}`,
    `SUMMARY:${icsText(title)}`,
    ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
    ...(location ? [`LOCATION:${icsText(location)}`] : []),
    `ORGANIZER${organizer?.name ? `;CN=${icsParam(organizer.name)}` : ''}:mailto:${organizer?.email || ''}`,
    `ATTENDEE${attendee?.name ? `;CN=${icsParam(attendee.name)}` : ''};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee?.email || ''}`,
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ─── storage ─────────────────────────────────────────────────────────────────

const ID_RE = /^m[a-z0-9]{8,40}$/;
const newId = () => `m${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const parseMeeting = (v) => { const m = asObject(v); return m && m.id ? m : null; };

export async function getMeeting(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  return parseMeeting(await kv.hget(K.meetings(), String(id)));
}

async function saveMeeting(m) {
  const out = { ...m, updatedAt: m.updatedAt || m.createdAt };
  await kv.hset(K.meetings(), { [m.id]: JSON.stringify(out) });
  // Scored by the time it holds, so a range read finds what is busy then.
  await kv.zadd(K.meetingsByStart(), { score: heldInterval(out)?.start ?? msOf(out.start) ?? 0, member: out.id });
  return out;
}

/** Meetings whose held time starts in [fromMs, toMs]. */
export async function meetingsBetween(fromMs, toMs) {
  const ids = (await kv.zrange(K.meetingsByStart(), Math.floor(fromMs), Math.ceil(toMs), { byScore: true })) || [];
  if (!ids.length) return [];
  const got = (await kv.hmget(K.meetings(), ...ids)) || {};
  return ids.map((id) => parseMeeting(got[id])).filter(Boolean);
}

/** One writer at a time: the check "is this slot still free?" and the write happen together. */
async function withLock(fn) {
  // A prefix keeps the value a string (the Redis client turns an all-digit value into a number).
  const me = `lock-${crypto.randomBytes(8).toString('hex')}`;
  for (let i = 0; i < 40; i++) {
    if ((await kv.set(K.calendarLock(), me, { nx: true, ex: 30 })) === 'OK') {
      try { return await fn(); } finally {
        try { if ((await kv.get(K.calendarLock())) === me) await kv.del(K.calendarLock()); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new CalendarError('The calendar is busy for a moment — try again.', 503);
}

const step = (what, by, now, extra = {}) => ({ at: now.toISOString(), what, by, ...extra });

/** A new meeting (every field of docs/CALENDAR.md, plus requestedAt / sequence / updatedAt). */
function newMeeting({ client = null, kind = 'other', title, start, minutes, status, source, theirZone = null, note = '', now, by }) {
  const at = now.toISOString();
  return {
    id: newId(),
    clientId: client?.id || null,
    company: client ? client.name || client.mainDomain || client.id : null,
    person: client?.contactName || null,
    email: client?.contactEmail || null,
    kind,
    title: String(title || '').slice(0, TITLE_MAX),
    start,
    minutes,
    status,
    source,
    theirZone,
    note,
    declineReason: null,
    proposed: null,
    createdAt: at,
    updatedAt: at,
    requestedAt: status === 'requested' ? at : null,
    confirmedAt: status === 'confirmed' ? at : null,
    sequence: 0,
    history: [step(status === 'blocked' ? 'blocked' : status, by, now, { via: source })],
  };
}

const onboardingTitle = (client) => `Onboarding call — ${client.name || client.mainDomain || client.id}`;

/** The client's onboarding meeting (linked from their onboarding call), or null. */
async function onboardingMeetingOf(clientId) {
  const raw = await call.readCall(clientId);
  return raw.meetingId ? getMeeting(raw.meetingId) : null;
}

/** Their zone from what they told us (application, then profile), else US Eastern. */
export async function zoneOfClient(clientId) {
  try {
    const [application, profile] = await Promise.all([kv.hgetall(K.application(clientId)), getProfile(clientId)]);
    return applicantZone({ application: application || {}, profile: profile || {} });
  } catch { return DEFAULTS.CALENDAR.usZone; }
}

// ─── links ───────────────────────────────────────────────────────────────────

/**
 * A booking-page link for this client (/c/{token}/book). Each email mints its
 * own token (purpose `book:{tag}`), so an earlier link keeps working; only the
 * token's hash is stored.
 */
export async function bookingLink(clientId, tag = 'x') {
  assertClientId(clientId);
  const token = await mintToken(clientId, `book:${String(tag).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'x'}`, { ttl: BOOK_TTL });
  return pageUrl(token, 'book');
}

/**
 * One more try from this booking link this hour? (asks and accepts together,
 * BOOK_TRIES_PER_HOUR). Only a hash of the link is used in the key. A Redis
 * hiccup lets the try through: the slot check still guards the calendar.
 */
export async function allowBookTry(rawToken, now = io.now()) {
  const key = K.bookRate(crypto.createHash('sha256').update(String(rawToken)).digest('hex').slice(0, 24), now.toISOString().slice(0, 13));
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 3700);
    return n <= BOOK_TRIES_PER_HOUR;
  } catch { return true; }
}

// ─── emails and alerts ───────────────────────────────────────────────────────

/** Owner alert that never throws (the meeting is already saved). */
async function alert(key, opts) {
  try { return await io.alertOwner(key, opts); } catch (err) { console.error('[calendar] alert failed', key, err?.message); return { sent: false }; }
}

const who = (m) => `${firstNameOf(m.person) || m.person || m.email || 'Someone'}${m.company ? ` (${m.company})` : ''}`;
const zoneOf = (m, s) => m.theirZone || s.usZone;
const sentence = (t) => { const x = String(t || '').trim(); return !x ? x : /[.!?]$/.test(x) ? x : `${x}.`; };

/**
 * The words every meeting email shares: {when}, {whenShort}, {minutes},
 * {linkLine}, {bookLink}, {nextLine} — in their zone, at time `t`.
 */
async function meetingVars(m, s, t, tag) {
  const tz = zoneOf(m, s);
  const bookLink = m.kind === 'onboarding' && m.clientId ? await bookingLink(m.clientId, `${m.id.slice(-10)}-${tag}`) : null;
  return {
    when: theirWhen(t, tz, s),
    whenShort: theirShort(t, tz),
    minutes: Number(m.minutes) || s.callMinutes,
    linkLine: s.meetingLink ? `Join here: ${s.meetingLink}` : "I'll send the link before the call.",
    bookLink: bookLink || '(reply to this email)',
    nextLine: bookLink ? `If the time stops working, pick another here: ${bookLink}` : 'If the time stops working, reply to this email.',
  };
}

/** The invite for a meeting (REQUEST at its time, or CANCEL), organised by the inbox that sends it. */
async function inviteFor(m, s, { method = 'REQUEST', now }) {
  const sender = await onboardSender();
  const organizer = { email: sender?.email || '', name: await ownerName(m.clientId) };
  const description = [
    m.kind === 'onboarding' ? `Our ${m.minutes}-minute onboarding call.` : `Our ${m.minutes}-minute call.`,
    s.meetingLink ? `Join here: ${s.meetingLink}` : "I'll send the link before the call.",
  ].join('\n');
  const content = buildIcs({ method, uid: m.id, sequence: m.sequence || 0, start: m.start, minutes: m.minutes, title: m.title, description, location: s.meetingLink || '', organizer, attendee: { email: m.email, name: m.person }, now });
  return { method: method === 'CANCEL' ? 'CANCEL' : 'REQUEST', filename: method === 'CANCEL' ? 'cancel.ics' : 'invite.ics', content };
}

/**
 * Email the meeting's client from the onboarding-call inbox, in the onboarding
 * conversation when there is one (threaded, shown in the hub's thread). A
 * meeting without a client or an address is simply not emailed.
 */
async function emailClient(m, key, vars, { icalEvent = null, dedupe = null, now }) {
  if (!m.clientId || !m.email) return { skipped: 'no client email' };
  return call.sendCallEmail(m.clientId, key, { firstName: firstNameOf(m.person) || 'there', ownerName: await ownerName(m.clientId), ...vars }, { icalEvent, dedupe, now });
}

// ─── the booking page ────────────────────────────────────────────────────────

/** Client states in which the booking page takes a time (the onboarding call is still to happen). */
const pageOpen = (client, raw) => Boolean(client) && call.WATCH_STATES.has(client.state) && !(raw.heldAt && String(raw.heldAt) !== '0');
/** Their request or booking that is still ahead (one whose time has passed no longer blocks a new pick). */
const stillAhead = (m, now) => Boolean(m) && OPEN.has(m.status) && (heldInterval(m)?.end ?? 0) > now.getTime();

/** What the applicant may see of their meeting. */
export function publicMeeting(m, tz) {
  if (!m) return null;
  return {
    id: m.id, status: m.status, start: m.start, minutes: m.minutes, proposed: m.proposed || null, note: m.note || '',
    theirZone: m.theirZone || null, label: slotLabel(m.start, tz), proposedLabel: m.proposed ? slotLabel(m.proposed, tz) : null,
  };
}

/**
 * Everything the booking page shows: their zone (asked for, else the one on
 * their meeting, else from their state), the open times grouped by day in
 * that zone, and their current request or booking.
 */
export async function bookingPageData(clientId, { tz = null, now = io.now() } = {}) {
  const [client, raw, s] = await Promise.all([getClient(clientId), call.readCall(clientId), calendarSettings()]);
  const current = raw.meetingId ? await getMeeting(raw.meetingId) : null;
  const existing = stillAhead(current, now) ? current : null;
  const zone = pickZone(tz) || pickZone(existing?.theirZone) || await zoneOfClient(clientId);
  const base = {
    clientId, closed: !pageOpen(client, raw), held: Boolean(raw.heldAt && String(raw.heldAt) !== '0'),
    company: client ? client.name || client.mainDomain || clientId : '', firstName: firstNameOf(client?.contactName),
    zone, zoneName: zoneInfo(zone).name, zones: US_ZONES.map(({ tz: z, name }) => ({ tz: z, name })),
    callMinutes: s.callMinutes, daysAhead: s.daysAhead, meetingLink: existing?.status === 'confirmed' ? s.meetingLink : null,
    existing: publicMeeting(existing, zone), slots: [], days: [],
  };
  if (base.closed) return base;
  const { from, to } = bookingWindow(s, now);
  const meetings = await meetingsBetween(from - DAY_MS, to + DAY_MS);
  base.slots = openSlots({ settings: s, meetings, now, from, to, exceptId: existing?.id || null }).map((x) => ({ start: x.start, label: slotLabel(x.start, zone) }));
  for (const x of base.slots) {
    const key = dayKeyOf(x.start, zone);
    let d = base.days[base.days.length - 1];
    if (!d || d.key !== key) { d = { key, label: longDay(x.start, zone), slots: [] }; base.days.push(d); }
    d.slots.push({ start: x.start, label: clockIn(x.start, zone) });
  }
  return base;
}

/**
 * They picked a time on the booking page. The slot must still be open (else
 * 409). One meeting per client's onboarding call: a new pick replaces the
 * time they asked for, and asking to move a confirmed call turns it back
 * into a request at the new time (the old time is free again until the owner
 * answers). The same pick twice changes nothing and emails nothing; picking
 * the time the owner suggested is their yes to it (acceptSuggestion).
 */
export async function requestMeeting(clientId, { start, note = '', zone = null } = {}, { now = io.now() } = {}) {
  assertClientId(clientId);
  const t = msOf(start);
  if (t == null) throw new CalendarError('Pick a time first.');
  const startIso = iso(t);
  const cleanNote = String(note || '').replace(/\r\n/g, '\n').trim().slice(0, NOTE_MAX);
  const s = await calendarSettings();
  const done = await withLock(async () => {
    const [client, raw] = await Promise.all([getClient(clientId), call.readCall(clientId)]);
    if (!pageOpen(client, raw)) throw new CalendarError("This page is closed — reply to my last email and we'll find a time.", 409);
    const current = raw.meetingId ? await getMeeting(raw.meetingId) : null;
    const active = current && OPEN.has(current.status) ? current : null;
    if (active && active.status === 'requested' && active.proposed === startIso) return { accept: active.id };
    if (active && active.start === startIso && (active.status === 'confirmed' || !active.proposed)) {
      if (cleanNote && cleanNote !== active.note) return { meeting: await saveMeeting({ ...active, note: cleanNote, updatedAt: now.toISOString() }), same: true };
      return { meeting: active, same: true };
    }
    const { from, to } = bookingWindow(s, now);
    const meetings = await meetingsBetween(from - DAY_MS, to + DAY_MS);
    const open = openSlots({ settings: s, meetings, now, from, to, exceptId: active?.id || null });
    if (!open.some((x) => x.start === startIso)) throw new CalendarError('Sorry — that time was just taken. Please pick another.', 409);
    const theirZone = pickZone(zone) || active?.theirZone || await zoneOfClient(clientId);
    const at = now.toISOString();
    let m;
    if (active) {
      m = {
        ...active, status: 'requested', start: startIso, minutes: s.callMinutes, proposed: null, declineReason: null,
        note: cleanNote || active.note || '', theirZone, requestedAt: at, updatedAt: at,
        history: [...(active.history || []), step('requested', 'them', now, { from: active.start, was: active.status })],
      };
    } else {
      m = newMeeting({ client, kind: 'onboarding', title: onboardingTitle(client), start: startIso, minutes: s.callMinutes, status: 'requested', source: 'booking_page', theirZone, note: cleanNote, now, by: 'them' });
    }
    m = await saveMeeting(m);
    await call.syncCallFromMeeting(clientId, m, { now });
    return { meeting: m, was: active };
  });
  if (done.accept) return acceptSuggestion(clientId, done.accept, { now });
  if (done.same) return done.meeting;
  const m = done.meeting;
  await logEvent(clientId, SYSTEM, 'requested', { meetingId: m.id, start: m.start, moved: done.was ? done.was.start : undefined });
  // After the slot is theirs: "got it" to them, the alert to the owner. Neither may undo the request.
  try {
    const v = await meetingVars(m, s, t, 'got');
    await emailClient(m, 'meeting_received', { when: v.when, bookLink: v.bookLink }, { dedupe: `meeting_received:${m.id}:${m.start}`, now });
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'email_failed', { meetingId: m.id, key: 'meeting_received', error: String(err?.message || err).slice(0, 200) });
  }
  const moving = done.was && done.was.status === 'confirmed';
  await alert('meeting_requested', {
    clientId,
    scope: `${clientId}:request:${m.id}:${m.start}`,
    vars: { who: who(m), when: usAndOwner(t, s) },
    body: `${m.person || m.email} (${m.email}) from ${m.company} ${moving ? 'asked to move the onboarding call to' : 'asked for'} ${usAndOwner(t, s)} (${theirShort(t, zoneOf(m, s))} for them).${moving ? ` It was ${usAndOwner(msOf(done.was.start), s)}; that time is free again until you answer.` : ''}${m.note ? `\n\nTheir note: “${m.note}”` : ''}`,
    did: 'Holding that time for them. In the hub\'s Calendar press Yes, Suggest another time, or Decline.',
    url: '/#calendar',
  });
  return m;
}

/**
 * Their "Yes, that works" on the owner's suggested time (from the link in the
 * suggestion email). The time must still be free; then it is confirmed as if
 * the owner had pressed Yes, and the owner is told.
 */
export async function acceptSuggestion(clientId, meetingId, { now = io.now() } = {}) {
  assertClientId(clientId);
  const s = await calendarSettings();
  const done = await withLock(async () => {
    const m = await getMeeting(meetingId);
    if (!m || m.clientId !== clientId) throw new CalendarError('This link does not match a meeting of yours.', 404);
    if (m.status === 'confirmed' && m.history?.some((h) => h.what === 'accepted')) return { meeting: m, same: true };
    if (m.status !== 'requested' || !m.proposed) throw new CalendarError('That suggestion is no longer open — please pick a time on the booking page.', 409);
    const t = msOf(m.proposed);
    if (t <= now.getTime()) throw new CalendarError('Sorry — that time has passed. Please pick another.', 409);
    const around = await meetingsBetween(t - DAY_MS, t + DAY_MS);
    if (clashWith(around, t, m.minutes, m.id)) throw new CalendarError('Sorry — that time has just been taken. Please pick another.', 409);
    const at = now.toISOString();
    const next = await saveMeeting({
      ...m, status: 'confirmed', start: m.proposed, proposed: null, confirmedAt: at, updatedAt: at,
      sequence: m.confirmedAt ? (Number(m.sequence) || 0) + 1 : Number(m.sequence) || 0,
      history: [...(m.history || []), step('accepted', 'them', now, { from: m.start }), step('confirmed', 'them', now)],
    });
    if (next.kind === 'onboarding') await call.syncCallFromMeeting(clientId, next, { now });
    return { meeting: next };
  });
  if (done.same) return done.meeting;
  const m = done.meeting;
  const t = msOf(m.start);
  await logEvent(clientId, SYSTEM, 'accepted', { meetingId: m.id, start: m.start });
  let emailError = null;
  try {
    const v = await meetingVars(m, s, t, 'ok');
    await emailClient(m, 'meeting_confirmed', v, { icalEvent: await inviteFor(m, s, { now }), dedupe: `meeting_confirmed:${m.id}:${m.start}:${m.sequence || 0}`, now });
  } catch (err) {
    emailError = String(err?.message || err).slice(0, 200);
    await logEvent(clientId, SYSTEM, 'email_failed', { meetingId: m.id, key: 'meeting_confirmed', error: emailError });
  }
  await alert('meeting_accepted', {
    clientId,
    scope: `${clientId}:accepted:${m.id}:${m.start}`,
    vars: { who: who(m), when: usAndOwner(t, s) },
    body: `${m.person || m.email} from ${m.company} said yes to the time you suggested: ${usAndOwner(t, s)} (${theirShort(t, zoneOf(m, s))} for them).${emailError ? `\n\nThe confirmation email to them failed (${emailError}) — write to them.` : ''}`,
    did: emailError ? 'Confirmed it in the Calendar and marked the onboarding call booked.' : 'Confirmed it in the Calendar, sent them the confirmation with a calendar invite, and marked the onboarding call booked.',
    url: '/#calendar',
  });
  return m;
}

// ─── the owner's buttons ─────────────────────────────────────────────────────

async function need(id) {
  const m = await getMeeting(id);
  if (!m) throw new CalendarError('No such meeting.', 404);
  return m;
}
const mustBe = (m, statuses, what) => {
  if (!statuses.includes(m.status)) throw new CalendarError(`This meeting is ${STATUS_WORDS[m.status] || m.status} — ${what}.`, 409);
};

/** A time the owner typed: valid, and for things still to happen, not in the past. */
function ownerTime(v, now, { future = true } = {}) {
  const t = msOf(v);
  if (t == null) throw new CalendarError('Give the date and time (for example 2026-10-06T15:00:00Z).');
  if (future && t <= now.getTime()) throw new CalendarError('That time has already passed — pick a later one.');
  if (t < now.getTime() - 60 * DAY_MS || t > now.getTime() + 366 * DAY_MS) throw new CalendarError('That date is too far from today — check it.');
  return t;
}

async function assertFree(t, minutes, exceptId, s) {
  const around = await meetingsBetween(t - DAY_MS, t + DAY_MS);
  const c = clashWith(around, t, minutes, exceptId);
  if (c) throw new CalendarError(`That overlaps ${c.status === 'blocked' ? 'time you blocked' : c.title} (${usAndOwner(heldInterval(c).start, s)}).`, 409);
}

const sendFailed = (err) => new CalendarError(`Could not email them (${String(err?.message || err).slice(0, 160)}) — nothing changed. Try again.`, 502);

/** Yes: the time they asked for is confirmed → confirmation + invite; the onboarding call is booked. */
async function confirm(id, s, now) {
  const m = await need(id);
  mustBe(m, ['requested'], 'there is nothing to say yes to');
  const t = msOf(m.start);
  if (t <= now.getTime()) throw new CalendarError('That time has already passed — suggest another time instead.', 409);
  await assertFree(t, m.minutes, m.id, s);
  const at = now.toISOString();
  const next = {
    ...m, status: 'confirmed', proposed: null, confirmedAt: at, updatedAt: at,
    // A time already in their calendar (they asked to move it) is updated, not added.
    sequence: m.confirmedAt ? (Number(m.sequence) || 0) + 1 : Number(m.sequence) || 0,
    history: [...(m.history || []), step('confirmed', 'owner', now)],
  };
  try {
    await emailClient(next, 'meeting_confirmed', await meetingVars(next, s, t, 'ok'), { icalEvent: next.email ? await inviteFor(next, s, { now }) : null, dedupe: `meeting_confirmed:${next.id}:${next.start}:${next.sequence}`, now });
  } catch (err) { throw sendFailed(err); }
  return next;
}

/** Suggest another time: the suggested time is held for them; they get it with a one-click "Yes, that works". */
async function suggest(id, start, s, now) {
  const m = await need(id);
  mustBe(m, ['requested'], 'suggest a time only on a request');
  const t = ownerTime(start, now);
  if (!m.clientId) throw new CalendarError('This meeting has no client to write to.', 409);
  await assertFree(t, m.minutes, m.id, s);
  const next = { ...m, proposed: iso(t), updatedAt: now.toISOString(), history: [...(m.history || []), step('suggested', 'owner', now, { proposed: iso(t) })] };
  const tz = zoneOf(m, s);
  try {
    const v = await meetingVars(next, s, t, 'sg');
    const acceptLink = `${await bookingLink(m.clientId, `${m.id.slice(-10)}-ac`)}/accept?m=${encodeURIComponent(m.id)}`;
    await emailClient(next, 'meeting_suggested', { when: v.when, asked: theirAsked(msOf(m.start), tz), acceptLink, bookLink: v.bookLink }, { now });
  } catch (err) { throw sendFailed(err); }
  return next;
}

/** Decline (with a short reason that goes to them). A time that had been in their calendar is cancelled there too. */
async function decline(id, reason, s, now) {
  const m = await need(id);
  mustBe(m, ['requested'], 'only a request can be declined (cancel a confirmed call instead)');
  const why = sentence(String(reason || '').trim().slice(0, REASON_MAX)) || "that time doesn't work on my side.";
  const at = now.toISOString();
  const next = { ...m, status: 'declined', declineReason: why, proposed: null, updatedAt: at, sequence: m.confirmedAt ? (Number(m.sequence) || 0) + 1 : Number(m.sequence) || 0, history: [...(m.history || []), step('declined', 'owner', now, { reason: why })] };
  try {
    const v = await meetingVars(next, s, msOf(m.start), 'dc');
    const ics = m.confirmedAt && m.email ? await inviteFor({ ...next, start: lastConfirmedStart(m) }, s, { method: 'CANCEL', now }) : null;
    await emailClient(next, 'meeting_declined', { asked: theirAsked(msOf(m.start), zoneOf(m, s)), reason: why, bookLink: v.bookLink }, { icalEvent: ics, now });
  } catch (err) { throw sendFailed(err); }
  return next;
}
/** The time that was last confirmed (what sits in their calendar). */
const lastConfirmedStart = (m) => {
  const h = [...(m.history || [])].reverse().find((x) => x.what === 'requested' && x.was === 'confirmed' && x.from);
  return h ? h.from : m.start;
};

/** Move a confirmed call (or a busy block) to a new time; they get the new time and the updated invite. */
async function move(id, start, s, now) {
  const m = await need(id);
  mustBe(m, ['confirmed', 'blocked'], m.status === 'requested' ? 'use Suggest another time for a request' : 'only a confirmed call can move');
  const t = ownerTime(start, now);
  if (iso(t) === m.start) return m;
  await assertFree(t, m.minutes, m.id, s);
  const at = now.toISOString();
  const next = { ...m, start: iso(t), updatedAt: at, sequence: (Number(m.sequence) || 0) + 1, history: [...(m.history || []), step('moved', 'owner', now, { from: m.start })] };
  if (m.status === 'confirmed') {
    try {
      await emailClient(next, 'meeting_moved', await meetingVars(next, s, t, 'mv'), { icalEvent: next.email ? await inviteFor(next, s, { now }) : null, dedupe: `meeting_moved:${next.id}:${next.start}:${next.sequence}`, now });
    } catch (err) { throw sendFailed(err); }
  }
  return next;
}

/** Cancel (the owner's side): they are told, and a confirmed time is removed from their calendar (METHOD:CANCEL). */
async function cancel(id, reason, s, now) {
  const m = await need(id);
  mustBe(m, ['requested', 'confirmed'], 'only a request or a confirmed call can be cancelled');
  const why = sentence(String(reason || '').trim().slice(0, REASON_MAX));
  const at = now.toISOString();
  const next = { ...m, status: 'cancelled', cancelReason: why || null, proposed: null, updatedAt: at, sequence: (Number(m.sequence) || 0) + (m.confirmedAt ? 1 : 0), history: [...(m.history || []), step('cancelled', 'owner', now, why ? { reason: why } : {})] };
  try {
    const t = msOf(m.start);
    const v = await meetingVars(next, s, t, 'cx');
    const nextLine = m.kind === 'onboarding' && m.clientId ? `When you're ready, pick a new time here: ${v.bookLink}` : "Reply to this email if you'd like a new time.";
    const cancelText = `I'm sorry — I've had to cancel our call on ${v.when}.${why ? ` ${why}` : ''}`;
    const ics = m.confirmedAt && m.email ? await inviteFor({ ...next, start: m.status === 'confirmed' ? m.start : lastConfirmedStart(m) }, s, { method: 'CANCEL', now }) : null;
    await emailClient(next, 'meeting_cancelled', { when: v.when, whenShort: v.whenShort, cancelText, nextLine }, { icalEvent: ics, dedupe: `meeting_cancelled:${m.id}:${next.sequence}`, now });
  } catch (err) { throw sendFailed(err); }
  return next;
}

/** Call done / they didn't show (a slip can be corrected either way). */
function markOutcome(m, what, now) {
  mustBe(m, ['confirmed', 'held', 'no_show'], 'only a confirmed call can be marked');
  if (m.status === what) return m;
  return { ...m, status: what, updatedAt: now.toISOString(), history: [...(m.history || []), step(what, 'owner', now)] };
}

/** A meeting the owner arranged himself (confirmed, nobody is emailed). kind 'onboarding' makes it that client's onboarding call. */
async function addMeeting(body, s, now) {
  const t = ownerTime(body.start, now, { future: false });
  const minutes = Math.round(Number(body.minutes) || s.callMinutes);
  if (minutes < 5 || minutes > 240) throw new CalendarError('A meeting is 5 to 240 minutes.');
  let client = null;
  if (body.clientId) {
    try { assertClientId(String(body.clientId)); } catch { throw new CalendarError('Unknown client.', 404); }
    client = await getClient(String(body.clientId));
    if (!client) throw new CalendarError('Unknown client.', 404);
  }
  const kind = body.kind === 'onboarding' && client ? 'onboarding' : 'other';
  if (kind === 'onboarding') {
    const current = await onboardingMeetingOf(client.id);
    if (current && OPEN.has(current.status)) throw new CalendarError('They already have an onboarding call in the calendar — move that one instead.', 409);
  }
  const title = String(body.title || '').trim() || (kind === 'onboarding' ? onboardingTitle(client) : client ? `Call — ${client.name || client.id}` : '');
  if (!title) throw new CalendarError('Give the meeting a title.');
  await assertFree(t, minutes, null, s);
  const theirZone = client ? await zoneOfClient(client.id) : null;
  return newMeeting({ client, kind, title, start: iso(t), minutes, status: 'confirmed', source: 'owner', theirZone, note: String(body.note || '').trim().slice(0, NOTE_MAX), now, by: 'owner' });
}

async function block(body, s, now) {
  const t = ownerTime(body.start, now, { future: false });
  const minutes = Math.round(Number(body.minutes) || 60);
  if (minutes < 5 || minutes > 24 * 60) throw new CalendarError('Block 5 minutes to 24 hours at a time.');
  const around = await meetingsBetween(t - DAY_MS, t + minutes * 60e3 + DAY_MS);
  const c = around.find((m) => COUNTED.has(m.status) && clashWith([m], t, minutes));
  if (c) throw new CalendarError(`That overlaps ${c.title} (${usAndOwner(heldInterval(c).start, s)}) — move or cancel it first.`, 409);
  return newMeeting({ title: 'Busy', start: iso(t), minutes, status: 'blocked', source: 'owner', now, by: 'owner' });
}

/**
 * POST /api/mc/calendar → { ok, meeting }. Every change happens under the
 * calendar lock; an email that must go (confirm, suggest, decline, move,
 * cancel) goes first, so a failed send changes nothing and the owner can
 * press again. An onboarding meeting keeps the onboarding call in step.
 */
export async function calendarAction(body = {}, { now = io.now() } = {}) {
  const s = await calendarSettings();
  const meeting = await withLock(async () => {
    let m;
    switch (body.action) {
      case 'confirm': m = await confirm(body.id, s, now); break;
      case 'suggest': m = await suggest(body.id, body.start, s, now); break;
      case 'decline': m = await decline(body.id, body.reason, s, now); break;
      case 'move': m = await move(body.id, body.start, s, now); break;
      case 'cancel': m = await cancel(body.id, body.reason, s, now); break;
      case 'held': m = markOutcome(await need(body.id), 'held', now); break;
      case 'noShow': m = markOutcome(await need(body.id), 'no_show', now); break;
      case 'add': m = await addMeeting(body, s, now); break;
      case 'block': m = await block(body, s, now); break;
      case 'unblock': {
        const b = await need(body.id);
        mustBe(b, ['blocked'], 'only a busy block can be unblocked');
        m = { ...b, status: 'cancelled', updatedAt: now.toISOString(), history: [...(b.history || []), step('unblocked', 'owner', now)] };
        break;
      }
      default: throw new CalendarError('Unknown action — use confirm, suggest, decline, move, held, noShow, cancel, add, block or unblock.');
    }
    const saved = await saveMeeting(m);
    if (saved.kind === 'onboarding' && saved.clientId) await call.syncCallFromMeeting(saved.clientId, saved, { now });
    return saved;
  });
  await logEvent(meeting.clientId || null, SYSTEM, `owner_${body.action}`, { meetingId: meeting.id, start: meeting.start, status: meeting.status });
  return { ok: true, meeting: hubMeeting(meeting, s) };
}

// ─── the onboarding card and the inbox → the calendar ────────────────────────

/**
 * Keep the client's onboarding meeting in step with the onboarding card
 * ("Mark call booked", "Call done", "They didn't show") and with calendar
 * invites found in the inbox — one meeting per client's onboarding call, no
 * emails (the owner or their own calendar tool already told them).
 * `what`: 'booked' (with `start`), 'held', 'no_show', 'cancelled'.
 */
export async function syncFromOnboardCall(clientId, what, { start = null, source = 'onboard_card', by = 'owner', now = io.now() } = {}) {
  assertClientId(clientId);
  const s = await calendarSettings();
  return withLock(async () => {
    const current = await onboardingMeetingOf(clientId);
    const at = now.toISOString();
    let m = null;
    if (what === 'booked') {
      const t = msOf(start);
      if (t == null) return null; // a booking email with no readable time: nothing to place
      const startIso = iso(t);
      if (current && OPEN.has(current.status)) {
        if (current.status === 'confirmed' && current.start === startIso) return current;
        m = {
          ...current, status: 'confirmed', start: startIso, proposed: null, confirmedAt: current.confirmedAt || at, updatedAt: at,
          history: [...(current.history || []), step(current.status === 'confirmed' ? 'moved' : 'confirmed', by, now, { via: source, ...(current.start !== startIso ? { from: current.start } : {}) })],
        };
      } else {
        const client = await getClient(clientId);
        if (!client) return null;
        m = newMeeting({ client, kind: 'onboarding', title: onboardingTitle(client), start: startIso, minutes: s.callMinutes, status: 'confirmed', source, theirZone: await zoneOfClient(clientId), now, by });
      }
    } else if (what === 'held' || what === 'no_show') {
      if (!current || !['confirmed', 'held', 'no_show'].includes(current.status) || current.status === what) return current;
      m = { ...current, status: what, updatedAt: at, history: [...(current.history || []), step(what, by, now, { via: source })] };
    } else if (what === 'cancelled') {
      if (!current || current.status !== 'confirmed') return current;
      m = { ...current, status: 'cancelled', updatedAt: at, history: [...(current.history || []), step('cancelled', by, now, { via: source })] };
    } else return current;
    m = await saveMeeting(m);
    await call.linkMeeting(clientId, m.id);
    await logEvent(clientId, SYSTEM, `synced_${what}`, { meetingId: m.id, start: m.start, source });
    return m;
  });
}

// ─── the hub ─────────────────────────────────────────────────────────────────

/** A meeting as the hub gets it: the stored fields plus its end and the three clocks (Sri Lanka · Eastern · theirs). */
export function hubMeeting(m, s = normaliseCalendar()) {
  const t = msOf(m.start);
  const tz = m.theirZone || null;
  return {
    ...m,
    end: t == null ? null : iso(t + (Number(m.minutes) || 30) * 60e3),
    labels: t == null ? null : {
      owner: `${shortDay(t, s.ownerZone)}, ${clockIn(t, s.ownerZone)}`,
      eastern: `${shortDay(t, s.usZone)}, ${clockIn(t, s.usZone)} ${zoneInfo(s.usZone).short}`,
      theirs: tz ? `${shortDay(t, tz)}, ${clockIn(t, tz)} ${zoneInfo(tz).short}` : null,
      proposed: m.proposed ? usAndOwner(msOf(m.proposed), s) : null,
    },
  };
}

/**
 * GET /api/mc/calendar: the meetings in [from, to) (declined and cancelled
 * left out unless `all`), every request still waiting for a yes (oldest
 * first, any date), the settings the grid needs, and the open times in the
 * range (for "Suggest another time": call hours, buffer and maxPerDay, no
 * notice period — the owner chooses).
 */
export async function calendarView({ from = null, to = null, all = false, now = io.now() } = {}) {
  const s = await calendarSettings();
  let fromMs = msOf(from) ?? now.getTime() - DAY_MS;
  let toMs = msOf(to) ?? fromMs + s.daysAhead * DAY_MS;
  if (toMs <= fromMs) throw new CalendarError('`to` must be after `from`.');
  if (toMs - fromMs > 62 * DAY_MS) toMs = fromMs + 62 * DAY_MS;
  const [inRange, ahead] = await Promise.all([
    meetingsBetween(fromMs - DAY_MS, toMs + DAY_MS),
    meetingsBetween(now.getTime() - 90 * DAY_MS, now.getTime() + 400 * DAY_MS),
  ]);
  const shown = inRange.filter((m) => {
    const t = msOf(m.start);
    const h = heldInterval(m)?.start;
    return ((t >= fromMs && t < toMs) || (h >= fromMs && h < toMs)) && (all || !['declined', 'cancelled'].includes(m.status));
  }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const requests = ahead.filter((m) => m.status === 'requested')
    .sort((a, b) => String(a.requestedAt || a.createdAt).localeCompare(String(b.requestedAt || b.createdAt)));
  const free = openSlots({ settings: s, meetings: inRange, now, from: Math.max(fromMs, now.getTime()), to: toMs, noticeHours: 0 }).map((x) => ({ start: x.start, minutes: x.minutes }));
  return {
    meetings: shown.map((m) => hubMeeting(m, s)),
    requests: requests.map((m) => hubMeeting(m, s)),
    settings: { hours: s.hours, days: s.days, slotMinutes: s.slotMinutes, ownerZone: s.ownerZone, usZone: s.usZone, meetingLink: s.meetingLink, bufferMinutes: s.bufferMinutes, maxPerDay: s.maxPerDay, minNoticeHours: s.minNoticeHours, daysAhead: s.daysAhead, callMinutes: s.callMinutes },
    free,
  };
}
