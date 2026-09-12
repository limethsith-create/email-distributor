/**
 * Email copy — Aviance
 *
 * FRESH START (Sep 2026). The old two-campaign copy (the "offer" / guaranteed-
 * calls pitch and the "free-leads" / SEND-IT hook) has been removed. The
 * business is moving to the 30-Day Trial model — one offer, one sequence,
 * one segment — so this module now holds a single, neutral three-touch
 * scaffold that keeps the sending engine working while the real Sequence T
 * copy is written and dropped in.
 *
 * The engine calls `getEmailForSequenceDay(lead, day)` for day 0 / 3 / 7 and
 * expects `{ subject, body, variant, template }`. Follow-ups (day 3, day 7)
 * reuse the original subject as "Re: …" — that threading is handled by the
 * sender, so here the follow-ups just carry their own body.
 *
 * Placeholders filled per lead: {first name}, {company}. Every body ends with
 * a plain-text unsubscribe line after a `---` separator (the sender splits on
 * it and renders a footer). Keep bodies plain: no images, no links in the
 * first email, under ~110 words, one question, one reply-based CTA.
 *
 * To go live with the trial, replace the three PLACEHOLDER bodies below with
 * Sequence T from the strategy doc (and, if you add a 4th touch, extend the
 * sender's timing). Nothing else in the engine needs to change.
 */

const SITE = 'aviance.online';
const SIGN_OFF = '— The Aviance Team';
const UNSUB = 'Not the right fit? Just reply STOP and I will not email you again.';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function firstNameOf(lead) {
  const fn = String(lead?.first_name || '').trim().split(/\s+/)[0];
  if (fn) return fn;
  const nm = String(lead?.name || '').trim().split(/[\s,]+/)[0];
  return nm || '';
}

function companyOf(lead) {
  return String(lead?.company_name || lead?.company || '').trim() || 'your company';
}

function greeting(lead) {
  const name = firstNameOf(lead);
  return name ? `Hi ${name},` : 'Hi there,';
}

// ---------------------------------------------------------------------------
// The single sequence — PLACEHOLDER copy. Replace the bodies with Sequence T.
// ---------------------------------------------------------------------------

function day0(lead) {
  const company = companyOf(lead);
  return {
    subject: `quick question for ${company}`,
    body: `${greeting(lead)}

[PLACEHOLDER — replace with Sequence T, email 1.]

This account is set up and sending, but the trial copy has not been written in yet. Until it is, no real outreach should be switched on.

Worth a short reply?

${SIGN_OFF}
${SITE}
---
${UNSUB}`,
    variant: 'placeholder-d0',
    template: 'placeholder',
  };
}

function day3(lead) {
  return {
    subject: `re: ${companyOf(lead)}`,
    body: `${greeting(lead)}

[PLACEHOLDER — replace with Sequence T, follow-up 1.]

${SIGN_OFF}
${SITE}
---
${UNSUB}`,
    variant: 'placeholder-d3',
    template: 'placeholder',
  };
}

function day7(lead) {
  return {
    subject: `re: ${companyOf(lead)}`,
    body: `${greeting(lead)}

[PLACEHOLDER — replace with Sequence T, breakup.]

${SIGN_OFF}
${SITE}
---
${UNSUB}`,
    variant: 'placeholder-d7',
    template: 'placeholder',
  };
}

// ---------------------------------------------------------------------------
// Public entry points used by the sending engine
// ---------------------------------------------------------------------------

export function generateEmailSequence(lead) {
  return { day0: day0(lead), day3: day3(lead), day7: day7(lead) };
}

/** Return the right email for a lead based on its sequence day (0 / 3 / 7). */
export function getEmailForSequenceDay(lead, sequenceDay) {
  const sequence = generateEmailSequence(lead);
  if (sequenceDay === 3) return sequence.day3;
  if (sequenceDay === 7) return sequence.day7;
  return sequence.day0;
}
