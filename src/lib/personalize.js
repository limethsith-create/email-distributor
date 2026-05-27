/**
 * Email Personalization Engine — Aviance AI Growth Systems
 * Generates industry-specific personalized outreach emails
 * Branded with aviance.online, Head of AI signature, phone number
 */

// Industry-specific hooks — what hurts them + what we fix
const INDUSTRY_TEMPLATES = {
  retail: {
    pain: 'still handling customer questions one by one and tracking stock in spreadsheets',
    solution: 'We set up AI systems that auto-respond to common customer queries, send restock alerts, and track orders — so your team only handles the stuff that actually needs a human',
    result: 'We helped a retail client streamline their support — they told us it freed up most of their week',
    subject: 'Thought about {{company_name}}',
    subjects: [
      'Thought about {{company_name}}',
      'Quick question for {{company_name}}',
      '{{company_name}} — saving time on support',
    ],
  },
  logistics: {
    pain: 'coordinating drivers over WhatsApp and manually updating customers on delivery status',
    solution: 'We build automated dispatch systems — drivers get routes automatically, customers get live tracking links, and you get a dashboard that shows everything in real time',
    result: 'We worked with a logistics company in Colombo and they said coordination got noticeably smoother within the first month',
    subject: 'Something for {{company_name}} to consider',
    subjects: [
      'Something for {{company_name}} to consider',
      'Idea for {{company_name}} logistics',
      '{{company_name}} — automating dispatch',
    ],
  },
  transport: {
    pain: 'managing fleet coordination and delivery updates through calls and messages',
    solution: 'We automate dispatch notifications, driver assignments, and customer ETA updates — the whole chain runs on autopilot',
    result: 'One transport firm we helped said their coordinator now has a few extra hours every day',
    subject: 'Thought about {{company_name}} operations',
    subjects: [
      'Thought about {{company_name}} operations',
      'Fleet idea for {{company_name}}',
      '{{company_name}} — streamlining delivery updates',
    ],
  },
  manufacturing: {
    pain: 'chasing suppliers by email and tracking production schedules on paper or Excel',
    solution: 'We set up automated supplier follow-ups, production milestone alerts, and quality check workflows that flag issues before they become expensive',
    result: 'A manufacturer told us their production delays dropped significantly after we automated their supplier reminders',
    subject: 'Regarding {{company_name}} production workflow',
    subjects: [
      'Regarding {{company_name}} production workflow',
      'Quick thought for {{company_name}}',
      '{{company_name}} — fewer supplier delays',
    ],
  },
  finance: {
    pain: 'processing applications and compliance docs by hand — slow and error-prone',
    solution: 'We build AI workflows that extract data from documents, run KYC checks automatically, and onboard clients in hours instead of days',
    result: 'A fintech we worked with in Colombo was able to process documents much faster after the setup',
    subject: 'Thought for {{company_name}} team',
    subjects: [
      'Thought for {{company_name}} team',
      'Speeding up docs at {{company_name}}',
      '{{company_name}} — faster client onboarding',
    ],
  },
  banking: {
    pain: 'manually reviewing applications and chasing clients for missing documents',
    solution: 'We automate document intake, compliance checks, and client communications — your team reviews, AI does the grunt work',
    result: 'We helped a bank get their onboarding from days down to same-day',
    subject: 'Idea for {{company_name}} onboarding',
    subjects: [
      'Idea for {{company_name}} onboarding',
      'Quick thought for {{company_name}}',
      '{{company_name}} — automating document intake',
    ],
  },
  insurance: {
    pain: 'spending days on claims processing and constantly chasing clients for paperwork',
    solution: 'We automate claims intake, document collection, and status updates — clients stay informed, your team moves faster',
    result: 'An insurer we worked with went from days to same-day on claims turnaround',
    subject: 'Thought for {{company_name}} claims',
    subjects: [
      'Thought for {{company_name}} claims',
      'Claims workflow idea for {{company_name}}',
      '{{company_name}} — faster claims turnaround',
    ],
  },
  healthcare: {
    pain: 'losing patients to no-shows and wasting staff time on phone reminders',
    solution: 'We set up automated appointment reminders via WhatsApp and email, plus easy reschedule links — patients show up, staff stays free',
    result: 'A clinic we worked with saw their no-shows drop noticeably within a few weeks',
    subject: 'Reducing no-shows at {{company_name}}',
    subjects: [
      'Reducing no-shows at {{company_name}}',
      'Patient reminders for {{company_name}}',
      '{{company_name}} — fewer missed appointments',
    ],
  },
  hospital: {
    pain: 'managing patient comms and appointment scheduling with too much manual work',
    solution: 'We automate reminders, referral follow-ups, and prescription notifications — patients get better care, staff gets their time back',
    result: 'A hospital told us their missed appointments dropped significantly after we set up reminders',
    subject: 'Appointment reminders for {{company_name}}',
    subjects: [
      'Appointment reminders for {{company_name}}',
      'Scheduling idea for {{company_name}}',
      '{{company_name}} — smoother patient comms',
    ],
  },
  clinic: {
    pain: 'losing patients to missed appointments and juggling bookings by hand',
    solution: 'We build automated booking reminders, reschedule flows, and follow-up messages that run on their own',
    result: 'A Colombo clinic we helped saw no-show rates come down meaningfully in just a few weeks',
    subject: 'Reducing missed appointments at {{company_name}}',
    subjects: [
      'Reducing missed appointments at {{company_name}}',
      'Booking idea for {{company_name}}',
      '{{company_name}} — automated patient reminders',
    ],
  },
  hotel: {
    pain: 'handling guest inquiries, room requests, and check-in paperwork manually',
    solution: 'We automate pre-arrival messages, housekeeping coordination, and online check-in — guests get a premium experience without extra staff overhead',
    result: 'A boutique hotel in Galle automated most of their pre-arrival messaging with us',
    subject: 'Guest experience idea for {{company_name}}',
    subjects: [
      'Guest experience idea for {{company_name}}',
      'Quick thought for {{company_name}}',
      '{{company_name}} — smoother check-ins',
    ],
  },
  hospitality: {
    pain: 'managing reservations and guest communications one message at a time',
    solution: 'We set up automated reservation confirmations, guest welcome sequences, and feedback collection — everything runs behind the scenes',
    result: 'A hotel chain told us their front-desk call volume dropped noticeably after automation',
    subject: 'Reservation workflow for {{company_name}}',
    subjects: [
      'Reservation workflow for {{company_name}}',
      'Guest comms idea for {{company_name}}',
      '{{company_name}} — automating reservations',
    ],
  },
  restaurant: {
    pain: 'losing bookings to missed calls and managing reservations on paper',
    solution: 'We automate reservation confirmations, table reminders, and loyalty messages — more bookings, fewer no-shows',
    result: 'A restaurant group we helped saw their cancellations come down after setting up reminders',
    subject: 'Booking idea for {{company_name}}',
    subjects: [
      'Booking idea for {{company_name}}',
      'Reservation thought for {{company_name}}',
      '{{company_name}} — fewer no-shows',
    ],
  },
  legal: {
    pain: 'spending hours on client intake forms and routine document drafting',
    solution: 'We automate client onboarding, document generation, and deadline reminders — your lawyers focus on actual legal work',
    result: 'A law firm told us they got several hours back each week just from automating intake',
    subject: 'Saving time at {{company_name}}',
    subjects: [
      'Saving time at {{company_name}}',
      'Client intake idea for {{company_name}}',
      '{{company_name}} — automating the paperwork',
    ],
  },
  law: {
    pain: 'burning billable hours on admin — intake forms, document prep, follow-ups',
    solution: 'We build automated client intake, document assembly, and reminder systems so your team focuses on casework',
    result: 'We helped a law firm reclaim hours each week by automating their onboarding process',
    subject: 'Workflow thought for {{company_name}}',
    subjects: [
      'Workflow thought for {{company_name}}',
      'Saving billable hours at {{company_name}}',
      '{{company_name}} — less admin, more casework',
    ],
  },
  'real estate': {
    pain: 'manually following up with every inquiry and trying to schedule viewings over the phone',
    solution: 'We automate lead follow-up sequences, viewing scheduling, and property info delivery — leads get instant responses, you close more deals',
    result: 'An agency we worked with told us their viewing bookings picked up after setting up automated follow-ups',
    subject: 'Follow-up idea for {{company_name}}',
    subjects: [
      'Follow-up idea for {{company_name}}',
      'Viewing bookings at {{company_name}}',
      '{{company_name}} — faster lead follow-ups',
    ],
  },
  education: {
    pain: 'chasing students and parents about fees, deadlines, and assignments',
    solution: 'We set up automated fee reminders, assignment notifications, and parent communication flows — everything goes out on time without staff effort',
    result: 'A school we helped said fee collection improved noticeably once automated reminders went live',
    subject: 'Communication idea for {{company_name}}',
    subjects: [
      'Communication idea for {{company_name}}',
      'Parent updates at {{company_name}}',
      '{{company_name}} — automating reminders',
    ],
  },
  technology: {
    pain: 'spending too much time on manual operations instead of building product',
    solution: 'We automate your internal ops — onboarding, support triage, reporting, alerts — so your dev team ships faster',
    result: 'A tech startup told us their operational overhead dropped after we automated their internal workflows',
    subject: 'Ops workflow for {{company_name}}',
    subjects: [
      'Ops workflow for {{company_name}}',
      'Internal automation for {{company_name}}',
      '{{company_name}} — less ops, more shipping',
    ],
  },
  construction: {
    pain: 'tracking project timelines and coordinating subcontractors through calls and messages',
    solution: 'We build automated project milestone alerts, subcontractor scheduling, and progress reporting that keeps everyone aligned',
    result: 'One contractor told us they basically stopped getting "where are we on this?" calls after setup',
    subject: 'Project tracking for {{company_name}}',
    subjects: [
      'Project tracking for {{company_name}}',
      'Subcontractor coordination at {{company_name}}',
      '{{company_name}} — automated milestone updates',
    ],
  },
  automotive: {
    pain: 'manually reminding customers about service appointments and managing bookings',
    solution: 'We automate service reminders, booking confirmations, and follow-up satisfaction checks',
    result: 'A service centre told us repeat bookings picked up after setting up automated reminder sequences',
    subject: 'Service reminders for {{company_name}}',
    subjects: [
      'Service reminders for {{company_name}}',
      'Booking idea for {{company_name}}',
      '{{company_name}} — more repeat bookings',
    ],
  },
};

// Default for any industry not specifically listed
const DEFAULT_TEMPLATE = {
  pain: 'spending hours each week on repetitive tasks that don\'t need a human touch',
  solution: 'We identify the biggest time-wasters in your workflow and automate them using AI — simple tools, no complex tech, and you see results within weeks',
  result: 'Most businesses we work with tell us they get a few hours back each week pretty quickly',
  subject: 'Thought for {{company_name}}',
  subjects: [
    'Thought for {{company_name}}',
    'Quick idea for {{company_name}}',
    '{{company_name}} — saving time with automation',
  ],
};

/**
 * Generate the initial outreach email (Day 0)
 */
function generateInitialEmail(lead) {
  const template = INDUSTRY_TEMPLATES[(lead.industry || '').toLowerCase()] || DEFAULT_TEMPLATE;
  const companyRef = lead.company_name || 'your business';
  const greeting = lead.first_name ? `Hi ${lead.first_name},` : 'Hi,';
  const industry = lead.industry || 'business';

  // A/B testing: randomly pick a subject variant from the subjects array
  const subjectVariants = template.subjects || [template.subject];
  const subjectVariant = Math.floor(Math.random() * subjectVariants.length);
  const subject = subjectVariants[subjectVariant].replace('{{company_name}}', companyRef);

  const body = `${greeting}

I came across ${companyRef} while looking into ${industry} businesses in Sri Lanka, and wanted to share a thought.

A lot of ${industry} companies I talk to are ${template.pain}. It's one of those things that quietly eats up time every month.

At Aviance, we work on exactly that. ${template.solution}.

${template.result}.

Would a quick 15-minute call make sense to see if something similar could work for ${companyRef}? Happy to walk through what we've done for similar companies if that would be useful.

Let me know if you'd like to chat.

Limethsith
Aviance — AI Growth Systems
071 870 2702 | aviance.online

---
To opt out of future emails, just reply "unsubscribe".`;

  return { subject, body, subjectVariant };
}

/**
 * Generate Day 3 follow-up email
 */
function generateFollowUp1(lead) {
  const companyRef = lead.company_name || 'your business';
  const industry = lead.industry || 'business';

  return {
    subject: `Following up — ${companyRef}`,
    body: `Hi,

Just following up on my last email — I know things get busy.

I work with a few ${industry} businesses in Sri Lanka and the feedback on our automation work has been really positive. Most companies we help start seeing time savings pretty quickly.

If it's easier, I can send over a quick 1-page breakdown showing how it would work for ${companyRef} — just reply and I'll put it together.

Talk soon,
Limethsith
Aviance — AI Growth Systems
071 870 2702 | aviance.online

---
To opt out of future emails, just reply "unsubscribe".`,
  };
}

/**
 * Generate Day 7 final follow-up email
 */
function generateFollowUp2(lead) {
  const companyRef = lead.company_name || 'your business';

  return {
    subject: `Last note — ${companyRef}`,
    body: `Hi,

This will be my last follow-up — I respect your time.

If now is not the right moment, no worries at all. I will check back in a couple of months.

But if you ever want to explore how ${companyRef} could save a few hours a week with some simple automation, I am always around:

071 870 2702 | aviance.online

Hope you have a great week.

Limethsith
Aviance — AI Growth Systems

---
To opt out of future emails, just reply "unsubscribe".`,
  };
}

/**
 * Generate all email sequences for a lead
 */
export function generateEmailSequence(lead, config = {}) {
  return {
    day0: generateInitialEmail(lead),
    day3: generateFollowUp1(lead),
    day7: generateFollowUp2(lead),
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
  if (!apiKey) return baseEmail;

  try {
    const prompt = `You are an email copywriting expert. Slightly personalize this cold email for a ${lead.industry} company called "${lead.company_name}" in ${lead.city}, Sri Lanka. Keep the same structure, tone, and length but make 2-3 small tweaks to feel more personal and specific to their industry. Do NOT change the signature, phone number, website, CTA, or any contact details. Do NOT use spam trigger words like "free", "guarantee", "amazing", "incredible", "act now", "limited time", "don't miss", "exclusive", "urgent", or exclamation marks. Keep the tone calm and conversational. Return ONLY the improved email body, nothing else.

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
            maxOutputTokens: 600,
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
    return baseEmail;
  }
}
