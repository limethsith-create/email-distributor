/**
 * The trial agreement (SPEC §6.2) — Section 9 of *The 30-Day Trial*, verbatim.
 * Bracketed fields are slots: {Company}, {date} (effective date), {usHours}
 * (the owner's US hours from OWNER.usHours), {signerName} (OWNER.signerName)
 * and {clientSignature}. `renderAgreement` refuses to render with any slot
 * empty — the onboarding page must not show an agreement without a signer.
 *
 * Note: clauses 3 and 7 still mention the kickoff call and the day-30 call;
 * SPEC §16 #8/#9 replace those calls with the approval and decision pages and
 * say the clause wording is to be updated by the owner. It is left verbatim
 * until the owner changes it (docs/assumptions/stage-a.md).
 */

import { fill } from '@/lib/templates/render';
import { sha256 } from '@/lib/crypto';

export const AGREEMENT_VERSION = '2026-09-12';

export const AGREEMENT_TEXT = `The Aviance 30-Day Trial — Agreement
Between Aviance (“we”) and {Company} (“you”). Effective {date}.

1. What this is. A 30-day cold email trial. We build and run a small outbound campaign in your name, book sales calls onto your calendar, and hand you a written report of what your market said. It costs you nothing. It is not a paid plan; it is how you decide whether to buy one.

2. What we do. Register one sending domain and two inboxes. Research and verify a list of 300–500 contacts matching the customer profile you approve. Write a three-email sequence you approve. Send for 30 days. Handle every reply. Book, confirm and remind every meeting, and chase no-shows for 14 days. Send you a written update every Friday, and on day 29 a report covering the numbers, every reply we received and what it means.

3. What you do. Approve the customer profile and the copy on the kickoff call. Keep at least five open slots a week on the calendar you give us, and be able to take a booked meeting within five business days. Reply to any hot lead we hand you within one business day. Give us the postal address for the email footer. Authorise us to send email in your company’s name, from the trial domain, using only copy you approved.

4. The two promises. First: we will contact the approved list and give you the written report — that is guaranteed. Second: if no qualified booked call has been held by the end of the 30 days, we keep sending at our cost until one is, for up to 30 further days, after which the trial ends. Both promises hold while you hold up clause 3. If you stop responding for five business days, the trial ends and the promises end with it.

5. What counts as a qualified booked call. All four must be true: the company matches the approved profile; the attendee holds an approved title; they attended; they booked in response to outreach describing your offer. Budget, timeline, level of interest and whether they buy do not affect whether a call counts. No-shows do not count; we re-book them for 14 days. You may flag a call as not qualifying within 24 business hours, in writing, stating which criterion it failed.

6. The exchange. The trial is free, so its price is proof. You agree to: (a) leave a review of the trial on Clutch, or a platform we both agree, within seven days of the day-30 call. That review may be positive or negative, must be your honest opinion, and must begin with the words “I received this service for free for my review.” We will never ask you to change or remove it; (b) if at least one qualified call was held, allow us to quote you by name, title and company, using words you approve in writing before publication; (c) allow us to publish the trial’s numbers — companies contacted, replies, calls booked — as a case study, anonymised if you prefer; (d) give us ten minutes at the end for an honest debrief, whatever the outcome. We will never publish anything you have not approved in writing, and we will never ask you to say anything you do not mean.

7. Day 31. On the day-30 call you decide whether to continue on one of our plans: Starter $2,497 for 10 guaranteed booked calls a month, Growth $3,997 for 20, or Scale $8,497 for 50 — month to month, 14 days’ notice to cancel, no setup fee, on the terms published at aviance.online. We will recommend one of them based on what the trial measured and how many calls a week you told us you can handle. If you continue, the trial domain, inboxes and list carry into your plan and campaigns stay live. If you don’t, we retire the trial domain and inboxes within seven days and never use them for anyone else. There is no obligation to continue and nothing to cancel.

8. Ownership and data. Your leads, replies and booked meetings are yours, exported on request, whether or not you continue. The sending domain and inboxes are registered by us and stay ours. Our methods, templates and tools stay ours. We do not sell or share your data.

9. Limits. One trial per company. One profile, one sequence, one segment. We may end the trial if the outreach would breach Google’s sending rules or ours, or if clause 3 is not met.

10. Where we are. Aviance is run from Sri Lanka. Working hours in your time zone: {usHours} US Eastern, Monday to Friday. Replies are handled inside those hours; hot leads the same day.

Signed for Aviance: {signerName}
Signed for {Company}: {clientSignature}`;

/** 'HH:MM' pair → '09:00–17:00'. */
export function usHoursText(hours) {
  const [a, b] = Array.isArray(hours) ? hours : String(hours || '').split(/[-–]/);
  return a && b ? `${String(a).trim()}–${String(b).trim()}` : '';
}

/**
 * Fill the agreement. `clientSignature` defaults to a blank line for display
 * before acceptance. Throws TemplateError when company, date, hours or signer
 * is missing.
 */
export function renderAgreement({ company, date, usHours, signerName, clientSignature = '______________________   Name, title, date' }) {
  return fill('agreement', AGREEMENT_TEXT, { Company: company, date, usHours: usHoursText(usHours), signerName, clientSignature });
}

/** Stable fingerprint of the exact text accepted (stored with the acceptance). */
export const agreementHash = (text) => sha256(text);
