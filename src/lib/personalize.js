/**
 * Email Personalization Engine
 * Generates industry-specific personalized emails
 * Uses templates by default ($0) with optional Gemini Flash AI enhancement
 */

// Industry-specific email templates
const INDUSTRY_TEMPLATES = {
  retail: {
    pain: 'managing inventory manually and handling repetitive customer queries one by one',
    solution: 'automate inventory alerts, customer support responses, and order tracking updates',
    example: 'One retail client reduced support tickets by 60% in the first month',
    subject: 'Quick question about {{company_name}}',
  },
  logistics: {
    pain: 'manually updating customers on delivery status and coordinating drivers over WhatsApp',
    solution: 'automate route updates, driver dispatch notifications, and customer tracking links',
    example: 'A Colombo logistics firm cut dispatch coordination time by 40% in 30 days',
    subject: 'Quick question about {{company_name}}',
  },
  transport: {
    pain: 'manually coordinating deliveries and managing fleet communication',
    solution: 'automate dispatch, driver communication, and customer ETAs',
    example: 'Automated dispatch reduced coordinator overhead by 3 hours per day',
    subject: 'Quick question about {{company_name}}',
  },
  manufacturing: {
    pain: 'tracking production schedules and supplier communications manually',
    solution: 'automate production alerts, supplier PO follow-ups, and quality check workflows',
    example: 'A manufacturer cut production delays by 30% with automated alerts',
    subject: 'Quick question about {{company_name}}',
  },
  finance: {
    pain: 'processing loan applications and compliance documents manually',
    solution: 'automate document extraction, KYC checks, and client onboarding workflows',
    example: 'A fintech in Colombo cut document processing time by 70%',
    subject: 'Quick question for {{company_name}}',
  },
  banking: {
    pain: 'processing applications and compliance documents manually',
    solution: 'automate document extraction, KYC checks, and compliance tracking',
    example: 'One bank reduced onboarding time from 5 days to same-day',
    subject: 'Quick question for {{company_name}}',
  },
  insurance: {
    pain: 'manually reviewing claims and chasing clients for documents',
    solution: 'automate claims intake, document requests, and status notifications',
    example: 'Claims processing time dropped from 5 days to same-day with automation',
    subject: 'Quick question for {{company_name}}',
  },
  healthcare: {
    pain: 'losing patients to no-shows and spending staff time on appointment reminders',
    solution: 'automate appointment reminders, rescheduling flows, and follow-up messages',
    example: 'One clinic reduced no-shows by 45% using automated WhatsApp and email reminders',
    subject: 'Reducing no-shows for {{company_name}}',
  },
  hospital: {
    pain: 'managing patient communications and appointment scheduling manually',
    solution: 'automate appointment reminders, referral follow-ups, and prescription notifications',
    example: 'A hospital reduced missed appointments by 40% within 6 weeks',
    subject: 'Reducing no-shows for {{company_name}}',
  },
  clinic: {
    pain: 'losing patients to no-shows and managing bookings manually',
    solution: 'automate booking reminders, rescheduling, and follow-up care messages',
    example: 'No-show rates dropped by 45% for a Colombo clinic within 6 weeks',
    subject: 'Reducing no-shows for {{company_name}}',
  },
  hotel: {
    pain: 'manually handling guest inquiries, room requests, and check-in paperwork',
    solution: 'automate guest pre-arrival messages, housekeeping alerts, and online check-in',
    example: 'A boutique hotel in Galle automated 80% of guest pre-arrival messaging',
    subject: 'Quick question for {{company_name}}',
  },
  hospitality: {
    pain: 'manually handling guest communication and reservation management',
    solution: 'automate reservation confirmations, guest messaging, and feedback collection',
    example: 'A hotel chain reduced front-desk call volume by 50% with automation',
    subject: 'Quick question for {{company_name}}',
  },
  restaurant: {
    pain: 'managing reservations manually and losing bookings to missed calls',
    solution: 'automate reservation confirmations, table reminders, and loyalty messaging',
    example: 'Automated booking reminders reduced cancellations by 35%',
    subject: 'Quick question for {{company_name}}',
  },
  legal: {
    pain: 'spending hours on client intake forms and routine document drafting',
    solution: 'automate client intake, document generation, and deadline reminders',
    example: 'A law firm saved 8 hours per week by automating client onboarding alone',
    subject: 'Saving {{company_name}} 5+ hours a week',
  },
  law: {
    pain: 'spending hours on client intake forms and routine document drafting',
    solution: 'automate client intake, document generation, and deadline reminders',
    example: 'A law firm saved 8 hours per week just from automating onboarding',
    subject: 'Saving {{company_name}} 5+ hours a week',
  },
  'real estate': {
    pain: 'manually following up with every property inquiry and scheduling viewings',
    solution: 'automate lead follow-up, viewing scheduling, and property info packets',
    example: 'Automated follow-ups increased viewing bookings by 50%',
    subject: 'Quick question about {{company_name}}',
  },
  education: {
    pain: 'manually communicating with students and parents about deadlines and fees',
    solution: 'automate fee reminders, assignment notifications, and parent communication',
    example: 'Fee collection improved 25% with automated SMS and email reminders',
    subject: 'Quick question about {{company_name}}',
  },
};

// Default template for unlisted industries
const DEFAULT_TEMPLATE = {
  pain: 'handling repetitive tasks manually that take up hours every week',
  solution: 'automate your most time-consuming workflows using simple AI tools',
  example: 'Businesses using AI automation save 5-10 hours per week on average',
  subject: 'Quick question about {{company_name}}',
};

/**
 * Generate the initial outreach email (Day 0)
 */
function generateInitialEmail(lead, senderName, senderCompany, calendarLink) {
  const template = INDUSTRY_TEMPLATES[lead.industry] || DEFAULT_TEMPLATE;
  const companyRef = lead.company_name || 'your business';
  const greeting = lead.first_name ? `Hi ${lead.first_name},` : 'Hi,';
  const industry = lead.industry || 'business';

  const subject = template.subject.replace('{{company_name}}', companyRef);

  const body = `${greeting}

I came across ${companyRef} and noticed you're in the ${industry} space in Sri Lanka.

Many ${industry} businesses I speak with are still ${template.pain} — and it ends up costing them significant time and revenue every month.

I help Sri Lankan businesses ${template.solution} using simple AI tools — no complicated tech, no long setup.

${template.example}.

Would it be worth a quick 20-minute call to see if something similar could work for ${companyRef}?

You can book a time here: ${calendarLink}

Either way, happy to share a free breakdown of which processes in your business could be automated first.

Best,
${senderName}
${senderCompany}

---
To unsubscribe from these emails, reply with "unsubscribe" in the subject line.`;

  return { subject, body };
}

/**
 * Generate Day 3 follow-up email
 */
function generateFollowUp1(lead, senderName) {
  const companyRef = lead.company_name || 'your business';
  const industry = lead.industry || 'business';

  return {
    subject: `Re: Quick question about ${companyRef}`,
    body: `Hi,

Just wanted to bump this in case it got buried.

I know running a ${industry} business in Sri Lanka keeps you busy — that's exactly why I wanted to reach out. The automation tools I set up typically show results within 2 weeks, and there's no big upfront cost or complex software involved.

Happy to send a quick voice note or a 1-page PDF showing exactly how it would work for ${companyRef} specifically — just reply and I'll get it over.

Best,
${senderName}`,
  };
}

/**
 * Generate Day 7 final follow-up email
 */
function generateFollowUp2(lead, senderName, calendarLink) {
  const companyRef = lead.company_name || 'your business';

  return {
    subject: `Last note — ${companyRef}`,
    body: `Hi,

This will be my last message — I know your inbox is valuable.

If now isn't the right time, completely understood. I'll circle back in a few months.

If you ever want to explore how automation could save ${companyRef} a few hours a week, my calendar is always open: ${calendarLink}

Wishing you a great week ahead!

${senderName}`,
  };
}

/**
 * Generate all email sequences for a lead
 * @param {object} lead - Qualified lead object
 * @param {object} config - Sender configuration
 * @returns {object} { day0: { subject, body }, day3: {...}, day7: {...} }
 */
export function generateEmailSequence(lead, config = {}) {
  const {
    senderName = process.env.SENDER_NAME || 'Aviance',
    senderCompany = process.env.SENDER_COMPANY || 'Aviance Systems',
    calendarLink = process.env.CALENDAR_LINK || 'https://calendly.com/aviance',
  } = config;

  return {
    day0: generateInitialEmail(lead, senderName, senderCompany, calendarLink),
    day3: generateFollowUp1(lead, senderName),
    day7: generateFollowUp2(lead, senderName, calendarLink),
  };
}

/**
 * Get the right email for a lead based on their sequence day
 */
export function getEmailForSequenceDay(lead, sequenceDay, config = {}) {
  const sequence = generateEmailSequence(lead, config);

  if (sequenceDay === 0) return sequence.day0;
  if (sequenceDay === 3) return sequence.day3;
  if (sequenceDay === 7) return sequence.day7;

  return sequence.day0; // Fallback
}

/**
 * Optional: Enhance email with Gemini Flash AI
 * Only used if GEMINI_API_KEY is set
 * Free tier: 1,500 requests/day
 */
export async function enhanceWithAI(lead, baseEmail) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return baseEmail; // Skip if no API key

  try {
    const prompt = `You are an email copywriting expert. Slightly personalize this cold email for a ${lead.industry} company called "${lead.company_name}" in ${lead.city}, Sri Lanka. Keep the same structure and length but make 2-3 small tweaks to feel more personal and specific to their industry. Do NOT change the CTA or calendar link. Return ONLY the improved email body, nothing else.

Original email:
${baseEmail.body}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 500,
          },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) return baseEmail;

    const data = await response.json();
    const enhanced = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (enhanced && enhanced.length > 50) {
      return { subject: baseEmail.subject, body: enhanced };
    }

    return baseEmail;
  } catch (err) {
    console.log(`[personalize] Gemini enhancement failed: ${err.message}`);
    return baseEmail; // Fallback to template
  }
}
