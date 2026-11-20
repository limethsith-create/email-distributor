/**
 * The plan agreement every client signs (SPEC §6.2): Starter / Growth / Scale.
 * Bracketed fields are slots: {Company}, {date} (effective date), {usHours}
 * (the owner's US hours from OWNER.usHours), {signerName} (OWNER.signerName),
 * {planName}, {price}, {calls} and {clientSignature}. `renderPaidAgreement`
 * refuses to render with any slot empty — the onboarding page must not show an
 * agreement without a signer. Still marked a draft: have a lawyer read it.
 */

import { fill } from '@/lib/templates/render';
import { sha256 } from '@/lib/crypto';

export const PAID_AGREEMENT_VERSION = 'plan-2026-09-28-draft';

export const PAID_AGREEMENT_TEXT = `Aviance — {planName} Plan Agreement
Between Aviance (“we”) and {Company} (“you”). Effective {date}.

1. What this is. A done-for-you cold email service on the {planName} plan: {price} a month for {calls} booked sales calls a month. We build and run outbound campaigns in your name and book sales calls onto your calendar.

2. What we do. Register sending domains and inboxes for you. Research and verify contacts matching the customer profile you approve. Write email sequences you approve. Send them, handle every reply, and book, confirm and remind every meeting, chasing no-shows for 14 days. Send you a written update every Friday.

3. What you do. Approve the customer profile and the copy. Keep enough open slots on the calendar you give us to take the calls your plan books, and be able to take a booked meeting within five business days. Reply to any hot lead we hand you within one business day. Give us the postal address for the email footer. Authorise us to send email in your company’s name, from the domains we set up, using only copy you approved.

4. What counts as a booked call. All four must be true: the company matches the approved profile; the attendee holds an approved title; they attended; they booked in response to outreach describing your offer. No-shows do not count; we re-book them for 14 days. You may flag a call as not qualifying within 24 business hours, in writing, stating which criterion it failed.

5. Price and term. {price} a month, month to month, billed monthly in advance. 14 days’ notice to cancel. No setup fee. On the terms published at aviance.online.

6. Ownership and data. Your leads, replies and booked meetings are yours, exported on request. The sending domains and inboxes are registered by us and stay ours. Our methods, templates and tools stay ours. We do not sell or share your data.

7. Limits. We may pause or end the service if the outreach would breach Google’s sending rules or ours, or if clause 3 is not met.

8. Where we are. Aviance is run from Sri Lanka. Working hours in your time zone: {usHours} US Eastern, Monday to Friday. Replies are handled inside those hours; hot leads the same day.

Signed for Aviance: {signerName}
Signed for {Company}: {clientSignature}`;

/** The plan agreement, filled. `plan` = { name, price, calls }. Throws TemplateError on any missing slot. */
export function renderPaidAgreement({ company, date, usHours, signerName, plan, clientSignature = '______________________   Name, title, date' }) {
  return fill('agreement', PAID_AGREEMENT_TEXT, {
    Company: company, date, usHours: usHoursText(usHours), signerName, clientSignature,
    planName: plan?.name, price: plan?.price != null ? `$${Number(plan.price).toLocaleString('en-US')}` : '', calls: plan?.calls,
  });
}

/** 'HH:MM' pair → '09:00–17:00'. */
export function usHoursText(hours) {
  const [a, b] = Array.isArray(hours) ? hours : String(hours || '').split(/[-–]/);
  return a && b ? `${String(a).trim()}–${String(b).trim()}` : '';
}

/** Stable fingerprint of the exact text accepted (stored with the acceptance). */
export const agreementHash = (text) => sha256(text);

/**
 * The service agreement emailed after a yes on the sales call (systems/agreementsend.js), with the
 * month-one invoice. Plain English, from the owner's "Aviance Client Service Agreement" draft; plan,
 * price and calls come from config PLANS. Paying the invoice counts as accepting it. Still a draft:
 * have a lawyer read it (the governing-law line waits on where Aviance Inc. is registered).
 */
export const SERVICE_AGREEMENT_VERSION = 'service-2026-11-20-draft';

export const SERVICE_AGREEMENT_TEXT = `Aviance Client Service Agreement
Agreement {agreementNo} · issued {issuedDate}

Between Aviance Inc. ("Aviance", "we") and {Company} ("you"), for {contactName} ({contactEmail}).
It starts on the date you accept it or pay the first invoice, whichever comes first.

Plan: {planName}
Booked calls a month: {calls}
Price: {price} USD a month, month to month
Setup fee: none

1. What we deliver
We build and run a cold email program that books sales calls for you: sending domains, warmed inboxes, a verified prospect list, the emails, and handling replies until a call is booked. Campaigns go live within 14 days of kickoff. We aim to book {calls} calls for you each month.

What counts as a booked call. All four must be true:
  1. The prospect matches the ideal customer profile you approved in writing.
  2. The prospect came from our outreach.
  3. The meeting is booked on your calendar.
  4. The prospect shows up.
No-shows do not count, and we replace them at no cost. If you miss a call we booked, it still counts. Whether a prospect buys, or their budget and timing, never decides whether a call counts.

2. Price and payment
You pay {price} USD a month, in advance. The first invoice comes with this agreement; work starts (day 1 of kickoff) once it is paid. Each later month is billed on the same date and is due within 5 days. If a payment is more than 7 days late we may pause sending until it arrives; paused days don't count toward any guarantee. Prices exclude any taxes or payment fees on your side.
Paying the first invoice means you accept this agreement, even if you have not replied to say so.

3. Our guarantees
  - Fewer than {calls} booked calls in your first month: we refund twice what you paid for that month.
  - Fewer than {calls} in any later month: that month's fee is refunded in full.
  - Campaigns not live within 14 days of kickoff: your next month is free.
  - A prospect doesn't show up: a replacement call at no cost.
We count calls on the last day of each month and send you the count. If a guarantee applies, we refund within 10 business days. Refunds and free months are your only remedy for a missed number. The guarantees hold while you do your part (section 4); they pause for any day we are waiting on you, any day sending is paused at your request, and any day a payment is late.

4. Your part
  - Approve your ideal customer profile and the first emails within 48 hours of us sending them. After one reminder and another 48 hours, silence counts as approval.
  - Keep the calendar we book into working, and show up to booked calls.
  - Confirm your offer is legal and true, and that you may sell it to the people we contact.

5. Length and cancelling
Month to month. Either side can cancel with 14 days' written notice (email is fine) before the next billing date. If we miss your number two months in a row, you can cancel at once, with no notice. We can end the agreement at once if a payment is more than 14 days late or your offer breaks the law.

6. Data and confidentiality
Your prospect list, replies and booked calls are yours to export any time. We never reuse them for another client, and we delete our copy 30 days after you leave. The sending domains and inboxes stay ours. Both sides keep the other's business information private.

7. Limits
We guarantee booked calls, not sales or revenue from them. Our total liability is capped at the fees you paid in the 3 months before a claim, plus any guarantee refund owed. Neither side is liable for indirect or lost-profit damages. We send email in line with anti-spam laws such as CAN-SPAM, with a working opt-out.

8. General
This is the whole agreement; changes must be in writing and accepted by both sides. Accepting by email or by paying the first invoice is binding.

For Aviance Inc.: {signerName}, Founder
For {Company}: accepted by replying "I agree" or by paying the first invoice`;

/** The service agreement, filled. Throws TemplateError on any missing slot (nothing goes out with a hole). */
export function renderServiceAgreement({ company, contactName, contactEmail, agreementNo, issuedDate, signerName, plan }) {
  return fill('service_agreement', SERVICE_AGREEMENT_TEXT, {
    Company: company, contactName, contactEmail, agreementNo, issuedDate, signerName,
    planName: plan?.name, price: plan?.price != null ? `$${Number(plan.price).toLocaleString('en-US')}` : '', calls: plan?.calls,
  });
}

/** The same agreement as a small printable page (the email's attachment). */
export function serviceAgreementHtml(text, title = 'Aviance Client Service Agreement') {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;font-size:15px;line-height:1.6;color:#111"><div style="white-space:pre-wrap">${esc(text)}</div></body></html>`;
}
