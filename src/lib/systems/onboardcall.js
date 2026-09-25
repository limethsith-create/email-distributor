/**
 * Onboarding call (docs/ONBOARD-CALL.md) — the owner's words: "When we say yes
 * to a customer an email goes to them: we accept your business, book your
 * onboarding call. There should be a reply system and a tracking system for
 * getting the onboarding call on time."
 *
 *  - sendAcceptance: ONE email (`accepted_call`) from ONE inbox
 *    (ONBOARDCALL.inbox, else the owner sender) with the booking link and the
 *    one-page onboarding link, one open pixel, and its Message-ID kept so the
 *    replies thread. Called by gatekeeper.startOnboarding (Approve, New
 *    client, queue promotion) and by the owner's "resend".
 *  - checkOnboardCalls: reads that inbox (a reply from the applicant, or to one
 *    of our Message-IDs → the conversation + `onboard_reply`; a calendar
 *    invite or booking-tool email naming the applicant's address → booked +
 *    `onboard_booked`), sends the reminders that are due (US business hours
 *    only; never after booked, stopped or a reply), and raises
 *    `onboard_overdue` once. It runs after Approve, when the hub opens the
 *    Trials screen and as the `onboard-calls` job — one throttle for all three.
 *  - the owner's buttons in the hub: reply (threaded, same inbox), markBooked,
 *    markHeld, markNoShow, resend, stopReminders.
 *  - onboardCallView: the hub's `onboardCall` object, a pure function of the
 *    stored times. The status is never stored, so it cannot drift.
 *  - the Calendar (docs/CALENDAR.md, systems/calendar.js): the booking line
 *    links the machine's own booking page; syncCallFromMeeting takes the
 *    calendar's answer (asked for / confirmed / held / no-show / declined /
 *    cancelled), the card's buttons and inbox bookings go the other way
 *    (toCalendar), sendCallEmail threads the calendar's emails, and
 *    onboardPageClock sets the onboarding page's reminders and Day +7 close.
 *
 * No AI: replies are known by their address and Message-ID, bookings by .ics
 * attendees or the applicant's address in a booking-tool email.
 *
 * Storage: client:{id}:onboardcall (hash of times), client:{id}:onboardthread
 * (list), and two flags on the client hash the tick already reads —
 * onboardCallSentAt (the board reads the hash only when it is set) and
 * onboardCallOpen ('1' while the inbox is watched for this applicant).
 *
 * Messages + reply bot (docs/REPLYBOT-MEET.md §1–2): the thread is the
 * client's ONE conversation (systems/conversation.js). The check also reads
 * the inbox for every other client (`talksWith`), so their messages during
 * the trial land in it too, and each new message goes past the reply bot
 * (systems/replybot.js) before the owner is alerted.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { DEFAULTS, globalOverrides, cfg } from '@/lib/config';
import { getClient, getAllClients, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { onboardPixelUrl } from '@/lib/tokens';
import { onboardSender } from '@/lib/notify';
import { renderTemplate } from '@/lib/templates/client';
import { mintToken, pageUrl, TTL } from '@/lib/pagetokens';
import { normId, stripQuotedReply, snippet } from '@/lib/mail-utils';
import { parseIcs, parseBodyDate } from '@/lib/systems/bookings';
import { configList, lower, shortHash, zonedToUtc, formatWhen, isBusinessDayKey } from '@/lib/systems/stagec-common';
import { io, sendClient, firstNameOf, ownerName, isPublicUrl, asArray, asObject } from '@/lib/systems/intake-io';
import { partsIn, addDays, hhmmToMin, ET, OWNER_TZ } from '@/lib/time';
import * as conv from '@/lib/systems/conversation';

const SYSTEM = 'onboardcall';
/** Client states in which the inbox is still watched for this applicant. */
export const WATCH_STATES = new Set(['onboarding', 'awaiting_purchase', 'setup_check']);
/**
 * Clients whose mail in the ONBOARDCALL inbox goes into their conversation
 * (docs/REPLYBOT-MEET.md §1): any state but deleted, with a contact address.
 */
export const talksWith = (c) => Boolean(c && c.id !== 'aviance' && c.state !== 'deleted' && c.contactEmail);
const TEXT_MAX = conv.TEXT_MAX;
const REPLY_MAX = 2000;
const EMAIL_RE = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi;
/** The acceptance email's subject (templates/client/stage-a.js accepted_call): follow-ups answer it. */
const FIRST_SUBJECT = "You're in — let's book your onboarding call";

/** A mistake in what the owner asked for (the route answers 400 with the message). */
export class OnboardCallError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ─── settings ────────────────────────────────────────────────────────────────

/**
 * ONBOARDCALL in one Redis read (it is one machine-wide block). A leaf
 * override (/mc/config writes the block and every leaf) wins over a
 * whole-block one. Also carries OWNER.usHours: the US hours reminders keep to.
 */
export async function onboardSettings() {
  let o = {};
  try { o = await globalOverrides(); } catch {}
  const whole = o.ONBOARDCALL && typeof o.ONBOARDCALL === 'object' ? o.ONBOARDCALL : {};
  const pick = (k) => (o[`ONBOARDCALL.${k}`] !== undefined ? o[`ONBOARDCALL.${k}`] : whole[k] !== undefined ? whole[k] : DEFAULTS.ONBOARDCALL[k]);
  const s = Object.fromEntries(Object.keys(DEFAULTS.ONBOARDCALL).map((k) => [k, pick(k)]));
  s.usHours = o['OWNER.usHours'] || o.OWNER?.usHours || DEFAULTS.OWNER.usHours;
  return normaliseSettings(s);
}

/** Settings → safe values (a bad booking link counts as none: the email then asks for times). */
export function normaliseSettings(s = {}) {
  const d = DEFAULTS.ONBOARDCALL;
  const pos = (v, def) => (Number(v) > 0 ? Number(v) : def);
  const url = String(s.bookingUrl || '').trim();
  const hours = Array.isArray(s.usHours) && s.usHours.length === 2 ? s.usHours.map(String) : DEFAULTS.OWNER.usHours;
  return {
    inbox: String(s.inbox || '').trim().toLowerCase() || null,
    bookingUrl: url && isPublicUrl(url) ? url : null,
    callMinutes: pos(s.callMinutes, d.callMinutes),
    bookWithinDays: pos(s.bookWithinDays, d.bookWithinDays),
    reminderHours: (Array.isArray(s.reminderHours) ? s.reminderHours : d.reminderHours).map(Number).filter((h) => h > 0).sort((a, b) => a - b),
    dayBeforeReminder: s.dayBeforeReminder !== false && s.dayBeforeReminder !== 'false',
    checkEveryMinutes: pos(s.checkEveryMinutes, d.checkEveryMinutes),
    usHours: hours,
  };
}

/**
 * The one line that tells them how to book: the owner's own booking link when
 * ONBOARDCALL.bookingUrl is set, else the machine's booking page
 * (docs/CALENDAR.md), else — only when that page could not be made — "reply
 * with two or three times".
 */
export function bookingLine(s, pageLink = null) {
  const link = s.bookingUrl || pageLink;
  return link
    ? `Book a time that suits you: ${link}`
    : "Reply with two or three times that suit you and I'll confirm one.";
}

/** A fresh link to the machine's booking page for this email, or null when it cannot be made (never throws). */
async function ownBookingLink(clientId, s, tag) {
  if (s.bookingUrl) return null;
  try {
    const { bookingLink } = await import('@/lib/systems/calendar');
    return await bookingLink(clientId, tag);
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'booking_page_link_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    return null;
  }
}

// ─── time ────────────────────────────────────────────────────────────────────

const ms = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const isoOrNull = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const atHhmm = (dayKey, hhmm, tz = ET) => {
  const [y, m, d] = dayKey.split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  return zonedToUtc(y, m, d, h || 0, mi || 0, 0, tz);
};

/** Inside the owner's US hours (OWNER.usHours, US Eastern) on a US business day? */
export function inUsBusinessHours(date, hours = DEFAULTS.OWNER.usHours) {
  const p = partsIn(ET, date);
  return isBusinessDayKey(p.dayKey) && p.minuteOfDay >= hhmmToMin(hours[0]) && p.minuteOfDay < hhmmToMin(hours[1]);
}

/** The first moment at or after `date` inside US business hours. */
export function nextBusinessMoment(date, hours = DEFAULTS.OWNER.usHours) {
  if (inUsBusinessHours(date, hours)) return date;
  const p = partsIn(ET, date);
  let day = p.dayKey;
  if (!(isBusinessDayKey(day) && p.minuteOfDay < hhmmToMin(hours[0]))) day = addDays(day, 1);
  for (let i = 0; i < 14 && !isBusinessDayKey(day); i++) day = addDays(day, 1);
  return atHhmm(day, hours[0]);
}

/** `days` US business days after `sentAt`, same Eastern clock time (Mon 11:00 + 3 → Thu 11:00). */
export function dueByFrom(sentAt, days) {
  const p = partsIn(ET, sentAt);
  let day = p.dayKey;
  let n = 0;
  for (let i = 0; i < 90 && n < days; i++) { day = addDays(day, 1); if (isBusinessDayKey(day)) n++; }
  return atHhmm(day, p.hhmm);
}

/** The day-before reminder may go from the start of US hours on the last business day before the call's day. */
export function dayBeforeOpensAt(bookedFor, hours = DEFAULTS.OWNER.usHours) {
  let day = partsIn(ET, new Date(bookedFor)).dayKey;
  for (let i = 0; i < 14; i++) { day = addDays(day, -1); if (isBusinessDayKey(day)) break; }
  return atHhmm(day, hours[0]);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Tue 29 Sep, 7:30 pm' in the owner's own time zone (the hub is read by him). */
export function ownerWhen(v) {
  const t = ms(v);
  if (t == null) return null;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const time = p.minute === '00' ? `${p.hour} ${p.dayPeriod}` : `${p.hour}:${p.minute} ${p.dayPeriod}`;
  return `${p.weekday} ${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${time.toLowerCase()}`;
}

/** 'later today' / 'tomorrow' / 'on Tue 29 Sep' — relative to the owner's day. */
export function ownerDayWord(v, now) {
  const t = ms(v);
  if (t == null) return null;
  const day = partsIn(OWNER_TZ, new Date(t)).dayKey;
  const today = partsIn(OWNER_TZ, now).dayKey;
  if (day <= today) return 'later today';
  if (day === addDays(today, 1)) return 'tomorrow';
  return `on ${ownerWhen(t).split(',')[0]}`;
}

/** 'tomorrow' / 'today' / 'on Monday' — the call's day for the applicant (their zone, else US Eastern). */
export function callDayWord(bookedFor, now, tz = ET) {
  const day = partsIn(tz, new Date(bookedFor)).dayKey;
  const today = partsIn(tz, now).dayKey;
  if (day === today) return 'today';
  if (day === addDays(today, 1)) return 'tomorrow';
  return `on ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(bookedFor))}`;
}

// ─── status (pure) ───────────────────────────────────────────────────────────

const flag = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0';

/** A time they asked for on the booking page that still waits for the owner's answer (docs/CALENDAR.md). */
export const requestPending = (raw) => flag(raw.requestedAt) && flag(raw.requestedFor) && !flag(raw.bookedAt) && !flag(raw.heldAt);

/**
 * Overdue: still onboarding, past dueBy, and no booking, call, no-show or
 * stop — and no time they asked for waiting on the owner (they did their part).
 */
export function isOverdue(raw, now, clientState = 'onboarding') {
  const due = ms(raw.dueBy);
  return clientState === 'onboarding' && due != null && now.getTime() > due
    && !flag(raw.bookedAt) && !flag(raw.heldAt) && !flag(raw.noShowAt) && !flag(raw.stoppedAt) && !requestPending(raw);
}

/** One current state, worked out from the times: held > no_show > booked > stopped > overdue > replied > opened > sent. */
export function statusOf(raw, { now = new Date(), clientState = 'onboarding' } = {}) {
  if (flag(raw.heldAt)) return 'held';
  if (flag(raw.noShowAt)) return 'no_show';
  if (flag(raw.bookedAt)) return 'booked';
  if (flag(raw.stoppedAt)) return 'stopped';
  if (isOverdue(raw, now, clientState)) return 'overdue';
  if (flag(raw.lastReplyAt)) return 'replied';
  if (flag(raw.openedAt)) return 'opened';
  return 'sent';
}

/**
 * Their last word came after the owner's last word, the reply bot's last
 * answer (or a thank-you it read as needing none: lastAnsweredAt) and any
 * booking → the owner owes an answer.
 */
export function needsReply(raw) {
  const last = ms(raw.lastReplyAt);
  if (last == null || flag(raw.heldAt) || flag(raw.noShowAt)) return false;
  return last > Math.max(ms(raw.lastOwnerReplyAt) || 0, ms(raw.bookedAt) || 0, ms(raw.lastAnsweredAt) || 0);
}

/**
 * Reminders stop for good once they book, reply, ask for a time on the
 * booking page, or the owner stops them (or the call happened / was missed).
 */
const remindersOver = (raw, clientState) => clientState !== 'onboarding'
  || flag(raw.bookedAt) || flag(raw.stoppedAt) || flag(raw.lastReplyAt) || flag(raw.heldAt) || flag(raw.noShowAt) || flag(raw.firstRequestAt);

/**
 * Two emails to them are never closer than the first reminder's wait
 * (reminderHours[0]): a 24 h reminder pushed past a weekend cannot land an
 * hour before the 72 h one.
 */
const earliestNext = (raw, s) => {
  const last = Math.max(ms(raw.lastSentAt || raw.sentAt) || 0, ms(raw.lastReminderAt) || 0);
  return last + (s.reminderHours[0] || 0) * 3600e3;
};

/** Which reminder (0-based) is due at `now`, or null. The latest one due wins; earlier ones are then skipped, never sent late. */
export function dueReminder(raw, s, now, clientState = 'onboarding') {
  if (remindersOver(raw, clientState)) return null;
  const base = ms(raw.lastSentAt || raw.sentAt);
  if (base == null || now.getTime() < earliestNext(raw, s)) return null;
  const done = Number(raw.remindersSent) || 0;
  let idx = null;
  s.reminderHours.forEach((h, i) => { if (now.getTime() >= base + h * 3600e3) idx = i; });
  return idx == null || idx < done ? null : idx;
}

/** When the next reminder will go (moved into US hours), or null when none is left. */
export function nextReminderAt(raw, s, clientState = 'onboarding') {
  if (remindersOver(raw, clientState)) return null;
  const base = ms(raw.lastSentAt || raw.sentAt);
  const h = s.reminderHours[Number(raw.remindersSent) || 0];
  if (base == null || h == null) return null;
  return nextBusinessMoment(new Date(Math.max(base + h * 3600e3, earliestNext(raw, s))), s.usHours).toISOString();
}

/** Is the day-before reminder due (the caller also checks US hours)? */
export function dayBeforeDue(raw, s, now) {
  if (!s.dayBeforeReminder || !flag(raw.bookedAt) || !flag(raw.bookedFor) || flag(raw.heldAt) || flag(raw.noShowAt)) return false;
  if (raw.tomorrowSentFor === raw.bookedFor) return false;
  const at = ms(raw.bookedFor);
  const bookedAt = ms(raw.bookedAt);
  // Booked less than a day ahead: the booking confirmation is the reminder.
  if (bookedAt != null && at - bookedAt < 24 * 3600e3) return false;
  // Never in the last two hours before the call.
  return now.getTime() >= dayBeforeOpensAt(at, s.usHours).getTime() && now.getTime() < at - 2 * 3600e3;
}

const callPassed = (raw, s, now) => flag(raw.bookedFor) && now.getTime() > ms(raw.bookedFor) + s.callMinutes * 60e3;

function labelFor(status, raw, s, now) {
  // A time from the booking page waiting on the owner comes first (docs/CALENDAR.md).
  if (status !== 'held' && status !== 'booked' && requestPending(raw)) {
    return flag(raw.proposedFor)
      ? `You suggested ${ownerWhen(raw.proposedFor)} (your time) — waiting for them`
      : `They asked for ${ownerWhen(raw.requestedFor)} (your time) — say yes in the Calendar`;
  }
  switch (status) {
    case 'held': return 'Call done';
    case 'no_show': return "They didn't show for the call";
    case 'booked':
      if (!flag(raw.bookedFor)) return 'Call booked — the time was not in the confirmation, check your calendar';
      return callPassed(raw, s, now) ? `Call was ${ownerWhen(raw.bookedFor)} (your time) — mark it done or no-show` : `Call booked for ${ownerWhen(raw.bookedFor)} (your time)`;
    case 'stopped': return 'Reminders stopped — nothing more is sent to them';
    case 'overdue': return `Not booked yet — it should have been booked by ${ownerWhen(raw.dueBy)} (your time)`;
    case 'replied': return needsReply(raw) ? 'They replied — answer them below' : 'You answered — waiting for them to book';
    case 'opened': return 'They opened the email — waiting for them to book';
    default: return 'Email sent — waiting for them to book';
  }
}

/** One entry of the conversation as the hub gets it (systems/conversation.js; + auto / rule / template). */
const threadEntry = conv.entryView;

/**
 * The hub's `onboardCall` (docs/ONBOARD-CALL.md §5), or null when no
 * acceptance email was sent. Pure: stored times + settings + now.
 */
export function onboardCallView(raw, thread = [], { now = new Date(), settings, clientState = 'onboarding' } = {}) {
  if (!raw || !flag(raw.sentAt)) return null;
  const s = settings || normaliseSettings();
  const status = statusOf(raw, { now, clientState });
  const firstReplyAt = isoOrNull(raw.firstReplyAt || raw.lastReplyAt);
  const booked = flag(raw.bookedAt) || flag(raw.heldAt);
  return {
    status,
    label: labelFor(status, raw, s, now),
    sentAt: isoOrNull(raw.sentAt),
    openedAt: isoOrNull(raw.openedAt),
    lastReplyAt: isoOrNull(raw.lastReplyAt),
    bookedFor: isoOrNull(raw.bookedFor),
    bookedAt: isoOrNull(raw.bookedAt),
    bookedBy: flag(raw.bookedAt) ? (raw.bookedBy || null) : null,
    heldAt: isoOrNull(raw.heldAt),
    dueBy: isoOrNull(raw.dueBy),
    overdue: status === 'overdue',
    remindersSent: Number(raw.remindersSent) || 0,
    nextReminderAt: nextReminderAt(raw, s, clientState),
    stopped: flag(raw.stoppedAt),
    bookingUrl: s.bookingUrl,
    fromInbox: raw.fromInbox || null,
    // Additions (not in the first contract draft): the other times the hub may show.
    noShowAt: isoOrNull(raw.noShowAt),
    stoppedAt: isoOrNull(raw.stoppedAt),
    lastOwnerReplyAt: isoOrNull(raw.lastOwnerReplyAt),
    needsReply: needsReply(raw),
    callMinutes: s.callMinutes,
    // The Calendar (docs/CALENDAR.md): a time they asked for on the booking page, the owner's suggestion, the meeting.
    requestedFor: requestPending(raw) ? isoOrNull(raw.requestedFor) : null,
    requestedAt: requestPending(raw) ? isoOrNull(raw.requestedAt) : null,
    proposedFor: requestPending(raw) ? isoOrNull(raw.proposedFor) : null,
    meetingId: raw.meetingId || null,
    steps: [
      { key: 'sent', label: 'Acceptance email sent', done: true, at: isoOrNull(raw.sentAt) },
      // A reply or a booking means they read it, even when the pixel was blocked.
      { key: 'opened', label: 'They opened it', done: flag(raw.openedAt) || Boolean(firstReplyAt) || booked, at: isoOrNull(raw.openedAt) },
      { key: 'replied', label: 'They replied', done: Boolean(firstReplyAt), at: firstReplyAt },
      { key: 'booked', label: 'Call booked', done: booked, at: isoOrNull(raw.bookedAt) },
      { key: 'held', label: 'Call done', done: flag(raw.heldAt), at: isoOrNull(raw.heldAt) },
    ],
    thread: (thread || []).map(threadEntry).filter(Boolean),
  };
}

// ─── storage ─────────────────────────────────────────────────────────────────

export async function readCall(clientId) {
  return (await kv.hgetall(K.onboardCall(clientId))) || {};
}

/** The client's one conversation (systems/conversation.js — this list, the key kept). */
export async function readThread(clientId) {
  return conv.readThread(clientId);
}

/** hset the values, hdel the nulls. */
async function patch(clientId, fields) {
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
  const del = Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k);
  if (Object.keys(set).length) await kv.hset(K.onboardCall(clientId), set);
  if (del.length) await kv.hdel(K.onboardCall(clientId), ...del);
}

const pushThread = conv.pushEntry;

/** '<Id@host>' as sent — Message-IDs keep their case in headers; only comparisons use normId. */
const bracket = conv.bracket;
/** Every Message-ID in the conversation, oldest first (last 30), one copy each. */
const withId = (raw, id) => conv.withId(raw.messageIds, id);

/** In-Reply-To = their last message, else our last one; References = the whole conversation. */
export function threadHeaders(raw) {
  const ids = asArray(raw.messageIds).map(bracket);
  const inReplyTo = raw.lastInMessageId ? bracket(raw.lastInMessageId) : ids[ids.length - 1] || null;
  return inReplyTo ? { inReplyTo, references: ids.length ? ids : [inReplyTo] } : {};
}

const person = (client) => client.contactName || client.contactEmail || client.name || client.id;

/** Owner alert that never throws (an alert failing must not stop the check). */
async function alert(key, opts) {
  try { return await io.alertOwner(key, opts); } catch (err) { console.error('[onboardcall] alert failed', key, err?.message); return { sent: false }; }
}

/** The rendered subject + text for the conversation (from the send result, else rendered again). */
function sentCopy(res, key, vars, client) {
  if (res && res.subject && res.text) return { subject: res.subject, text: res.text };
  try { return renderTemplate(key, { clientName: client.name, contactName: client.contactName, ...vars }); } catch { return { subject: '', text: '' }; }
}

async function fromInboxOf(res) {
  if (res && res.from) return res.from;
  try { return (await onboardSender())?.email || null; } catch { return null; }
}

// ─── the acceptance email ────────────────────────────────────────────────────

/**
 * Send `accepted_call` (email first, records second: a failed send throws
 * and nothing is marked sent). A second call without `resend` does nothing,
 * so a retried Approve can never send it twice. `resend` sends it again in
 * the same thread and restarts the reminder and booking clock from now.
 */
export async function sendAcceptance(clientId, { onboardingLink, now = io.now(), resend = false } = {}) {
  assertClientId(clientId);
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  if (!client.contactEmail) throw new Error(`no contact email for ${clientId}`);
  const raw = await readCall(clientId);
  if (flag(raw.sentAt) && !resend) return { already: true };
  if (!onboardingLink) throw new Error('the onboarding link is missing');
  const s = await onboardSettings();
  const n = (Number(raw.sends) || 0) + 1;
  const vars = {
    firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId),
    companyName: client.name || client.mainDomain || clientId, callMinutes: s.callMinutes,
    bookingLine: bookingLine(s, await ownBookingLink(clientId, s, `a${n}`)), onboardingLink,
  };
  const res = await sendClient(clientId, 'accepted_call', vars, {
    dedupe: n === 1 ? 'accepted_call' : `accepted_call:${n}`,
    thread: false, // its own entry below (kind 'acceptance')
    pixelUrl: onboardPixelUrl(client.contactEmail, clientId, now.getTime()),
    linkify: true,
    ...(flag(raw.sentAt) ? threadHeaders(raw) : {}),
  });
  const at = now.toISOString();
  const copy = sentCopy(res, 'accepted_call', vars, client);
  const fromInbox = await fromInboxOf(res);
  await patch(clientId, {
    ...(flag(raw.sentAt) ? {} : { sentAt: at, subject: copy.subject }),
    lastSentAt: at,
    sends: n,
    fromInbox,
    contactEmail: lower(client.contactEmail),
    messageIds: JSON.stringify(withId(raw, res.messageId)),
    dueBy: dueByFrom(now, s.bookWithinDays).toISOString(),
    remindersSent: 0,
    overdueAt: null,
  });
  await pushThread(clientId, { id: `out-${shortHash(res.messageId || `${at}|acceptance`)}`, dir: 'out', at, from: fromInbox, to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'acceptance' });
  await updateClient(clientId, { ...(client.onboardCallSentAt ? {} : { onboardCallSentAt: at }), onboardCallOpen: '1' });
  await logEvent(clientId, SYSTEM, resend ? 'acceptance_resent' : 'acceptance_sent', { messageId: res.messageId || null, from: fromInbox, deduped: Boolean(res.deduped) || undefined });
  return { sent: true, messageId: res.messageId || null, from: fromInbox };
}

// ─── reminders + overdue ─────────────────────────────────────────────────────

async function sendReminder(client, raw, s, idx, now) {
  const id = client.id;
  const vars = { firstName: firstNameOf(client.contactName), ownerName: await ownerName(id), callMinutes: s.callMinutes, bookingLine: bookingLine(s, await ownBookingLink(id, s, `r${Number(raw.sends) || 1}-${idx}`)), threadSubject: raw.subject || FIRST_SUBJECT };
  const res = await sendClient(id, 'accepted_call_reminder', vars, {
    dedupe: `accepted_call_reminder:${Number(raw.sends) || 1}:${idx}`,
    thread: false,
    pixelUrl: onboardPixelUrl(client.contactEmail, id, now.getTime()),
    linkify: true,
    ...threadHeaders(raw),
  });
  const at = now.toISOString();
  await patch(id, { remindersSent: idx + 1, lastReminderAt: at, ...(res.messageId ? { messageIds: JSON.stringify(withId(raw, res.messageId)) } : {}) });
  if (!res.deduped) {
    const copy = sentCopy(res, 'accepted_call_reminder', vars, client);
    await pushThread(id, { id: `out-${shortHash(res.messageId || `${at}|reminder${idx}`)}`, dir: 'out', at, from: await fromInboxOf(res), to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'reminder' });
  }
  await logEvent(id, SYSTEM, 'reminder_sent', { reminder: idx + 1, deduped: Boolean(res.deduped) || undefined });
  return !res.deduped;
}

async function sendDayBefore(client, raw, s, now) {
  const id = client.id;
  // Their own zone when the Calendar knows it (the state they applied from), else US Eastern.
  const tz = raw.theirZone || ET;
  // The Google Meet link (or the owner's own link) goes in the reminder too.
  let link = null;
  try {
    if (raw.meetingId) { const { getMeeting } = await import('@/lib/systems/calendar'); link = (await getMeeting(raw.meetingId))?.meetLink || null; }
    link = link || (await cfg(id, 'CALENDAR.meetingLink')) || null;
  } catch { link = null; }
  const vars = { firstName: firstNameOf(client.contactName), ownerName: await ownerName(id), callMinutes: s.callMinutes, when: formatWhen(raw.bookedFor, tz), callDay: callDayWord(raw.bookedFor, now, tz), joinLine: link ? `Join here: ${link}` : "I'll send the video link before the call." };
  const res = await sendClient(id, 'onboard_call_tomorrow', vars, { dedupe: `onboard_call_tomorrow:${raw.bookedFor}`, thread: false, ...threadHeaders(raw) });
  const at = now.toISOString();
  await patch(id, { tomorrowSentFor: raw.bookedFor, lastReminderAt: at, ...(res.messageId ? { messageIds: JSON.stringify(withId(raw, res.messageId)) } : {}) });
  if (!res.deduped) {
    const copy = sentCopy(res, 'onboard_call_tomorrow', vars, client);
    await pushThread(id, { id: `out-${shortHash(res.messageId || `${at}|tomorrow`)}`, dir: 'out', at, from: await fromInboxOf(res), to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'reminder' });
  }
  await logEvent(id, SYSTEM, 'day_before_sent', { bookedFor: raw.bookedFor });
  return !res.deduped;
}

/** Reminders due for one applicant — US business hours only, at most one email per check. */
async function runReminders(client, raw, s, now) {
  if (!inUsBusinessHours(now, s.usHours)) return 0;
  const idx = dueReminder(raw, s, now, client.state);
  if (idx != null) return (await sendReminder(client, raw, s, idx, now)) ? 1 : 0;
  if (dayBeforeDue(raw, s, now)) return (await sendDayBefore(client, raw, s, now)) ? 1 : 0;
  return 0;
}

/** Past dueBy and still not booked → onboard_overdue, once per acceptance email. */
async function runOverdue(client, raw, s, now) {
  if (flag(raw.overdueAt) || !isOverdue(raw, now, client.state)) return false;
  await patch(client.id, { overdueAt: now.toISOString() });
  const n = Number(raw.remindersSent) || 0;
  await alert('onboard_overdue', {
    clientId: client.id,
    scope: `${client.id}:overdue:${raw.lastSentAt || raw.sentAt}`,
    vars: { person: person(client) },
    body: `${person(client)} (${client.contactEmail}) from ${client.name || client.id} has not booked the onboarding call ${s.bookWithinDays} business days after the acceptance email (sent ${ownerWhen(raw.lastSentAt || raw.sentAt)}, your time).${n ? ` ${n} reminder${n === 1 ? '' : 's'} went out.` : ''}`,
    did: 'Nothing more goes to them by itself. From their trial in the hub you can write to them in the same thread, send the email again, or stop the reminders.',
    url: `/#trial/${client.id}`,
  });
  await logEvent(client.id, SYSTEM, 'overdue', { dueBy: raw.dueBy });
  return true;
}

// ─── the inbox ───────────────────────────────────────────────────────────────

const subjectIsBooking = (subject) => { const s = lower(subject); return configList('bookingSubjects').some((p) => s.includes(p)); };
/**
 * Only mail that arrived after the acceptance email counts (a little slack for
 * clock skew); for a client with no onboarding call in play, after the client
 * was created.
 */
const afterSend = (meta, w) => (ms(meta.date) ?? Infinity) >= (ms(w.raw?.sentAt) || ms(w.client?.createdAt) || 0) - 5 * 60e3;

/**
 * A message from them → one `in` entry in their conversation (any client,
 * docs/REPLYBOT-MEET.md §1). While their onboarding call is in play
 * (acceptance sent, client in WATCH_STATES) the call's times move as before:
 * replied, the reminders stop. The reply bot reads it first
 * (systems/replybot.js onInbound): it may queue an answer (no alert now —
 * `bot_replied` follows it), read a thank-you (nothing to answer, no alert),
 * or leave it to the owner → `onboard_reply`, exactly as before the bot.
 */
async function recordReply(w, meta, now) {
  const id = w.client.id;
  const entryId = `in-${shortHash(normId(meta.messageId) || `${meta.inbox}|${meta.folder}|${meta.uid}`)}`;
  if ((await readThread(id)).some((t) => t.id === entryId)) return false;
  const at = isoOrNull(meta.date) || now.toISOString();
  const text = (stripQuotedReply(meta.text || '') || snippet(meta.text || '', 600) || '(no text)').slice(0, TEXT_MAX);
  const raw = await readCall(id);
  const inCall = flag(raw.sentAt) && WATCH_STATES.has(w.client.state);
  const { onInbound } = await import('@/lib/systems/replybot');
  const bot = await onInbound(w.client, raw, { entryId, at, text, subject: meta.subject || '', messageId: meta.messageId || null, from: lower(meta.from), now });
  const thanks = bot.rule === 'thanks';
  await pushThread(id, { id: entryId, dir: 'in', at, from: lower(meta.from), to: meta.inbox || null, subject: meta.subject || '', text, kind: 'reply', ...(bot.rule ? { rule: bot.rule } : {}) });
  if (inCall) {
    await patch(id, {
      lastReplyAt: ms(raw.lastReplyAt) > ms(at) ? raw.lastReplyAt : at,
      ...(flag(raw.firstReplyAt) ? {} : { firstReplyAt: at }),
      replies: (Number(raw.replies) || 0) + 1,
      ...(meta.subject ? { lastInSubject: meta.subject } : {}),
      ...(meta.messageId ? { lastInMessageId: bracket(meta.messageId), messageIds: JSON.stringify(withId(raw, meta.messageId)) } : {}),
      // A thank-you needs no answer — unless an earlier message of theirs still does.
      ...(thanks && !needsReply(raw) ? { lastAnsweredAt: at } : {}),
    });
  }
  await conv.noteInbound(id, { at, messageId: meta.messageId || null, subject: meta.subject || '', needsAnswer: !thanks });
  await logEvent(id, SYSTEM, 'reply_received', { from: lower(meta.from), subject: meta.subject || '', ...(bot.rule ? { rule: bot.rule } : {}), ...(bot.queued ? { bot: 'queued' } : {}) });
  if (bot.alert) {
    await alert('onboard_reply', {
      clientId: id,
      scope: `${id}:${entryId}`,
      vars: { person: person(w.client) },
      body: `${person(w.client)} (${lower(meta.from)}) from ${w.client.name || id} ${inCall ? 'replied to the onboarding-call email' : 'wrote to you'}:\n\n“${text.slice(0, 1500)}”${bot.rule && bot.why ? `\n\nThe reply bot left this one to you: ${bot.why}.` : ''}`,
      did: 'Added it to the conversation on their trial in the hub. Answer them there — it goes from the same inbox, in the same thread.',
      url: `/#trial/${id}`,
    });
  }
  return true;
}

async function recordBooking(w, { start, uid, meta, now }) {
  const id = w.client.id;
  const raw = await readCall(id);
  const startIso = isoOrNull(start);
  if (flag(raw.heldAt)) return { skipped: 'call already done' };
  if (flag(raw.bookedAt) && (raw.bookedFor || null) === startIso) return { duplicate: true };
  const moved = flag(raw.bookedAt) && flag(raw.bookedFor) && Boolean(startIso);
  const at = isoOrNull(meta.date) || now.toISOString();
  await patch(id, { bookedFor: startIso, bookedAt: at, bookedBy: 'calendar', bookingUid: uid || null, noShowAt: null, cancelledAt: null, tomorrowSentFor: null });
  const whenLine = startIso ? formatWhen(startIso, ET) : 'a time that was not in the email';
  await pushThread(id, { id: `in-${shortHash(`${normId(meta.messageId) || meta.uid}|${startIso}`)}`, dir: 'in', at, from: lower(meta.from), to: meta.inbox || null, subject: meta.subject || '', text: `Calendar: ${moved ? 'the call moved to' : 'call booked for'} ${whenLine}.`, kind: 'booking' });
  await logEvent(id, SYSTEM, moved ? 'call_rescheduled' : 'call_booked', { bookedFor: startIso, by: 'calendar', from: lower(meta.from) });
  await toCalendar(id, 'booked', { start: startIso, source: 'inbox', by: 'them', now });
  await alert('onboard_booked', {
    clientId: id,
    scope: `${id}:booked:${startIso || normId(meta.messageId) || meta.uid}`,
    vars: { person: person(w.client), when: startIso ? `${ownerWhen(startIso)} your time` : 'time not in the email' },
    body: `${person(w.client)} from ${w.client.name || id} ${moved ? 'moved' : 'booked'} the onboarding call: ${startIso ? `${ownerWhen(startIso)} your time (${whenLine} for them)` : 'the confirmation did not show the time — check your calendar'}.`,
    did: 'Marked the call booked on their trial; the reminders to book have stopped.',
    url: `/#trial/${id}`,
  });
  return { booked: true, moved };
}

async function recordCancel(w, { uid, meta, now }) {
  const id = w.client.id;
  const raw = await readCall(id);
  if (!flag(raw.bookedAt) || flag(raw.heldAt)) return { skipped: 'no booked call' };
  if (uid && raw.bookingUid && uid !== raw.bookingUid) return { skipped: 'another booking' };
  const at = isoOrNull(meta.date) || now.toISOString();
  await patch(id, { bookedFor: null, bookedAt: null, bookedBy: null, bookingUid: null, tomorrowSentFor: null, cancelledAt: at });
  const was = raw.bookedFor ? formatWhen(raw.bookedFor, ET) : 'the booked time';
  await pushThread(id, { id: `in-${shortHash(`${normId(meta.messageId) || meta.uid}|cancel`)}`, dir: 'in', at, from: lower(meta.from), to: meta.inbox || null, subject: meta.subject || '', text: `Calendar: the call on ${was} was cancelled.`, kind: 'booking' });
  await logEvent(id, SYSTEM, 'call_cancelled', { was: raw.bookedFor || null });
  await toCalendar(id, 'cancelled', { source: 'inbox', by: 'them', now });
  await alert('onboard_cancelled', {
    clientId: id,
    scope: `${id}:cancel:${raw.bookedFor || at}`,
    vars: { person: person(w.client) },
    body: `${person(w.client)} from ${w.client.name || id} cancelled the onboarding call${raw.bookedFor ? ` (${ownerWhen(raw.bookedFor)} your time)` : ''}.`,
    did: 'Their trial shows the call as not booked again.',
    url: `/#trial/${id}`,
  });
  return { cancelled: true };
}

/**
 * One scanned message → a booking, a cancellation, a reply or nothing.
 * Calendar first (.ics naming the applicant, then a booking-tool email with
 * their address and a time in it) for the applicants whose onboarding call is
 * open (`watched`); anything else from them or answering our Message-IDs is a
 * reply (auto-replies and bounces are not). `talk`: every other client, whose
 * mail from their contact address goes into their conversation too.
 */
export async function handleMessage(meta, watched, now, talk = []) {
  const out = { replies: 0, booked: 0 };
  // An onboarding applicant wins over another client with the same address.
  const byEmail = new Map([...talk, ...watched].map((w) => [w.email, w]));
  const events = (meta.ics || []).flatMap(parseIcs).filter((e) => e.start || e.method === 'CANCEL' || e.status === 'CANCELLED');
  let handled = false;
  for (const ev of events) {
    const emails = [...(ev.attendees || []).map((a) => a.email), ev.organizer?.email].map(lower).filter(Boolean);
    const w = watched.find((x) => emails.includes(x.email));
    if (!w || !afterSend(meta, w)) continue;
    handled = true;
    const declined = ev.method === 'REPLY' && (ev.attendees || []).some((a) => lower(a.email) === w.email && /DECLINED/i.test(a.partstat || ''));
    if (ev.method === 'CANCEL' || ev.status === 'CANCELLED' || declined) await recordCancel(w, { uid: ev.uid || null, meta, now });
    else if ((await recordBooking(w, { start: ev.start, uid: ev.uid || null, meta, now })).booked) out.booked++;
  }
  if (!events.length && subjectIsBooking(meta.subject) && meta.text) {
    const emails = new Set([...String(meta.text).matchAll(EMAIL_RE)].map((m) => m[1].toLowerCase()));
    const w = watched.find((x) => emails.has(x.email));
    if (w && afterSend(meta, w)) {
      handled = true;
      if (/cancel/i.test(meta.subject)) await recordCancel(w, { uid: null, meta, now });
      else if ((await recordBooking(w, { start: parseBodyDate(meta.text), uid: null, meta, now })).booked) out.booked++;
    }
  }
  if (handled) return out;
  const ids = (meta.threadIds || []).map(normId);
  const w = byEmail.get(lower(meta.from)) || watched.find((x) => ids.some((i) => x.ids.has(i))) || null;
  if (!w || !afterSend(meta, w) || (meta.kind && meta.kind !== 'human')) return out;
  if (await recordReply(w, meta, now)) out.replies++;
  return out;
}

/** Read the ONBOARDCALL inbox once (UID watermark, headers first, bodies only for mail that matters). */
async function scanInbox(watched, now, talk = []) {
  let account;
  try { account = await onboardSender(); } catch (err) { return { replies: 0, booked: 0, error: String(err?.message || err) }; }
  if (!account || !(account.appPassword || account.password) || !account.imap?.host) return { replies: 0, booked: 0, error: 'no inbox the machine can read' };
  const saved = (await kv.hgetall(K.onboardImap())) || {};
  const prefix = `${account.email}|`;
  const uidState = {};
  for (const [k, v] of Object.entries(saved)) if (k.startsWith(prefix)) uidState[k.slice(prefix.length)] = asObject(v) || v;
  const own = lower(account.email);
  const emails = new Set([...watched, ...talk].map((w) => w.email));
  const ids = new Set(watched.flatMap((w) => [...w.ids]));
  const matters = (m) => lower(m.from) !== own && (emails.has(lower(m.from)) || (m.threadIds || []).some((i) => ids.has(normId(i))) || m.hasIcs || subjectIsBooking(m.subject));
  const res = await io.scanMailbox(account, {
    folders: ['INBOX'], includeSpam: true, uidState, maxMessages: 60, firstScanDays: 3, timeoutMs: 15_000,
    wantBody: matters, wantIcs: (m) => m.hasIcs && lower(m.from) !== own,
  });
  if (!res || !res.ok) {
    const error = `IMAP ${account.email}: ${res?.error || 'scan failed'}`;
    await logEvent(null, SYSTEM, 'inbox_scan_failed', { error });
    return { replies: 0, booked: 0, error };
  }
  const out = { replies: 0, booked: 0 };
  const msgs = [...(res.messages || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const meta of msgs) {
    if (!matters(meta)) continue;
    try {
      const r = await handleMessage(meta, watched, now, talk);
      out.replies += r.replies;
      out.booked += r.booked;
    } catch (err) {
      await logEvent(null, SYSTEM, 'message_error', { uid: meta.uid, error: String(err?.message || err).slice(0, 200) });
    }
  }
  const upd = {};
  for (const [folder, v] of Object.entries(res.uidState || {})) {
    const k = `${prefix}${folder}`;
    if (JSON.stringify(asObject(saved[k]) || saved[k] || null) !== JSON.stringify(v)) upd[k] = v;
  }
  if (Object.keys(upd).length) await kv.hset(K.onboardImap(), upd);
  return out;
}

/**
 * One check per ONBOARDCALL.checkEveryMinutes, whoever asks (the job, the
 * hub, Approve). The key holds the last run's time, so a moved clock (tests,
 * Test Mode) is measured on `now`, not only on the key's expiry.
 */
async function claimCheck(now, minutes) {
  const windowMs = minutes * 60e3;
  const ex = Math.max(30, Math.round(minutes * 60));
  if ((await kv.set(K.onboardCheck(), now.toISOString(), { nx: true, ex })) === 'OK') return true;
  const last = ms(await kv.get(K.onboardCheck()));
  if (last != null && now.getTime() >= last && now.getTime() - last < windowMs) return false;
  await kv.set(K.onboardCheck(), now.toISOString(), { ex });
  return true;
}

/**
 * The check: the inbox (the onboarding calls that are open, and every other
 * client's messages into their conversation), then reminders and overdue for
 * the open calls, then the reply bot's answers that are due
 * (systems/replybot.js). → { ok, checked, newReplies, booked, remindersSent,
 * botReplies? (only when > 0), skipped?, error? } — `checked` counts the
 * onboarding calls.
 */
export async function checkOnboardCalls({ now = io.now(), force = false, clients = null } = {}) {
  const s = await onboardSettings();
  const out = { ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 };
  if (!force && !(await claimCheck(now, s.checkEveryMinutes))) return { ...out, skipped: 'too soon' };
  const all = (clients || await getAllClients()).filter((c) => c && c.id !== 'aviance');
  const open = all.filter((c) => flag(c.onboardCallOpen));
  const watched = [];
  for (const c of open) {
    const raw = await readCall(c.id);
    if (!flag(raw.sentAt) || !WATCH_STATES.has(c.state)) {
      // Moved on (or never sent): stop reading the inbox for them.
      await updateClient(c.id, { onboardCallOpen: '0' });
      await logEvent(c.id, SYSTEM, 'watch_ended', { state: c.state });
      continue;
    }
    watched.push({ client: c, raw, email: lower(raw.contactEmail || c.contactEmail), ids: new Set(asArray(raw.messageIds).map(normId)) });
  }
  out.checked = watched.length;
  const inWatch = new Set(watched.map((w) => w.client.id));
  const talk = all.filter((c) => talksWith(c) && !inWatch.has(c.id)).map((c) => ({ client: c, raw: null, email: lower(c.contactEmail), ids: new Set(), talk: true }));
  if (watched.length || talk.length) {
    const scan = await scanInbox(watched, now, talk);
    out.newReplies = scan.replies;
    out.booked = scan.booked;
    if (scan.error) { out.ok = false; out.error = scan.error; }
  }
  for (const w of watched) {
    try {
      // Fresh times: a reply or booking found a moment ago stops a reminder.
      const raw = await readCall(w.client.id);
      out.remindersSent += await runReminders(w.client, raw, s, now);
      await runOverdue(w.client, raw, s, now);
    } catch (err) {
      out.ok = false;
      out.error = out.error || String(err?.message || err);
      await logEvent(w.client.id, SYSTEM, 'check_failed', { error: String(err?.message || err).slice(0, 200) });
    }
  }
  // The reply bot's answers that are due (a message found a moment ago may already be).
  try {
    const { runReplyBot } = await import('@/lib/systems/replybot');
    const bot = await runReplyBot({ now });
    if (bot.sent) out.botReplies = bot.sent;
  } catch (err) {
    await logEvent(null, SYSTEM, 'replybot_failed', { error: String(err?.message || err).slice(0, 200) });
  }
  return out;
}

/** checkOnboardCalls for after() (Approve): never throws. */
export async function checkOnboardCallsQuietly(opts = {}) {
  try { return await checkOnboardCalls(opts); } catch (err) {
    await logEvent(null, SYSTEM, 'check_failed', { error: String(err?.message || err).slice(0, 200) });
    return { ok: false, error: String(err?.message || err) };
  }
}

// ─── the pixel ───────────────────────────────────────────────────────────────

/** A human open of the onboarding email (the route has already set scanners and prefetches aside). */
export async function markOpened(clientId, email, { now = new Date() } = {}) {
  try { assertClientId(clientId); } catch { return false; }
  const raw = await readCall(clientId);
  if (!flag(raw.sentAt) || lower(raw.contactEmail) !== lower(email)) return false;
  await kv.hincrby(K.onboardCall(clientId), 'opens', 1);
  if (flag(raw.openedAt)) return false;
  const first = await kv.hsetnx(K.onboardCall(clientId), 'openedAt', now.toISOString());
  if (first === 1 || first === true) await logEvent(clientId, SYSTEM, 'opened', {});
  return true;
}

// ─── the Calendar (docs/CALENDAR.md) ─────────────────────────────────────────

/** The onboarding call → the Calendar (the card's buttons, the inbox). Never throws: the call is already recorded. */
async function toCalendar(clientId, what, opts) {
  try {
    const { syncFromOnboardCall } = await import('@/lib/systems/calendar');
    return await syncFromOnboardCall(clientId, what, opts);
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'calendar_sync_failed', { what, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    return null;
  }
}

/** Remember which calendar meeting is this client's onboarding call (one per call, no duplicates). */
export async function linkMeeting(clientId, meetingId) {
  const raw = await readCall(clientId);
  if (flag(raw.sentAt) && raw.meetingId !== meetingId) await patch(clientId, { meetingId });
}

/**
 * The Calendar → this onboarding call, after every change to the client's
 * onboarding meeting. requested → "they asked for … — say yes in the
 * Calendar" (and a booking they asked to move is open again); confirmed →
 * booked (bookedBy 'calendar'); held / no_show → the same here; declined /
 * cancelled → the request (and its booking) is gone. Never calls back.
 */
export async function syncCallFromMeeting(clientId, m, { now = io.now() } = {}) {
  const raw = await readCall(clientId);
  if (!m || !flag(raw.sentAt)) return false;
  const at = now.toISOString();
  const same = raw.meetingId === m.id || raw.bookingUid === m.id;
  const clearRequest = { requestedFor: null, requestedAt: null, proposedFor: null };
  const clearBooking = { bookedFor: null, bookedAt: null, bookedBy: null, bookingUid: null, tomorrowSentFor: null };
  const fields = { meetingId: m.id, theirZone: m.theirZone || null };
  switch (m.status) {
    case 'requested':
      Object.assign(fields, { requestedFor: m.start, requestedAt: m.requestedAt || at, proposedFor: m.proposed || null }, flag(raw.firstRequestAt) ? {} : { firstRequestAt: at });
      if (same && flag(raw.bookedAt)) Object.assign(fields, clearBooking);
      break;
    case 'confirmed': {
      const kept = flag(raw.bookedAt) && raw.bookedFor === m.start;
      Object.assign(fields, clearRequest, {
        bookedFor: m.start, bookedAt: kept ? raw.bookedAt : at, bookedBy: kept && raw.bookedBy ? raw.bookedBy : 'calendar', bookingUid: m.id,
        noShowAt: null, heldAt: null, cancelledAt: null, tomorrowSentFor: kept ? raw.tomorrowSentFor || null : null,
      });
      await updateClient(clientId, { onboardCallOpen: '1' });
      break;
    }
    case 'held':
      Object.assign(fields, clearRequest, { heldAt: flag(raw.heldAt) ? raw.heldAt : at, noShowAt: null });
      await updateClient(clientId, { onboardCallOpen: '0' });
      break;
    case 'no_show':
      Object.assign(fields, clearRequest, { noShowAt: flag(raw.noShowAt) ? raw.noShowAt : at, heldAt: null });
      break;
    case 'declined':
      Object.assign(fields, clearRequest);
      break;
    case 'cancelled':
      Object.assign(fields, clearRequest, same && flag(raw.bookedAt) ? { ...clearBooking, cancelledAt: at } : {});
      break;
    default:
      return false;
  }
  await patch(clientId, fields);
  await logEvent(clientId, SYSTEM, `calendar_${m.status}`, { meetingId: m.id, start: m.start });
  return true;
}

/**
 * A Calendar email to the applicant from the onboarding-call inbox. With an
 * onboarding conversation it is threaded (In-Reply-To / References, its
 * Message-ID kept, shown in the hub's thread as an outgoing `booking`).
 */
export async function sendCallEmail(clientId, key, vars, { icalEvent = null, dedupe = null, now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  const raw = await readCall(clientId);
  const threaded = flag(raw.sentAt);
  const all = { threadSubject: raw.subject || FIRST_SUBJECT, ...vars };
  const res = await sendClient(clientId, key, all, { dedupe, linkify: true, thread: false, ...(icalEvent ? { icalEvent } : {}), ...(threaded ? threadHeaders(raw) : {}) });
  if (threaded && !res.deduped) {
    const at = now.toISOString();
    const copy = sentCopy(res, key, all, client);
    if (res.messageId) await patch(clientId, { messageIds: JSON.stringify(withId(raw, res.messageId)) });
    await pushThread(clientId, { id: `out-${shortHash(res.messageId || `${at}|${key}`)}`, dir: 'out', at, from: await fromInboxOf(res), to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'booking' });
  } else if (!res.deduped && res.sent) {
    // No onboarding conversation (a meeting the owner added): still one entry in their conversation.
    await conv.logClientEmail(clientId, key, res, { kind: 'booking' });
  }
  return res;
}

/**
 * The onboarding page's own clock (Day +2/+4 reminders, Day +7 close;
 * gatekeeper.runOnboardingNudge) for an applicant, pure.
 *  - No acceptance email (clients from before the onboarding call): the old
 *    clock from the onboarding link, reminders as before.
 *  - One reminder track: while the call is still to happen, the acceptance
 *    email's own reminders are the only ones; the page reminders run only
 *    once the call is done (and never after the owner stopped reminders).
 *  - Extend, never close early: the close counts from their last sign of life
 *    (a reply, a time they asked for, the booked call, the call itself), and
 *    is held while a time they asked for waits for the owner or a booked call
 *    is still ahead.
 * → { from: ISO the clock counts from, hold: reason | null, reminders: bool }
 */
export function onboardPageClock(raw, sentAt, now = new Date()) {
  if (!raw || !flag(raw.sentAt)) return { from: sentAt, hold: null, reminders: true };
  const times = [sentAt, raw.lastReplyAt, raw.firstRequestAt, raw.requestedAt, raw.bookedFor || raw.bookedAt, raw.heldAt, raw.noShowAt].map(ms).filter((t) => t != null);
  const from = times.length ? new Date(Math.max(...times)).toISOString() : sentAt;
  let hold = null;
  if (requestPending(raw)) hold = 'a time they asked for waits for your yes in the Calendar';
  else if (flag(raw.bookedAt) && !flag(raw.heldAt) && !flag(raw.noShowAt) && ms(raw.bookedFor) > now.getTime()) hold = 'the onboarding call is booked';
  return { from, hold, reminders: flag(raw.heldAt) && !flag(raw.stoppedAt) };
}

// ─── the owner's buttons ─────────────────────────────────────────────────────

async function requireCall(clientId) {
  assertClientId(clientId);
  const client = await getClient(clientId);
  if (!client) throw new OnboardCallError('not found', 404);
  const raw = await readCall(clientId);
  return { client, raw };
}
const requireSent = (raw) => { if (!flag(raw.sentAt)) throw new OnboardCallError('No acceptance email went to this applicant yet — use resend to send it.', 409); };

/** Add the owner's sign-off unless the last line already carries his name. */
export function withSignOff(text, signer) {
  const first = String(signer || '').trim().split(/\s+/)[0] || '';
  const lastLine = String(text).trim().split('\n').pop().toLowerCase();
  if (!first || lastLine.includes(first.toLowerCase())) return String(text).trim();
  return `${String(text).trim()}\n\n${signer}`;
}

/**
 * The owner's reply from the hub: plain text, same inbox, same thread
 * (In-Reply-To their last message / References; "Re: " their last subject,
 * else the acceptance email's). It answers everything of theirs so far: an
 * answer the reply bot was waiting to send is dropped.
 */
export async function ownerReply(clientId, text, { now = io.now() } = {}) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new OnboardCallError('Write the reply first.');
  if (body.length > REPLY_MAX) throw new OnboardCallError(`Keep the reply under ${REPLY_MAX.toLocaleString('en-US')} characters (it has ${body.length.toLocaleString('en-US')}).`);
  const { client, raw } = await requireCall(clientId);
  requireSent(raw);
  // A double click sends once.
  const claim = await kv.set(K.onceClaim('onboard_reply', clientId, shortHash(body)), now.toISOString(), { nx: true, ex: 120 });
  if (claim !== 'OK') return { duplicate: true };
  const vars = { threadSubject: conv.stripRe(raw.lastInSubject) || raw.subject || FIRST_SUBJECT, text: withSignOff(body, await ownerName(clientId)) };
  let res;
  try {
    res = await sendClient(clientId, 'onboard_owner_reply', vars, { dedupe: null, thread: false, ...threadHeaders(raw) });
  } catch (err) {
    await kv.del(K.onceClaim('onboard_reply', clientId, shortHash(body)));
    throw err;
  }
  const at = now.toISOString();
  const copy = sentCopy(res, 'onboard_owner_reply', vars, client);
  const from = await fromInboxOf(res);
  await patch(clientId, { lastOwnerReplyAt: at, ...(res.messageId ? { messageIds: JSON.stringify(withId(raw, res.messageId)) } : {}) });
  await pushThread(clientId, { id: `out-${shortHash(res.messageId || `${at}|owner`)}`, dir: 'out', at, from, to: lower(client.contactEmail), subject: copy.subject, text: copy.text, kind: 'owner_reply' });
  await conv.noteAnswered(clientId, at, { messageId: res.messageId || null });
  const { dropPending } = await import('@/lib/systems/replybot');
  await dropPending(clientId);
  await logEvent(clientId, SYSTEM, 'owner_replied', { chars: body.length });
  return { sent: true };
}

/**
 * The reply bot answered them (or the calendar did, on its behalf): their
 * messages so far are answered, and its email joins the thread's Message-IDs.
 * Only for a client with an onboarding conversation.
 */
export async function markAnswered(clientId, at, messageId = null) {
  const raw = await readCall(clientId);
  if (!flag(raw.sentAt)) return;
  await patch(clientId, { lastAnsweredAt: at, ...(messageId ? { messageIds: JSON.stringify(withId(raw, messageId)) } : {}) });
}

/** "Mark call booked" with the date and time the owner agreed with them. */
export async function markBooked(clientId, when, { now = io.now() } = {}) {
  const t = ms(when);
  if (t == null) throw new OnboardCallError('Give the date and time of the call (for example 2026-10-06T15:00:00Z).');
  if (t < now.getTime() - 30 * 864e5 || t > now.getTime() + 180 * 864e5) throw new OnboardCallError('That date is too far from today — check it.');
  const { raw } = await requireCall(clientId);
  requireSent(raw);
  const bookedFor = new Date(t).toISOString();
  await patch(clientId, { bookedFor, bookedAt: now.toISOString(), bookedBy: 'owner', bookingUid: null, noShowAt: null, heldAt: null, cancelledAt: null, tomorrowSentFor: raw.bookedFor === bookedFor ? raw.tomorrowSentFor || null : null, requestedFor: null, requestedAt: null, proposedFor: null });
  await updateClient(clientId, { onboardCallOpen: '1' });
  await logEvent(clientId, SYSTEM, 'call_booked', { bookedFor, by: 'owner' });
  await toCalendar(clientId, 'booked', { start: bookedFor, source: 'onboard_card', by: 'owner', now });
}

/** "Call done". */
export async function markHeld(clientId, { now = io.now() } = {}) {
  const { raw } = await requireCall(clientId);
  requireSent(raw);
  await patch(clientId, { heldAt: now.toISOString(), noShowAt: null });
  await updateClient(clientId, { onboardCallOpen: '0' });
  await logEvent(clientId, SYSTEM, 'call_held', {});
  await toCalendar(clientId, 'held', { source: 'onboard_card', by: 'owner', now });
}

/** "They didn't show" — the inbox stays watched, so a new booking from their link is still seen. */
export async function markNoShow(clientId, { now = io.now() } = {}) {
  const { raw } = await requireCall(clientId);
  requireSent(raw);
  if (!flag(raw.bookedAt) && !flag(raw.heldAt)) throw new OnboardCallError('No call is booked for them.', 409);
  await patch(clientId, { noShowAt: now.toISOString(), heldAt: null });
  await logEvent(clientId, SYSTEM, 'call_no_show', { bookedFor: raw.bookedFor || null });
  await toCalendar(clientId, 'no_show', { source: 'onboard_card', by: 'owner', now });
}

/** "Stop reminders": nothing more goes to them by itself (their replies are still collected). */
export async function stopReminders(clientId, { now = io.now() } = {}) {
  const { raw } = await requireCall(clientId);
  requireSent(raw);
  if (!flag(raw.stoppedAt)) await patch(clientId, { stoppedAt: now.toISOString() });
  await logEvent(clientId, SYSTEM, 'reminders_stopped', {});
}

/** "Send it again": a fresh onboarding link (the first one keeps working), same thread. */
export async function resendAcceptance(clientId, { now = io.now() } = {}) {
  const { client, raw } = await requireCall(clientId);
  if (client.state !== 'onboarding') throw new OnboardCallError(`They are past onboarding (${client.state}) — nothing to resend.`, 409);
  const n = (Number(raw.sends) || 0) + 1;
  // Its own token purpose, so the link in the first email keeps working. The
  // onboarding page's own clock (Day +2/+4 reminders, Day +7 close) is not reset.
  const token = await mintToken(clientId, `onboarding:a${n}`, { ttl: TTL.long });
  return sendAcceptance(clientId, { onboardingLink: pageUrl(token, 'onboard'), now, resend: flag(raw.sentAt) });
}

/** The hub's onboardCall for one client (null when no acceptance email went). */
export async function onboardCallFor(clientId, { now = io.now(), settings = null, client = null } = {}) {
  const c = client || await getClient(clientId);
  if (!c) return null;
  const raw = await readCall(clientId);
  if (!flag(raw.sentAt)) return null;
  return onboardCallView(raw, await readThread(clientId), { now, settings: settings || await onboardSettings(), clientState: c.state });
}

/** POST /api/mc/clients/{id}/onboard-call → { ok, onboardCall }. */
export async function onboardCallAction(clientId, body = {}, { now = io.now() } = {}) {
  switch (body.action) {
    case 'reply': await ownerReply(clientId, body.text, { now }); break;
    case 'markBooked': await markBooked(clientId, body.when, { now }); break;
    case 'markHeld': await markHeld(clientId, { now }); break;
    case 'markNoShow': await markNoShow(clientId, { now }); break;
    case 'resend': await resendAcceptance(clientId, { now }); break;
    case 'stopReminders': await stopReminders(clientId, { now }); break;
    default: throw new OnboardCallError('Unknown action — use reply, markBooked, markHeld, markNoShow, resend or stopReminders.');
  }
  return { ok: true, onboardCall: await onboardCallFor(clientId, { now }) };
}
