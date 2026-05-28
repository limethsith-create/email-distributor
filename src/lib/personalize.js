/**
 * Email Personalization Engine â Aviance AI Growth Systems
 * Generates industry-specific personalized outreach emails
 * Uses 3 structurally different email templates to avoid pattern detection
 */

// Industry-specific hooks â what hurts them + what we fix
const INDUSTRY_TEMPLATES = {
  retail: {
    pain: 'handling customer questions one by one and tracking stock in spreadsheets',
    specificTask: 'customer support and inventory alerts',
    result: 'cut their support workload by a few hours every week',
    checklistPains: 'manually answering repeat questions, spreadsheet stock tracking, missed reorder alerts',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'retail + automation',
      'quick question',
      'idea for {{city}}',
      '{{company_name}} support workflow',
      'saving time on repeat queries',
    ],
  },
  logistics: {
    pain: 'coordinating drivers over WhatsApp and manually updating customers on delivery status',
    specificTask: 'dispatch and delivery tracking',
    result: 'cut coordination time in half within the first month',
    checklistPains: 'manual dispatch messages, missing delivery updates, phone-tag with drivers',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'logistics + automation',
      'quick question',
      'idea for {{city}}',
      'dispatch workflow thought',
      'driver coordination',
    ],
  },
  transport: {
    pain: 'managing fleet coordination and delivery updates through calls and messages',
    specificTask: 'fleet dispatch and ETA updates',
    result: 'freed up their coordinator for a few extra hours every day',
    checklistPains: 'manual route planning, missed ETA updates, endless driver calls',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'transport + automation',
      'quick question',
      'idea for {{city}}',
      'fleet ops thought',
      'delivery updates',
    ],
  },
  manufacturing: {
    pain: 'chasing suppliers by email and tracking production schedules on paper or Excel',
    specificTask: 'supplier follow-ups and production tracking',
    result: 'saw production delays drop significantly',
    checklistPains: 'chasing supplier replies, Excel production schedules, missed quality checks',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'manufacturing + automation',
      'quick question',
      'idea for {{city}}',
      'supplier follow-ups',
      'production tracking',
    ],
  },
  finance: {
    pain: 'processing applications and compliance docs by hand',
    specificTask: 'document processing and client onboarding',
    result: 'went from days to hours on document processing',
    checklistPains: 'manual document extraction, slow KYC checks, multi-day onboarding',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'finance + automation',
      'quick question',
      'idea for {{city}}',
      'client onboarding',
      'doc processing',
    ],
  },
  banking: {
    pain: 'manually reviewing applications and chasing clients for missing documents',
    specificTask: 'document intake and compliance checks',
    result: 'got onboarding from days down to same-day',
    checklistPains: 'manual application review, chasing missing docs, slow compliance checks',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'banking + automation',
      'quick question',
      'idea for {{city}}',
      'onboarding workflow',
      'document intake',
    ],
  },
  insurance: {
    pain: 'spending days on claims processing and chasing clients for paperwork',
    specificTask: 'claims intake and status updates',
    result: 'went from days to same-day on claims turnaround',
    checklistPains: 'slow claims intake, chasing paperwork, manual status updates',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'insurance + automation',
      'quick question',
      'idea for {{city}}',
      'claims workflow',
      'faster turnaround',
    ],
  },
  healthcare: {
    pain: 'losing patients to no-shows and wasting staff time on phone reminders',
    specificTask: 'appointment reminders and patient follow-ups',
    result: 'saw no-shows drop noticeably within a few weeks',
    checklistPains: 'phone reminder calls, missed appointments, manual rescheduling',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'healthcare + automation',
      'quick question',
      'idea for {{city}}',
      'patient no-shows',
      'appointment reminders',
    ],
  },
  hospital: {
    pain: 'managing patient comms and appointment scheduling with too much manual work',
    specificTask: 'patient reminders and referral follow-ups',
    result: 'saw missed appointments drop significantly',
    checklistPains: 'manual scheduling, missed referral follow-ups, phone-based reminders',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'hospital + automation',
      'quick question',
      'idea for {{city}}',
      'patient scheduling',
      'appointment reminders',
    ],
  },
  clinic: {
    pain: 'losing patients to missed appointments and juggling bookings by hand',
    specificTask: 'booking reminders and reschedule flows',
    result: 'saw no-show rates come down meaningfully in weeks',
    checklistPains: 'manual booking management, missed appointment calls, no reschedule flow',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'clinic + automation',
      'quick question',
      'idea for {{city}}',
      'booking workflow',
      'patient reminders',
    ],
  },
  hotel: {
    pain: 'handling guest inquiries, room requests, and check-in paperwork manually',
    specificTask: 'pre-arrival messaging and check-in',
    result: 'automated most of their pre-arrival comms',
    checklistPains: 'manual guest replies, paper check-in, uncoordinated housekeeping',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'hotel + automation',
      'quick question',
      'idea for {{city}}',
      'guest experience',
      'check-in workflow',
    ],
  },
  hospitality: {
    pain: 'managing reservations and guest communications one message at a time',
    specificTask: 'reservation confirmations and guest welcome sequences',
    result: 'saw front-desk call volume drop noticeably',
    checklistPains: 'one-by-one guest messages, manual reservations, no feedback collection',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'hospitality + automation',
      'quick question',
      'idea for {{city}}',
      'reservation workflow',
      'guest comms',
    ],
  },
  restaurant: {
    pain: 'losing bookings to missed calls and managing reservations on paper',
    specificTask: 'reservation confirmations and table reminders',
    result: 'saw cancellations come down after setting up reminders',
    checklistPains: 'missed reservation calls, paper booking systems, no-show losses',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'restaurant + automation',
      'quick question',
      'idea for {{city}}',
      'booking workflow',
      'fewer no-shows',
    ],
  },
  legal: {
    pain: 'spending hours on client intake forms and routine document drafting',
    specificTask: 'client onboarding and document generation',
    result: 'got several hours back each week from automating intake',
    checklistPains: 'manual intake forms, repetitive document drafting, missed deadline reminders',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'legal + automation',
      'quick question',
      'idea for {{city}}',
      'client intake',
      'document workflow',
    ],
  },
  law: {
    pain: 'burning billable hours on admin â intake forms, document prep, follow-ups',
    specificTask: 'client intake and document assembly',
    result: 'reclaimed hours each week by automating onboarding',
    checklistPains: 'admin eating billable hours, manual document prep, follow-up tracking',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'law + automation',
      'quick question',
      'idea for {{city}}',
      'billable hours',
      'intake workflow',
    ],
  },
  'real estate': {
    pain: 'manually following up with every inquiry and scheduling viewings over the phone',
    specificTask: 'lead follow-ups and viewing scheduling',
    result: 'saw viewing bookings pick up after automated follow-ups',
    checklistPains: 'slow lead follow-ups, phone-based viewing scheduling, missed inquiries',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'real estate + automation',
      'quick question',
      'idea for {{city}}',
      'lead follow-ups',
      'viewing bookings',
    ],
  },
  education: {
    pain: 'chasing students and parents about fees, deadlines, and assignments',
    specificTask: 'fee reminders and parent communication flows',
    result: 'saw fee collection improve once automated reminders went live',
    checklistPains: 'chasing fee payments, manual parent updates, missed deadline reminders',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'education + automation',
      'quick question',
      'idea for {{city}}',
      'parent comms',
      'fee reminders',
    ],
  },
  technology: {
    pain: 'spending too much time on manual operations instead of building product',
    specificTask: 'internal ops and support triage',
    result: 'saw operational overhead drop after automating internal workflows',
    checklistPains: 'manual onboarding, support triage delays, repetitive reporting',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'tech + automation',
      'quick question',
      'idea for {{city}}',
      'ops overhead',
      'internal workflows',
    ],
  },
  construction: {
    pain: 'tracking project timelines and coordinating subcontractors through calls and messages',
    specificTask: 'milestone alerts and subcontractor scheduling',
    result: 'basically stopped getting "where are we on this?" calls',
    checklistPains: 'manual timeline tracking, phone-tag with subs, missing milestone updates',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'construction + automation',
      'quick question',
      'idea for {{city}}',
      'project tracking',
      'subcontractor updates',
    ],
  },
  automotive: {
    pain: 'manually reminding customers about service appointments and managing bookings',
    specificTask: 'service reminders and booking confirmations',
    result: 'saw repeat bookings pick up after automated reminders',
    checklistPains: 'manual service reminders, missed booking confirmations, no follow-up system',
    subjects: [
      '{{first_name}}?',
      '{{company_name}}',
      'automotive + automation',
      'quick question',
      'idea for {{city}}',
      'service reminders',
      'repeat bookings',
    ],
  },
};

// Default for any industry not specifically listed
const DEFAULT_TEMPLATE = {
  pain: 'spending hours each week on repetitive tasks that don\'t need a human touch',
  specificTask: 'repetitive workflows',
  result: 'got a few hours back each week pretty quickly',
  checklistPains: 'manual data entry, repetitive follow-ups, scattered communication',
  subjects: [
    '{{first_name}}?',
    '{{company_name}}',
    'automation idea',
    'quick question',
    'idea for {{city}}',
    'saving a few hours',
    'workflow thought',
  ],
};

// ---------- Greeting variants ----------
const GREETINGS = [
  (name) => name ? `Hi ${name},` : 'Hi,',
  (name) => name ? `Hey ${name},` : 'Hey,',
  (name) => name ? `Hi ${name} â` : 'Hi there,',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- Structure A: Ultra-Short (3-4 lines) ----------
function structureA(lead, template) {
  const companyRef = lead.company_name || 'your company';
  const industry = lead.industry || 'business';
  const greeting = pickRandom(GREETINGS)(lead.first_name);

  return `${greeting}

Saw ${companyRef} does ${industry} work in Sri Lanka â we've been helping similar companies automate ${template.specificTask} and save a few hours a week.

Worth a quick look? Happy to share what we did for a ${industry} company recently.

Cheers,
Limethsith`;
}

// ---------- Structure B: Question-First ----------
function structureB(lead, template) {
  const companyRef = lead.company_name || 'your company';
  const industry = lead.industry || 'business';
  const city = lead.city || 'Sri Lanka';
  const greeting = pickRandom(GREETINGS)(lead.first_name);

  return `${greeting}

Quick question â does ${companyRef} still handle ${template.pain}?

We built a system for a ${industry} company in ${city} that ${template.result}. Takes about 2 weeks to set up.

If that sounds relevant, I can send a one-page breakdown. If not, no worries at all.

Limethsith`;
}

// ---------- Structure C: Value-First (share something useful) ----------
function structureC(lead, template) {
  const industry = lead.industry || 'business';
  const greeting = pickRandom(GREETINGS)(lead.first_name);

  return `${greeting}

I put together a short checklist of the 3 biggest time-wasters I see in ${industry} companies â things like ${template.checklistPains}.

Would it be useful if I sent it your way? No strings attached.

Limethsith`;
}

const STRUCTURES = [structureA, structureB, structureC];

/**
 * Generate the initial outreach email (Day 0)
 */
function generateInitialEmail(lead) {
  const template = INDUSTRY_TEMPLATES[(lead.industry || '').toLowerCase()] || DEFAULT_TEMPLATE;
  const companyRef = lead.company_name || 'your company';
  const city = lead.city || 'Sri Lanka';
  const firstName = lead.first_name || '';

  // Pick a random subject from the expanded list
  const subjectVariants = template.subjects;
  const subjectVariant = Math.floor(Math.random() * subjectVariants.length);
  const subject = subjectVariants[subjectVariant]
    .replace('{{company_name}}', companyRef)
    .replace('{{first_name}}', firstName)
    .replace('{{city}}', city);

  // Pick a random structure (A, B, or C)
  const structureFn = pickRandom(STRUCTURES);
  const body = structureFn(lead, template);

  return { subject, body, subjectVariant };
}

/**
 * Generate Day 3 follow-up email (2-3 sentences only)
 */
function generateFollowUp1(lead) {
  const companyRef = lead.company_name || 'your company';
  const template = INDUSTRY_TEMPLATES[(lead.industry || '').toLowerCase()] || DEFAULT_TEMPLATE;

  const variants = [
    `Hi${lead.first_name ? ' ' + lead.first_name : ''},

Just bumping this up â I know inboxes get crowded. If automating ${template.specificTask} sounds useful for ${companyRef}, I can send a one-page breakdown.

Either way, no pressure.

Limethsith`,

    `Hi${lead.first_name ? ' ' + lead.first_name : ''},

Circling back quickly. Happy to share a short case study on how we helped a similar company with ${template.specificTask} â just say the word.

Limethsith`,

    `Hi${lead.first_name ? ' ' + lead.first_name : ''},

Following up briefly â would a one-page overview of what we do with ${template.specificTask} be useful? Takes 2 minutes to read.

Limethsith`,
  ];

  return {
    subject: `Re: ${companyRef}`,
    body: pickRandom(variants),
  };
}

/**
 * Generate Day 7 final follow-up email (1-2 sentences max)
 */
function generateFollowUp2(lead) {
  const companyRef = lead.company_name || 'your company';

  const variants = [
    `Hi${lead.first_name ? ' ' + lead.first_name : ''},

Last note from me â if the timing is ever right for ${companyRef}, I'm around. No need to reply otherwise.

Limethsith`,

    `Hi${lead.first_name ? ' ' + lead.first_name : ''},

Closing the loop on this. If it's not a fit right now, totally fine â feel free to reach out whenever.

Limethsith`,

    `Hi${lead.first_name ? ' ' + lead.first_name : ''},

Won't follow up again. If you ever want to chat about automation for ${companyRef}, just reply to this thread.

Limethsith`,
  ];

  return {
    subject: `Re: ${companyRef}`,
    body: pickRandom(variants),
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
     
