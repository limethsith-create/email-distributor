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
