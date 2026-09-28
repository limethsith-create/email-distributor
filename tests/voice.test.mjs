// Sounding human (docs/IMPROVE-PASS.md §B): every client template, every reply
// bot answer and every cold sequence (all niches × frameworks × A/B and C/D
// variants × sample leads, plus Sequence T) rendered with sample values and
// held to the owner's rules — word counts, the banned phrases, the greeting
// by first name, one question, no links in touch 1, the opt-out line, reading
// grade ≤ 8, contractions, no "!". The Copy Checker's two new rules
// (sounds_template, reading_grade) are tested here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, renderTemplate } from '@/lib/templates/client';
import { TEMPLATES as A } from '@/lib/templates/client/stage-a';
import { TEMPLATES as B } from '@/lib/templates/client/stage-b';
import { TEMPLATES as C } from '@/lib/templates/client/stage-c';
import { TEMPLATES as D, FRIDAY_TRIAL_LINES, FRIDAY_BUILD_LINES, REPORT_LINES, REPORT_ZERO_LINES } from '@/lib/templates/client/stage-d';
import { slotsOf } from '@/lib/templates/render';
import { DEFAULTS } from '@/lib/config';
import { fillAnswer } from '@/lib/systems/replybot';
import { NICHE_TEMPLATES, frameworkTemplate, buildVariant, clientVars, renderVariant, firstLineFor } from '@/lib/systems/copy';
import { getSequence, varsFor, renderTouch } from '@/lib/systems/sequence';
import { checkEmail, ticks, RULES, wordCount, readingGrade, syllables, templateTells, bannedIn, uncontracted, VOICE_BANNED } from '@/lib/systems/copycheck';
import { __reset } from '@vercel/kv';

// ── sample values (the ones the stage tests use; realistic ones where those were x-tokens) ──

// notifyClient fills these three on every client email (client name, full contact name, first name).
const AUTO = { clientName: 'Acme IT', contactName: 'Ann Lee', firstName: 'Ann' };
const OWNER = 'Limeth Sith';
// tests/stage-a.test.mjs "every Stage A template renders with sample data".
const SAMPLE_A = {
  ownerName: OWNER, link: 'https://x/c/t/onboard', closeDate: 'Monday 12 October', position: 2,
  expectedLine: 'Soon.', reason: 'because.', minMarket: '1,000', estimate: '500', widenedLine: ' in the areas you gave me', mainDomain: 'acme.com',
  agreementText: 'TEXT', agreementName: 'Ann Lee', agreementTitle: 'CEO', companyName: 'Acme', acceptedAt: '2026-10-05 14:00', agreementIp: '1.2.3.4',
  day1Date: 'Monday 19 October', day30Date: 'Tuesday 17 November', calendarUrl: 'https://cal', problem: 'broken.',
  startWhen: 'Monday 19 October at 8:00 am Central Time (9:00 am Eastern)', senderName: 'Dana Whitfield', inboxes: 'dana@ridgeline-team.com and dana.w@ridgeline-team.com', sendWindow: "between 9:00 am and 5:00 pm on weekdays, in each prospect's own time zone",
  callMinutes: 30, bookingLine: 'Book a time that suits you: https://cal.com/limeth/onboarding', onboardingLink: 'https://x/c/t/onboard',
  threadSubject: "Let's book your onboarding call", when: 'Tuesday, October 13 at 11:00 AM EDT', callDay: 'tomorrow', text: 'Tuesday works.\n\nLimeth', joinLine: 'Join here: https://meet.google.com/abc-defg-hij',
  whenShort: 'Tue 13 Oct at 11:00 am ET', minutes: 30, linkLine: "I'll send the link before the call.", bookLink: 'https://x/c/t/book',
  nextLine: 'If the time stops working, pick another here: https://x/c/t/book', asked: 'Tuesday at 2:00 pm', acceptLink: 'https://x/c/t/book/accept?m=m1',
  cancelText: "I'm sorry — I've had to cancel our call on Tuesday 13 October at 11:00 am Eastern Time.",
  opening: 'Good to talk with you today, thank you.', listSize: 400, day1Line: 'in about three weeks',
};
// Stage B (approval.js mailVars, launchcall.js, readiness.js day1_moved).
const SAMPLE_B = {
  ...SAMPLE_A, senderName: 'Dana Whitfield', silenceDate: 'Friday 16 October', approvalUrl: 'https://x/c/t/approve', day1Line: 'about Wednesday 21 October',
  reason: 'the canary check needs one more day', waitingLine: 'Nothing is needed from you.',
};
// tests/stage-c.test.mjs "every Stage C template renders with sample data".
const SAMPLE_C = {
  Company: 'Acme', Name: 'Ann', Title: 'Owner', size: '10-50', city: 'Dover', verbatim: 'Tell me more', quote: '“Tell me more.”', who: 'Ann at Acme (10-50, Dover)', actionLine: 'x', context: 'Acme — Dover',
  hours: 5, when: 'Thursday 10:00 AM', whyYes: 'Tell me more', asked: 'nothing', thread: 'x', days: 6, showedUrl: 'u', noshowUrl: 'u', wrongfitUrl: 'u', disputeUrl: 'u', clientNoshowUrl: 'u',
  companies: 240, replies: 7, positive: 2, diagnosis: 'd', fix: 'f', pending: 2, FirstName: 'Ann', slot1: 's1', slot2: 's2', calendarUrl: 'c',
  month: 'January', Referrer: 'Bob', Greeting: 'Hi Ann,', oneLiner: 'We fix IT.', SenderName: 'Jane', missedWhen: 'Tuesday', ClientCompany: 'Acme IT',
  ownerName: OWNER,
};
// Stage D (trialmanager, decision, ladder, handover, invoice callers).
const SAMPLE_D = {
  ownerName: OWNER, senderAddress: 'dana@ridgeline-team.com', day30Date: 'Tuesday 17 November', buttons: 'Pause sending: https://x/c/t/pause',
  title: 'Acme IT — trial week 3 of 4', body: 'A reply came in from Bolt IT on Tue.\nSent this week: 180 · to date: 1040, to 412 companies',
  rows: '• Bolt IT, Tue 13 Oct: showed', decisionUrl: 'https://x/c/t/decide', recommendationLine: 'I recommend Growth.', bonusLine: '22 calls for the price of 20',
  bonusExpires: 'Friday 20 November', day: 60, companies: 412, replies: 31, positive: 12, slots: '• Tue 10:00 am\n• Wed 2:00 pm', capDay: 60,
  clutchUrl: 'https://clutch.co/profile/aviance', quoteDate: 'Tue 3 Nov', draft: 'They were quick and honest.', openList: '• bo@bolt.test (asked for a quote)',
  leadCount: 400, invoiceNo: 'INV-001', planName: 'Growth', issuedDate: '2 December', priceText: '$3,997', calls: 20,
  paymentLines: 'PayPal: https://paypal.me/aviance/3997USD', whatsNew: 'call notes',
};
const STAGE_SAMPLE = new Map([[A, SAMPLE_A], [B, SAMPLE_B], [C, SAMPLE_C], [D, SAMPLE_D]]);
const stageOf = (key) => [A, B, C, D].find((s) => key in s);

/** A template's sample values: its stage's, notifyClient's own, and a plain word for any slot a newer template adds. */
function varsFor1(key) {
  const t = TEMPLATES[key];
  const base = { ...AUTO, ...STAGE_SAMPLE.get(stageOf(key)) };
  // inWhoseName is worked out by renderTemplate from senderName / contactName.
  for (const s of [...slotsOf(t.subject || ''), ...slotsOf(t.body)]) if (base[s] === undefined && s !== 'inWhoseName') base[s] = 'Tuesday';
  return base;
}

// ── the rules ────────────────────────────────────────────────────────────────

/** Subject words with each {slot} as one word (a name or a date is one thing), "Re:" left out. */
const subjectWords = (subject) => String(subject || '').replace(/^\s*re:\s*/i, '').replace(/\{[^}]+\}/g, 'X').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
/** Question marks a reader sees (a "?" inside a link's query string is not a question). */
const questions = (text) => (String(text).replace(/https?:\/\/\S+/g, 'link').match(/\?/g) || []).length;

/** Templates whose body carries a report, a list or a document (no 120-word or grade limit on the data they carry). */
const CARRIES_A_REPORT = new Set(['agreement_copy', 'friday_update', 'trial_report', 'trial_report_zero', 'disposition_sheet', 'handover', 'invoice_month1', 'invoice_plan_start', 'ladder_37', 'call_handoff', 'call_tap', 'call_tap_reminder']);
/** Passed through as they are: the owner's own words, and the reply bot's answer (tested below). */
const PASSTHROUGH = new Set(['onboard_owner_reply', 'bot_reply']);

const letters = () => Object.entries(TEMPLATES).filter(([k, t]) => !PASSTHROUGH.has(k) && !t.prospect && t.from !== 'trial');
const notices = () => Object.entries(TEMPLATES).filter(([, t]) => !t.prospect && t.from === 'trial');
const prospects = () => Object.entries(TEMPLATES).filter(([, t]) => t.prospect);

/** Rules every email of ours keeps; → the broken ones as strings. */
function common(key, subject, text, { maxWords = 120, grade = true, names = [] } = {}) {
  const out = [];
  if (/!/.test(`${subject}\n${text}`)) out.push('has "!"');
  const banned = bannedIn(`${subject}\n${text}`);
  if (banned.length) out.push(`banned: ${banned.join(', ')}`);
  const unc = uncontracted(text);
  if (unc.length) out.push(`not contracted: ${unc.join(', ')}`);
  const tells = templateTells(`${subject}\n${text}`);
  if (tells.count > 2) out.push(`sounds like a template: ${tells.found.join(', ')}`);
  if (maxWords && !CARRIES_A_REPORT.has(key) && wordCount(text) > maxWords) out.push(`${wordCount(text)} words (limit ${maxWords})`);
  if (grade && !CARRIES_A_REPORT.has(key)) {
    // A long business name is one name, not long words (as the Copy Checker reads it).
    let plain = text;
    for (const name of names) if (name && String(name).includes(' ')) plain = plain.split(String(name)).join('Company');
    const g = readingGrade(plain);
    if (g > 8) out.push(`reading grade ${g}`);
  }
  return out;
}

// ── client emails ────────────────────────────────────────────────────────────

test('every client email: "Hi {firstName}," and the owner\'s name as the sign-off, < 120 words, one ask, contractions, no banned phrase, no "!", grade ≤ 8, a subject under 6 words', () => {
  const problems = [];
  let n = 0;
  for (const [key, t] of letters()) {
    n++;
    const vars = varsFor1(key);
    const m = renderTemplate(key, vars);
    const bad = common(key, m.subject, m.text);
    // The greeting is the first name only (never the full contact name), on its own line.
    if (!/^Hi \{firstName\},\n\n/.test(t.body)) bad.push('does not open with "Hi {firstName},"');
    if (!m.text.startsWith('Hi Ann,\n\n') || /Ann Lee/.test(m.text.split('\n')[0])) bad.push(`greeting: ${JSON.stringify(m.text.split('\n')[0])}`);
    // Signed with the owner's name and nothing after it (no title block).
    if (!/\n\n\{ownerName\}$/.test(t.body) || !m.text.endsWith(`\n\n${OWNER}`)) bad.push('not signed with {ownerName} as the last line');
    if (questions(m.text) > 1) bad.push(`${questions(m.text)} question marks (one ask)`);
    if (subjectWords(t.subject) > 5) bad.push(`subject "${t.subject}" is ${subjectWords(t.subject)} words`);
    if (bad.length) problems.push(`${key}: ${bad.join('; ')}`);
  }
  assert.ok(n >= 50, `${n} client emails`);
  assert.deepEqual(problems, []);
});

test('the fact that makes it theirs: company, exact dates, the count — in the emails that carry them', () => {
  const has = (key, re) => assert.match(renderTemplate(key, varsFor1(key)).text, re, key);
  has('accepted_call', /30-day trial for Acme\./);
  has('onboarding_link', /from Acme IT/);
  has('welcome_two_dates', /we start on Monday 19 October at 8:00 am Central Time \(9:00 am Eastern\)\.[\s\S]*That's Day 1 of your 30\. Day 30 is Tuesday 17 November\./);
  has('next_steps', /your list of about 400 companies/);
  has('launch_invite', /in Dana Whitfield's name/);
  has('launch_invite', /the first emails go out about Wednesday 21 October\./);
  has('day1_moved', /moves to Monday 19 October at 8:00 am Central Time \(9:00 am Eastern\), and Day 30 moves to Tuesday 17 November/);
  has('day1_started', /The first emails for Acme IT went out this morning from dana@ridgeline-team\.com\. Day 30 is Tuesday 17 November\./);
  has('onboard_call_tomorrow', /is Tuesday, October 13 at 11:00 AM EDT\./);
  has('meeting_confirmed', /is Tuesday, October 13 at 11:00 AM EDT\./);
  assert.equal(renderTemplate('welcome_two_dates', varsFor1('welcome_two_dates')).subject, 'We start on Monday 19 October');
  assert.equal(renderTemplate('launch_invite', varsFor1('launch_invite')).subject, 'Your list is ready');
});

test('the owner\'s words and the bot\'s answer pass through untouched', () => {
  for (const key of PASSTHROUGH) {
    assert.equal(TEMPLATES[key].body, '{text}');
    assert.equal(renderTemplate(key, { threadSubject: 'Hello', text: 'Hi Ann,\n\nYes.\n\nLimeth' }).text, 'Hi Ann,\n\nYes.\n\nLimeth');
  }
});

test('trial-inbox notices to the client and replies to prospects: short, one question, contractions, no banned phrase, no "!"', () => {
  const problems = [];
  for (const [key] of notices()) {
    const m = renderTemplate(key, varsFor1(key));
    const bad = common(key, m.subject, m.text);
    if (questions(m.text) > 1) bad.push(`${questions(m.text)} question marks`);
    if (subjectWords(TEMPLATES[key].subject) > 5) bad.push(`subject "${TEMPLATES[key].subject}"`);
    if (bad.length) problems.push(`${key}: ${bad.join('; ')}`);
  }
  for (const [key, t] of prospects()) {
    const m = renderTemplate(key, varsFor1(key));
    const bad = common(key, m.subject, m.text, { maxWords: 49 });
    if (questions(m.text) > 1) bad.push(`${questions(m.text)} question marks`);
    if (t.subject && subjectWords(t.subject) > 5) bad.push(`subject "${t.subject}"`);
    // A name in a reply to a prospect is the first name only.
    if (/\{(Name|contactName)\}/.test(t.body)) bad.push('uses a full name');
    if (bad.length) problems.push(`${key}: ${bad.join('; ')}`);
  }
  assert.deepEqual(problems, []);
});

test('the Friday update and Trial Report lines: no banned phrase, no "!", contractions', () => {
  const problems = [];
  for (const [name, lines] of Object.entries({ FRIDAY_TRIAL_LINES, FRIDAY_BUILD_LINES, REPORT_LINES, REPORT_ZERO_LINES })) {
    const text = lines.join('\n');
    const bad = [];
    if (/!/.test(text)) bad.push('has "!"');
    if (bannedIn(text).length) bad.push(`banned: ${bannedIn(text)}`);
    if (uncontracted(text).length) bad.push(`not contracted: ${uncontracted(text)}`);
    if (bad.length) problems.push(`${name}: ${bad.join('; ')}`);
  }
  assert.deepEqual(problems, []);
});

// ── the reply bot ────────────────────────────────────────────────────────────

test('every reply bot answer: "Hi {firstName},", signed, < 120 words, one question at most, contractions, no banned phrase, no "!", grade ≤ 8', () => {
  const vars = {
    firstName: 'Sam', ownerName: OWNER, bookingLink: 'https://app.test/c/t/book', times: '• Tue 6 Oct at 9:00 am ET\n• Wed 7 Oct at 9:00 am ET',
    when: 'Tuesday 6 October at 2:00 pm', onboardingLink: 'https://app.test/c/t/onboard', callMinutes: 30,
    howLine: "You applied for our free 30-day trial on our website, and that's where your email came from.",
  };
  const problems = [];
  const answers = DEFAULTS.REPLYBOT.answers;
  for (const rule of ['who_are_you', 'later']) assert.ok(answers[rule], `REPLYBOT.answers.${rule}`);
  for (const [rule, tpl] of Object.entries(answers)) {
    const text = fillAnswer(tpl, vars);
    assert.ok(text, `${rule} fills`);
    const bad = common(rule, '', text);
    if (!text.startsWith('Hi Sam,\n\n')) bad.push('greeting');
    if (!text.endsWith(`\n\n${OWNER}`)) bad.push('sign-off');
    if (questions(text) > 1) bad.push(`${questions(text)} question marks`);
    if (bad.length) problems.push(`${rule}: ${bad.join('; ')}`);
  }
  assert.deepEqual(problems, []);
  assert.match(fillAnswer(answers.who_are_you, vars), /aviance\.online/, 'who_are_you gives the website');
  assert.match(fillAnswer(answers.later, vars), /I'll check back Tuesday 6 October at 2:00 pm/);
});

// ── cold sequences ───────────────────────────────────────────────────────────

const PROFILE = {
  senderName: 'Sam Carter', companyName: 'Acme IT', postalAddress: '100 Main St, Dallas, TX 75201',
  oneLiner: 'We look after computers, email and backups for small offices in Dallas.', defaultNiche: 'managed IT', defaultIcp: 'dental practices',
  proofLine: 'We look after 30 offices around Dallas, most of them dental and law practices.',
};
// tests/leads-copy-v2.test.mjs SAMPLES: a lead with every fact, a long legal name with no facts, a shouting name with no city.
const LEADS = [
  { first_name: 'Ann', company: 'Smile Dental - Family & Cosmetic Dentistry of North Dallas', city: 'Dallas', types: ['dentist'], facts: { rating: 4.8, reviews: 212, since: 1998, services: ['teeth whitening'], servicePage: { label: 'dental implants' } } },
  { first_name: 'Christopher', company: 'Greater Metropolitan Property Management Group LLC', city: 'San Antonio', types: [] },
  { first_name: 'Bo', company: 'ABC PLUMBING', city: '', types: ['plumber'], facts: { services: ['drain cleaning'] } },
];

/** The rules of one rendered cold touch → the broken ones. */
function coldRules(r, lead, { firstLine = null } = {}) {
  const bad = common(r.touch, r.subject || '', r.body, { maxWords: r.touch === 'd0' ? 79 : 49, names: r.exemptWords || [] });
  const first = lead.first_name;
  if (r.touch === 'd0' && !r.body.startsWith(`Hi ${first},\n\n`)) bad.push('touch 1 does not open "Hi {FirstName},"');
  if (r.touch !== 'd0' && !r.body.startsWith(`${first},`) && !r.body.startsWith(`${first} —`)) bad.push(`follow-up does not open with the first name: ${JSON.stringify(r.body.slice(0, 30))}`);
  if (questions(r.text) > 1) bad.push(`${questions(r.text)} question marks in the email`);
  if (r.touch === 'd0' && /(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|net|org|io|co|online)\b/i.test(r.text)) bad.push('a link in touch 1');
  if (!/reply\s+STOP\b/.test(r.text)) bad.push('no opt-out line');
  if (firstLine && r.touch === 'd0' && !r.body.includes(firstLine)) bad.push('touch 1 has no first line of its own');
  return bad;
}

test('every cold touch (all niches × frameworks × variants × sample leads): < 80 words in touch 1, < 50 after, one question, first name, no link in touch 1, opt-out, grade ≤ 8, passes the Copy Checker', () => {
  const problems = [];
  let n = 0;
  for (const tpl of Object.values(NICHE_TEMPLATES)) {
    for (const fw of Object.keys(tpl.frameworks)) {
      for (const backup of [false, true]) {
        const t = frameworkTemplate(tpl, fw, { backup });
        for (const def of t.variants) {
          const v = buildVariant(t, def, clientVars({ name: 'Acme IT' }, PROFILE));
          for (const lead of LEADS) {
            const firstLine = firstLineFor(lead, def.firstLineSet);
            for (const r of renderVariant(v, lead)) {
              n++;
              const bad = coldRules(r, lead, { firstLine });
              if (questions(r.body) !== 1) bad.push(`${questions(r.body)} questions in the body (one ask)`);
              const res = checkEmail(r, PROFILE);
              if (!res.ok) bad.push(`Copy Checker: ${JSON.stringify(res.failures)}`);
              if (bad.length) problems.push(`${tpl.niche}/${fw}/${def.id}/${r.touch}/${lead.first_name}: ${bad.join('; ')}`);
            }
          }
        }
      }
    }
  }
  assert.ok(n >= 900, `${n} renders`);
  assert.deepEqual(problems.slice(0, 15), [], `${problems.length} problems`);
});

test('Sequence T (Aviance\'s own, default.json) keeps the same voice', async () => {
  __reset();
  const seq = await getSequence('aviance');
  const lead = { email: 'ann@acme.com', first_name: 'Ann', company: 'Acme IT', city: 'Dallas', marketCount: 612, sizeBand: '10-50', dealValue: '5,000' };
  const vars = varsFor(lead, { profile: { senderName: 'Limethsith', postalAddress: '1 Main St, Dover, DE 19901', defaultNiche: 'IT service companies', defaultIcp: 'small offices near you' } });
  const problems = [];
  for (const t of seq.touches) {
    const r = { touch: t.touch, ...renderTouch(seq, t.touch, vars) };
    const bad = coldRules(r, lead);
    if (t.touch === 'd0' && !/Acme IT/.test(r.body)) bad.push('touch 1 does not name the company');
    if (subjectWords(r.subject || '') > 6) bad.push('subject too long');
    if (bad.length) problems.push(`${t.touch}: ${bad.join('; ')}`);
  }
  assert.deepEqual(problems, []);
  assert.match(renderTouch(seq, 'd3', vars).body, /seven dollars a month/, 'the $7 line stays (SPEC decision 3)');
});

test('a first line in long words falls back to a plainer fact, so the email keeps its grade', () => {
  const lead = { company: 'Bolt Co', city: 'Dallas', types: ['plumber'], facts: { services: ['commercial refrigeration'] } };
  assert.ok(readingGrade('I was reading about the commercial refrigeration work Bolt Co does in Dallas.') > 9);
  assert.equal(firstLineFor(lead, 'B'), 'I was looking at plumbing companies in Dallas and Bolt Co came up.');
  assert.equal(firstLineFor({ ...lead, facts: { services: ['drain cleaning'] } }, 'B'), 'I was reading about the drain cleaning work Bolt Co does in Dallas.', 'a plain service is kept');
});

test('the opt-out line is plain: a statement with "reply STOP", no question, in every niche footer', () => {
  for (const tpl of Object.values(NICHE_TEMPLATES)) {
    const line = tpl.footer.split('\n\n').pop();
    assert.match(line, /reply STOP/, tpl.niche);
    assert.doesNotMatch(line, /\?|!|\bjust\b/i, tpl.niche);
  }
});

// ── the Copy Checker's new rules ─────────────────────────────────────────────

test('reading grade (Flesch-Kincaid, no library) and the syllable rules of thumb', () => {
  assert.deepEqual(['cat', 'table', 'computer', 'email', "you're", 'backups', 'reviewed', 'yes', 'IT', '2026'].map(syllables), [1, 2, 3, 2, 1, 2, 2, 1, 1, 1]);
  assert.ok(readingGrade('We fix computers. You get your day back.') < 3);
  assert.ok(readingGrade('Our comprehensive infrastructure optimisation methodology facilitates organisational transformation across heterogeneous environments.') > 12);
  assert.equal(readingGrade(''), 0);
  assert.equal(readingGrade('Hi Ann,'), 0, 'a greeting line alone is nothing to grade');
  // Links and addresses are one short word each, not a 40-letter monster.
  assert.equal(readingGrade('Book here: https://app.test/c/abcdefghijklmnopqrstuvwxyz/book'), readingGrade('Book here: link'));
});

test('copy checker: sounds_template (three tells) and reading_grade fail when they should, and are listed on the approval page', () => {
  const profile = { senderName: 'Sam Carter', postalAddress: '100 Main St, Dallas, TX 75201' };
  const footer = '\n\nSam Carter\n100 Main St, Dallas, TX 75201\n\nIf this isn\'t for you, reply STOP and I won\'t email you again.';
  const mk = (body, extra = {}) => ({ touch: 'd3', subject: 'idea for Acme', body, text: `${body}${footer}`, ...extra });
  const rules = (r) => checkEmail(r, profile).failures.map((f) => f.rule);
  assert.deepEqual(rules(mk('Ann, one thought for you.\n\nWorth a chat?')), []);
  assert.deepEqual(rules(mk('I wanted to share one idea. I hope it helps, and it is just a small one.\n\nWorth a chat?')), ['sounds_template']);
  assert.deepEqual(rules(mk('Ann, just one idea. It is just a small one, just for you.\n\nWorth a chat?')), ['sounds_template'], 'each "just" counts');
  assert.deepEqual(rules(mk('Ann, I hope all is well. Just one idea.\n\nWorth a chat?')), [], 'two tells are fine');
  assert.deepEqual(rules(mk('Our comprehensive infrastructure optimisation methodology facilitates transformation.\n\nInterested in a conversation?')), ['reading_grade']);
  assert.deepEqual(rules(mk('We reach out to offices.\n\nWorth a chat?')), ['stale_phrase'], '"reach out" is banned in cold copy too');
  // The approval page lists every rule with a tick (and the reason when it fails).
  const t = ticks(checkEmail(mk('I wanted to share one idea. I hope it helps, and it is just a small one.\n\nWorth a chat?'), profile));
  assert.deepEqual(t.filter((x) => ['sounds_template', 'reading_grade'].includes(x.rule)).map((x) => [x.rule, x.ok]), [['sounds_template', false], ['reading_grade', true]]);
  assert.match(t.find((x) => x.rule === 'sounds_template').detail, /^3 template tells: "i hope", "i wanted to", "just"$/);
  assert.ok(RULES.sounds_template && RULES.reading_grade);
});

test('the banned list and the contraction check themselves', () => {
  assert.deepEqual(bannedIn("We're excited to reach out and circle back — hope this finds you well."), ["we're excited", 'reach out', 'circle back', 'hope this finds you well']);
  assert.deepEqual(bannedIn('We reached outside the box.'), []);
  assert.ok(VOICE_BANNED.includes('just checking in') && VOICE_BANNED.includes('leverage') && VOICE_BANNED.includes('seamless'));
  assert.deepEqual(uncontracted('I am sure it is fine and we do not mind.'), ['I am', 'it is', 'do not']);
  assert.deepEqual(uncontracted("Keep going until there is. That's who you are."), [], 'the end of a clause keeps them apart');
});

test('"in your name" when the emails go out as the contact; the sender\'s name when someone else sends', async () => {
  const { inWhoseName } = await import('@/lib/templates/client');
  assert.equal(inWhoseName({ senderName: 'Dana Whitfield', contactName: 'Dana  whitfield' }), 'in your name');
  assert.equal(inWhoseName({ senderName: 'Dana', contactName: 'Dana Whitfield' }), 'in your name');
  assert.equal(inWhoseName({ senderName: 'Sam Carter', contactName: 'Dana Whitfield' }), "in Sam Carter's name");
  assert.equal(inWhoseName({ senderName: 'Sam Carter' }), "in Sam Carter's name");
  assert.equal(inWhoseName({ contactName: 'Dana Whitfield' }), null);
  assert.match(renderTemplate('launch_invite', { ...varsFor1('launch_invite'), senderName: 'Ann Lee', contactName: 'Ann Lee' }).text, /will go out in your name are ready/);
});
