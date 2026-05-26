/**
 * Email Personalization Engine â Aviance AI Growth Systems
 * Generates industry-specific personalized outreach emails
 * Branded with aviance.online, Head of AI signature, phone number
 */

// Industry-specific hooks â what hurts them + what we fix
const INDUSTRY_TEMPLATES = {
  retail: {
    pain: 'still handling customer questions one by one and tracking stock in spreadsheets',
    solution: 'We set up AI systems that auto-respond to common customer queries, send restock alerts, and track orders â so your team only handles the stuff that actually needs a human',
    result: 'One retail client cut their support workload by 60% in the first month',
    subject: 'Quick idea for {{company_name}}',
  },
  logistics: {
    pain: 'coordinating drivers over WhatsApp and manually updating customers on delivery status',
    solution: 'We build automated dispatch systems â drivers get routes automatically, customers get live tracking links, and you get a dashboard that shows everything in real time',
    result: 'A Colombo logistics company cut coordination time by 40% within 30 days',
    subject: 'An idea for {{company_name}}',
  },
  transport: {
    pain: 'managing fleet coordination and delivery updates through calls and messages',
    solution: 'We automate dispatch notifications, driver assignments, and customer ETA updates â the whole chain runs on autopilot',
    result: 'Automated dispatch saved one transport firm 3+ hours of coordinator time per day',
    subject: 'Quick idea for {{company_name}}',
  },
  manufacturing: {
    pain: 'chasing suppliers by email and tracking production schedules on paper or Excel',
    solution: 'We set up automated supplier follow-ups, production milestone alerts, and quality check workflows that flag issues before they become expensive',
    result: 'A manufacturer reduced production delays by 30% just by automating supplier reminders',
    subject: 'Quick idea for {{company_name}}',
  },
  finance: {
    pain: 'processing applications and compliance docs by hand â slow and error-prone',
    solution: 'We build AI workflows that extract data from documents, run KYC checks automatically, and onboard clients in hours instead of days',
    result: 'A fintech in Colombo cut document processing time by 70%',
    subject: 'Quick idea for {{company_name}}',
  },
  banking: {
    pain: 'manually reviewing applications and chasing clients for missing documents',
    solution: 'We automate document intake, compliance checks, and client communications â your team reviews, AI does the grunt work',
    result: 'One bank went from 5-day onboarding to same-day using our automation',
    subject: 'Quick idea for {{company_name}}',
  },
  insurance: {
    pain: 'spending days on claims processing and constantly chasing clients for paperwork',
    solution: 'We automate claims intake, document collection, and status updates â clients stay informed, your team moves faster',
    result: 'Claims processing went from 5 days to same-day for one insurer',
    subject: 'Quick idea for {{company_name}}',
  },
  healthcare: {
    pain: 'losing patients to no-shows and wasting staff time on phone reminders',
    solution: 'We set up automated appointment reminders via WhatsApp and email, plus easy reschedule links â patients show up, staff stays free',
    result: 'One clinic reduced no-shows by 45% within 6 weeks',
    subject: 'Reducing no-shows at {{company_name}}',
  },
  hospital: {
    pain: 'managing patient comms and appointment scheduling with too much manual work',
    solution: 'We automate reminders, referral follow-ups, and prescription notifications â patients get better care, staff gets their time back',
    result: 'A hospital reduced missed appointments by 40% in 6 weeks',
    subject: 'Reducing no-shows at {{company_name}}',
  },
  clinic: {
    pain: 'losing patients to missed appointments and juggling bookings by hand',
    solution: 'We build automated booking reminders, reschedule flows, and follow-up messages that run on their own',
    result: 'No-show rates dropped 45% for a Colombo clinic in just 6 weeks',
    subject: 'Reducing no-shows at {{company_name}}',
  },
  hotel: {
    pain: 'handling guest inquiries, room requests, and check-in paperwork manually',
    solution: 'We automate pre-arrival messages, housekeeping coordination, and online check-in â guests get a premium experience without extra staff overhead',
    result: 'A boutique hotel in Galle automated 80% of their pre-arrival messaging',
    subject: 'Quick idea for {{company_name}}',
  },
  hospitality: {
    pain: 'managing reservations and guest communications one message at a time',
    solution: 'We set up automated reservation confirmations, guest welcome sequences, and feedback collection â everything runs behind the scenes',
    result: 'A hotel chain cut front-desk call volume by 50% with our automation',
    subject: 'Quick idea for {{company_name}}',
  },
  restaurant: {
    pain: 'losing bookings to missed calls and managing reservations on paper',
    solution: 'We automate reservation confirmations, table reminders, and loyalty messages â more bookings, fewer no-shows',
    result: 'Automated reminders cut cancellations by 35% for one restaurant group',
    subject: 'Quick idea for {{company_name}}',
  },
  legal: {
    pain: 'spending hours on client intake forms and routine document drafting',
    solution: 'We automate client onboarding, document generation, and deadline reminders â your lawyers focus on actual legal work',
    result: 'One law firm saved 8+ hours per week by automating intake alone',
    subject: 'Saving {{company_name}} 5+ hours a week',
  },
  law: {
    pain: 'burning billable hours on admin â intake forms, document prep, follow-ups',
    solution: 'We build automated client intake, document assembly, and reminder systems so your team focuses on casework',
    result: 'A law firm reclaimed 8 hours per week just from automating onboarding',
    subject: 'Saving {{company_name}} 5+ hours a week',
  },
  'real estate': {
    pain: 'manually following up with every inquiry and trying to schedule viewings over the phone',
    solution: 'We automate lead follow-up sequences, viewing scheduling, and property info delivery â leads get instant responses, you close more deals',
    result: 'Automated follow-ups increased viewing bookings by 50% for one agency',
    subject: 'Quick idea for {{company_name}}',
  },
  education: {
    pain: 'chasing students and parents about fees, deadlines, and assignments',
    solution: 'We set up automated fee reminders, assignment notifications, and parent communication flows â everything goes out on time without staff effort',
    result: 'Fee collection improved 25% with automated reminders for one school',
    subject: 'Quick idea for {{company_name}}',
  },
  technology: {
    pain: 'spending too much time on manual operations instead of building product',
    solution: 'We automate your internal ops â onboarding, support triage, reporting, alerts â so your dev team ships faster',
    result: 'A tech startup cut operational overhead by 40% in the first quarter',
    subject: 'Quick idea for {{company_name}}',
  },
  construction: {
    pain: 'tracking project timelines and coordinating subcontractors through calls and messages',
    solution: 'We build automated project milestone alerts, subcontractor scheduling, and progress reporting that keeps everyone aligned',
    result: 'One contractor eliminated 90% of "where are we on this?" calls with automated updates',
    subject: 'Quick idea for {{company_name}}',
  },
  automotive: {
    pain: 'manually reminding customers about service appointments and managing bookings',
    solution: 'We automate service reminders, booking confirmations, and follow-up satisfaction checks',
    result: 'Repeat service bookings increased 30% with automated reminder sequences',
    subject: 'Quick idea for {{company_name}}',
  },
};

// Default for any industry not specifically listed
const DEFAULT_TEMPLATE = {
  pain: 'spending hours each week on repetitive tasks that don\'t need a human touch',
  solution: 'We identify the biggest time-wasters in your workflow and automate them using AI â simple tools, no complex tech, real results within weeks',
  result: 'Most of our clients save 5-10 hours per week within the first month',
  subject: 'Quick idea for {{company_name}}',
};

/**
 * Generate the initial outreach email (Day 0)
 */
function generateInitialEmail(lead) {
  const template = INDUSTRY_TEMPLATES[(lead.industry || '').toLowerCase()] || DEFAULT_TEMPLATE;
  const companyRef = lead.company_name || 'your business';
  const greeting = lead.first_name ? `Hi ${lead.first_name},` : 'Hi there,';
  const industry = lead.industry || 'business';

  const subject = template.subject.replace('{{company_name}}', companyRef);

  const body = `${greeting}

I came across ${companyRef} while looking into ${industry} businesses in Sri Lanka, and I think there's a real opportunity here.

A lot of ${industry} companies I talk to are ${template.pain}. It's one of those things that quietly eats up time and money every month.

At Aviance, we fix exactly that. ${template.solution}.

${template.result}.

Would a quick 15-minute call make sense to see if something similar could work for ${companyRef}? No pitch â just a straightforward look at where automation could save you time.

You can check out what we do here: https://www.aviance.online

Happy to chat whenever works for you.

Cheers,
Limethsith
Head of AI â Aviance
Phone: 071 870 2702
Web: https://www.aviance.online

---
To opt out of future emails, just reply "unsubscribe".`;

  return { subject, body };
}

/**
 * Generate Day 3 follow-up email
 */
function generateFollowUp1(lead) {
  const companyRef = lead.company_name || 'your business';
  const industry = lead.industry || 'business';

  return {
    subject: `Re: Quick idea for ${companyRef}`,
    body: `Hey,

Just wanted to follow up on my last email â I know things get busy.

I work with a few ${industry} businesses in Sri Lanka and the results we're seeing with automation are pretty impressive. Most clients start seeing time savings within the first 2 weeks, and there's no big upfront cost involved.

If it's easier, I can send over a quick 1-page breakdown showing exactly how it would work for ${companyRef} â just reply and I'll put it together.

Talk soon,
Limethsith
Head of AI â Aviance
071 870 2702 | https://www.aviance.online`,
  };
}

/**
 * Generate Day 7 final follow-up email
 */
function generateFollowUp2(lead) {
  const companyRef = lead.company_name || 'your business';

  return {
    subject: `Last one from me â ${companyRef}`,
    body: `Hey,

This'll be my last follow-up â I respect your time.

If now's not the right moment, totally fine. I'll check back in a couple of months.

But if you ever want to explore how ${companyRef} could save a few hours a week with simple AI automation, I'm always around:

Phone: 071 870 2702
Website: https://www.aviance.online

Hope you have a great week!

Limethsith
Head of AI â Aviance`,
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
    const prompt = `You are an email copywriting expert. Slightly personalize this cold email for a ${lead.industry} company called "${lead.company_name}" in ${lead.city}, Sri Lanka. Keep the same structure, tone, and length but make 2-3 small tweaks to feel more personal and specific to their industry. Do NOT change the signature, phone number, website, CTA, or any contact details. Return ONLY the improved email body, nothing else.

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
