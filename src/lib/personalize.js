/**
 * Email Personalization Engine — Aviance
 *
 * What we sell (aviance.online):
 *   Done-for-you cold email that books QUALIFIED SALES CALLS onto the
 *   client's calendar. 20 booked calls in 4 weeks — or you don't pay a cent.
 *
 * Offer rules (finalized Aug 2026):
 * - SHORT. Two or three sentences. No walls of text.
 * - PAIN FIRST — open on the recipient's specific pipeline pain.
 * - GUARANTEE UP FRONT — the "don't pay a cent" sits in the promise sentence,
 *   not buried at the end.
 * - Four factors baked in: Promise (calls booked) · Result (20) · Time (4 weeks)
 *   · Guarantee (miss it, pay nothing).
 * - No personal sender name in the body (brand-only sign-off added by sender).
 * - A clickable aviance.online link sits in the body (linkified by the sender).
 * - Personalized by industry (pain) + company (name).
 */

import { geminiGenerate } from '@/lib/gemini';

const SITE = 'aviance.online';

// The promise sentence — carries Result (20) + Time (4 weeks) + Guarantee up front.
// `co` is the company name.
function promise(co) {
  return `We'll book 20 sales calls for ${co} in the next 4 weeks — and if we don't hit 20, you don't pay a cent.`;
}

// Subject lines drive opens more than anything else in the email. Research on
// millions of cold sends is consistent: SHORT (2-4 words), lowercase, a touch
// of curiosity, and a first-name token beat long "salesy" subjects by a wide
// margin. We keep three pools and pick by what data we have, so the subject
// degrades gracefully when a first name is missing.
const SUBJECTS_NAMED = [
  '{{first_name}} + dry referral months + 20 on the calendar',
  '{{first_name}} + referrals gone quiet + a written guarantee',
  '{{first_name}} + empty pipeline weeks + 20 booked calls',
];
const SUBJECTS_COMPANY = [
  '{{company_name}} + dry referral months + 20 on the calendar',
  '{{company_name}} + referrals gone quiet + a written guarantee',
  '{{company_name}} + empty pipeline weeks + 20 booked calls',
];
const SUBJECTS_NEUTRAL = [
  'dry referral months + 20 on the calendar',
  'referrals gone quiet + a written guarantee',
];

// Per-industry angle:
//   pain  = the short, specific pipeline pain that OPENS the day-0 email
//   proof = the one-line peer proof used on the day-3 nudge
const INDUSTRY_TEMPLATES = {
  msp: {
    pain: 'Referrals dry up and the pipeline goes quiet — every MSP knows the feeling.',
    proof: 'the last MSP we ran this for went from referral-only to a full calendar of booked calls',
  },
  'it services': {
    pain: 'IT firms grow on word-of-mouth — right up until it stalls and the new-client flow goes flat.',
    proof: 'an IT services firm we work with booked 14 qualified calls in their first month',
  },
  technology: {
    pain: 'Great tech, quiet pipeline — the outbound never quite gets built.',
    proof: "we filled a tech team's calendar with 15 qualified demos last month",
  },
  saas: {
    pain: 'Growth stalls the moment outbound slows, and SDRs are slow and expensive to build.',
    proof: 'a SaaS client is getting 18 booked demos a month from us — no SDRs',
  },
  finance: {
    pain: 'The right buyers are out there, but nobody has time to prospect them consistently.',
    proof: 'we booked a finance firm 11 calls last month with buyers who fit their profile',
  },
  consulting: {
    pain: 'Feast-or-famine pipeline — you\'re either delivering or hunting, never both.',
    proof: 'we booked a consulting firm 12 discovery calls last month, fully hands-off',
  },
  agency: {
    pain: 'You sell growth for clients, but your own new-business pipeline runs dry between referrals.',
    proof: "we filled an agency's calendar with 15 booked calls last month",
  },
  marketing: {
    pain: 'You sell growth for clients, but your own new-business pipeline runs dry between referrals.',
    proof: 'we booked an agency 15 qualified calls in a month with in-market prospects',
  },
};

const DEFAULT_TEMPLATE = {
  pain: 'Steady new-business calls are hard to keep flowing when nobody owns outbound.',
  proof: "we recently filled a B2B company's calendar with 15 qualified sales calls in a single month",
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Map a lead's industry to a template. MSPs and every IT-adjacent industry
 * (managed IT, network security, computer networking, telecom, cloud) all
 * resolve to the MSP angle.
 */
function templateFor(lead) {
  const key = (lead.industry || '').toLowerCase().trim();
  if (INDUSTRY_TEMPLATES[key]) return INDUSTRY_TEMPLATES[key];

  // IT / MSP family → msp angle
  if (/\bmsp\b|managed\s*it|managed\s*service|it\s*support|it\s*service|network|cyber|security|computer|telecom|cloud|\bit\b|information\s*technology/i.test(key)) {
    return INDUSTRY_TEMPLATES.msp;
  }
  // fall back to any partial keyword match
  for (const k of Object.keys(INDUSTRY_TEMPLATES)) {
    if (key.includes(k)) return INDUSTRY_TEMPLATES[k];
  }
  return DEFAULT_TEMPLATE;
}

/** Day 0 — pain first, promise + guarantee up front. Short, plain, link-free. */
function generateInitialEmail(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = (lead.first_name || '').trim();
  const hi = name ? `Hi ${name},` : 'Hi,';

  // Pick the subject pool by the data we actually have.
  const pool = name ? SUBJECTS_NAMED : (lead.company_name ? SUBJECTS_COMPANY : SUBJECTS_NEUTRAL);
  const subject = pickRandom(pool)
    .replace(/{{company_name}}/g, company)
    .replace(/{{first_name}}/g, name);

  // Day 0 is deliberately plain and LINK-FREE: no URL and no image on the first
  // touch keeps it out of spam and makes it read like a real 1:1 note, which
  // lifts inbox placement (and therefore opens). The CTA is a soft reply-ask;
  // the aviance.online link appears only on the follow-ups (day 3 / day 7).
  const body = `${hi}

We have yet to be properly introduced — we're Aviance, and we fix the one problem referrals can't: the pipeline goes quiet the month your network does.

${t.pain} ${promise(company)} We handle it end-to-end — domains, lists, copy, sending — and the calls just land on your calendar.

And we know the usual worry: "cold outreach doesn't work in our space", or "we've been burned by an agency before". That's exactly why the risk sits on our side — we hit the number, or we keep working free until we do.

One thing worth knowing: we're onboarding three founding clients at a permanently reduced founding rate. Once those slots fill, that rate is gone for good.

Do you have time over the next week or two to hear how it'd work? Just reply here and we'll take it from there.`;

  return { subject, body };
}

/** Day 3 — proof nudge. Short, keeps the guarantee in the promise. */
function generateFollowUp1(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Quick nudge — ${t.proof}. Same deal for ${company}: 20 booked calls in 4 weeks, or you don't pay a cent — and one of our three founding-client slots (permanently reduced rate) is still open.

${SITE}`;

  return { subject: `Re: ${company}`, body };
}

/** Day 7 — breakup. Short, guarantee restated once. */
function generateFollowUp2(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Last note — if a steady flow of booked calls isn't a priority for ${company} right now, no worries. If that changes: ${SITE} — 20 calls in 4 weeks, or you don't pay a cent.`;

  return { subject: `Re: ${company}`, body };
}

/** Build all three sequence emails for a lead */
export function generateEmailSequence(lead) {
  return {
    day0: generateInitialEmail(lead),
    day3: generateFollowUp1(lead),
    day7: generateFollowUp2(lead),
  };
}

/** Return the right email for a lead based on their sequence day */
export function getEmailForSequenceDay(lead, sequenceDay) {
  const sequence = generateEmailSequence(lead);
  if (sequenceDay === 3) return sequence.day3;
  if (sequenceDay === 7) return sequence.day7;
  return sequence.day0;
}

/** Optional Gemini polish — tiny tweaks only; keeps it short, offer + guarantee + link intact */
export async function enhanceWithAI(lead, baseEmail) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return baseEmail;

  try {
    const prompt = `You are lightly editing a B2B cold email for "${lead.company_name}"${lead.industry ? ` (industry: ${lead.industry})` : ''}.

We sell done-for-you cold email that books qualified sales calls onto the recipient's calendar: 20 booked calls in 4 weeks or they don't pay a cent.

Rewrite ONLY the opening pain sentence so it feels specific to this company and its industry. Keep every other sentence exactly as it is. Keep it plain text, no links, no exclamation marks, no invented facts, no personal sender name. Return ONLY the email body.

Original:
${baseEmail.body}`;

    const enhanced = await geminiGenerate(apiKey, prompt, { temperature: 0.7, maxOutputTokens: 500 });
    if (enhanced && enhanced.length > 100 && enhanced.length < 1600) {
      return { subject: baseEmail.subject, body: enhanced };
    }
    return baseEmail;
  } catch {
    return baseEmail;
  }
}
