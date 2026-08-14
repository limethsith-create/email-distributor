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

const SITE = 'aviance.online';

// The promise sentence — carries Result (20) + Time (4 weeks) + Guarantee up front.
// `co` is the company name.
function promise(co) {
  return `We'll book 20 sales calls for ${co} in the next 4 weeks — and if we don't hit 20, you don't pay a cent.`;
}

const SUBJECTS = [
  '{{company_name}} — 20 calls in 4 weeks?',
  'booked calls for {{company_name}}',
  '{{company_name}} — pipeline that doesn\'t dry up',
  'a full calendar for {{company_name}}?',
  '{{company_name}} — 20 sales calls, or you don\'t pay',
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

/** Day 0 — pain first, promise + guarantee up front, link. Short. */
function generateInitialEmail(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name || '';
  const hi = name ? `Hi ${name},` : 'Hi,';

  const subject = pickRandom(SUBJECTS)
    .replace(/{{company_name}}/g, company)
    .replace(/{{first_name}}/g, name);

  const body = `${hi}

${t.pain} ${promise(company)}

We do it done-for-you — the calls just show up on your calendar. Here's how it works: ${SITE}`;

  return { subject, body };
}

/** Day 3 — proof nudge. Short, keeps the guarantee in the promise. */
function generateFollowUp1(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || lead.company || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Quick nudge — ${t.proof}. Same deal for ${company}: 20 booked calls in 4 weeks, or you don't pay a cent.

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
    const prompt = `You are lightly editing a SHORT B2B cold email for "${lead.company_name}"${lead.industry ? ` (industry: ${lead.industry})` : ''}.

We sell done-for-you cold email that books qualified sales calls onto the recipient's calendar: 20 booked calls in 4 weeks or they don't pay a cent.

Make 1 small tweak so the opening pain line feels specific to this company. Keep it UNDER 60 words. Keep it pain-first. Keep the promise sentence (20 calls, 4 weeks, don't pay a cent) and the "${SITE}" link exactly. No personal sender name, no spam words, no exclamation marks, no hype. Return ONLY the email body.

Original:
${baseEmail.body}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) return baseEmail;
    const data = await response.json();
    const enhanced = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (enhanced && enhanced.length > 30 && enhanced.length < 500) {
      return { subject: baseEmail.subject, body: enhanced };
    }
    return baseEmail;
  } catch {
    return baseEmail;
  }
}
