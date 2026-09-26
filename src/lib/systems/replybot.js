/**
 * The reply bot (docs/REPLYBOT-MEET.md §2) — the owner's words: "After we send
 * the booking details there should be a reply bot."
 *
 * No AI: fixed rules on the words they typed (quoted history already cut), in
 * this order, the FIRST match answers and nothing else:
 *   not_interested  a polite close; the reminders stop; the owner is told
 *   reschedule      the booking page ("pick any other time")
 *   proposes_time   a day + a time the rules can read → free by the calendar
 *                   rules: a meeting request at it (source reply_bot, the owner
 *                   still says yes) and "works on my side"; taken: the three
 *                   nearest free times + the booking page
 *   wants_time      the booking page + the next three open times
 *   price           the trial is free, no card, an honest review; plans on the call
 *   what_needed     what the call covers + the one-page onboarding link
 *   thanks          nothing is sent, and nothing waits for an answer
 *
 * It never answers: a client whose bot is off (or everyone's), a client who is
 * not onboarding, automatic mail (out-of-office, bounces, no-reply senders), a
 * message the owner already answered, a message older than 3 days when first
 * seen, a second message before it answered the first, more than
 * REPLYBOT.maxPerDay bot emails to one client in a US day, or anything no rule
 * reads → the owner gets `onboard_reply` exactly as before. Outside
 * REPLYBOT.hours an answer waits for the next check inside them, and every
 * answer waits REPLYBOT.delayMinutes after their message arrived (the owner
 * can still answer first — then the bot says nothing).
 *
 * Flow: onboardcall.recordReply calls `onInbound` for each new message (before
 * storing it, so the entry carries the rule) → an answer is queued in the
 * client's convo hash (`botPending`, one at a time) and the client id in the
 * `replybot:pending` set → `runReplyBot` (end of every onboarding check: the
 * job, the hub's check, after Approve) sends the answers that are due.
 * After each: a quiet `bot_replied` alert.
 *
 * Pure parts (plain, the rule tests, readTimes, classify, fillAnswer,
 * nearestTimes, nextDayTimes) are unit-tested in tests/replybot.test.mjs.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { DEFAULTS, globalOverrides, cfg } from '@/lib/config';
import { getClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { mintToken, pageUrl, rememberLink, TTL } from '@/lib/pagetokens';
import { isJunkReply } from '@/lib/junk-filter';
import { zonedToUtc, shortHash, lower } from '@/lib/systems/stagec-common';
import { io, sendClient, firstNameOf, ownerName, asObject } from '@/lib/systems/intake-io';
import { partsIn, addDays, ET } from '@/lib/time';
import * as call from '@/lib/systems/onboardcall';
import * as conv from '@/lib/systems/conversation';
import * as cal from '@/lib/systems/calendar';

const SYSTEM = 'replybot';
const DAY_MS = 864e5;
/** A message older than this when the inbox first shows it gets no automatic answer. */
export const MAX_AGE_MS = 3 * DAY_MS;
export const RULES = ['not_interested', 'reschedule', 'proposes_time', 'wants_time', 'price', 'what_needed', 'thanks'];
/** Rules that need the booking page open (the client is onboarding and the call is not done). */
const BOOKING_RULES = new Set(['reschedule', 'proposes_time', 'wants_time']);
/** The placeholders an answer may use. Anything else in {braces} stops the answer (the owner gets the message). */
const SLOTS = ['bookingLink', 'times', 'firstName', 'onboardingLink', 'ownerName', 'when', 'callMinutes'];

const ms = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => new Date(t).toISOString();
const flag = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ─── settings ────────────────────────────────────────────────────────────────

/**
 * REPLYBOT in one Redis read. A leaf override (REPLYBOT.maxPerDay,
 * REPLYBOT.answers.price) wins over a whole-block one, as /mc/config writes both.
 */
export async function replyBotSettings() {
  let o = {};
  try { o = await globalOverrides(); } catch {}
  const d = DEFAULTS.REPLYBOT;
  const whole = isObj(o.REPLYBOT) ? o.REPLYBOT : {};
  const pick = (k) => (o[`REPLYBOT.${k}`] !== undefined ? o[`REPLYBOT.${k}`] : whole[k] !== undefined ? whole[k] : d[k]);
  const s = Object.fromEntries(Object.keys(d).map((k) => [k, pick(k)]));
  const answers = {};
  for (const k of Object.keys(d.answers)) {
    answers[k] = o[`REPLYBOT.answers.${k}`] ?? (isObj(s.answers) ? s.answers[k] : undefined) ?? (isObj(whole.answers) ? whole.answers[k] : undefined);
  }
  return normaliseBot({ ...s, answers });
}

/** Settings → safe values (a broken number falls back to the default; an empty answer to the default text). */
export function normaliseBot(s = {}) {
  const d = DEFAULTS.REPLYBOT;
  const int = (v, def, min, max) => { const n = Math.round(Number(v)); return v !== null && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : def; };
  const answers = { ...d.answers };
  for (const [k, v] of Object.entries(isObj(s.answers) ? s.answers : {})) if (k in answers && typeof v === 'string' && v.trim()) answers[k] = v;
  return {
    enabled: s.enabled !== false && s.enabled !== 'false' && s.enabled !== 0 && s.enabled !== '0',
    maxPerDay: int(s.maxPerDay, d.maxPerDay, 0, 50),
    delayMinutes: int(s.delayMinutes, d.delayMinutes, 0, 24 * 60),
    hours: s.hours === 'any' ? 'any' : 'us',
    answers,
  };
}

// ─── reading their words (pure) ──────────────────────────────────────────────

/** Their words for the rules: straight quotes, plain dashes, one space, lower case. */
export function plain(text) {
  return String(text || '').replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[‒-―]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const NOT_INTERESTED = [
  /\bnot interested\b/,
  // "no longer" alone would also catch "Tuesday no longer works" — a close sent by mistake is the worst answer, so it needs its object.
  /\bno longer (?:interested|need|needed|want|wanted|looking|require|required|pursuing|going ahead|moving forward|proceeding|a fit|a priority|relevant|keen)\b/,
  /\bchanged (?:my|our) minds?\b/,
  /\bcancel (?:the|my|our|this) (?:free )?trial\b/,
  /\bunsubscribe\b/,
  /\bremove (?:me|us)\b/,
];
const RESCHEDULE = [
  /\bre-?schedul/,
  /\bmove (?:the|our|my) (?:call|meeting)\b/,
  /\bdifferent time\b(?!\s*zones?)/,
  /\bcan'?t make\b/, /\bcannot make\b/, /\bcan not make\b/,
  /\bsomething (?:has |'s )?c[ao]me up\b/, /\bsomething's come up\b/,
];
const WANTS_TIME = [
  /\bwhat times?\b(?!\s*zones?)/,
  /\bwhen (?:are|would|will) you (?:be )?(?:free|available)\b/,
  /\byour availability\b/,
  /\bhappy to (?:jump|hop|get) on a call\b/,
  /\blet'?s book\b/,
  /\bsounds good\b/,
  /\bworks for me\b/,
];
const PRICE = [
  /\bcost(?:s|ing)?\b/,
  /\bpric(?:e|es|ed|ing)\b/,
  /\bhow much\b(?!\s+(?:time|notice|info|information|detail|details|of your time|prep|preparation|work|effort))/,
  /\bfees?\b/,
  /\bis (?:it|this|that|the trial) (?:really |actually |completely |totally |100% )?free\b/,
  // "what's the catch" — not "let's catch up".
  /\bcatch\b(?!\s+(?:up|you|ya|u)\b)/,
];
const WHAT_NEEDED = [
  /\bwhat (?:do|would|will|did) you need\b/,
  /\bwhat (?:should|do|shall|must) (?:i|we) (?:prepare|bring|have ready|get ready|send)\b/,
  /\bwhat info(?:rmation)?\b/,
  /\banything (?:i|we) (?:need|should|must)\b/,
  /\bdo (?:i|we) need to (?:prepare|bring|send|do) anything\b/,
];

export const isNotInterested = (t) => /^\W*stop\W*$/.test(t) || NOT_INTERESTED.some((re) => re.test(t));
export const isReschedule = (t) => RESCHEDULE.some((re) => re.test(t));
export const isWantsTime = (t) => WANTS_TIME.some((re) => re.test(t));
export const isPrice = (t) => PRICE.some((re) => re.test(t));
export const isWhatNeeded = (t) => WHAT_NEEDED.some((re) => re.test(t));

const THANKS_CORE = new Set(['thanks', 'thank', 'thx', 'ty', 'tks', 'ok', 'okay', 'k', 'great', 'perfect', 'cheers', 'awesome', 'appreciated', 'appreciate', 'brilliant', 'excellent', 'wonderful', 'lovely', 'noted', 'cool', 'fantastic', 'super', 'nice', 'good', 'got', 'received']);
const THANKS_FILL = new Set(['you', 'so', 'much', 'very', 'a', 'lot', 'many', 'again', 'for', 'that', 'this', 'the', 'it', 'will', 'do', 'sounds', 'see', 'then', 'all', 'set', 'and', 'yes', 'yeah', 'yep', 'sure', 'hi', 'hey', 'hello', 'dear', 'mate', 'sir', 'indeed', 'really', 'too', 'as', 'well', 'looking', 'forward', 'to', 'your', 'email', 'note', 'message', 'in', 'advance', 'now', "that's", 'thats', 'is', 'just', 'x']);

/**
 * The whole message is a thank-you / ok (≤ 6 words once names are left out):
 * every word is one of the ok-words or their filler, at least one real
 * ok-word, and no question mark.
 */
export function isThanks(t, names = []) {
  if (!t || t.includes('?')) return false;
  const skip = new Set(names.flatMap((n) => String(n || '').toLowerCase().split(/\s+/)).filter(Boolean));
  const words = t.replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter((w) => w && !skip.has(w));
  if (!words.length || words.length > 6) return false;
  return words.every((w) => THANKS_CORE.has(w) || THANKS_FILL.has(w)) && words.some((w) => THANKS_CORE.has(w));
}

// ── a day + a time ──

const ZONES = {
  NY: 'America/New_York', CHI: 'America/Chicago', DEN: 'America/Denver', PHX: 'America/Phoenix', LA: 'America/Los_Angeles', ANC: 'America/Anchorage', HNL: 'Pacific/Honolulu',
};
const ZONE_WORD = {
  eastern: ZONES.NY, et: ZONES.NY, est: ZONES.NY, edt: ZONES.NY,
  central: ZONES.CHI, ct: ZONES.CHI, cst: ZONES.CHI, cdt: ZONES.CHI,
  mountain: ZONES.DEN, mt: ZONES.DEN, mst: ZONES.DEN, mdt: ZONES.DEN,
  pacific: ZONES.LA, pt: ZONES.LA, pst: ZONES.LA, pdt: ZONES.LA,
  alaska: ZONES.ANC, akt: ZONES.ANC, akst: ZONES.ANC, akdt: ZONES.ANC,
  hawaii: ZONES.HNL, hst: ZONES.HNL, hdt: ZONES.HNL,
  arizona: ZONES.PHX,
};
const WEEKDAY_NUM = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember|t)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_RE = '(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*';
const pad = (n) => String(n).padStart(2, '0');

/** A real date 'YYYY-MM-DD' (no 31 September), else null. */
function realDay(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const key = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(`${key}T12:00:00Z`).toISOString().slice(0, 10) === key ? key : null;
}
/** A month + day with no year: this year's, or next year's once it has passed. */
function dayFromDate(y, m, d, today) {
  if (y) return realDay(y < 100 ? 2000 + y : y, m, d);
  const year = Number(today.slice(0, 4));
  const key = realDay(year, m, d);
  if (key && key >= today) return key;
  return realDay(year + 1, m, d);
}
const weekdayOfKey = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();

/** Every day they name, with where it is in the text: dates first-class, then today/tomorrow, then weekdays. */
function dayMentions(t) {
  // "Mon-Fri" / "Monday to Friday" (office hours in a signature) names no day.
  const s = t.replace(new RegExp(`\\b${DAY_RE}\\.?\\s*(?:-|to|through|thru|until|till)\\s*${DAY_RE}\\.?`, 'g'), (x) => ' '.repeat(x.length));
  const out = [];
  const add = (re, fn) => { let m; re.lastIndex = 0; while ((m = re.exec(s))) { const v = fn(m); if (v) out.push({ i: m.index, j: m.index + m[0].length, ...v }); } };
  add(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4})\\b)?`, 'g'), (m) => ({ kind: 'date', m: MONTHS3.indexOf(m[1].slice(0, 3)) + 1, d: Number(m[2]), y: m[3] ? Number(m[3]) : null }));
  add(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s*(\\d{4})\\b)?`, 'g'), (m) => ({ kind: 'date', m: MONTHS3.indexOf(m[2].slice(0, 3)) + 1, d: Number(m[1]), y: m[3] ? Number(m[3]) : null }));
  add(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (m) => ({ kind: 'date', m: Number(m[1]), d: Number(m[2]), y: m[3] ? Number(m[3]) : null }));
  add(/\b(today|tomorrow|tmrw|tmr)\b/g, (m) => ({ kind: 'rel', plus: m[1] === 'today' ? 0 : 1 }));
  add(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|weds?|thu(?:rs?)?|fri|sat)\b\.?/g, (m) => ({ kind: 'weekday', wd: WEEKDAY_NUM[m[1].slice(0, 3)] }));
  return out;
}

/** 'h' on a 12-hour clock with no am/pm, in business hours: 8–11 morning, 12–7 afternoon. */
const businessHour = (h) => (h >= 1 && h <= 7 ? h + 12 : h);
const to24 = (h, suffix) => (/p/.test(suffix) ? (h % 12) + 12 : h % 12);

/** Every time of day they name (with where it is), ranges and "after 2pm" left out. */
function timeMentions(t) {
  const out = [];
  const add = (re, fn) => { let m; re.lastIndex = 0; while ((m = re.exec(t))) { const v = fn(m); if (v) out.push({ i: m.index, j: m.index + m[0].length, ...v }); } };
  // "2pm", "2:30 p.m."
  add(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/g, (m) => (Number(m[1]) >= 1 && Number(m[1]) <= 12 ? { h: to24(Number(m[1]), m[3]), mi: Number(m[2] || 0) } : null));
  // "2-3pm", "11 to 12pm": the start takes the end's am/pm, earlier than the end (the end is part of this reading).
  add(/\b(\d{1,2})(?::([0-5]\d))?\s*(?:-|to)\s*(\d{1,2})(?::[0-5]\d)?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/g, (m) => {
    const end = to24(Number(m[3]), m[4]);
    let h = to24(Number(m[1]), m[4]);
    if (h >= end) h -= 12;
    return h >= 0 && Number(m[1]) <= 12 ? { h, mi: Number(m[2] || 0), range: true } : null;
  });
  // "14:00", "9:30" with no am/pm.
  add(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:a\.?\s?m|p\.?\s?m))/g, (m) => { const h = Number(m[1]); return h === 0 ? null : { h: h >= 13 ? h : businessHour(h), mi: Number(m[2]) }; });
  // "at 3", "@ 11", "3 o'clock"
  add(/(?:\bat|@)\s*(\d{1,2})\b(?!\s*(?::|\.\d|\/|a\.?\s?m|p\.?\s?m|%|st\b|nd\b|rd\b|th\b|min|hour|hr|people|person|of\b|percent|days?\b|weeks?\b|months?\b|years?\b|-|to\b))/g, (m) => { const h = Number(m[1]); return h >= 1 && h <= 12 ? { h: businessHour(h), mi: 0 } : null; });
  add(/\b(\d{1,2})\s*o'?\s?clock\b/g, (m) => { const h = Number(m[1]); return h >= 1 && h <= 12 ? { h: businessHour(h), mi: 0 } : null; });
  add(/\b(noon|midday)\b/g, () => ({ h: 12, mi: 0 }));
  out.sort((a, b) => a.i - b.i);
  const kept = [];
  for (const x of out) {
    if (kept.some((k) => x.i < k.j && k.i < x.j)) continue; // one reading per place in the text
    const prev = kept[kept.length - 1];
    // The end of a range ("9am-5pm", "2-3pm"): the start already counts.
    if (prev && /^\s*(?:-|to|until|till|through)\s*$/.test(t.slice(prev.j, x.i))) continue;
    // "after 2pm", "before 11": not a time they propose.
    if (/\b(?:after|before|until|till|til|by|past|not later than|no later than)\s*$/.test(t.slice(Math.max(0, x.i - 16), x.i))) continue;
    kept.push(x);
  }
  return kept;
}

/** The zone named right after the time ("2pm CT", "2 pm (Central)"), else anywhere ("Eastern time", "EST"), else null. */
function zoneNamed(original, t, time) {
  const after = t.slice(time.j, time.j + 30).match(/^\s*\(?\s*(eastern|central|mountain|pacific|alaska|hawaii|arizona|[ecmp][sd]?t|ak[sd]?t|h[sd]t)\b/);
  if (after) return ZONE_WORD[after[1]] || null;
  const long = t.match(/\b(eastern|central|mountain|pacific|alaska|hawaii|arizona)(?: standard| daylight)? time\b/);
  if (long) return ZONE_WORD[long[1]];
  const code = t.match(/\b(est|edt|cst|cdt|mst|mdt|pst|pdt|akst|akdt|hst)\b/) || String(original || '').match(/\b(ET|CT|MT|PT)\b/);
  return code ? ZONE_WORD[code[1].toLowerCase()] : null;
}

/**
 * The times they propose, read from their words (pure): a day (a date,
 * today/tomorrow, or a weekday = the NEXT such day in their zone) within 40
 * characters of a time of day, in the zone they name (ET/EST/EDT/Eastern …,
 * US only) or else theirs. Up to three, in the order written.
 * → [{ start: ISO, zone }]
 */
export function readTimes(text, { now = new Date(), zone = ET } = {}) {
  const t = plain(text);
  if (!t) return [];
  const days = dayMentions(t);
  const times = timeMentions(t);
  const out = [];
  const rank = { date: 0, rel: 1, weekday: 2 };
  for (const time of times) {
    const near = days
      .map((d) => ({ d, gap: d.j <= time.i ? time.i - d.j : d.i >= time.j ? d.i - time.j : 0 }))
      .filter((x) => x.gap <= 40)
      .sort((a, b) => rank[a.d.kind] - rank[b.d.kind] || a.gap - b.gap);
    if (!near.length) continue;
    const named = zoneNamed(text, t, time);
    // "MT" from someone in Arizona is Arizona time (no daylight saving there).
    const tz = named === ZONES.DEN && zone === ZONES.PHX ? ZONES.PHX : named || zone;
    const today = partsIn(tz, now).dayKey;
    const d = near[0].d;
    let key = null;
    if (d.kind === 'date') key = dayFromDate(d.y, d.m, d.d, today);
    else if (d.kind === 'rel') key = addDays(today, d.plus);
    else for (let i = 1; i <= 7 && !key; i++) { const k = addDays(today, i); if (weekdayOfKey(k) === d.wd) key = k; }
    if (!key) continue;
    const [y, m, dd] = key.split('-').map(Number);
    const start = zonedToUtc(y, m, dd, time.h, time.mi, 0, tz).toISOString();
    if (!out.some((x) => x.start === start)) out.push({ start, zone: tz });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Which rule answers (pure), in the contract's order; the first match wins.
 * ctx: { now, zone, canBook (booking page open), ownPage (the machine's own
 * booking page, not an outside link), openMeeting {status, start} | null,
 * booked, names }. → { rule: string|null, times?: [ISO], zone? }
 */
export function classify(text, ctx = {}) {
  const t = plain(text);
  if (!t) return { rule: null };
  if (isNotInterested(t)) return { rule: 'not_interested' };
  if (ctx.canBook && isReschedule(t)) return { rule: 'reschedule' };
  const times = ctx.canBook ? readTimes(text, { now: ctx.now || new Date(), zone: ctx.zone || ET }) : [];
  if (ctx.canBook && ctx.ownPage) {
    // The time already confirmed is no proposal ("see you Tuesday at 2pm").
    const fresh = times.filter((x) => !(ctx.openMeeting?.status === 'confirmed' && x.start === ctx.openMeeting.start));
    if (fresh.length) return { rule: 'proposes_time', times: fresh.map((x) => x.start), zone: fresh[0].zone };
  }
  if (ctx.canBook && !times.length && !ctx.openMeeting && !ctx.booked && isWantsTime(t)) return { rule: 'wants_time' };
  if (isPrice(t)) return { rule: 'price' };
  if (isWhatNeeded(t)) return { rule: 'what_needed' };
  if (isThanks(t, ctx.names || [])) return { rule: 'thanks' };
  return { rule: null };
}

// ─── the answers (pure) ──────────────────────────────────────────────────────

/**
 * The answer's text with its {slots} filled. A slot with nothing to say (no
 * free times) drops its paragraph; a {slot} the bot does not know → null (the
 * answer is not sent: never a half-filled email).
 */
export function fillAnswer(template, vars = {}) {
  const tpl = String(template || '').replace(/\r\n/g, '\n');
  const unknown = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !SLOTS.includes(k));
  if (unknown.length) return null;
  const empty = (k) => vars[k] === undefined || vars[k] === null || String(vars[k]).trim() === '';
  const paras = tpl.split(/\n[ \t]*\n/).filter((p) => ![...p.matchAll(/\{(\w+)\}/g)].some((m) => empty(m[1])));
  const text = paras.join('\n\n').replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** 'Tuesday 6 October at 2:00 pm' in their zone. */
export const whenLabel = (t, tz) => `${cal.longDay(ms(t), tz)} at ${cal.clockIn(ms(t), tz)}`;
/** '• Tue 6 Oct at 2:00 pm CT' lines. */
export const timesList = (starts, tz) => starts.map((s) => `• ${cal.theirShort(ms(s), tz)}`).join('\n');

/** The `n` open times nearest to `t` (either side), in time order. */
export function nearestTimes(open, t, n = 3) {
  const at = ms(t);
  return open.map((x) => ms(x.start)).sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || a - b).slice(0, n).sort((a, b) => a - b).map(iso);
}

/** The first open time on each of the next `n` open days (US Eastern days) — three days to choose from, not one morning. */
export function nextDayTimes(open, n = 3, tz = ET) {
  const out = [];
  const seen = new Set();
  for (const x of [...open].sort((a, b) => ms(a.start) - ms(b.start))) {
    const day = partsIn(tz, new Date(ms(x.start))).dayKey;
    if (seen.has(day)) continue;
    seen.add(day);
    out.push(iso(ms(x.start)));
    if (out.length === n) break;
  }
  return out;
}

// ─── who it may answer ───────────────────────────────────────────────────────

/** Why the bot cannot answer this client now (plain words), or null. The per-client switch is checked by the caller. */
export function notEligible(client, raw, s) {
  if (!s.enabled) return 'The reply bot is off for everyone (Settings › Reply bot).';
  if (!client || client.state !== 'onboarding' || !flag(raw?.sentAt)) return 'The reply bot only answers while they are onboarding (after the acceptance email).';
  return null;
}

/** For the hub's conversation: the switches, whether it can answer this client, and the US day its count is kept on. */
export async function botViewFor(client, raw, { now = io.now() } = {}) {
  const s = await replyBotSettings();
  const why = notEligible(client, raw, s);
  return { enabled: s.enabled, maxPerDay: s.maxPerDay, answersNow: !why, why, dayKey: partsIn(ET, now).dayKey };
}

/** The client's onboarding meeting that is still ahead (requested or confirmed), or null. */
async function openMeetingOf(raw, now) {
  if (!raw.meetingId) return null;
  const m = await cal.getMeeting(raw.meetingId);
  if (!m || !['requested', 'confirmed'].includes(m.status)) return null;
  const h = cal.heldInterval(m);
  return h && h.end > now.getTime() ? m : null;
}

/** Everything the rules need about this client right now. */
async function botContext(client, raw, { now, settings, convo, onboard = null }) {
  const why = notEligible(client, raw, settings) || (flag(convo.botOff) ? `You turned the reply bot off for ${firstNameOf(client?.contactName) || 'them'}.` : null);
  const o = onboard || await call.onboardSettings();
  const meeting = why ? null : await openMeetingOf(raw, now);
  const owner = String((await cfg(client.id, 'OWNER.signerName')) || '');
  return {
    why,
    now,
    canBook: !why && !flag(raw.heldAt),
    ownPage: !o.bookingUrl,
    bookingUrl: o.bookingUrl,
    openMeeting: meeting ? { id: meeting.id, status: meeting.status, start: meeting.start, proposed: meeting.proposed || null } : null,
    booked: flag(raw.bookedAt) || meeting?.status === 'confirmed',
    zone: meeting?.theirZone || raw.theirZone || (why ? ET : await cal.zoneOfClient(client.id)),
    names: [client.contactName, owner.split(/\s+/)[0]],
  };
}

// ─── a new message ───────────────────────────────────────────────────────────

async function readPending(clientId) {
  return asObject((await conv.readConvo(clientId)).botPending);
}

/** Forget the answer waiting for this client (the owner answered, turned it off, or it went). */
export async function dropPending(clientId) {
  await conv.patchConvo(clientId, { botPending: null });
  try { await kv.srem(K.replyBotPending(), clientId); } catch {}
}

/**
 * A new message from them (onboardcall.recordReply, before it is stored).
 * → { rule, alert, queued?, why? }: `rule` is stored on the entry (only when
 * the bot may answer this client); `alert` true = the owner gets
 * onboard_reply now, exactly as before the bot.
 */
export async function onInbound(client, raw, { entryId, at, text, subject = '', messageId = null, from = '', now = io.now() } = {}) {
  try {
    const s = await replyBotSettings();
    const convo = await conv.readConvo(client.id);
    const ctx = await botContext(client, raw, { now, settings: s, convo });
    if (ctx.why) return { rule: null, alert: true, why: ctx.why };
    if (isJunkReply({ from, subject, preview: text })) return { rule: null, alert: true, why: 'it looks like an automatic message' };
    const v = classify(text, ctx);
    if (!v.rule) return { rule: null, alert: true, why: 'none of its rules fits this message' };
    if (v.rule === 'thanks') return { rule: 'thanks', alert: false };
    if (now.getTime() - (ms(at) ?? now.getTime()) > MAX_AGE_MS) return { rule: v.rule, alert: true, why: 'the message is more than 3 days old' };
    if (Math.max(ms(convo.lastAnswerAt) || 0, ms(raw.lastOwnerReplyAt) || 0) >= ms(at)) return { rule: v.rule, alert: true, why: 'you answered after it was written' };
    const pending = asObject(convo.botPending);
    if (pending) {
      await dropPending(client.id);
      await logEvent(client.id, SYSTEM, 'left_to_owner', { rule: pending.rule, why: 'wrote again' });
      return { rule: v.rule, alert: true, why: 'they wrote again before it answered their last message, so both are yours' };
    }
    const waitingAt = await kv.hget(K.client(client.id), 'msgWaitingAt');
    if (conv.needsReplyFor({ msgWaitingAt: waitingAt }, raw)) return { rule: v.rule, alert: true, why: 'an earlier message of theirs still waits for your answer' };
    const after = (ms(at) ?? now.getTime()) + s.delayMinutes * 60e3;
    await conv.patchConvo(client.id, {
      botPending: JSON.stringify({
        id: entryId, at, rule: v.rule, times: v.times || [], zone: v.zone || ctx.zone, subject, messageId,
        text: String(text || '').slice(0, 600), after: iso(after), queuedAt: now.toISOString(),
      }),
    });
    await kv.sadd(K.replyBotPending(), client.id);
    await logEvent(client.id, SYSTEM, 'queued', { rule: v.rule, answerAfter: iso(after) });
    return { rule: v.rule, alert: false, queued: true };
  } catch (err) {
    // The bot failing must never lose the owner's alert.
    await logEvent(client.id, SYSTEM, 'inbound_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    return { rule: null, alert: true, why: 'the reply bot hit an error' };
  }
}

// ─── answering ───────────────────────────────────────────────────────────────

/** Owner alert that never throws. */
async function alert(key, opts) {
  try { return await io.alertOwner(key, opts); } catch (err) { console.error('[replybot] alert failed', key, err?.message); return { sent: false }; }
}

const who = (client) => `${firstNameOf(client.contactName) || client.contactName || client.contactEmail || client.id}${client.name ? ` (${client.name})` : ''}`;

/** The answer waiting cannot go: the message is the owner's again — onboard_reply, as without the bot. */
async function handOver(client, p, why, now) {
  await dropPending(client.id);
  await logEvent(client.id, SYSTEM, 'left_to_owner', { rule: p.rule, why });
  await alert('onboard_reply', {
    clientId: client.id,
    scope: `${client.id}:${p.id}`,
    vars: { person: client.contactName || client.contactEmail || client.id },
    body: `${client.contactName || client.contactEmail} (${client.contactEmail}) from ${client.name || client.id} wrote:\n\n“${String(p.text || '').slice(0, 1500)}”\n\nThe reply bot left this one to you: ${why}`,
    did: 'It is in the conversation on their trial in the hub. Answer them there — it goes from the same inbox, in the same thread.',
    url: `/#trial/${client.id}`,
  });
  return 'handedOver';
}

/** The calendar's open times for this client now (their own request or booking set aside, as the booking page does). */
async function freeTimesFor(raw, now) {
  const cs = await cal.calendarSettings();
  const { from, to } = cal.bookingWindow(cs, now);
  const meetings = await cal.meetingsBetween(from - DAY_MS, to + DAY_MS);
  const current = raw.meetingId ? await cal.getMeeting(raw.meetingId) : null;
  const active = current && ['requested', 'confirmed'].includes(current.status) ? current : null;
  return { cs, active, open: cal.openSlots({ settings: cs, meetings, now, from, to, exceptId: active?.id || null }) };
}

async function bookingLinkFor(clientId, onboard, p) {
  return onboard.bookingUrl || cal.bookingLink(clientId, `bot-${shortHash(p.id, 8)}`);
}

/**
 * proposes_time: the first time they wrote that is free by the calendar rules
 * (or the time the owner suggested) → a meeting request at it (source
 * reply_bot; no separate "got it" — this answer is it) → "works on my side".
 * Their yes to the owner's suggestion confirms it right away (the calendar
 * sends the confirmation with the invite; the bot adds nothing). Nothing free
 * → the three nearest free times + the booking page.
 */
async function proposeAnswer(client, raw, p, base, s, onboard, now) {
  const tz = p.zone || ET;
  let { cs, active, open } = await freeTimesFor(raw, now);
  const pick = (p.times || []).find((t) => (active?.status === 'requested' && active.proposed === t) || open.some((x) => x.start === t));
  if (pick) {
    try {
      const note = `By email: “${String(p.text || '').replace(/\s+/g, ' ').slice(0, 200)}”`;
      const m = await cal.requestMeeting(client.id, { start: pick, zone: cal.pickZone(tz), note }, { now, source: 'reply_bot', gotIt: false });
      if (m.status === 'confirmed') return { calendar: true, did: `they said yes by email to ${cal.usAndOwner(ms(pick), cs)} — confirmed it and sent the calendar invite` };
      return { text: fillAnswer(s.answers.proposes_time_ok, { ...base, when: whenLabel(pick, tz) }), did: `their time ${cal.usAndOwner(ms(pick), cs)} is free — asked for it in the Calendar; say yes there`, calendarAsk: true };
    } catch (err) {
      if (!(err instanceof cal.CalendarError) || err.status !== 409) throw err;
      ({ cs, active, open } = await freeTimesFor(raw, now)); // just taken: offer what is left
    }
  }
  const asked = (p.times || [])[0];
  const near = nearestTimes(open, asked, 3);
  const text = fillAnswer(s.answers.proposes_time_busy, { ...base, when: whenLabel(asked, tz), times: timesList(near, tz), bookingLink: await bookingLinkFor(client.id, onboard, p) });
  return { text, did: `${cal.usAndOwner(ms(asked), cs)} isn't free — sent the ${near.length === 1 ? 'nearest free time' : `${near.length} nearest free times`} and the booking link` };
}

/** The answer for one rule → { text } (an email), { calendar } (the calendar answered), or { handOver: why }. */
async function answerFor(client, raw, p, s, onboard, now) {
  const base = { firstName: firstNameOf(client.contactName) || 'there', ownerName: await ownerName(client.id), callMinutes: onboard.callMinutes };
  const tz = p.zone || ET;
  switch (p.rule) {
    case 'not_interested':
      return { text: fillAnswer(s.answers.not_interested, base), did: "said they're not interested — sent a polite close and stopped the reminders", stop: true };
    case 'reschedule':
      return { text: fillAnswer(s.answers.reschedule, { ...base, bookingLink: await bookingLinkFor(client.id, onboard, p) }), did: 'sent the booking link to pick another time' };
    case 'proposes_time':
      return proposeAnswer(client, raw, p, base, s, onboard, now);
    case 'wants_time': {
      const times = onboard.bookingUrl ? [] : nextDayTimes((await freeTimesFor(raw, now)).open, 3);
      return { text: fillAnswer(s.answers.wants_time, { ...base, bookingLink: await bookingLinkFor(client.id, onboard, p), times: timesList(times, tz) }), did: times.length ? 'sent the booking link and the next open times' : 'sent the booking link' };
    }
    case 'price':
      return { text: fillAnswer(s.answers.price, base), did: 'answered the price question: the trial is free, no card, an honest review' };
    case 'what_needed': {
      const token = await mintToken(client.id, `onboarding:bot${shortHash(p.id, 8)}`, { ttl: TTL.long });
      const onboardingLink = pageUrl(token, 'onboard');
      await rememberLink(client.id, 'onboarding', onboardingLink, { now });
      return { text: fillAnswer(s.answers.what_needed, { ...base, onboardingLink }), did: 'sent what the call covers and the onboarding page link' };
    }
    default:
      return { handOver: 'none of its rules fits this message' };
  }
}

/** One client's waiting answer: wait, drop, hand over, or send. → 'sent' | 'waiting' | 'dropped' | 'handedOver' */
async function answerPending(clientId, s, onboard, now) {
  const convo = await conv.readConvo(clientId);
  const p = asObject(convo.botPending);
  if (!p) { await kv.srem(K.replyBotPending(), clientId); return 'dropped'; }
  const client = await getClient(clientId);
  if (!client) { await dropPending(clientId); return 'dropped'; }
  const raw = await call.readCall(clientId);
  // The owner answered after their message: he has it.
  if (Math.max(ms(convo.lastAnswerAt) || 0, ms(raw.lastOwnerReplyAt) || 0) >= ms(p.at)) {
    await dropPending(clientId);
    await logEvent(clientId, SYSTEM, 'skipped', { rule: p.rule, why: 'owner answered' });
    return 'dropped';
  }
  const ctx = await botContext(client, raw, { now, settings: s, convo, onboard });
  if (ctx.why) return handOver(client, p, ctx.why, now);
  if (BOOKING_RULES.has(p.rule) && !ctx.canBook) return handOver(client, p, 'the call is done, so the booking page is closed', now);
  if (now.getTime() < (ms(p.after) ?? 0)) return 'waiting';
  if (s.hours === 'us' && !call.inUsBusinessHours(now, onboard.usHours)) return 'waiting';
  const day = partsIn(ET, now).dayKey;
  const count = convo.botDay === day ? Number(convo.botCount) || 0 : 0;
  if (count >= s.maxPerDay) return handOver(client, p, `it already sent ${count} email${count === 1 ? '' : 's'} to them today, the most it sends a client in a day (REPLYBOT.maxPerDay)`, now);
  const a = await answerFor(client, raw, p, s, onboard, now);
  if (a.handOver) return handOver(client, p, a.handOver, now);
  if (!a.calendar && !a.text) return handOver(client, p, `its ${p.rule} answer has a {slot} it cannot fill — check REPLYBOT.answers`, now);
  const at = now.toISOString();
  let messageId = null;
  let text = null;
  if (a.text) {
    const threadSubject = conv.stripRe(p.subject) || conv.stripRe(raw.subject) || "You're in — let's book your onboarding call";
    const res = await sendClient(clientId, 'bot_reply', { threadSubject, text: a.text }, { dedupe: `bot_reply:${p.id}`, thread: false, linkify: true, ...call.threadHeaders(raw) });
    messageId = res.messageId || null;
    text = res.text || a.text;
    if (!res.deduped) {
      await conv.pushEntry(clientId, {
        id: `out-${shortHash(messageId || `${at}|bot|${p.id}`)}`, dir: 'out', at, from: res.from || raw.fromInbox || null, to: lower(client.contactEmail),
        subject: res.subject || `Re: ${threadSubject}`, text, kind: 'auto_reply', auto: true, rule: p.rule,
      });
    }
    if (a.stop) await call.stopReminders(clientId, { now }).catch(() => {});
  }
  await call.markAnswered(clientId, at, messageId, { bot: true });
  await conv.noteAnswered(clientId, at, { messageId });
  await conv.patchConvo(clientId, { botPending: null, botDay: day, botCount: count + 1 });
  await kv.srem(K.replyBotPending(), clientId);
  await logEvent(clientId, SYSTEM, 'answered', { rule: p.rule, email: Boolean(a.text), messageId });
  await alert('bot_replied', {
    clientId,
    scope: `${clientId}:bot:${p.id}`,
    vars: { who: who(client), did: a.did },
    body: `Auto-replied to ${who(client)} <${client.contactEmail}>: ${a.did}.\n\nThey wrote:\n“${String(p.text || '').slice(0, 1200)}”${text ? `\n\nThe reply:\n“${text.slice(0, 1500)}”` : ''}`,
    did: a.stop
      ? 'Stopped the reminders to book. If you want to close their application, do it from their trial in the hub.'
      : 'Nothing for you unless you want to add something — the conversation is on their trial in the hub, where you can also turn the bot off for them.',
    url: a.calendarAsk ? '/#calendar' : `/#trial/${clientId}`,
  });
  return 'sent';
}

/**
 * Send the answers that are due (end of every onboarding check). One client
 * failing never stops the others; a failed send leaves the message to the
 * owner (onboard_reply), never a retry loop.
 * → { sent, waiting, dropped, handedOver }
 */
export async function runReplyBot({ now = io.now() } = {}) {
  const out = { sent: 0, waiting: 0, dropped: 0, handedOver: 0 };
  let ids = [];
  try { ids = (await kv.smembers(K.replyBotPending())) || []; } catch { return out; }
  if (!ids.length) return out;
  const s = await replyBotSettings();
  const onboard = await call.onboardSettings();
  for (const id of ids) {
    try {
      out[await answerPending(id, s, onboard, now)]++;
    } catch (err) {
      await logEvent(id, SYSTEM, 'answer_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
      const client = await getClient(id).catch(() => null);
      const p = await readPending(id).catch(() => null);
      if (client && p) { await handOver(client, p, `it could not send its answer (${String(err?.message || err).slice(0, 120)})`, now); out.handedOver++; }
      else await dropPending(id).catch(() => {});
    }
  }
  return out;
}
