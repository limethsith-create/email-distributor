/**
 * Email Personalization Engine — Aviance
 *
 * What we actually sell (aviance.online):
 *   Done-for-you cold email that books QUALIFIED SALES CALLS straight onto
 *   the client's calendar. Live in ~3 weeks. Pay per call that shows.
 *   Fully guaranteed — hit the agreed number of calls or you don't pay.
 *
 * Copy principles:
 * - Short (under ~70 words), about THEIR pipeline, not about us
 * - One concrete peer result, no vague hype
 * - One low-friction CTA (a soft question)
 * - Professional US B2B tone
 * - Every send picks 1 of 3 structurally different templates
 */

// Per-industry angle. `pain` = the pipeline problem they feel,
// `hook` = a concrete peer result, `result` = how it worked / the mechanism,
// `followUpHook` = an extra proof point used on the Day-3 nudge.
const SUBJECTS = [
  '{{first_name}} — quick idea for {{company_name}}',
  'booked calls for {{company_name}}',
  '{{company_name}} — more sales calls?',
  'quick idea, {{first_name}}',
  'pipeline for {{company_name}}',
  '{{first_name}}?',
];

const INDUSTRY_TEMPLATES = {
  'it services': {
    pain: 'winning new clients beyond referrals and word of mouth',
    hook: 'we recently booked an IT services firm 14 qualified calls in a month with in-market decision-makers',
    result: 'all done-for-you cold email, and they only paid for the calls that actually showed',
    followUpHook: 'those calls were with owners and IT directors who had real budget — not tire-kickers',
  },
  msp: {
    pain: 'keeping a steady flow of new managed-services clients',
    hook: 'an MSP we work with went from referral-only to 12+ booked calls a month',
    result: 'we ran the lists, copy, inboxes and sending end-to-end — they just showed up and closed',
    followUpHook: 'they signed two new retainers off the first month of calls',
  },
  technology: {
    pain: 'keeping reps selling instead of prospecting',
    hook: 'we filled a software team\'s calendar with 15 qualified demos last month',
    result: 'done-for-you outbound, priced per call that shows — no SDR to hire or manage',
    followUpHook: 'their AEs stopped cold-prospecting and just took the booked calls',
  },
  saas: {
    pain: 'predictable pipeline without scaling an SDR team',
    hook: 'a SaaS company we work with is getting 18 booked demos a month from us',
    result: 'we handle lists, copy, deliverability and sending — you only pay per call booked',
    followUpHook: 'it replaced roughly two SDRs at a fraction of the cost',
  },
  finance: {
    pain: 'getting in front of qualified prospects consistently',
    hook: 'we booked a finance firm 11 calls last month with decision-makers who fit their profile',
    result: 'fully managed cold email, guaranteed — they only paid per call that showed',
    followUpHook: 'the meetings were pre-qualified, so their team spent time only on real fits',
  },
  fintech: {
    pain: 'building outbound pipeline without a big sales hire',
    hook: 'a fintech we work with is averaging 16 qualified calls a month from us',
    result: 'we run the whole outbound engine and bill per call that actually shows',
    followUpHook: 'they closed their first enterprise pilot from a call we booked',
  },
  consulting: {
    pain: 'filling the calendar without cold outreach eating billable time',
    hook: 'we booked a consulting firm 12 discovery calls last month, hands-off',
    result: 'we run the outreach end-to-end so partners just show up to the calls and close',
    followUpHook: 'they didn\'t send a single email themselves — the calls just appeared on the calendar',
  },
  logistics: {
    pain: 'landing new shipper and enterprise accounts predictably',
    hook: 'we filled a logistics company\'s calendar with 13 qualified calls in a month',
    result: 'done-for-you cold email, priced per call booked — guaranteed to hit the number',
    followUpHook: 'the calls were with ops and procurement leads who actually control the contract',
  },
  transport: {
    pain: 'winning new B2B accounts without a dedicated sales team',
    hook: 'we booked a transport company 10+ qualified calls last month',
    result: 'we handle the entire outbound process and only charge per call that shows',
    followUpHook: 'they told us it was the first steady pipeline they\'d had in a year',
  },
  manufacturing: {
    pain: 'getting in front of new buyers and distributors',
    hook: 'we booked a manufacturer 12 qualified calls last month with real buyers',
    result: 'fully managed cold email — lists, copy, sending — priced per call that shows',
    followUpHook: 'a couple of those calls turned into sample orders within weeks',
  },
  healthcare: {
    pain: 'reaching decision-makers at clinics, groups and payers',
    hook: 'we booked a healthcare vendor 11 qualified calls last month',
    result: 'done-for-you outbound, guaranteed, billed per call that actually shows',
    followUpHook: 'the meetings were with administrators who could actually sign off',
  },
  marketing: {
    pain: 'landing new retainer clients without doing your own outreach',
    hook: 'we booked an agency 15 qualified calls in a month with in-market prospects',
    result: 'we run the whole cold-email engine so you just take the calls and pitch',
    followUpHook: 'they closed two retainers off month one and kept us running',
  },
  agency: {
    pain: 'a steady stream of qualified new-client calls',
    hook: 'we filled an agency\'s calendar with 15 booked calls last month',
    result: 'done-for-you outbound, priced per call that shows — no in-house SDR needed',
    followUpHook: 'they signed two clients from the first batch of calls',
  },
  'real estate': {
    pain: 'a consistent flow of qualified investor and commercial leads',
    hook: 'we booked a commercial real estate team 12 qualified calls last month',
    result: 'we handle the outreach end-to-end and only bill per call that shows',
    followUpHook: 'those calls were with principals who actually had capital ready',
  },
  insurance: {
    pain: 'reaching qualified commercial prospects at scale',
    hook: 'we booked an insurance firm 11 qualified calls last month',
    result: 'fully managed cold email, guaranteed, priced per call that shows',
    followUpHook: 'the calls were with business owners who fit their ideal policy profile',
  },
  legal: {
    pain: 'a predictable flow of qualified client consultations',
    hook: 'we booked a firm 10 qualified consultations last month, hands-off',
    result: 'we run the outreach so your team just takes the calls',
    followUpHook: 'the consultations came pre-qualified, so no time wasted on bad fits',
  },
};

const DEFAULT_TEMPLATE = {
  pain: 'keeping the calendar full of qualified sales calls',
  hook: 'we recently filled a B2B company\'s calendar with 15 qualified sales calls in a single month',
  result: 'fully done-for-you cold email, and they only paid per call that actually showed',
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
  // loose contains-match so "IT Services & Consulting" etc. still map
  for (const k of Object.keys(INDUSTRY_TEMPLATES)) {
    if (key.includes(k)) return INDUSTRY_TEMPLATES[k];
  }
  return DEFAULT_TEMPLATE;
}

// ============================================================
// STRUCTURE A: peer proof + guarantee (~60 words)
// ============================================================
function structureA(lead, t) {
  const name = lead.first_name || '';
  const hi = name ? `Hi ${name},` : 'Hi,';
  return `${hi}

${cap(t.hook)} — ${t.result}.

If ${lead.company_name} is focused on ${t.pain}, this is worth a look. We're live in about 3 weeks, and it's guaranteed: hit your number of booked calls or you don't pay for the miss.

Open to seeing how it'd work?

Limethsith`;
}

// ============================================================
// STRUCTURE B: direct question (~55 words)
// ============================================================
function structureB(lead, t) {
  const name = lead.first_name || '';
  const hi = name ? `Hey ${name},` : 'Hey,';
  return `${hi}

Is ${lead.company_name} looking to book more qualified sales calls this quarter?

We run cold email end-to-end — lists, copy, inboxes, sending — and put booked calls straight on your calendar. ${cap(t.hook)}. You only pay per call that shows, and we're live in ~3 weeks.

Worth a conversation?

Limethsith`;
}

// ============================================================
// STRUCTURE C: short curiosity (~45 words)
// ============================================================
function structureC(lead, t) {
  const name = lead.first_name || '';
  const hi = name ? `Hi ${name} —` : 'Hi —';
  return `${hi}

Quick one — we book qualified sales calls straight onto B2B calendars, done-for-you and guaranteed. ${cap(t.hook)}.

Not sure if ${lead.company_name} needs more pipeline right now, but if so I can show you exactly how it works.

Limethsith`;
}

const STRUCTURES = [structureA, structureB, structureC];

/** Day 0 — initial outreach */
function generateInitialEmail(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || 'your company';
  const firstName = lead.first_name || '';

  const subject = pickRandom(SUBJECTS)
    .replace(/{{company_name}}/g, company)
    .replace(/{{first_name}}/g, firstName);

  const structureFn = pickRandom(STRUCTURES);
  const body = structureFn({ ...lead, company_name: company }, t);

  return { subject, body };
}

/** Day 3 — adds a new proof point, not just a bump */
function generateFollowUp1(lead) {
  const t = templateFor(lead);
  const company = lead.company_name || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const variants = [
    `Hi${name},

One more thing worth mentioning — ${t.followUpHook}.

If a steady flow of booked calls would help ${company}, I can walk you through how we'd set it up. If not, no worries at all.

Limethsith`,

    `Hi${name},

Quick follow-up — ${t.followUpHook}.

We could do the same for ${company}: done-for-you cold email, calls booked to your calendar, and you only pay per call that shows. Happy to share the details.

Limethsith`,

    `Hi${name},

Wanted to add one thing — ${t.followUpHook}.

Would predictable booked calls move the needle for ${company} this quarter? Either way, appreciate your time.

Limethsith`,
  ];

  return { subject: `Re: ${company}`, body: pickRandom(variants) };
}

/** Day 7 — breakup email (highest reply rates), points to the site */
function generateFollowUp2(lead) {
  const company = lead.company_name || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const variants = [
    `Hi${name},

Closing the loop — I'll assume the timing isn't right for ${company} to add booked calls right now.

If that changes, you can see exactly how it works at aviance.online, or just reply here.

Limethsith`,

    `Hi${name},

Last note from me. If ${company} ever wants qualified sales calls booked for you — guaranteed, pay per call — this thread will still be here, and there's more at aviance.online.

Limethsith`,

    `Hi${name},

Won't take up more of your time. If more pipeline ever becomes a priority for ${company}, reply here or take a look at aviance.online.

All the best,
Limethsith`,
  ];

  return { subject: `Re: ${company}`, body: pickRandom(variants) };
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

/** Optional Gemini polish — small tweaks only, keeps the offer + guarantee intact */
export async function enhanceWithAI(lead, baseEmail) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return baseEmail;

  try {
    const prompt = `You are writing a B2B cold email for "${lead.company_name}"${lead.industry ? ` (industry: ${lead.industry})` : ''}.

We sell done-for-you cold email that books qualified sales calls onto the recipient's calendar — live in ~3 weeks, pay per call that shows, fully guaranteed.

Lightly personalize the email below: make 1-2 small tweaks so it feels specific to this company/industry. Keep it UNDER 70 words. Keep the guarantee and the "booked calls" offer. Do NOT add spam words, exclamation marks, hype, or change the signature line "Limethsith". Return ONLY the email body.

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
