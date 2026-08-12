/**
 * Email Personalization Engine — Aviance
 *
 * What we sell (aviance.online):
 *   Done-for-you cold email that books QUALIFIED SALES CALLS onto the
 *   client's calendar. Live in ~3 weeks. Pay per call that shows.
 *   Guarantee: 20 booked calls in a month or every cent back.
 *
 * Rules:
 * - No personal sender name in the body (brand-only sign-off is added by the sender)
 * - Every email (day 0, 3, 7) ENDS on the money-back guarantee
 * - A clickable aviance.online link sits in the body (linkified by the sender)
 * - Short, about THEIR pipeline, one concrete proof point, low-friction CTA
 * - Personalized by industry + company
 */

const SITE = 'aviance.online';
const GUARANTEE = "Our guarantee is simple: if we don't get you 20 booked calls in a month, you get every cent back.";

const SUBJECTS = [
  '{{company_name}} — more sales calls?',
  'booked calls for {{company_name}}',
  'quick idea for {{company_name}}',
  '{{company_name}} — pipeline',
  'more qualified calls for {{company_name}}?',
];

// Per-industry angle: `hook` = a concrete peer result, `followUpHook` = extra proof for Day 3.
const INDUSTRY_TEMPLATES = {
  'it services': {
    hook: 'we recently booked an IT services firm 14 qualified calls in a month with in-market decision-makers',
    followUpHook: 'those calls were with owners and IT directors who had real budget — not tire-kickers',
  },
  msp: {
    hook: 'an MSP we work with went from referral-only to 12+ booked calls a month',
    followUpHook: 'they signed two new retainers off the first month of calls',
  },
  technology: {
    hook: "we filled a software team's calendar with 15 qualified demos last month",
    followUpHook: 'their AEs stopped cold-prospecting and just took the booked calls',
  },
  saas: {
    hook: 'a SaaS company we work with is getting 18 booked demos a month from us',
    followUpHook: 'it replaced roughly two SDRs at a fraction of the cost',
  },
  finance: {
    hook: 'we booked a finance firm 11 calls last month with decision-makers who fit their profile',
    followUpHook: 'the meetings were pre-qualified, so their team spent time only on real fits',
  },
  fintech: {
    hook: 'a fintech we work with is averaging 16 qualified calls a month from us',
    followUpHook: 'they closed their first enterprise pilot from a call we booked',
  },
  consulting: {
    hook: 'we booked a consulting firm 12 discovery calls last month, hands-off',
    followUpHook: "they didn't send a single email themselves — the calls just appeared on the calendar",
  },
  logistics: {
    hook: "we filled a logistics company's calendar with 13 qualified calls in a month",
    followUpHook: 'the calls were with ops and procurement leads who actually control the contract',
  },
  transport: {
    hook: 'we booked a transport company 10+ qualified calls last month',
    followUpHook: "they told us it was the first steady pipeline they'd had in a year",
  },
  manufacturing: {
    hook: 'we booked a manufacturer 12 qualified calls last month with real buyers',
    followUpHook: 'a couple of those calls turned into sample orders within weeks',
  },
  healthcare: {
    hook: 'we booked a healthcare vendor 11 qualified calls last month',
    followUpHook: 'the meetings were with administrators who could actually sign off',
  },
  marketing: {
    hook: 'we booked an agency 15 qualified calls in a month with in-market prospects',
    followUpHook: 'they closed two retainers off month one and kept us running',
  },
  agency: {
    hook: "we filled an agency's calendar with 15 booked calls last month",
    followUpHook: 'they signed two clients from the first batch of calls',
  },
  'real estate': {
    hook: 'we booked a commercial real estate team 12 qualified calls last month',
    followUpHook: 'those calls were with principals who actually had capital ready',
  },
  insurance: {
    hook: 'we booked an insurance firm 11 qualified calls last month',
    followUpHook: 'the calls were with business owners who fit their ideal policy profile',
  },
  legal: {
    hook: 'we booked a firm 10 qualified consultations last month, hands-off',
    followUpHook: 'the consultations came pre-qualified, so no time wasted on bad fits',
  },
};

const DEFAULT_TEMPLATE = {
  hook: "we recently filled a B2B company's calendar with 15 qualified sales calls in a single month",
  followUpHook: 'the calls were with real decision-makers, booked straight onto their calendar',
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Capitalize the first letter — used where a stored phrase begins a sentence. */
function cap(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function templateFor(lead) {
  const key = (lead.industry || '').toLowerCase().trim();
  if (INDUSTRY_TEMPLATES[key]) return INDUSTRY_TEMPLATES[key];
  for (const k of Object.keys(INDUSTRY_TEMPLATES)) {
    if (key.includes(k)) return INDUSTRY_TEMPLATES[k];
  }
  return DEFAULT_TEMPLATE;
}

/** Day 0 — the primary email. No sender name; ends on the guarantee. */
function generateInitialEmail(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || 'your company';
  const name = lead.first_name || '';
  const hi = name ? `Hi ${name},` : 'Hi,';

  const subject = pickRandom(SUBJECTS)
    .replace(/{{company_name}}/g, company)
    .replace(/{{first_name}}/g, name);

  const body = `${hi}

We book qualified sales calls straight onto B2B calendars — done-for-you, live in about 3 weeks. ${cap(t.hook)}, and they only paid per call that showed.

Worth a quick look for ${company}? You can see exactly how it works here: ${SITE}

${GUARANTEE}`;

  return { subject, body };
}

/** Day 3 — proof nudge. Ends on the guarantee. */
function generateFollowUp1(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Quick follow-up — ${t.followUpHook}.

If a steady flow of booked calls would help ${company}, here's exactly how it works: ${SITE}

${GUARANTEE}`;

  return { subject: `Re: ${company}`, body };
}

/** Day 7 — breakup. Ends on the guarantee. */
function generateFollowUp2(lead) {
  const company = lead.company_name || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const body = `Hi${name},

Closing the loop — I'll assume the timing isn't right for ${company} to add booked calls right now. If that changes, everything's here: ${SITE}

${GUARANTEE}`;

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

/** Optional Gemini polish — small tweaks only, keeps offer + guarantee + link intact */
export async function enhanceWithAI(lead, baseEmail) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return baseEmail;

  try {
    const prompt = `You are writing a B2B cold email for "${lead.company_name}"${lead.industry ? ` (industry: ${lead.industry})` : ''}.

We sell done-for-you cold email that books qualified sales calls onto the recipient's calendar — live in ~3 weeks, pay per call that shows.

Lightly personalize the email below: make 1-2 small tweaks so it feels specific to this company/industry. Keep it UNDER 75 words. Do NOT add a personal sender name. Keep the "${SITE}" link and keep the final guarantee sentence exactly. No spam words, no exclamation marks, no hype. Return ONLY the email body.

Original:
${baseEmail.body}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) return baseEmail;
    const data = await response.json();
    const enhanced = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (enhanced && enhanced.length > 30 && enhanced.length < 600) {
      return { subject: baseEmail.subject, body: enhanced };
    }
    return baseEmail;
  } catch {
    return baseEmail;
  }
}
