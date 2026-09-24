/**
 * Client / prospect message templates for Stage D (SPEC §11).
 * Shape: { key: { subject, body, from: 'owner' | 'trial' } }. Slots are {name}.
 * Wording comes from the trial doc / SOPs verbatim where it exists; anything
 * written new is listed in docs/assumptions/stage-d.md.
 *
 * Messages whose lines depend on the data (Friday update, Trial Report) keep
 * their line templates here as constants; the system fills the lines and
 * hands the finished block to the registered template as {body}. Every slot
 * is still filled through `fill`, so nothing can go out with a hole.
 */

// ── Friday update (The 30-Day Trial, Section 10 "The Friday update") ──
export const FRIDAY_TRIAL_LINES = [
  '{clientName} — {weekLabel}',
  'Sent this week: {sentWeek} · to date: {sentTotal}, to {companies} companies',
  'Replies: {repliesWeek} ({replyRateWeek}) · positive: {positiveWeek}',
  'Meetings booked: {bookedWeek} · held: {heldWeek} · running total: {qualifiedTotal} qualified — promise {promise}, target {target}',
  'This week: {thisWeek}',
  'Waiting on you: {waiting}',
  'Watch: {watch}',
];

// Build-week variant (SPEC §9.1 example wording).
export const FRIDAY_BUILD_LINES = [
  '{clientName} — build week {buildWeek} of 2',
  'Inboxes warming: day {warmDay} of {warmDays}',
  'List: {listCount} contacts found',
  'Emails: {copyStatus}',
  'First send: {day1Date}',
  'Waiting on you: {waiting}',
  'Watch: {watch}',
];

// ── Trial Report (The 30-Day Trial, Section 10 "The Trial Report — Day 29") ──
export const REPORT_LINES = [
  '{clientName} — 30-Day Trial Report',
  '',
  'Companies contacted: {companies} · Emails sent: {sent} · Bounce: {bounceRate} · Inbox placement: {placement}',
  'Replies: {replies} ({replyRate}) · Positive: {positive} ({positiveRate})',
  'Calls booked: {booked} · Held: {held} · Qualified: {qualified} · No-shows re-booked: {rebooked}',
  'Promise (one call): {promiseMet} · Target (three): {targetMet}',
  '',
  'What produced it: {produced}. What didn’t: {didnt}.',
  '',
  'Your measured rate: {qualified} qualified calls from {companies} companies is {rate}.',
  '',
  'What that means at volume: Starter contacts at least {starterReach} companies a month — about {starterCalls} calls at your rate, and we guarantee {starterGuarantee}. Growth contacts {growthReach} — about {growthCalls}, and we guarantee {growthGuarantee}.',
  '',
  'What carries over if you continue: the warm domain and inboxes, the profile, the proven copy. Full volume inside two weeks, not three.',
  '',
  'The market report: attached — every reply, tagged, plus the {openCount} conversations still open.',
  '',
  'One recommendation: {recommendation}',
  '',
  'Your Day 30 page: {decisionUrl}',
];

// Zero-call version (Section 8 "What you always deliver" → report sections).
export const REPORT_ZERO_LINES = [
  '{clientName} — Trial Report',
  '',
  'We didn’t get you a call. {companies} companies, {replies} replies, {positive} of them positive, no qualified meetings. I’m not going to dress that up.',
  '',
  'The numbers: Emails sent: {sent} · Bounce: {bounceRate} · Inbox placement: {placement} · Replies: {replyRate} · Positive: {positiveRate} · Booked: {booked} · Held: {held}',
  '',
  'The diagnosis: {diagnosis}',
  '',
  'The Market Report (attached): every reply tagged, which titles, company sizes and cities answered.',
  'The open pipeline: {openCount} conversations still alive, with follow-up dates — yours in the spreadsheet either way.',
  'The list: all {leadCount} contacts, exported.',
  'The copy and what it did: {variants}.',
  'The infrastructure proof: bounce {bounceRate}, inbox placement {placement}, {sendsPerDay} sends per sending day.',
  '',
  'What I’d do next, honestly: {recommendation}',
  '',
  'Your page: {decisionUrl}',
];

// ── Decision page FAQ (The 30-Day Trial, Section 6 "What they say, and what you say") ──
export const DECISION_FAQ = [
  { q: 'Can we start on Starter and move up later?', a: 'Yes — upgrade any time, prorated. But you told us you can take {capacityPerWeek} calls a week; Starter gives you two or three. Pick the plan that matches your calendar.' },
  { q: 'That’s more than I expected.', a: 'It’s about {perCall} a call for meetings with companies you approved. What were you expecting to pay for a sales conversation?' },
  { q: 'Can you do a discount for the first month?', a: 'No — but we can change the scope. Starter is ten calls at $2,497. Same work, fewer conversations.' },
  { q: 'Let me think about it.', a: 'Of course. What’s the one thing you’d need to be sure about? Tap “Talk to someone” and name it. The trial domain retires on Day 45.' },
  { q: 'We want the calls but not the retainer.', a: 'Then pay per show: $250 for every qualified call that actually attends, billed weekly, nothing else. After month two it moves to a minimum of five a month or a plan.' },
];

export const TEMPLATES = {
  // Day 1 — verbatim ("Your trial started today", Section 10).
  day1_started: {
    subject: 'Day 1',
    body: '{contactName} — the first emails went out this morning from {senderAddress}. Day 30 is {day30Date}.\n\nI handle every reply. Anything hot lands in your inbox the same day with a note on what to do. Friday update as usual.\n\n{buttons}\n\n{ownerName}',
  },

  friday_update: { subject: '{title}', body: '{body}\n\n{ownerName}' },

  disposition_sheet: {
    subject: 'Your meetings so far — {clientName}',
    body: '{contactName} — every meeting from the trial so far, pre-filled: company, date, showed, right fit, outcome. Fill this in and I’ll fix the targeting for you.\n\n{rows}\n\nThe buttons under each meeting stay open until Day 25. Anything to add? Just reply to this email.\n\n{ownerName}',
  },

  trial_report: { subject: '{clientName} — 30-Day Trial Report', body: '{body}\n\n{ownerName}' },
  trial_report_zero: { subject: '{clientName} — Trial Report', body: '{body}\n\n{ownerName}' },

  decision_link: {
    subject: 'Day 30 — your numbers and one recommendation',
    body: '{contactName} — Day 30. Your five numbers, one recommendation and three buttons are on one page: {decisionUrl}\n\n{recommendationLine}\n\nMonth-one bonus: {bonusLine} if you start before {bonusExpires}. The domain’s already warm and the copy’s proven, so you skip the build. If you don’t continue, the trial domain retires on Day 45.\n\n{ownerName}',
  },
  decision_link_zero: {
    subject: 'Day {day} — the honest numbers',
    body: '{contactName} — we didn’t get you a call. {companies} companies, {replies} replies, {positive} of them positive, no qualified meetings. I’m not going to dress that up.\n\nThe full report is attached to the last email and on your page: {decisionUrl}\n\nWhat I’d do next, honestly: {recommendationLine}\n\n{ownerName}',
  },

  talk_ack: {
    subject: 'Let’s talk — pick a time',
    body: '{contactName} — thanks. Times I can do (US Eastern):\n\n{slots}\n\nReply with the one that suits you and I’ll send the invite.\n\n{ownerName}',
  },

  // Section 7 "The extension" wording, as an email.
  extension_notice: {
    subject: 'Day 30 — we keep going',
    body: '{contactName} — no qualified call has been held by Day 30, so the promise kicks in: we keep sending at our cost until one is, up to Day {capDay}. You don’t pay for the extra time and you don’t have to ask for it.\n\nWe change the campaign, not the deal: new copy, a tighter list, better timing. The Day 30 decision moves to the day after the first qualified call. Hard stop at Day {capDay}; after that the trial ends whatever happened, and you get the full report.\n\nYour side still has to hold: calendar open, hot replies answered within one business day.\n\n{ownerName}',
  },

  // Review requests — verbatim (Section 10).
  review_request: {
    subject: 'The review — ten minutes',
    body: '{contactName}, thank you for the last 30 days. Here’s the one thing I ask in return: a review on Clutch — {clutchUrl}.\n\nThree things, so it’s all above board: it can be positive or negative, it should be exactly what you actually think, and it needs to start with the line “I received this service for free for my review.” Clutch requires that when a service was free.\n\nSay what actually happened. If something was a three out of five, say so — that’s the version I can learn from and the version people believe. Clutch may email you to verify it.\n\n{ownerName}',
  },
  review_request_zero: {
    subject: 'The review — and thank you for the 30 days',
    body: '{contactName}, we didn’t get you a call, and I’m not going to pretend otherwise. I’d still like the review, and I’d like it to say that.\n\nWhat’s useful to someone reading it: whether the work was run properly, whether the reporting was clear, whether I told you the truth when it wasn’t working, and whether the report on your market was worth having. Rate it however you actually rate it.\n\nSame three rules: positive or negative, your honest opinion, and it starts with “I received this service for free for my review.” Link: {clutchUrl}.\n\n{ownerName}',
  },

  // Testimonial approval — verbatim.
  testimonial_approval: {
    subject: 'Your words — edit freely',
    body: '{contactName}, this is what you said on {quoteDate}, tidied: “{draft}”\n\nChange anything. Once you reply “approved”, it goes on our site with your name, title and the {clientName} logo. If you’d rather it were anonymous — “founder, 12-person MSP” — say so and that’s what we’ll use.\n\n{ownerName}',
  },

  // Not-now ladder (Section 10 table).
  ladder_33: {
    subject: 'The review link, once more',
    body: '{contactName} — the review link again, in case it got buried: {clutchUrl}. The review is due regardless of the decision: positive or negative, your honest opinion, starting with “I received this service for free for my review.”\n\n{ownerName}',
  },
  ladder_33_quote: {
    subject: 'Your words, and the review link',
    body: '{contactName} — the quote draft from {quoteDate}, tidied: “{draft}” Reply “approved” or change anything.\n\nAnd the review link again: {clutchUrl}. The review is due regardless of the decision: positive or negative, your honest opinion, starting with “I received this service for free for my review.”\n\n{ownerName}',
  },
  ladder_37: {
    subject: 'Conversations still open from your trial',
    body: '{contactName} — no ask in this one. These conversations from your trial are still open:\n\n{openList}\n\nThey’re yours whatever you decide.\n\n{ownerName}',
  },
  ladder_44: {
    subject: 'The trial domain retires tomorrow',
    body: '{contactName} — the domain retires tomorrow. Say the word and it stays live.\n\n{ownerName}',
  },

  // Exit interview — the three questions from Section 10.
  exit_interview: {
    subject: 'Three questions, ten minutes',
    body: '{contactName} — ten minutes, and tell me the real reason. It’s the only way I get better at this.\n\n1. What was the real reason?\n2. What would have made this a yes?\n3. Who else should be doing this?\n\nOne line each is plenty — just reply. The review is still welcome: {clutchUrl}\n\n{ownerName}',
  },

  handover: {
    subject: 'Everything from your trial — {clientName}',
    body: '{contactName} — your leads, replies and booked meetings are yours, whether or not you continue. Attached:\n\n• leads.csv — all {leadCount} contacts\n• replies.csv — every reply with its tag and a snippet\n• bookings.csv — every meeting and what happened\n• the Market Report (HTML and CSV)\n\nThe sending domain and inboxes are registered by us and are never used for anyone else.\n\n{ownerName}',
  },

  invoice_month1: {
    subject: 'Invoice {invoiceNo} — {planName}, month one',
    body: '{contactName} — welcome to {planName}.\n\nInvoice {invoiceNo} · issued {issuedDate} · due today\n{planName}: {priceText} a month for {calls} guaranteed booked calls\n{bonusLine}\nTotal due: {priceText}\n\nPay by:\n{paymentLines}\n\nThe trial domain and inboxes stay live, so you’re at full volume inside two weeks. Month to month, 14 days’ notice, no setup fee.\n\n{ownerName}',
  },
  invoice_reminder: {
    subject: 'Reminder: invoice {invoiceNo}',
    body: '{contactName} — a reminder that invoice {invoiceNo} ({priceText}, {planName}) is still open.\n\nPay by:\n{paymentLines}\n\nIf it’s already on its way, ignore this — thank you.\n\n{ownerName}',
  },

  // Offboarding SOP step 6 + the trial doc's win-back line.
  winback_90: {
    subject: 'Worth a 15-minute look?',
    body: 'Hi {contactName} — we’ve added {whatsNew} since your trial ended, and it is working well for clients like you. The list has moved on and we’d rebuild. Same offer, same price. Worth a 15-minute look?\n\n{ownerName}',
  },
};
