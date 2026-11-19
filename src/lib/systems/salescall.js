/**
 * Sales calls booked on the public website (docs/CALENDAR.md "Sales calls").
 *
 * The owner's words: "when a person books through the website it should show up
 * in my calendar in the hub, an email should go out to them with the details,
 * reminders should keep going, and the hub should show which stage each of
 * these people is in."
 *
 *  - bookAndConfirm: an inquiry with a time → a confirmed `sales` meeting in the
 *    Calendar (with its Google Meet when Google is set up) → the confirmation
 *    email with a calendar invite, from the onboarding-call inbox. Never throws:
 *    the inquiry is already saved; what failed is written on it and the owner
 *    is told.
 *  - runSalesReminders (a global tick job): "tomorrow" ~24 h before (only when
 *    they booked more than a day ahead) and "in 1 hour" ~60 min before, while
 *    the inquiry is still at Booked and the meeting confirmed. Each goes once.
 *  - afterCalendarAction: the owner pressed Call done / No-show / Cancel / moved
 *    the call in the Calendar → the inquiry's stage follows; a move emails the
 *    new time with an updated invite.
 *  - meetingForStage: the owner moved the inquiry to Call done / No-show in
 *    Inquiries → the Calendar follows.
 *
 * No AI anywhere. Emails go straight to the address they typed (they are not a
 * client yet), deduped per meeting + email + time so a retry never sends twice.
 */

import { kv } from '@vercel/kv';
import { logEvent } from '@/lib/db/events';
import { io, firstNameOf, ownerName } from '@/lib/systems/intake-io';
import { onboardSender } from '@/lib/notify';
import { sendEmail, newMessageId } from '@/lib/mailer';
import { renderTemplate } from '@/lib/templates/client';
import * as cal from '@/lib/systems/calendar';
import { getInquiry, patchInquiry, setInquiryStatus, inferPlan } from '@/lib/systems/inquiries';
import { designedSalesHtml } from '@/lib/templates/client/salesDesigned';

const SYSTEM = 'sales';
const H = 3600e3;
const MIN = 60e3;

/** What the tests replace: the inbox that sends, and the send itself. */
export const salesIo = {
  sender: () => onboardSender(),
  send: (account, mail) => sendEmail(account, mail),
};

/** When each reminder goes, relative to the call's start. */
export const REMINDERS = [
  // The day before — only when they booked more than ~a day ahead (else the confirmation is fresh).
  { key: 'sales_call_tomorrow', field: 'tomorrow', opensBefore: 24 * H, closesBefore: 3 * H, minLead: 26 * H },
  // An hour before (stops 10 minutes out, where the 5-minute one takes over).
  { key: 'sales_call_soon', field: 'soon', opensBefore: 60 * MIN, closesBefore: 10 * MIN, minLead: 0 },
  // Five minutes before: a short "starting soon" — only when they booked more than 15 minutes ahead.
  { key: 'sales_call_now', field: 'now', opensBefore: 5 * MIN, closesBefore: 0, minLead: 15 * MIN },
];

const PLAN_CALLS = { starter: 5, growth: 10, scale: 15 };
const cap = (w) => String(w || '')[0].toUpperCase() + String(w || '').slice(1);

/** The plan line of the confirmation, from the plan card they came from, else the calls a month they said they could take. */
export function planLineFor(inq = {}) {
  const plan = inferPlan(inq);
  return plan
    ? `Your guaranteed number (${cap(plan)} is ${PLAN_CALLS[plan]} booked calls a month) and what it would cost`
    : 'Your guaranteed number (5, 10 or 15 booked calls a month) and what it would cost';
}

export const GUARANTEE_LINE = 'And the guarantee: if we miss your number in month one, we refund double what you paid. Miss it in any month after, and that month is refunded in full.';

/** Send one sales-call email to the person who booked. Deduped by `dedupe`. → { sent, deduped?, messageId? } */
async function sendSales(m, key, vars, { icalEvent = null, dedupe, now = io.now() } = {}) {
  if (!m.email) return { sent: false, skipped: 'no email' };
  const dk = `sales:mail:${m.id}:${dedupe || key}`;
  if ((await kv.set(dk, now.toISOString(), { nx: true, ex: 120 * 86400 })) !== 'OK') return { sent: false, deduped: true };
  try {
    const account = await salesIo.sender();
    if (!account) throw new Error('no inbox to send from — set the onboarding inbox in Settings');
    const full = { firstName: firstNameOf(m.person) || 'there', ownerName: await ownerName(null), company: m.company || 'your business', ...vars };
    const msg = renderTemplate(key, full);
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // The branded design for the confirmation and the three reminders; the plain version for everything else.
    const link = (/^Join here:\s*(\S+)/.exec(String(full.linkLine || '')) || [])[1] || null;
    const end = new Date(Date.parse(m.start) + (Number(m.minutes) || 15) * MIN).toISOString();
    const html = designedSalesHtml(key, { ...full, link, replyTo: account.email, start: m.start, end })
      || `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(msg.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`;
    const res = await salesIo.send(account, {
      to: m.email, subject: msg.subject, text: msg.text, html,
      transactional: true, noTrack: true, messageId: newMessageId(account.email),
      ...(icalEvent ? { icalEvent } : {}),
    });
    if (!res || !res.success) throw new Error(res?.error || 'the inbox did not take it');
    await logEvent(null, SYSTEM, 'email_sent', { meetingId: m.id, inquiryId: m.inquiryId, key, to: m.email });
    return { sent: true, messageId: res.messageId || null, from: account.email };
  } catch (err) {
    await kv.del(dk);
    await logEvent(null, SYSTEM, 'email_failed', { meetingId: m.id, inquiryId: m.inquiryId, key, error: String(err?.message || err).slice(0, 200) });
    throw err;
  }
}

/**
 * The inquiry has a time: put the call in the Calendar and email them the
 * confirmation. Never throws. → { meeting, clash, emailed, error }
 */
export async function bookAndConfirm(inq, { now = io.now() } = {}) {
  const out = { meeting: null, clash: null, emailed: false, error: null };
  if (!inq?.slotStart) return out;
  const minutes = inq.slotEnd ? Math.round((Date.parse(inq.slotEnd) - Date.parse(inq.slotStart)) / MIN) : 15;
  try {
    const r = await cal.bookSalesCall({
      inquiryId: inq.id, company: inq.company, person: inq.name, email: inq.email, start: inq.slotStart, minutes,
      theirZone: inq.theirTz, note: inq.sells, linkedClientId: inq.clientId || null,
    }, { now });
    out.meeting = r.meeting;
    out.clash = r.clash;
  } catch (err) {
    out.error = `Could not put it in the Calendar: ${String(err?.message || err).slice(0, 160)}`;
    await patchInquiry(inq.id, { calendarError: out.error }).catch(() => {});
    return out;
  }
  const m = out.meeting;
  const fields = { meetingId: m.id, meetLink: m.meetLink || null };
  try {
    const v = await cal.salesVars(m);
    const r = await sendSales(m, 'sales_call_confirmed', { ...v, planLine: planLineFor(inq), guaranteeLine: GUARANTEE_LINE },
      { icalEvent: await cal.salesInvite(m, { now }), dedupe: `confirmed:${m.start}`, now });
    if (r.sent || r.deduped) { out.emailed = true; fields.confirmationSentAt = now.toISOString(); fields.confirmationError = null; }
  } catch (err) {
    out.error = String(err?.message || err).slice(0, 200);
    fields.confirmationError = out.error;
  }
  await patchInquiry(inq.id, fields).catch(() => {});
  return out;
}

/** Which reminder is due for this meeting at `now` (the latest that is open and not yet sent), or null. Pure. */
export function dueSalesReminder(m, now = new Date()) {
  if (!m || m.kind !== 'sales' || m.status !== 'confirmed') return null;
  const start = Date.parse(m.start);
  if (!Number.isFinite(start)) return null;
  const booked = Date.parse(m.createdAt || m.confirmedAt || m.start);
  const t = now.getTime();
  const sent = m.reminders || {};
  let due = null;
  for (const r of REMINDERS) {
    if (sent[r.field]) continue;
    if (start - booked < r.minLead) continue;
    if (t >= start - r.opensBefore && t < start - r.closesBefore) due = r;
  }
  return due;
}

/**
 * The tick job: every sales call starting in the next ~25 hours gets the
 * reminder that is due — only while its inquiry is still at Booked.
 * → { checked, sent, failed }
 */
export async function runSalesReminders({ now = io.now() } = {}) {
  const meetings = await cal.meetingsBetween(now.getTime() - H, now.getTime() + 25 * H);
  let checked = 0; let sent = 0; let failed = 0;
  for (const m of meetings) {
    const r = dueSalesReminder(m, now);
    if (!r) continue;
    checked++;
    const inq = m.inquiryId ? await getInquiry(m.inquiryId) : null;
    if (!inq || inq.status !== 'new') continue;
    try {
      const vars = await cal.salesVars(m);
      // Five minutes out, "I'll send the link before the call" is too late: offer it by reply instead.
      if (r.field === 'now' && !/^Join here:/.test(vars.linkLine)) vars.linkLine = "If you don't have the video link yet, reply to this email and I'll send it straight away.";
      const res = await sendSales(m, r.key, vars, { dedupe: `${r.field}:${m.start}`, now });
      const at = now.toISOString();
      await cal.patchMeeting(m.id, { reminders: { ...(m.reminders || {}), [r.field]: at } }, { now });
      await patchInquiry(inq.id, { [`reminded_${r.field}`]: at });
      if (res.sent) sent++;
    } catch (err) {
      failed++;
      await io.alertOwner('sales_reminder_failed', {
        scope: `${m.id}:${r.field}`, url: `/#inquiry/${inq.id}`,
        vars: { company: m.company || inq.company },
        body: `The ${r.field === 'now' ? '5-minute' : r.field === 'soon' ? '1-hour' : 'day-before'} reminder to ${m.person || m.email} (${m.company}) did not send: ${String(err?.message || err).slice(0, 200)}`,
        did: 'Nothing was sent. Write to them yourself if the call is soon.',
      }).catch(() => {});
    }
  }
  const retried = await retryHeldConfirmations({ now });
  return { checked, sent, failed, retried };
}

/**
 * A confirmation that could not go when they booked (no signer name yet, no inbox, the inbox refused)
 * goes on a later tick once the cause is fixed — at most every 15 minutes per call, only while the
 * call is still ahead and the inquiry still at Booked. Never throws. → how many went.
 */
export async function retryHeldConfirmations({ now = io.now() } = {}) {
  let sent = 0;
  try {
    const meetings = await cal.meetingsBetween(now.getTime() + 10 * MIN, now.getTime() + 60 * 24 * H);
    for (const m of meetings) {
      if (m.kind !== 'sales' || m.status !== 'confirmed' || !m.inquiryId) continue;
      const inq = await getInquiry(m.inquiryId);
      if (!inq || inq.status !== 'new' || inq.confirmationSentAt || !inq.confirmationError) continue;
      if ((await kv.set(`sales:retry:${m.id}`, now.toISOString(), { nx: true, ex: 900 })) !== 'OK') continue;
      try {
        const v = await cal.salesVars(m);
        const r = await sendSales(m, 'sales_call_confirmed', { ...v, planLine: planLineFor(inq), guaranteeLine: GUARANTEE_LINE },
          { icalEvent: await cal.salesInvite(m, { now }), dedupe: `confirmed:${m.start}`, now });
        if (r.sent || r.deduped) {
          await patchInquiry(inq.id, { confirmationSentAt: now.toISOString(), confirmationError: null });
          if (r.sent) sent++;
        }
      } catch (err) {
        await patchInquiry(inq.id, { confirmationError: String(err?.message || err).slice(0, 200) }).catch(() => {});
      }
    }
  } catch { /* the next tick tries again */ }
  return sent;
}

/** The owner changed the sales call in the Calendar: the inquiry follows; a new time is emailed. Never throws. */
export async function afterCalendarAction(m, action, { now = io.now() } = {}) {
  try {
    const inq = await getInquiry(m.inquiryId);
    if (!inq) return null;
    const open = !['won', 'lost'].includes(inq.status);
    if (action === 'held' && open) await setInquiryStatus(inq.id, 'held', '', { now, fromCalendar: true });
    else if (action === 'noShow' && open) await setInquiryStatus(inq.id, 'no_show', '', { now, fromCalendar: true });
    else if (action === 'cancel' && inq.status === 'new') await setInquiryStatus(inq.id, 'lost', 'Call cancelled in the Calendar', { now, fromCalendar: true });
    else if (action === 'move' && m.status === 'confirmed') {
      // A new time: the reminders start over for it, and they get the new time with an updated invite.
      const fresh = await cal.patchMeeting(m.id, { reminders: {} }, { now });
      try {
        await sendSales(fresh, 'sales_call_moved', await cal.salesVars(fresh), { icalEvent: await cal.salesInvite(fresh, { now }), dedupe: `moved:${fresh.start}`, now });
        await patchInquiry(inq.id, { slotStart: fresh.start, slotEnd: new Date(Date.parse(fresh.start) + (fresh.minutes || 15) * MIN).toISOString(), reminded_tomorrow: null, reminded_soon: null, reminded_now: null });
      } catch (err) {
        await io.alertOwner('sales_reminder_failed', { scope: `${m.id}:moved:${fresh.start}`, url: `/#inquiry/${inq.id}`, vars: { company: m.company }, body: `The new-time email to ${m.person || m.email} did not send: ${String(err?.message || err).slice(0, 200)}`, did: 'The Calendar has the new time. Tell them yourself.' }).catch(() => {});
      }
    }
    return true;
  } catch { return null; }
}

/** The owner moved the inquiry to Call done / No-show in Inquiries: the Calendar follows. Never throws. */
export async function meetingForStage(inq, status, { now = io.now() } = {}) {
  if (!inq?.meetingId || !['held', 'no_show'].includes(status)) return null;
  try {
    const m = await cal.getMeeting(inq.meetingId);
    if (!m || m.kind !== 'sales' || m.status === status || !['confirmed', 'held', 'no_show'].includes(m.status)) return m;
    return await cal.patchMeeting(m.id, { status }, { now, historyStep: status });
  } catch { return null; }
}
