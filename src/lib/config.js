/**
 * Every threshold the trial machine uses (SPEC §12). Systems read values
 * through `cfg(clientId, 'DOTTED.KEY')`; nothing hard-codes a number.
 *
 * Resolution order: client override (client:{id}:config) → global override
 * (system:config, edited in /mc/config) → the default below. Overrides are
 * stored as JSON strings per dotted key.
 *
 * Two limits are legal/safety ceilings, not preferences, and are clamped here
 * whatever an override says (SPEC §14.8): 25 cold + 15 warm-up per inbox/day.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

export const HARD_COLD_CAP = 25;
export const HARD_WARMUP_CAP = 15;

export const DEFAULTS = {
  MAX_ACTIVE_TRIALS: 3,
  MIN_MARKET: 1000,
  FIT: { employeesMin: 5, employeesMax: 50, dealValueMin: 2000, slotsPerWeekMin: 5 },
  ONBOARD: { reminderDays: [2, 4], closeDay: 7 },
  PURCHASE: { reminderHours: [12, 48] },
  ALLOWED_TLDS: ['com', 'net', 'co'],
  BANNED_TLDS: ['xyz', 'shop', 'info', 'top', 'club', 'site', 'online'],
  WARMUP: {
    minPool: 8,
    quota: { '1-3': 3, '4-7': 8, '8-14': 15, '15+': 8 },
    replyRate: 0.40,
    readyRate: 0.90,
    readyConsecutiveDays: 2,
    lowRate: 0.80,
    maxSlideDays: 7,
  },
  LIST: { need: 400, refillBelow: 50, startMin: 200, sanitySample: 20, maxFail: 2 },
  PLACES: { monthlyEnterprise: 1000 },
  REOON: { dailyFree: 20 },
  COPY: { maxWords: 80 },
  SEQUENCE: { gaps: [0, 3, 4, 3], compressedGaps: [0, 3, 2, 3] },
  APPROVAL: { reminderDays: [-5, -3], silenceHours: 48 },
  CANARY: { gate: 0.85, warn: 0.85, emergency: 0.70 },
  RAMP: { caps: { '1-2': 8, '3-4': 12, '5-6': 16, '7+': 25 } },
  COLD_CAP: 25,
  SEND: {
    windowLeadTz: ['09:00', '17:00'],
    windowInboxEt: ['08:00', '19:00'],
    smokeTestSends: 50,
    smokeTestBounceMax: 0.03,
    trackOpens: false,
  },
  FRESH_MIN_SHARE: 0.4,
  FOLLOWUP_GRACE_DAYS: 7,
  BOUNCE: { max: 0.02 },
  REPLIES: { offHoursMinutes: 20 },
  HOT: { nudgeHours: 4, holdingHours: 24 },
  BOOK: { farSlotDays: 5, reminders: [24, 1], tapReminderHours: 24 },
  NOSHOW: { attempts: 2, emails: 3, windowDays: 14, highRate: 0.30 },
  DISPUTE: { windowBusinessHours: 24, autoUpholdHours: 48 },
  NOTNOW: { defaultDays: 60, quarterDays: 90, maxMoves: 1 },
  CLIENT: { quietWarnDays: 2, pauseDays: 5, endDays: 14 },
  PACE: { days: [3, 7, 12, 15, 20, 25], replyMin: 0.01, positiveMin: 0.01, bookedMin: 0.0025 },
  EMERGENCY: { noReplyDays: 2, placementMin: 0.70, dmarcMin: 0.80, greenDays: 3 },
  TRIAL: { buildDays: 14, reportDay: 29, decisionDay: 30, ladderDays: [33, 37, 44], retireDay: 45, bonusHours: 24 },
  EXTENSION_CAP: 60,
  DELETE: { afterEndDays: 30 },
  WINBACK: { days: 90 },
  PLANS: {
    starter: { price: 2497, calls: 10, reach: 2000 },
    growth: { price: 3997, calls: 20, reach: 4000 },
    scale: { price: 8497, calls: 50, reach: 10000 },
    perCallAfter: 150,
    payPerShow: 250,
  },
  BONUS: { starter: [12, 10], growth: [22, 20], scale: [55, 50] },
  CAPACITY: { starterMax: 3, growthMax: 7 },
  WATCHDOG: { sendStallMin: 30, hcGraceMin: 15, jobFailStreak: 3 },
  USAGE: { warn: 0.80, stop: 0.95 },
  // "to set" values (SPEC §12): null means not set yet. Anything that needs one
  // refuses to run and alerts rather than inventing it (rule 4).
  OWNER: {
    usHours: ['09:00', '17:00'],
    signerName: null,
    address: null,
    email: null,
    telegramChatId: null,
  },
  PAYMENT: { paypalMe: null, wiseDetails: null },
  // US federal holidays, observed dates. Update once a year (one line per year).
  US_HOLIDAYS: [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03',
    '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05',
    '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24',
  ],
};

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function parse(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function clamp(key, value) {
  if (key === 'COLD_CAP') return Math.min(HARD_COLD_CAP, Math.max(0, Number(value) || 0));
  if (key === 'RAMP.caps' && value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = Math.min(HARD_COLD_CAP, Math.max(0, Number(v) || 0));
    return out;
  }
  if (key === 'WARMUP.quota' && value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = Math.min(HARD_WARMUP_CAP, Math.max(0, Number(v) || 0));
    return out;
  }
  return value;
}

/** Default value for a dotted key (no overrides). */
export function defaultOf(key) {
  return getPath(DEFAULTS, key);
}

/**
 * Resolve one setting. `clientId` may be null for global-only lookups.
 * Never throws: a KV failure falls back to the default.
 */
export async function cfg(clientId, key) {
  let value;
  try {
    if (clientId) value = parse(await kv.hget(K.config(clientId), key));
    if (value === undefined) value = parse(await kv.hget(K.globalConfig(), key));
  } catch {
    value = undefined;
  }
  if (value === undefined) value = defaultOf(key);
  return clamp(key, value);
}

/** Every global override currently set (for /mc/config and drift reporting). */
export async function globalOverrides() {
  try {
    const raw = (await kv.hgetall(K.globalConfig())) || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = parse(v);
    return out;
  } catch {
    return {};
  }
}

/** Set (or with `value === undefined`, clear) an override. */
export async function setOverride(clientId, key, value) {
  if (defaultOf(key) === undefined) throw new Error(`unknown config key: ${key}`);
  const hash = clientId ? K.config(clientId) : K.globalConfig();
  if (value === undefined) return kv.hdel(hash, key);
  return kv.hset(hash, { [key]: JSON.stringify(clamp(key, value)) });
}

export function isUsHoliday(dayKey) {
  return DEFAULTS.US_HOLIDAYS.includes(dayKey);
}
