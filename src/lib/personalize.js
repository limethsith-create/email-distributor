/**
 * Email Personalization Engine — Aviance
 *
 * TWO campaigns run simultaneously; every lead carries a `campaign` field
 * ('offer' by default) and the engine returns that campaign's sequence:
 *
 *  CAMPAIGN 'offer'      — the direct pitch: guaranteed booked sales calls,
 *                          in writing. Live in 3 weeks or the next month is
 *                          free · no-shows replaced · shortfalls roll over ·
 *                          no setup fee · month-to-month.
 *  CAMPAIGN 'free-leads' — the goodwill hook: 5 qualified, researched leads
 *                          for the prospect's market, free, delivered on a
 *                          one-word reply ("SEND IT"). Proves the targeting
 *                          before any pitch.
 *
 * Voice rules (finalized Sep 2026): official and composed — a firm writing,
 * not a hustler. Short paragraphs, zero hype, the guarantee stated as terms
 * rather than promises. Sign-off is always "— The Aviance Team".
 */

import { geminiGenerate } from '@/lib/gemini';

const SITE = 'aviance.online';

// ---------------------------------------------------------------------------
// Campaign selection
// ---------------------------------------------------------------------------

export function campaignFor(lead) {
  return String(lead?.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer';
}

// ---------------------------------------------------------------------------
// Subject pools — short, specific, stated like a document title, not a hook.
// ---------------------------------------------------------------------------

const OFFER_SUBJECTS_NAMED = [
  '{{first_name}} — booked sales calls, in writing',
  '{{first_name}} — a written guarantee on your pipeline',
  '{{first_name}} — guaranteed calls for {{company_name}}',
];
const OFFER_SUBJECTS_COMPANY = [
  '{{company_name}} — booked sales calls, in writing',
  'a written pipeline guarantee for {{company_name}}',
];
const OFFER_SUBJECTS_NEUTRAL = [
  'booked sales calls — in writing',
  'a written guarantee on your pipeline',
];

const FREE_SUBJECTS_NAMED = [
  '{{first_name}} — 5 qualified leads for {{company_name}}, on us',
  '{{first_name}} — 5 ready buyers for {{company_name}}',
];
const FREE_SUBJECTS_COMPANY = [
  '5 qualified leads for {{company_name}} — free',
  '{{company_name}} — 5 ready buyers, on us',
];
const FREE_SUBJECTS_NEUTRAL = [
  '5 qualified leads — on us',
];

// ---------------------------------------------------------------------------
// Per-industry angle for the OFFER campaign
//   pain  = the pipeline pain that opens day 0
//   proof = the one-line peer proof used on day 3
// ---------------------------------------------------------------------------

const INDUSTRY_TEMPLATES = {
  msp: {
    pain: 'Every MSP knows the quarter where referrals dry up and the pipeline goes quiet.',
    proof: 'the last MSP we ran this for went from referral-only to a full calendar of booked discovery calls',
  },
  'it services': {
    pain: 'IT firms grow on word of mouth — until the month it stalls and new-client flow goes flat.',
    proof: 'an IT services firm we work with took 14 qualified calls in their first month',
  },
  technology: {
    pain: 'Strong product, quiet pipeline — outbound is the function that never quite gets built.',
    proof: "we filled a technology team's calendar with 15 qualified demos in a single month",
  },
  saas: {
    pain: 'Growth stalls the moment outbound slows, and an SDR team is slow and expensive to build.',
    proof: 'a SaaS client takes 18 booked demos a month from us, with no internal SDRs',
  },
  finance: {
    pain: 'The right buyers exist; nobody inside the firm has the hours to prospect them consistently.',
    proof: 'we booked a finance firm 11 calls in a month, every one matching their client profile',
  },
  consulting: {
    pain: 'Consulting pipelines run feast-or-famine — you are either delivering or hunting, never both.',
    proof: 'we booked a consulting firm 12 discovery calls in a month, fully hands-off',
  },
  agency: {
    pain: 'You sell growth to clients while your own new-business pipeline runs dry between referrals.',
    proof: "we filled an agency's calendar with 15 booked calls in a month",
  },
  marketing: {
    pain: 'You sell growth to clients while your own new-business pipeline runs dry between referrals.',
    proof: 'we booked an agency 15 qualified calls in a month with in-market prospects',
  },
};

const DEFAULT_TEMPLATE = {
  pain: 'A steady flow of new-business calls is hard to sustain when no one owns outbound.',
  proof: "we recently filled a B2B company's calendar with 15 qualified sales calls in one month",
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function templateFor(lead) {
  const key = (lead.industry || '').toLowerCase().trim();
  if (INDUSTRY_TEMPLATES[key]) return INDUSTRY_TEMPLATES[key];
  if (/\bmsp\b|managed\s*it|managed\s*service|it\s*support|it\s*service|network|cyber|security|computer|telecom|cloud|\bit\b|information\s*technology/i.test(key)) {
    return INDUSTRY_TEMPLATES.msp;
  }
  for (const k of Object.keys(INDUSTRY_TEMPLATES)) {
    if (key.includes(k)) return INDUSTRY_TEMPLATES[k];
  }
  return DEFAULT_TEMPLATE;
}

function subjectFrom(pool, lead, company) {
  return pickRandom(pool)
    .replace(/{{company_name}}/g, company)
    .replace(/{{first_name}}/g, (lead.first_name || '').trim());
}

function pickPool(lead, named, companyPool, neutral) {
  const name = (lead.first_name || '').trim();
  if (name) return named;
  if (lead.company_name || lead.company) return companyPool;
  return neutral;
}

const SIGNATURE = '— The Aviance Team\nGuaranteed booked sales calls · aviance.online';

// ---------------------------------------------------------------------------
// CAMPAIGN 'offer' — the direct pitch
// ---------------------------------------------------------------------------

function offerDay0(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = (lead.first_name || '').trim();
  const hi = name ? `Hi ${name},` : 'Hello,';

  const subject = subjectFrom(
    pickPool(lead, OFFER_SUBJECTS_NAMED, OFFER_SUBJECTS_COMPANY, OFFER_SUBJECTS_NEUTRAL),
    lead, company
  );

  const body = `${hi}

${t.pain}

Aviance exists for exactly that problem. We build and operate your entire outbound engine — domains, warmed inboxes, verified prospect lists, copywriting, sending and reply handling — and we put the result in writing: a guaranteed number of booked sales calls on ${company}'s calendar, live within 3 weeks, or your next month is free.

The terms are deliberately simple. No-shows are replaced at no charge. Any monthly shortfall rolls over until delivered. There is no setup fee, and the engagement is month-to-month. The one-pager below carries the full terms and current founding-client rates.

If a predictable calendar matters to ${company} this quarter, reply to this email — or take 15 minutes with us via ${SITE}.

${SIGNATURE}`;

  return { subject, body };
}

function offerDay3(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

A short follow-up, with proof in hand: ${t.proof}.

The same written commitment is on the table for ${company} — a guaranteed number of booked calls each month, live within 3 weeks or your next month is free, no-shows replaced, shortfalls rolled over until delivered. One founding-client rate, locked for life, remains open.

The full terms are in the one-pager below. Reply here and we will walk you through it in 15 minutes.

${SIGNATURE}`;

  return { subject: `Re: booked sales calls for ${company}`, body };
}

function offerDay7(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Closing the loop so we do not clutter your inbox. If a guaranteed pipeline is not a priority for ${company} this quarter, we will not follow up again.

When it becomes one, the offer stands: booked sales calls, in writing — live in 3 weeks, no setup fee, month-to-month. ${SITE}

${SIGNATURE}`;

  return { subject: `Re: booked sales calls for ${company}`, body };
}

// ---------------------------------------------------------------------------
// CAMPAIGN 'free-leads' — the goodwill hook
// ---------------------------------------------------------------------------

function freeLeadsDay0(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = (lead.first_name || '').trim();
  const hi = name ? `Hi ${name},` : 'Hello,';

  const subject = subjectFrom(
    pickPool(lead, FREE_SUBJECTS_NAMED, FREE_SUBJECTS_COMPANY, FREE_SUBJECTS_NEUTRAL),
    lead, company
  );

  const body = `${hi}

We are Aviance — the cold-email firm that books guaranteed sales calls for B2B companies. Before we ask for a minute of your time, we would rather prove that our targeting works.

Our research desk has identified five businesses in ${company}'s market showing clear signs they are ready to buy right now. For each one you receive the company, the specific reason the timing is right, the decision-maker to ask for, and their direct contact details. The list is yours, free — no strings and no obligation.

Reply "SEND IT" and it is in your inbox the same day.

This is the exact targeting we run at scale for clients — with the results guaranteed in writing. Details at ${SITE}.

${SIGNATURE}`;

  return { subject, body };
}

function freeLeadsDay3(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Your five leads are still set aside for ${company} — each with the reason they are ready now and the person to call. One word — "SEND IT" — and they are yours the same day.

There is no catch. It is simply how we prove our targeting before we ever talk business. ${SITE}

${SIGNATURE}`;

  return { subject: `Re: 5 qualified leads for ${company}`, body };
}

function freeLeadsDay7(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

A last note from us. The five researched leads stay reserved for ${company} — whenever you want them, a one-word reply does it.

And if you would rather skip straight to the part where booked calls land on your calendar, guaranteed in writing: ${SITE}.

${SIGNATURE}`;

  return { subject: `Re: 5 qualified leads for ${company}`, body };
}

// ---------------------------------------------------------------------------
// Public API (same shape the sender has always used)
// ---------------------------------------------------------------------------

/** Build all three sequence emails for a lead, per its campaign. */
export function generateEmailSequence(lead) {
  if (campaignFor(lead) === 'free-leads') {
    return { day0: freeLeadsDay0(lead), day3: freeLeadsDay3(lead), day7: freeLeadsDay7(lead) };
  }
  return { day0: offerDay0(lead), day3: offerDay3(lead), day7: offerDay7(lead) };
}

/** Return the right email for a lead based on its sequence day. */
export function getEmailForSequenceDay(lead, sequenceDay) {
  const sequence = generateEmailSequence(lead);
  if (sequenceDay === 3) return sequence.day3;
  if (sequenceDay === 7) return sequence.day7;
  return sequence.day0;
}

/** Optional Gemini polish — offer campaign only; tweaks the opening pain line. */
export async function enhanceWithAI(lead, baseEmail) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return baseEmail;
  if (campaignFor(lead) === 'free-leads') return baseEmail; // copy is fixed by design

  try {
    const prompt = `You are lightly editing a B2B cold email for "${lead.company_name}"${lead.industry ? ` (industry: ${lead.industry})` : ''}.

We sell done-for-you cold email with the result guaranteed in writing: booked sales calls on the client's calendar, live within 3 weeks or the next month is free, no-shows replaced, shortfalls rolled over.

Rewrite ONLY the opening pain sentence so it feels specific to this company and its industry. Keep every other sentence exactly as it is. Keep it plain text, composed and official in tone, no exclamation marks, no invented facts, no personal sender names. Return ONLY the email body.

Original:
${baseEmail.body}`;

    const enhanced = await geminiGenerate(apiKey, prompt, { temperature: 0.7, maxOutputTokens: 2048 });
    if (enhanced && enhanced.length > 100 && enhanced.length < 1800) {
      return { subject: baseEmail.subject, body: enhanced };
    }
    return baseEmail;
  } catch {
    return baseEmail;
  }
}
