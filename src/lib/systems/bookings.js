/**
 * Booking Watcher + Call Handoff (SPEC §8.4).
 *
 * The client adds the trial sender address as a notification recipient on
 * their booking tool, so confirmations land in a trial inbox. The `bookings`
 * job scans one inbox per run (own UID watermark) for `.ics` invites or
 * subjects from config/bookingSubjects.txt, parses DTSTART / ATTENDEE /
 * ORGANIZER (UTC, TZID and floating forms) and matches the attendee to a
 * lead. Unmatched bookings are still recorded (`leadEmail = null`,
 * `manualMatch = true`) for the client tap.
 *
 * On a new booking: claim `booking:{id}`, send `call_handoff` within the same
 * run (retried by `reminders` until it goes, well inside 2 h), warn when the
 * slot is more than 5 business days out, count `booked` (a re-book of a
 * no-show counts once). The `reminders` job (every 5 min) sends the prospect
 * reminders at 24 h / 1 h unless the tool sends its own, the `call_tap` at
 * +1 h and the tap reminder at +24 h.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getProfile } from '@/lib/db/client';
import { getAccounts } from '@/lib/db/inboxes';
import { getLead, getLeads, saveLead, hostOf } from '@/lib/db/leads';
import { bump } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { mintToken, pageUrl, TTL } from '@/lib/pagetokens';
import { recordImapResult } from '@/lib/inbox-health';
import { ET } from '@/lib/time';
import { recordLearning } from '@/lib/systems/learning';
import { sendToProspect, notifyClientSafe, clientAddresses } from '@/lib/systems/outbound';
import {
  deps, alert, isTrialClient, lower, shortHash, configList, zonedToUtc, formatWhen, truthy, businessDaysBetween,
  getRunState, patchRunState, claimOnce, nicheOf, ccfg } from '@/lib/systems/stagec-common';

// ─── ICS parsing ─────────────────────────────────────────────────────────────

const WINDOWS_TZ = {
  'eastern standard time': 'America/New_York', 'us eastern standard time': 'America/Indiana/Indianapolis',
  'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix', 'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage', 'hawaiian standard time': 'Pacific/Honolulu',
  'gmt standard time': 'Europe/London', 'utc': 'UTC', 'sri lanka standard time': 'Asia/Colombo',
};

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export function resolveTzid(tzid) {
  const raw = String(tzid || '').replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, '').trim();
  if (!raw) return null;
  if (validTz(raw)) return raw;
  return WINDOWS_TZ[raw.toLowerCase()] || null;
}

/** Parse an iCalendar date-time value → { date: Date|null, allDay, floating }. */
export function parseIcsDate(value, params = {}, fallbackTz = ET) {
  const v = String(value || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || String(params.VALUE || '').toUpperCase() === 'DATE') {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return { date: null };
    return { date: zonedToUtc(+m[1], +m[2], +m[3], 0, 0, 0, resolveTzid(params.TZID) || fallbackTz), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return { date: null };
  const [, y, mo, d, h, mi, s = '0', z] = m;
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) };
  const tz = resolveTzid(params.TZID);
  return { date: zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz || fallbackTz), floating: !tz };
}

function parseParams(str) {
  const out = {};
  const re = /;([A-Za-z-]+)=("[^"]*"|[^;:]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
  return out;
}
const mailto = (v) => lower(String(v || '').replace(/^mailto:/i, ''));

/**
 * Parse an .ics body → [{ uid, method, sequence, status, summary, start, end,
 * allDay, floating, attendees: [{email, name, partstat}], organizer }].
 */
export function parseIcs(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let method = null;
  let cur = null;
  for (const line of lines) {
    const idx = line.search(/[:;]/);
    if (idx <= 0) continue;
    const name = line.slice(0, idx).toUpperCase();
    const colon = line.indexOf(':', idx);
    if (colon < 0) continue;
    const params = parseParams(line.slice(idx, colon));
    const value = line.slice(colon + 1).trim();
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') { cur = { attendees: [], method, sequence: 0 }; continue; }
    if (name === 'END' && value.toUpperCase() === 'VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) { if (name === 'METHOD') method = value.toUpperCase(); continue; }
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SEQUENCE': cur.sequence = Number(value) || 0; break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'SUMMARY': cur.summary = value.replace(/\\,/g, ',').replace(/\\n/gi, ' '); break;
      case 'DTSTART': { const r = parseIcsDate(value, params); cur.start = r.date; cur.allDay = Boolean(r.allDay); cur.floating = Boolean(r.floating); break; }
      case 'DTEND': cur.end = parseIcsDate(value, params).date; break;
      case 'ATTENDEE': cur.attendees.push({ email: mailto(value), name: params.CN || null, partstat: params.PARTSTAT || null, role: params.ROLE || null }); break;
      case 'ORGANIZER': cur.organizer = { email: mailto(value), name: params.CN || null }; break;
      default: break;
    }
  }
  for (const e of events) if (!e.method) e.method = method;
  return events;
}

/** Best-effort date from a confirmation body with no .ics ("Tuesday, September 29, 2026 10:00am (Eastern Time)"). */
export function parseBodyDate(text) {
  const t = String(text || '');
  const m = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})[^0-9]{1,40}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
  if (!m) return null;
  const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  let h = Number(m[4]) % 12;
  if (/pm/i.test(m[6])) h += 12;
  const zone = /pacific/i.test(t) ? 'America/Los_Angeles' : /mountain/i.test(t) ? 'America/Denver' : /central/i.test(t) ? 'America/Chicago' : /eastern/i.test(t) ? 'America/New_York' : null;
  if (!zone) return null; // a time with no zone is not guessed
  return zonedToUtc(Number(m[3]), mo, Number(m[2]), h, Number(m[5] || 0), 0, zone);
}

// ─── Matching + recording ────────────────────────────────────────────────────

export function bookingIdOf(uidOrMessageId) { return `b${shortHash(lower(uidOrMessageId))}`; }

export async function getBookings(clientId) {
  const raw = (await kv.hgetall(K.bookings(clientId))) || {};
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v === 'object'));
}
export async function saveBooking(clientId, id, patch) {
  const cur = (await kv.hget(K.bookings(clientId), id)) || {};
  const next = { ...cur, ...patch, id };
  await kv.hset(K.bookings(clientId), { [id]: next });
  return next;
}

/** Attendee emails → { lead, attendee, colleague } (first attendee that is, or works with, one of our leads). */
async function matchAttendees(clientId, emails, exclude) {
  const cands = emails.map(lower).filter((e) => e && e.includes('@') && !exclude.has(e));
  for (const e of cands) {
    const lead = await getLead(clientId, e);
    if (lead && lead.sent_at) return { lead, attendee: e, colleague: false };
  }
  if (!cands.length) return { lead: null, attendee: null };
  const hosts = new Set(cands.map(hostOf));
  const all = await getLeads(clientId);
  const same = all.filter((l) => l.sent_at && hosts.has(hostOf(l.email))).sort((a, b) => String(b.replied_at || '').localeCompare(String(a.replied_at || '')));
  if (same.length) return { lead: same[0], attendee: cands.find((c) => hostOf(c) === hostOf(same[0].email)), colleague: true };
  return { lead: null, attendee: cands[0] };
}

function subjectIsBooking(subject) {
  const s = lower(subject);
  return configList('bookingSubjects').some((p) => s.includes(p));
}

/** Everything the client handoff needs from the reply history. */
async function replyHistory(clientId, leadEmail) {
  const all = Object.values((await kv.hgetall(K.replies(clientId))) || {}).filter((r) => r && lower(r.leadEmail) === lower(leadEmail));
  all.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  const yes = [...all].reverse().find((r) => r.kind === 'interested') || all[all.length - 1] || null;
  const questions = all.filter((r) => r.kind === 'question').map((r) => `“${String(r.text || r.snippet).slice(0, 300)}”`);
  const thread = all.map((r) => `${String(r.receivedAt).slice(0, 10)} — ${r.kind}: “${String(r.text || r.snippet || '').slice(0, 300)}”`).join('\n');
  return { whyYes: yes ? String(yes.text || yes.snippet).slice(0, 800) : null, asked: questions.join(' / '), thread };
}

export async function sendHandoff(clientId, booking, now = new Date()) {
  if (booking.threadForwardedAt) return { already: true };
  const lead = booking.leadEmail ? await getLead(clientId, booking.leadEmail) : null;
  const h = lead ? await replyHistory(clientId, lead.email) : { whyYes: null, asked: '', thread: '' };
  const vars = {
    Name: lead?.name || lead?.first_name || booking.attendeeName || booking.attendeeEmail || 'Unknown attendee',
    Title: lead?.title || 'title not on file',
    Company: lead?.company || (booking.attendeeEmail ? hostOf(booking.attendeeEmail) : 'company not matched'),
    when: formatWhen(booking.scheduledAt, lead?.tz || ET) || 'time not in the confirmation',
    whyYes: h.whyYes || (booking.manualMatch ? 'This booking did not match anyone we emailed — tell me who it was when you tap after the call.' : 'They booked straight from the link.'),
    asked: h.asked || 'nothing beyond the reply above',
    thread: h.thread || '(no reply thread — they booked from the email link)',
  };
  const r = await notifyClientSafe(clientId, 'call_handoff', vars, { from: 'trial', dedupe: `call_handoff:${booking.id}` });
  if (r.sent || r.deduped) await saveBooking(clientId, booking.id, { threadForwardedAt: now.toISOString() });
  return r;
}

/** Record one detected booking event. Exported for tests. */
export async function recordBookingEvent(clientId, ev, { now = new Date(), source = 'link', messageId = null, ctx }) {
  const id = bookingIdOf(ev.uid || messageId || `${ev.start?.toISOString?.()}|${(ev.attendees || []).map((a) => a.email).join(',')}`);
  const existing = (await kv.hget(K.bookings(clientId), id)) || null;
  const scheduledAt = ev.start ? new Date(ev.start).toISOString() : null;
  const cancelled = ev.method === 'CANCEL' || ev.status === 'CANCELLED';

  if (existing) {
    if (cancelled && !existing.cancelledAt) {
      await saveBooking(clientId, id, { cancelledAt: now.toISOString() });
      await logEvent(clientId, 'bookings', 'booking_cancelled', { id, lead: existing.leadEmail });
      return { id, cancelled: true };
    }
    if (scheduledAt && existing.scheduledAt && scheduledAt !== existing.scheduledAt && (ev.sequence || 0) >= (Number(existing.icsSequence) || 0)) {
      await saveBooking(clientId, id, { previousScheduledAt: existing.scheduledAt, scheduledAt, rescheduleCount: (Number(existing.rescheduleCount) || 0) + 1, icsSequence: ev.sequence || 0, remindersSent: [], tapSentAt: null });
      await logEvent(clientId, 'bookings', 'booking_rescheduled', { id, from: existing.scheduledAt, to: scheduledAt });
      return { id, rescheduled: true };
    }
    return { id, duplicate: true };
  }
  if (cancelled) return { id, skipped: 'cancel for a booking we never saw' };
  if (!(await claimOnce('booking', clientId, id))) return { id, duplicate: true };

  const emails = [...(ev.attendees || []).map((a) => a.email), ev.organizer?.email].filter(Boolean);
  const { lead, attendee, colleague } = await matchAttendees(clientId, emails, ctx.exclude);
  const all = await getBookings(clientId);
  const prior = lead ? Object.values(all).find((b) => lower(b.leadEmail) === lower(lead.email) && ['noshow', 'closed_noshow'].includes(b.status)) : null;
  const booking = await saveBooking(clientId, id, {
    leadEmail: lead ? lead.email : null,
    attendeeEmail: attendee || null,
    attendeeName: (ev.attendees || []).find((a) => a.email === attendee)?.name || null,
    colleague: Boolean(colleague),
    scheduledAt,
    source,
    remindersSent: [],
    status: 'booked',
    attendedTapAt: null,
    qualified: false,
    disputeReason: null,
    rebookAttempts: 0,
    threadForwardedAt: null,
    quote: null,
    quoteApprovedAt: null,
    manualMatch: !lead,
    rebookOf: prior ? prior.id : null,
    icsUid: ev.uid || null,
    icsSequence: ev.sequence || 0,
    createdAt: now.toISOString(),
    summary: ev.summary || null,
  });
  if (prior) await saveBooking(clientId, prior.id, { status: 'rebooked', rebookedAs: id, rebookedAt: now.toISOString() });
  else await bump(clientId, 'booked', 1, now);
  if (lead) {
    await saveLead(clientId, { ...lead, bookedAt: lead.bookedAt || now.toISOString(), bookingId: id }, lead.status);
    if (!prior) await recordLearning(clientId, 'booked', { lead, niche: ctx.niche, at: lead.sent_at });
  } else {
    await alert('booking_unmatched', { clientId, scope: `${clientId}:${id}`, vars: { clientId }, body: `A booking for ${formatWhen(scheduledAt) || 'an unknown time'} (${emails.join(', ') || 'no attendee'}) did not match any prospect.`, did: 'Recorded with manual_match; the client names the person when they tap after the call.' });
  }
  await logEvent(clientId, 'bookings', 'booking_created', { id, lead: lead?.email || null, scheduledAt, rebookOf: prior?.id || null });

  await sendHandoff(clientId, booking, now);
  const farDays = await ccfg(clientId, 'BOOK.farSlotDays');
  if (scheduledAt) {
    const bd = businessDaysBetween(now.getTime(), Date.parse(scheduledAt));
    if (bd > farDays) {
      await notifyClientSafe(clientId, 'slot_far_warning', { Name: lead?.name || lead?.first_name || attendee || 'The prospect', Company: lead?.company || hostOf(attendee || '') || 'their company', when: formatWhen(scheduledAt, lead?.tz || ET), days: bd }, { from: 'trial', dedupe: `slot_far:${id}` });
    }
  }
  return { id, created: true, lead: lead?.email || null };
}

async function bookingContext(clientId) {
  const [client, profile, accounts] = await Promise.all([getClient(clientId), getProfile(clientId), getAccounts(clientId)]);
  const exclude = new Set([...accounts.map((a) => a.email), ...clientAddresses(client || {}, profile)]);
  return { client: client || {}, profile, accounts, exclude, niche: nicheOf(client || {}, profile) };
}

/** Handle one scanned message: .ics events first, then a subject-only confirmation. */
export async function processBookingMessage(clientId, meta, ctx, now = new Date()) {
  const out = [];
  const events = (meta.ics || []).flatMap(parseIcs).filter((e) => e.start || e.method === 'CANCEL');
  for (const ev of events) out.push(await recordBookingEvent(clientId, ev, { now, messageId: meta.messageId, ctx }));
  if (!events.length && subjectIsBooking(meta.subject)) {
    const text = meta.text || '';
    const emails = [...text.matchAll(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi)].map((m) => m[1].toLowerCase());
    const start = parseBodyDate(text);
    const cancelled = /cancel/i.test(meta.subject);
    out.push(await recordBookingEvent(clientId, { uid: null, method: cancelled ? 'CANCEL' : null, start, attendees: [...new Set(emails)].map((email) => ({ email })) }, { now, messageId: meta.messageId, ctx }));
  }
  return out;
}

/** The `bookings` job: one inbox per run. */
export async function runBookings(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const ctx = await bookingContext(clientId);
  const accounts = ctx.accounts.filter((a) => a.appPassword || a.password);
  if (!accounts.length) return { skipped: 'no inbox with a password' };
  const st = await getRunState(clientId);
  const idx = (Number(st.bookingCursor) || 0) % accounts.length;
  const account = accounts[idx];
  await patchRunState(clientId, { bookingCursor: idx + 1 });
  const saved = (await kv.hgetall(K.imapState(clientId))) || {};
  const uidState = {};
  for (const [k, v] of Object.entries(saved)) { const [p, e, ...f] = k.split('|'); if (p === 'bookings' && e === account.email) uidState[f.join('|')] = v; }
  const res = await deps.scanMailbox(account, { folders: ['INBOX'], uidState, maxMessages: 40, firstScanDays: 14, wantBody: (m) => subjectIsBooking(m.subject), wantIcs: (m) => m.hasIcs });
  if (!res || !res.ok) {
    await recordImapResult(account.email, { ok: false, error: res?.error || 'scan failed' });
    throw new Error(`IMAP ${account.email}: ${res?.error || 'scan failed'}`);
  }
  const results = [];
  for (const meta of res.messages || []) {
    if (!(meta.ics && meta.ics.length) && !subjectIsBooking(meta.subject)) continue;
    if (ctx.exclude.has(lower(meta.from)) && !(meta.ics && meta.ics.length)) continue;
    try { results.push(...(await processBookingMessage(clientId, meta, ctx, now))); } catch (err) {
      results.push({ error: err.message });
      await logEvent(clientId, 'bookings', 'message_error', { uid: meta.uid, error: err.message });
    }
  }
  const upd = {};
  for (const [folder, v] of Object.entries(res.uidState || {})) upd[`bookings|${account.email}|${folder}`] = v;
  if (Object.keys(upd).length) await kv.hset(K.imapState(clientId), upd);
  return { inbox: account.email, messages: (res.messages || []).length, bookings: results.filter((r) => r.created).length };
}

// ─── Reminders, tap, handoff retry (every 5 min) ─────────────────────────────

export async function tapLinks(clientId, bookingId) {
  const token = await mintToken(clientId, `tap:${bookingId}`, { ttl: TTL.short, data: { bookingId } });
  const u = (a) => pageUrl(token, `tap?a=${a}`);
  return { showedUrl: u('showed'), noshowUrl: u('noshow'), wrongfitUrl: u('wrongfit'), disputeUrl: u('dispute'), clientNoshowUrl: u('client_noshow') };
}

export async function runReminders(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const [profile, bookings] = await Promise.all([getProfile(clientId), getBookings(clientId)]);
  const toolReminds = truthy(profile.toolSendsReminders);
  const tapHours = await ccfg(clientId, 'BOOK.tapReminderHours');
  const out = { handoffs: 0, reminders: 0, taps: 0, tapReminders: 0 };
  const nowMs = now.getTime();
  for (const b of Object.values(bookings)) {
    if (!b.id) continue;
    if (!b.threadForwardedAt && b.status === 'booked') { const r = await sendHandoff(clientId, b, now); if (r.sent) out.handoffs++; }
    if (!b.scheduledAt) continue;
    const at = Date.parse(b.scheduledAt);
    const lead = b.leadEmail ? await getLead(clientId, b.leadEmail) : null;
    const when = formatWhen(b.scheduledAt, lead?.tz || ET);

    // Prospect reminders: 24 h (until 2 h before) and 1 h, unless the tool sends its own.
    if (b.status === 'booked' && !b.cancelledAt && lead && !toolReminds && nowMs < at) {
      const sent = new Set(b.remindersSent || []);
      const thread = { subject: lead.original_subject, messageId: lead.original_message_id, references: [lead.original_message_id].filter(Boolean) };
      let key = null;
      if (nowMs >= at - 3600e3 && !sent.has('1h')) key = '1h';
      else if (nowMs >= at - 24 * 3600e3 && nowMs < at - 2 * 3600e3 && !sent.has('24h')) key = '24h';
      if (key) {
        const r = await sendToProspect(clientId, `reminder_${key}`, { lead, vars: { when }, thread, dedupe: `reminder_${key}:${b.id}:${b.scheduledAt}` });
        if (r.sent || r.deduped) { sent.add(key); await saveBooking(clientId, b.id, { remindersSent: [...sent] }); out.reminders++; }
      }
    }

    // call_tap at +1 h.
    if (b.status === 'booked' && !b.tapSentAt && nowMs >= at + 3600e3) {
      const vars = { Name: lead?.name || lead?.first_name || b.attendeeName || b.attendeeEmail || 'the prospect', Company: lead?.company || (b.attendeeEmail ? hostOf(b.attendeeEmail) : 'their company'), when: when || 'the booked time', ...(await tapLinks(clientId, b.id)) };
      const r = await notifyClientSafe(clientId, 'call_tap', vars, { from: 'trial', dedupe: `call_tap:${b.id}:${b.scheduledAt}` });
      if (r.sent || r.deduped) { await saveBooking(clientId, b.id, { tapSentAt: now.toISOString() }); out.taps++; }
    }
    // Tap reminder at +24 h after the tap email.
    if (b.status === 'booked' && b.tapSentAt && !b.attendedTapAt && !b.tapReminderAt && nowMs >= Date.parse(b.tapSentAt) + tapHours * 3600e3) {
      const vars = { Name: lead?.name || lead?.first_name || b.attendeeEmail || 'the prospect', Company: lead?.company || 'their company', when: when || 'the booked time', ...(await tapLinks(clientId, b.id)) };
      const r = await notifyClientSafe(clientId, 'call_tap_reminder', vars, { from: 'trial', dedupe: `call_tap_reminder:${b.id}` });
      if (r.sent || r.deduped) { await saveBooking(clientId, b.id, { tapReminderAt: now.toISOString() }); out.tapReminders++; }
    }
  }
  return out;
}

