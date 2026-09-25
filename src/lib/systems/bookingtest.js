/**
 * Booking Link Tester (SPEC §6.7). Prevents the "prospect says yes and the
 * link is broken" failure. Runs from Day −4 (four days before day1Date) and
 * again whenever the calendar URL changes.
 *
 * 1. GET calendarUrl → must be 200 and a known booking host (Calendly,
 *    Cal.com, Google appointment pages, TidyCal, Zoho) or a page with a form.
 * 2. Where the host exposes availability (Calendly's public booking API,
 *    slot/duration JSON embedded in the page), check: first slot ≤ 5
 *    business days out, ≥ 10 slots in the next 7 days, length 15–30 min.
 *    Anything not exposed is recorded as unknown, never failed.
 * 3. Problems → booking_fix naming them. Otherwise booking_test_request with
 *    a one-tap "It worked" button (/c/{token}/booking-ok) that sets
 *    profile.bookingTested. Daily reminder until tapped (warming/ready).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, getTrial } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { mintToken, readToken, pageUrl, TTL } from '@/lib/pagetokens';
import { sha256 } from '@/lib/crypto';
import { dayKeyIn, addDays, ET } from '@/lib/time';
import { io, asArray, truthy, firstNameOf, ownerName, sendClient, businessDaysBetween, isPublicUrl } from '@/lib/systems/intake-io';

const SYSTEM = 'bookingtest';

/** Booking host from the final URL / page HTML: calendly | calcom | google | tidycal | zoho | form | null. */
export function detectHost(url, html = '') {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (/(^|\.)calendly\.com$/.test(host)) return 'calendly';
  if (/(^|\.)cal\.com$/.test(host) || /(^|\.)cal\.id$/.test(host)) return 'calcom';
  if (/calendar\.google\.com$/.test(host) || /calendar\.app\.google$/.test(host) || (/google\.com$/.test(host) && /appointments?|schedules/.test(url))) return 'google';
  if (/(^|\.)tidycal\.com$/.test(host)) return 'tidycal';
  if (/zoho(bookings)?\.(com|eu|in)$/.test(host) || /bookings\.zoho/.test(host)) return 'zoho';
  const h = String(html);
  if (/assets\.calendly\.com|calendly-inline-widget/i.test(h)) return 'calendly';
  if (/cal\.com\/embed|app\.cal\.com/i.test(h)) return 'calcom';
  if (/calendar\.google\.com\/calendar\/appointments/i.test(h)) return 'google';
  if (/tidycal\.com/i.test(h)) return 'tidycal';
  if (/zohobookings|bookings\.zoho/i.test(h)) return 'zoho';
  if (/<form[\s>]/i.test(h)) return 'form';
  return null;
}

/** Slots and meeting length embedded in page JSON, where the host exposes them. */
export function parseEmbedded(html) {
  const h = String(html || '');
  const lengthM = h.match(/"(?:duration|length|lengthInMinutes|slotDuration)"\s*:\s*(\d{1,3})\b/);
  // Only slot-shaped keys, and only when there are several: one stray
  // timestamp in page metadata must not read as "1 open slot".
  const slots = [...new Set([...h.matchAll(/"(?:start_time|startTime)"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^"]*)"/g)].map((m) => m[1]))];
  const len = lengthM ? Number(lengthM[1]) : null;
  return { lengthMin: len >= 5 && len <= 240 ? len : null, slots: slots.length >= 3 ? slots : null };
}

/** Calendly public booking API (best effort; any failure → nulls). */
export async function calendlyAvailability(url, now) {
  try {
    const u = new URL(url);
    const [profile, event] = u.pathname.split('/').filter(Boolean);
    if (!profile || !event) return { slots: null, lengthMin: null };
    const look = await io.fetchJson(`https://calendly.com/api/booking/event_types/lookup?event_type_slug=${encodeURIComponent(event)}&profile_slug=${encodeURIComponent(profile)}`, { timeoutMs: 6000, retry: false });
    const uuid = look.json?.uuid;
    const lengthMin = Number(look.json?.duration) || null;
    if (!uuid) return { slots: null, lengthMin };
    const start = dayKeyIn(ET, now);
    const end = addDays(start, 10);
    const range = await io.fetchJson(`https://calendly.com/api/booking/event_types/${uuid}/calendar/range?timezone=America%2FNew_York&diagnostics=false&range_start=${start}&range_end=${end}`, { timeoutMs: 6000, retry: false });
    const days = range.json?.days;
    if (!Array.isArray(days)) return { slots: null, lengthMin };
    const slots = days.flatMap((d) => (d.spots || []).filter((s) => !s.status || s.status === 'available').map((s) => s.start_time)).filter(Boolean);
    return { slots, lengthMin };
  } catch {
    return { slots: null, lengthMin: null };
  }
}

/**
 * Apply the §6.7 rules. `slots` null = unknown (never a problem).
 * Returns { problems: [text], firstSlotDays, slots7d, lengthMin }.
 */
export function evaluateBooking({ status, host, slots, lengthMin }, rules, now) {
  const problems = [];
  if (status !== 200) problems.push(`the page did not open (status ${status ?? 'no answer'}).`);
  else if (!host) problems.push("the page doesn't look like a booking page — no Calendly, Cal.com, Google, TidyCal or Zoho booking and no form.");
  let firstSlotDays = null;
  let slots7d = null;
  if (status === 200 && Array.isArray(slots)) {
    const today = dayKeyIn(ET, now);
    const in7 = addDays(today, 7);
    const days = slots.map((s) => dayKeyIn(ET, new Date(s))).filter((d) => d >= today).sort();
    slots7d = days.filter((d) => d <= in7).length;
    firstSlotDays = days.length ? businessDaysBetween(today, days[0]) : null;
    if (!days.length) problems.push('there are no open slots at all.');
    else if (firstSlotDays > rules.firstSlotMaxBusinessDays) problems.push(`the first open slot is ${firstSlotDays} business days away; it needs to be within ${rules.firstSlotMaxBusinessDays}.`);
    if (days.length && slots7d < rules.minSlots7d) problems.push(`there are only ${slots7d} open slots in the next 7 days; the trial needs at least ${rules.minSlots7d}.`);
  }
  if (status === 200 && Number.isFinite(lengthMin) && (lengthMin < rules.lengthMin || lengthMin > rules.lengthMax)) {
    problems.push(`meetings are set to ${lengthMin} minutes; a first call should be ${rules.lengthMin}–${rules.lengthMax} minutes.`);
  }
  return { problems, firstSlotDays, slots7d, lengthMin: Number.isFinite(lengthMin) ? lengthMin : null };
}

/** Is a test due now? From Day −4 (day1Date − 4) on, when the URL changed or the last test found problems ≥ 20 h ago. */
export function testDue(profile, trial, now) {
  if (!profile.calendarUrl || !trial.day1Date) return false;
  if (dayKeyIn(ET, now) < addDays(trial.day1Date, -4)) return false;
  if (profile.bookingTestedUrl !== profile.calendarUrl) return true;
  if (profile.bookingCheckStatus === 'problems' && profile.bookingTestAt) return now.getTime() - Date.parse(profile.bookingTestAt) >= 20 * 3600e3;
  return false;
}

/** Run the test for one client. */
export async function runBookingTest(clientId, { now = io.now(), force = false } = {}) {
  const client = await getClient(clientId);
  const profile = await getProfile(clientId);
  const trial = await getTrial(clientId);
  if (!force && !testDue(profile, trial, now)) return { skipped: 'not due' };
  const url = String(profile.calendarUrl || '');
  const rules = await cfg(clientId, 'BOOKTEST');

  let status = null;
  let finalUrl = url;
  let html = '';
  try {
    if (!isPublicUrl(url)) throw new Error('not a public web address');
    const res = await io.fetchExt(url, { timeoutMs: 10000, retry: false, redirect: 'follow', publicOnly: true, headers: { 'user-agent': 'Mozilla/5.0 (compatible; AvianceBot/1.0; +aviance.online/bot)' } });
    status = res.status;
    finalUrl = res.url || url;
    html = (await res.text()).slice(0, 500_000);
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'fetch_failed', { error: String(err?.message || err).slice(0, 160) });
  }
  const host = detectHost(finalUrl, html);
  let { slots, lengthMin } = parseEmbedded(html);
  if (host === 'calendly' && status === 200) {
    const c = await calendlyAvailability(finalUrl, now);
    if (c.slots) slots = c.slots;
    if (c.lengthMin) lengthMin = c.lengthMin;
  }
  const verdict = evaluateBooking({ status, host, slots, lengthMin }, rules, now);
  const urlChanged = profile.bookingTestedUrl && profile.bookingTestedUrl !== url;
  await kv.hset(K.profile(clientId), {
    bookingTestAt: now.toISOString(),
    bookingTestedUrl: url,
    bookingHost: host || '',
    bookingFirstSlotDays: verdict.firstSlotDays ?? '',
    bookingSlots7d: verdict.slots7d ?? '',
    bookingLengthMin: verdict.lengthMin ?? '',
    bookingProblems: JSON.stringify(verdict.problems),
    bookingCheckStatus: verdict.problems.length ? 'problems' : 'ok',
    ...(urlChanged ? { bookingTested: '0' } : {}),
  });
  await logEvent(clientId, SYSTEM, 'tested', { host, status, problems: verdict.problems.length, slotsKnown: Array.isArray(slots) });

  const base = { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId), calendarUrl: url };
  if (verdict.problems.length) {
    const tag = sha256(`${url}|${verdict.problems.join('|')}`).slice(0, 12);
    await sendClient(clientId, 'booking_fix', { ...base, problem: verdict.problems.join(' Also, ') }, { dedupe: `booking_fix:${tag}:${dayKeyIn(ET, now)}` });
    await io.alertOwner('booking_link_broken', { clientId, vars: { clientId }, body: `Booking link ${url}: ${verdict.problems.join(' ')}`, did: 'Emailed the client booking_fix; the test re-runs daily until it passes.' });
    return { problems: verdict.problems };
  }
  if (!truthy(profile.bookingTested) || urlChanged) {
    const token = await mintToken(clientId, 'bookingok', { ttl: TTL.long, data: { url } });
    await sendClient(clientId, 'booking_test_request', { ...base, link: pageUrl(token, 'booking-ok') }, { dedupe: `booking_test_request:${sha256(url).slice(0, 12)}` });
    await kv.hset(K.profile(clientId), { bookingRequestSentAt: now.toISOString() });
  }
  return { ok: true, host, firstSlotDays: verdict.firstSlotDays, slots7d: verdict.slots7d };
}

/** The client's "It worked" tap. */
export async function confirmBookingOk(rawToken, { now = io.now() } = {}) {
  const t = await readToken(rawToken, { purpose: 'bookingok' });
  if (!t) return { ok: false, error: 'This link has expired. Reply to the email and we will send a new one.' };
  const profile = await getProfile(t.clientId);
  if (truthy(profile.bookingTested)) return { ok: true, already: true };
  await kv.hset(K.profile(t.clientId), { bookingTested: '1', bookingTestedAt: now.toISOString(), bookingTestedConfirmedUrl: t.data?.url || profile.calendarUrl || '' });
  await logEvent(t.clientId, SYSTEM, 'client_confirmed', { url: t.data?.url || profile.calendarUrl });
  return { ok: true };
}

/** Daily reminder while the test request is untapped (warming / ready only). */
export async function runBookingReminder({ clientId, now = io.now() }) {
  const client = await getClient(clientId);
  if (!client || !['warming', 'ready'].includes(client.state)) return { skipped: 'state' };
  const profile = await getProfile(clientId);
  if (!profile.bookingRequestSentAt || truthy(profile.bookingTested) || profile.bookingCheckStatus !== 'ok') return { skipped: 'nothing to remind' };
  const today = dayKeyIn(ET, now);
  if (dayKeyIn(ET, new Date(profile.bookingRequestSentAt)) === today) return { skipped: 'sent today' };
  const token = await mintToken(clientId, `bookingok:${today}`, { ttl: TTL.long, data: { url: profile.calendarUrl } });
  await sendClient(clientId, 'booking_test_request', { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId), calendarUrl: profile.calendarUrl, link: pageUrl(token, 'booking-ok') }, { dedupe: `booking_test_request:${today}` });
  const sent = asArray(profile.bookingRemindersSent);
  await kv.hset(K.profile(clientId), { bookingRemindersSent: JSON.stringify([...sent, today].slice(-30)) });
  await logEvent(clientId, SYSTEM, 'reminder_sent', {});
  return { reminded: true };
}
