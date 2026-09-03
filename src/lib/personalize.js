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
 * Voice rules (rewritten from outreach research, Sep 2026):
 *  · Subjects: 1–5 words, lowercase, specific to the company — never a pitch,
 *    never "free"/"guaranteed"/salesy words (spam + reply-rate killers).
 *    Question subjects lift opens; benefit-claiming numbers hurt replies.
 *  · Bodies: 70–110 words. Open with THEM, never with who we are. Loss-framed
 *    pain beats gain-framing. Two-sentence paragraphs, one question, one CTA.
 *  · CTA: interest/permission-based ("want it?", "worth me sending it?") —
 *    beats calendar asks ~3:1 on first touch (Gong, 304k emails). The bot
 *    delivers the full terms AFTER they reply, which is where pitching works.
 *  · Day 3: new angle + proof, never "just following up". Day 7: breakup with
 *    an easy out — a stated guess plus "no reply needed if wrong".
 *  · Sign-off is always "— The Aviance Team".
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
// Subject pools — short, lowercase, specific. They read like a colleague's
// note, not a marketing blast. No pitch, no "free", no claims.
// ---------------------------------------------------------------------------

const OFFER_SUBJECTS_NAMED = [
  '{{first_name}}, outbound at {{company_name}}?',
  '{{first_name}}, new clients at {{company_name}}?',
  "{{company_name}}'s pipeline next quarter",
];
const OFFER_SUBJECTS_COMPANY = [
  'outbound at {{company_name}}?',
  'new clients at {{company_name}}?',
  "{{company_name}}'s pipeline next quarter",
];
const OFFER_SUBJECTS_NEUTRAL = [
  'who owns outbound?',
  'your pipeline next quarter',
];

const FREE_SUBJECTS_NAMED = [
  '{{first_name}}, made you a list',
  '5 buyers for {{company_name}}?',
];
const FREE_SUBJECTS_COMPANY = [
  'a list for {{company_name}}',
  '5 buyers for {{company_name}}?',
];
const FREE_SUBJECTS_NEUTRAL = [
  'made you a list',
];

// ---------------------------------------------------------------------------
// Per-industry angle for the OFFER campaign
//   pain  = the loss-framed pipeline pain that opens day 0
//   proof = the one-line peer proof used on day 3
// ---------------------------------------------------------------------------

const INDUSTRY_TEMPLATES = {
  msp: {
    pain: 'Most MSPs hit a quarter where referrals dry up — and every quiet week is contracts a competitor signs instead.',
    proof: 'the last MSP we ran this for went from referral-only to a full calendar of booked discovery calls',
  },
  'it services': {
    pain: 'IT firms grow on word of mouth — until the month it stalls, and the gap in the pipeline shows up 90 days later as flat revenue.',
    proof: 'an IT services firm we work with took 14 qualified calls in their first month',
  },
  technology: {
    pain: 'Strong product, quiet pipeline — and every month outbound stays unbuilt, deals that should be yours close somewhere else.',
    proof: "we filled a technology team's calendar with 15 qualified demos in a single month",
  },
  saas: {
    pain: 'When outbound slows, growth stalls a quarter later — and hiring SDRs takes months you may not want to spend.',
    proof: 'a SaaS client takes 18 booked demos a month from us, with no internal SDRs',
  },
  finance: {
    pain: 'The right clients for your firm exist right now — but nobody inside has the hours to prospect them, so they get signed elsewhere.',
    proof: 'we booked a finance firm 11 calls in a month, every one matching their client profile',
  },
  consulting: {
    pain: 'Consulting runs feast-or-famine: while you are delivering, nobody is hunting — and next quarter pays the price.',
    proof: 'we booked a consulting firm 12 discovery calls in a month, fully hands-off',
  },
  agency: {
    pain: 'You sell growth to clients while your own new-business pipeline sits empty between referrals — the classic agency trap.',
    proof: "we filled an agency's calendar with 15 booked calls in a month",
  },
  marketing: {
    pain: 'You sell growth to clients while your own new-business pipeline sits empty between referrals — the classic agency trap.',
    proof: 'we booked an agency 15 qualified calls in a month with in-market prospects',
  },
};

const DEFAULT_TEMPLATE = {
  pain: 'When nobody owns outbound, the pipeline runs on luck — and slow months cost more than any vendor ever would.',
  proof: "we recently filled a B2B company's calendar with 15 qualified sales calls in one month",
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function templateFor(lead) {
  const key = (lead.industry || '').toLowerCase().trim();
  if (INDUSTRY_TEMPLATES[key]) return { ...INDUSTRY_TEMPLATES[key], key };
  if (/\bmsp\b|managed\s*it|managed\s*service|it\s*support|it\s*service|network|cyber|security|computer|telecom|cloud|\bit\b|information\s*technology/i.test(key)) {
    return { ...INDUSTRY_TEMPLATES.msp, key: 'msp' };
  }
  for (const k of Object.keys(INDUSTRY_TEMPLATES)) {
    if (key.includes(k)) return { ...INDUSTRY_TEMPLATES[k], key: k };
  }
  return { ...DEFAULT_TEMPLATE, key: 'default' };
}

/** Pick a subject variant; returns { subject, variant } so sends can record which line went out. */
function subjectFrom(pool, lead, company, poolName) {
  const idx = Math.floor(Math.random() * pool.length);
  const subject = pool[idx]
    .replace(/{{company_name}}/g, company)
    .replace(/{{first_name}}/g, (lead.first_name || '').trim());
  return { subject, variant: `${poolName}#${idx}` };
}

function pickPool(lead, named, companyPool, neutral) {
  const name = (lead.first_name || '').trim();
  if (name) return { pool: named, name: 'named' };
  if (lead.company_name || lead.company) return { pool: companyPool, name: 'company' };
  return { pool: neutral, name: 'neutral' };
}

const SIGNATURE = '— The Aviance Team\nGuaranteed booked sales calls · aviance.online';

// ---------------------------------------------------------------------------
// CAMPAIGN 'offer' — the direct pitch
// Day 0 stays light on purpose: pain → one line on what we do → interest CTA.
// The full terms live in the one-pager below the email and in the bot's reply.
// ---------------------------------------------------------------------------

function offerDay0(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = (lead.first_name || '').trim();
  const hi = name ? `Hi ${name},` : 'Hello,';

  const picked = pickPool(lead, OFFER_SUBJECTS_NAMED, OFFER_SUBJECTS_COMPANY, OFFER_SUBJECTS_NEUTRAL);
  const { subject, variant } = subjectFrom(picked.pool, lead, company, `offer-${picked.name}`);

  const body = `${hi}

${t.pain}

We run the whole outbound engine for B2B firms like ${company} — and we put the result in writing: a set number of booked sales calls on your calendar, or the next month costs you nothing. The one-pager below carries the terms.

Worth me sending the exact numbers for ${company}? A one-word reply — "details" — is enough.

${SIGNATURE}`;

  return { subject, body, variant, template: t.key || 'default' };
}

function offerDay3(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

One data point since my last note: ${t.proof}.

The same structure is open for ${company} — a set number of booked calls each month, in writing, and if we miss, the next month costs nothing.

Would the exact numbers be useful, or is this off base for the quarter?

${SIGNATURE}`;

  return { subject: `Re: outbound at ${company}`, body };
}

function offerDay7(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Closing the loop. My guess: ${company} could use a fuller calendar, but nobody owns outbound right now. If that is wrong, no reply needed — this is my last note.

If it is close, the written commitment stands: booked calls on your calendar or the month costs nothing. Reply any time and I will send the terms. ${SITE}

${SIGNATURE}`;

  return { subject: `Re: outbound at ${company}`, body };
}

// ---------------------------------------------------------------------------
// CAMPAIGN 'free-leads' — the goodwill hook
// Built on the highest-tested pattern in cold email: a made-for-you gift plus
// a permission CTA ("want it?"). No pitch until they reply.
// ---------------------------------------------------------------------------

function freeLeadsDay0(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = (lead.first_name || '').trim();
  const hi = name ? `Hi ${name},` : 'Hello,';

  const picked = pickPool(lead, FREE_SUBJECTS_NAMED, FREE_SUBJECTS_COMPANY, FREE_SUBJECTS_NEUTRAL);
  const { subject, variant } = subjectFrom(picked.pool, lead, company, `free-${picked.name}`);

  const body = `${hi}

We researched ${company}'s market this week and found five businesses showing clear buying signals right now. For each one: the company, why the timing is right, the decision-maker to ask for, and their direct contact.

The list took real hours to build, and it is yours at no cost. It is how we prove our targeting before ever asking for your time.

Want it? Reply "SEND IT" and it is in your inbox the same day.

${SIGNATURE}`;

  return { subject, body, variant, template: 'free-leads' };
}

function freeLeadsDay3(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

The five companies we set aside for ${company} are still holding — each with the reason they are ready now and the person to ask for.

Buying signals fade, so I would rather this reach you while the timing holds. One word — "SEND IT" — and the list is yours today.

${SIGNATURE}`;

  return { subject: `Re: a list for ${company}`, body };
}

function freeLeadsDay7(lead) {
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Last note from me. If new clients are not the focus right now, no reply needed — I will close the file.

If they are, the five researched leads are still yours for a one-word reply. And when you want this running at scale — booked calls on your calendar, in writing — that is exactly what we do: ${SITE}

${SIGNATURE}`;

  return { subject: `Re: a list for ${company}`, body };
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

Rewrite ONLY the opening pain sentence so it feels specific to this company and its industry. Frame it as a loss (what quiet pipeline is costing them), keep it under 25 words, plain and conversational, no exclamation marks, no invented facts, no personal sender names. Keep every other sentence exactly as it is. Return ONLY the email body.

Original:
${baseEmail.body}`;

    const enhanced = await geminiGenerate(apiKey, prompt, { temperature: 0.7, maxOutputTokens: 1024, timeoutMs: 12000 });
    if (enhanced && enhanced.length > 100 && enhanced.length < 1800 && /STOP/i.test(enhanced) === /STOP/i.test(baseEmail.body)) {
      return { ...baseEmail, body: enhanced, aiEnhanced: true };
    }
    return baseEmail;
  } catch {
    return baseEmail;
  }
}
