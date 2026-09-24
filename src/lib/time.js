/**
 * Time-zone helpers (SPEC §5). Sending hours use the lead's tz, owner digests
 * use Asia/Colombo, everything else uses America/New_York. `trialDay` is the
 * only place that computes a trial day number.
 */

export const ET = 'America/New_York';
export const OWNER_TZ = 'Asia/Colombo';

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of `date` in `tz`. */
export function partsIn(tz = ET, date = new Date()) {
  const map = {};
  for (const p of formatter(tz).formatToParts(date)) map[p.type] = p.value;
  const hour = parseInt(map.hour, 10) % 24;
  const minute = parseInt(map.minute, 10);
  return {
    weekday: map.weekday,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    dayKey: `${map.year}-${map.month}-${map.day}`,
    monthKey: `${map.year}-${map.month}`,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

export const dayKeyIn = (tz = ET, date = new Date()) => partsIn(tz, date).dayKey;

export const isWeekday = (weekday) => !['Sat', 'Sun'].includes(weekday);

/** 'HH:MM' → minutes after midnight. */
export function hhmmToMin(s) {
  const [h, m] = String(s).split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

/** True when `date` in `tz` falls inside [start, end) given as 'HH:MM'. */
export function inWindow(tz, [start, end], date = new Date()) {
  const { minuteOfDay } = partsIn(tz, date);
  return minuteOfDay >= hhmmToMin(start) && minuteOfDay < hhmmToMin(end);
}

/** Whole calendar days from dayKey a to dayKey b (b − a). */
export function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 864e5);
}

/** dayKey + n calendar days. */
export function addDays(dayKey, n) {
  const d = new Date(Date.parse(`${dayKey}T12:00:00Z`) + n * 864e5);
  return d.toISOString().slice(0, 10);
}

/**
 * Trial day (SPEC §4): days since day1Date in US Eastern, +1. Before day 1 it
 * is negative, counted from signedDay (Day −14), so the day after signing is
 * Day −13. Returns null when neither date is set.
 */
export function trialDay(trial, now = new Date()) {
  const today = dayKeyIn(ET, now);
  if (trial?.day1Date && today >= trial.day1Date) return daysBetween(trial.day1Date, today) + 1;
  if (trial?.signedDay) return -14 + daysBetween(trial.signedDay, today);
  if (trial?.day1Date) return daysBetween(trial.day1Date, today); // before day 1, no signedDay
  return null;
}

/** Map a US state (2-letter or name) to its main IANA tz (SPEC §3 lead tz). */
const TZ_BY_STATE = {
  America_Chicago: 'AL AR IA IL KS LA MN MO MS ND NE OK SD TN TX WI',
  America_Denver: 'AZ CO ID MT NM UT WY',
  America_Los_Angeles: 'CA NV OR WA',
};
const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

export function tzForState(state) {
  const s = String(state || '').trim();
  const code = s.length === 2 ? s.toUpperCase() : STATE_NAMES[s.toLowerCase()] || '';
  for (const [tz, list] of Object.entries(TZ_BY_STATE)) {
    if (list.split(' ').includes(code)) return tz.replace('_', '/');
  }
  return ET;
}
