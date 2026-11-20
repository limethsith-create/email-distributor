/**
 * Client / prospect message templates for Stage D (SPEC §11).
 * Shape: { key: { subject, body, from: 'owner' | 'sender' | 'onboard' } }. Slots are {name}.
 * Wording comes from the SOPs verbatim where it exists; anything
 * written new is listed in docs/assumptions/stage-d.md.
 *
 * Messages whose lines depend on the data (the Friday update) keep
 * their line templates here as constants; the system fills the lines and
 * hands the finished block to the registered template as {body}. Every slot
 * is still filled through `fill`, so nothing can go out with a hole.
 */

// ── Friday update (the weekly update while sending) ──
export const FRIDAY_LINES = [
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

// Every email here goes through notifyClient, which fills {firstName} (the
// contact's first name) and {clientName} (their company) — the voice rules of
// stage-a.js (docs/IMPROVE-PASS.md §B, tests/voice.test.mjs) apply.
export const TEMPLATES = {
  // Day 1: the first emails went out.
  day1_started: {
    subject: 'Your first emails went out',
    body: 'Hi {firstName},\n\nThe first emails for {clientName} went out this morning from {senderAddress}.\n\nI handle every reply. Anything hot lands in your inbox the same day, with a note on what to do. Your Friday update comes every week.\n\n{dashboardLine}\n\n{buttons}\n\n{ownerName}',
  },

  // The owner shares the client's dashboard with someone (POST /api/mc/clients/{id} {action:'shareDashboard', email}).
  dashboard_access: {
    subject: 'Your Aviance dashboard',
    body: 'Hi {firstName},\n\nHere’s the dashboard for {clientName}: {dashboardLink}\n\nYou can see the sending as it happens: emails sent, replies and booked calls. It updates by itself, so keep the link.\n\n{ownerName}',
  },

  // The owner invites someone to the client portal (POST /api/mc/clients/{id} {action:'invitePortal', email, link}).
  portal_invite: {
    subject: 'Your Aviance portal',
    body: 'Hi {firstName},\n\nYou can now see the numbers for {clientName} and message us in one place. Open this link to set up your account: {portalLink}\n\nThe link works for 14 days, and only with this email address.\n\n{ownerName}',
  },

  friday_update: { subject: '{title}', body: 'Hi {firstName},\n\n{body}\n\n{ownerName}' },

  // Sent when a client stops: everything we gathered is theirs.
  handover: {
    subject: 'Everything from your campaign — {clientName}',
    body: 'Hi {firstName},\n\nYour leads, replies and booked meetings are yours to keep. Attached:\n\n• leads.csv — all {leadCount} contacts\n• replies.csv — every reply with its tag and a snippet\n• bookings.csv — every meeting and what happened\n• the Market Report (HTML and CSV)\n\nWe registered the sending domain and inboxes, and they’re never used for anyone else.\n\n{ownerName}',
  },

  // A client is invoiced for month one when they sign the plan agreement (systems/onboarding.js).
  invoice_plan_start: {
    subject: 'Invoice {invoiceNo} — {planName}, month one',
    body: 'Hi {firstName},\n\nWelcome to {planName}.\n\nInvoice {invoiceNo} · issued {issuedDate} · due today\n{planName}: {priceText} a month for {calls} guaranteed booked calls\nTotal due: {priceText}\n\nPay by:\n{paymentLines}\n\nWe’re setting up your sending address and inboxes now; after about two weeks of warm-up the first emails go out. Month to month, 14 days’ notice, no setup fee.\n\n{ownerName}',
  },
  // One polite nudge ~24 hours after the agreement and invoice went out and nothing was paid (systems/invoice.js chaseUnpaidInvoices).
  invoice_chase: {
    subject: 'Quick note about invoice {invoiceNo}',
    body: 'Hi {firstName},\n\nJust a friendly note: we sent over your agreement and invoice {invoiceNo} ({priceText}, {planName}) yesterday, and we haven’t seen the payment yet.\n\nPay by:\n{paymentLines}\n\nIf it’s already on its way, ignore this, and thank you. If anything is unclear, just reply and I’ll help.\n\n{ownerName}',
  },
  invoice_reminder: {
    subject: 'Reminder: invoice {invoiceNo}',
    body: 'Hi {firstName},\n\nA reminder that invoice {invoiceNo} ({priceText}, {planName}) is still open.\n\nPay by:\n{paymentLines}\n\nIf it’s already on its way, ignore this, and thank you.\n\n{ownerName}',
  },
};
