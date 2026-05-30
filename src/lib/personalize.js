/**
 * Email Personalization Engine — Aviance AI Growth Systems
 *
 * Key principles:
 * - Every email under 60 words
 * - About THEIR problem, not about us
 * - Specific results, not vague claims
 * - One low-friction question as CTA
 * - Conversational Sri Lankan tone
 * - 3 structurally different templates per send
 */

const INDUSTRY_TEMPLATES = {
  retail: {
    pain: 'answering the same customer questions over and over on WhatsApp',
    hook: 'a retail shop in Colombo was spending 3+ hours/day on repeat customer queries',
    result: 'now a bot handles 80% of them automatically',
    followUpHook: 'the owner told me he got his evenings back',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  logistics: {
    pain: 'coordinating drivers on WhatsApp and updating customers manually',
    hook: 'a logistics company here was losing 2 hours/day on driver coordination calls',
    result: 'automated dispatch + live customer tracking cut that to 15 minutes',
    followUpHook: 'their customers started rating them higher just from the tracking updates',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  transport: {
    pain: 'managing fleet updates through calls and messages',
    hook: 'a transport company was burning hours daily on "where is my delivery?" calls',
    result: 'automated ETA updates eliminated most of those calls within a week',
    followUpHook: 'their dispatcher said it felt like hiring an extra person',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  manufacturing: {
    pain: 'chasing suppliers and tracking production in spreadsheets',
    hook: 'a manufacturer in Colombo had suppliers ghosting them for days',
    result: 'automated follow-ups brought average response time down from 3 days to same-day',
    followUpHook: 'they caught a quality issue early because the system flagged a delayed shipment',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  finance: {
    pain: 'processing client documents and onboarding by hand',
    hook: 'a finance company was spending a full day onboarding each new client',
    result: 'automated document intake brought that down to 2 hours',
    followUpHook: 'they onboarded 3x more clients last month without adding staff',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  banking: {
    pain: 'chasing clients for missing documents during onboarding',
    hook: 'a financial services firm was losing weeks on back-and-forth document requests',
    result: 'automated reminders got 90% of docs submitted within 48 hours',
    followUpHook: 'their compliance team said it was the first time they weren\'t behind on reviews',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  insurance: {
    pain: 'processing claims manually and chasing paperwork',
    hook: 'an insurance company took 5+ days per claim because of manual processing',
    result: 'automated intake and status updates brought that to same-day',
    followUpHook: 'their customer complaints about claim delays dropped to nearly zero',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  healthcare: {
    pain: 'losing patients to no-shows because reminders go out too late or not at all',
    hook: 'a clinic was losing 15-20% of appointments to no-shows',
    result: 'automated reminders at 24hr and 2hr before brought no-shows under 5%',
    followUpHook: 'they actually had to open more slots because attendance improved so much',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  hospital: {
    pain: 'managing patient scheduling and reminders with phone calls',
    hook: 'a hospital was making 50+ reminder calls a day by hand',
    result: 'automated messaging handles all of it now — zero manual calls',
    followUpHook: 'their front desk staff said they can actually focus on patients walking in',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  clinic: {
    pain: 'manually calling patients about appointments',
    hook: 'a clinic in Colombo had 2 staff members doing nothing but reminder calls',
    result: 'automated WhatsApp reminders replaced all of it in a week',
    followUpHook: 'no-shows dropped and those staff now handle actual patient care',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  hotel: {
    pain: 'handling guest requests and check-in paperwork manually',
    hook: 'a hotel was spending 30+ minutes per guest on pre-arrival coordination',
    result: 'automated pre-arrival messages + digital check-in cut that to under 5 minutes',
    followUpHook: 'their Google reviews actually improved because guests felt more prepared',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  hospitality: {
    pain: 'replying to reservation inquiries one by one',
    hook: 'a hospitality business was losing bookings because replies took 4-6 hours',
    result: 'instant auto-replies + booking confirmations captured 30% more reservations',
    followUpHook: 'their revenue went up without spending anything on marketing',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  restaurant: {
    pain: 'losing bookings to missed calls and managing reservations on paper',
    hook: 'a restaurant was missing 10+ reservation calls during peak hours every week',
    result: 'automated booking via WhatsApp captured those missed calls',
    followUpHook: 'they filled 2 extra tables per night just from the missed-call bookings',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  legal: {
    pain: 'spending hours on client intake and routine document work',
    hook: 'a law firm was losing 5+ hours/week on intake forms alone',
    result: 'automated intake collects everything before the first meeting now',
    followUpHook: 'their lawyers said consultations got more productive because clients come prepared',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  law: {
    pain: 'admin eating into billable hours — intake, doc prep, follow-ups',
    hook: 'a firm was losing 8+ billable hours/week to admin work',
    result: 'automated client intake and follow-ups gave those hours back',
    followUpHook: 'they billed more last month without working longer hours',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  'real estate': {
    pain: 'following up with property inquiries manually',
    hook: 'an agency was responding to inquiries 6-8 hours after they came in',
    result: 'instant auto-follow-ups increased viewing bookings by 40%',
    followUpHook: 'speed matters in property — they started closing leads their competitors missed',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  education: {
    pain: 'chasing students and parents about fees and deadlines',
    hook: 'a school was spending days every month chasing overdue fees',
    result: 'automated reminders improved on-time collection by 35%',
    followUpHook: 'their admin staff went from chasing payments to actually supporting students',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  technology: {
    pain: 'spending time on internal ops instead of building product',
    hook: 'a tech company had engineers doing support triage instead of coding',
    result: 'automated ticket routing freed up 10+ engineering hours/week',
    followUpHook: 'they shipped a feature that had been stuck for months',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  construction: {
    pain: 'tracking project timelines and coordinating subs through calls',
    hook: 'a contractor was getting 10+ "where are we on this?" calls daily',
    result: 'automated milestone updates eliminated almost all of them',
    followUpHook: 'his subcontractors started showing up on time because they got real-time updates',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
  automotive: {
    pain: 'manually reminding customers about service appointments',
    hook: 'a garage was losing 20% of booked services to no-shows',
    result: 'automated SMS reminders brought no-shows under 5%',
    followUpHook: 'they started a follow-up upsell flow and saw repeat visits go up',
    subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
  },
};

const DEFAULT_TEMPLATE = {
  pain: 'spending hours every week on tasks that could run on autopilot',
  hook: 'a business here was losing 10+ hours/week on manual follow-ups and admin',
  result: 'simple automation gave those hours back within the first month',
  followUpHook: 'they said it felt like hiring someone without the overhead',
  subjects: ['{{first_name}} — quick thought', '{{company_name}}', 'question about {{company_name}}', 'thought for {{company_name}}', '{{first_name}}?'],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
// STRUCTURE A: Observation + proof (under 50 words)
// ============================================================
function structureA(lead, t) {
  const name = lead.first_name || '';
  const hi = name ? `Hi ${name},` : 'Hi,';

  return `${hi}

${t.hook}.

${t.result}.

Does ${lead.company_name} deal with something similar? If so, happy to share how it worked.

Limethsith`;
}

// ============================================================
// STRUCTURE B: Direct question (under 45 words)
// ============================================================
function structureB(lead, t) {
  const name = lead.first_name || '';
  const hi = name ? `Hey ${name},` : 'Hey,';

  return `${hi}

Is ${lead.company_name} still ${t.pain}?

Asking because ${t.hook} — ${t.result}.

Worth a conversation, or not the right time?

Limethsith`;
}

// ============================================================
// STRUCTURE C: Soft/curiosity (under 40 words)
// ============================================================
function structureC(lead, t) {
  const name = lead.first_name || '';
  const hi = name ? `Hi ${name} —` : 'Hi —';

  return `${hi}

Not sure if this is relevant for ${lead.company_name}, but ${t.hook} — ${t.result}.

Sound familiar at all?

Limethsith`;
}

const STRUCTURES = [structureA, structureB, structureC];

/**
 * Generate initial outreach email (Day 0)
 */
function generateInitialEmail(lead) {
  const t = INDUSTRY_TEMPLATES[(lead.industry || '').toLowerCase()] || DEFAULT_TEMPLATE;
  const company = lead.company_name || 'your company';
  const city = lead.city || 'Sri Lanka';
  const firstName = lead.first_name || '';

  const subject = pickRandom(t.subjects)
    .replace('{{company_name}}', company)
    .replace('{{first_name}}', firstName)
    .replace('{{city}}', city);

  const structureFn = pickRandom(STRUCTURES);
  const body = structureFn(lead, t);

  return { subject, body };
}

/**
 * Day 3 follow-up — adds new info, not just "bumping"
 */
function generateFollowUp1(lead) {
  const t = INDUSTRY_TEMPLATES[(lead.industry || '').toLowerCase()] || DEFAULT_TEMPLATE;
  const company = lead.company_name || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const variants = [
    `Hi${name},

One thing I forgot to mention — ${t.followUpHook}.

If ${company} is dealing with anything similar, I can share the specifics. If not, no worries.

Limethsith`,

    `Hi${name},

Quick follow-up — ${t.followUpHook}.

Thought that might be relevant for ${company}. Happy to share more if useful, otherwise feel free to ignore.

Limethsith`,

    `Hi${name},

Wanted to add one thing — ${t.followUpHook}.

Would something like that matter for ${company}? Either way, appreciate your time.

Limethsith`,
  ];

  return {
    subject: `Re: ${company}`,
    body: pickRandom(variants),
  };
}

/**
 * Day 7 final follow-up — breakup email (highest reply rates)
 */
function generateFollowUp2(lead) {
  const company = lead.company_name || 'your company';
  const name = lead.first_name ? ' ' + lead.first_name : '';

  const variants = [
    `Hi${name},

Closing the loop — I'll assume the timing isn't right for ${company}. If things change down the road, just reply to this thread.

Limethsith`,

    `Hi${name},

Last note from me. If automation ever makes sense for ${company}, this thread will still be here.

Limethsith`,

    `Hi${name},

Won't take up more of your time. If ${company} ever needs help with this, just reply here.

All the best,
Limethsith`,
  ];

  return {
    subject: `Re: ${company}`,
    body: pickRandom(variants),
  };
}

/**
 * Generate all email sequences for a lead
 */
export function generateEmailSequence(lead) {
  return {
    day0: generateInitialEmail(lead),
    day3: generateFollowUp1(lead),
    day7: generateFollowUp2(lead),
  };
}

/**
 * Get the right email for a lead based on their sequence day
 */
export function getEmailForSequenceDay(lead, sequenceDay) {
  const sequence = generateEmailSequence(lead);
  if (sequenceDay === 0) return sequence.day0;
  if (sequenceDay === 3) return sequence.day3;
  if (sequenceDay === 7) return sequence.day7;
  return sequence.day0;
}

/**
 * Optional: Enhance email with Gemini Flash AI
 */
export async function enhanceWithAI(lead, baseEmail) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return baseEmail;

  try {
    const prompt = `You are writing a cold email for a ${lead.industry} company called "${lead.company_name}" in ${lead.city}, Sri Lanka. Slightly personalize this email — make 1-2 small tweaks to feel more specific to their industry. Keep it UNDER 60 words. Do NOT add spam words, exclamation marks, or change the signature. Return ONLY the email body.

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
    if (enhanced && enhanced.length > 30 && enhanced.length < 500) {
      return { subject: baseEmail.subject, body: enhanced };
    }
    return baseEmail;
  } catch {
    return baseEmail;
  }
}
