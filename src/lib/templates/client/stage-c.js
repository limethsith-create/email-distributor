/**
 * Client / prospect message templates for Stage C (SPEC §11).
 * Shape: { key: { subject, body, from: 'owner' | 'trial' } }. Slots are {name}.
 * Wording comes from the trial doc / SOPs verbatim where it exists; anything
 * written new is listed in docs/assumptions/stage-c.md.
 *
 * Prospect-facing templates (`prospect: true`) are sent by
 * systems/outbound.js from the trial inbox, in the thread, and get the
 * sequence footer appended (sender name, postal address, "reply STOP") so the
 * Compliance Guard passes. They therefore carry no sign-off of their own.
 * A template with no `subject` is always sent as a reply in an existing
 * thread ("Re: <thread subject>").
 */
export const TEMPLATES = {
  // ── To the client ──────────────────────────────────────────────────────────
  // Hot-lead alert: subject and body verbatim from The 30-Day Trial §10
  // ("Hot-lead alert — same day"); {actionLine} is the doc's sentence for an
  // interested reply and a tag line for "needs answer" / "unclear — your call".
  hot_lead: {
    from: 'trial',
    subject: 'Hot — {Company}, {Name}, {Title}',
    body: '{Name} at {Company} ({size}, {city}) replied: “{verbatim}.” {actionLine} Context: {context}.',
  },
  hot_lead_nudge: {
    from: 'trial',
    subject: 'Still waiting — {Company}, {Name}',
    body: '{Name} at {Company} replied {hours} hours ago and has not heard from you yet: “{verbatim}.”\n\nIf you can, reply today — response speed decides these. At 24 hours I send them a short holding note in your name.',
  },
  call_handoff: {
    from: 'trial',
    subject: 'Booked — {Company}, {Name}',
    body: '{Name} ({Title}) at {Company} booked a call for {when}.\n\nWhy they said yes, in their words: “{whyYes}”\n\nWhat they asked: {asked}\n\nThe thread so far:\n{thread}\n\nAfter the call I will send you one-tap buttons to tell me how it went.',
  },
  slot_far_warning: {
    from: 'trial',
    subject: 'Heads up — {Company} booked {days} business days out',
    body: '{Name} at {Company} booked for {when}, which is {days} business days away. Calls booked more than five business days out go cold more often.\n\nIf you can offer an earlier slot, reply with a time and I will pass it on.',
  },
  call_tap: {
    from: 'trial',
    subject: 'How did the call with {Name} go?',
    body: 'Your call with {Name} at {Company} was booked for {when}. One tap tells me what happened:\n\nShowed: {showedUrl}\nNo-show: {noshowUrl}\nWrong fit: {wrongfitUrl}\nDoesn’t count (reason required): {disputeUrl}\n\nIf you could not make it yourself: {clientNoshowUrl}',
  },
  call_tap_reminder: {
    from: 'trial',
    subject: 'One tap: the call with {Name}',
    body: 'Still need one tap on the call with {Name} at {Company} ({when}):\n\nShowed: {showedUrl}\nNo-show: {noshowUrl}\nWrong fit: {wrongfitUrl}\nDoesn’t count (reason required): {disputeUrl}',
  },
  // "First held meeting" row of the ladder (The 30-Day Trial §5), words verbatim.
  quote_request: {
    from: 'trial',
    subject: 'Your first call — {Company}',
    body: 'Your first call from the trial was held — {Name} at {Company}. What was the meeting like? One or two sentences is plenty; just reply to this email.\n\n“Can I write that down and use it, with your name and company? I’ll send it to you first — change it or kill it.”',
  },
  // Off-pace call script (The 30-Day Trial §7), sent as an email.
  offpace_day15: {
    from: 'owner',
    subject: 'Day 15 — where we are',
    body: 'Quick one, and it’s me bringing you bad news before you go looking for it. We’re halfway. Here’s where we are.\n\n{companies} companies contacted, {replies} replies, {positive} of them positive, no meetings booked yet. That’s below where I want to be at day fifteen.\n\nWhat I think is happening: {diagnosis}\n\nWhat I’m changing today: {fix}. You’ll see it in Friday’s update.\n\nAnd what happens if it doesn’t work: the promise stands. If there’s no qualified call by day thirty, we keep sending at our cost until there is, up to thirty more days. You don’t pay for the extra time and you don’t have to ask for it.\n\nThe one thing I need from you: nothing.',
  },
  // Deliverability Emergency SOP, "Tell the client the same day" — adapted to
  // a one-domain trial (see docs/assumptions/stage-c.md).
  deliverability_notice: {
    from: 'owner',
    subject: 'Heads up — sending paused on your trial',
    body: 'Heads up: we caught an email deliverability issue on your campaign today and paused sending within the hour. We’ve isolated the affected inbox and are re-cleaning the entire list before anything else goes out. Expect a slightly quieter 2-3 days, then back to normal volume. The trial promise is unaffected.',
  },
  paused_quiet: {
    from: 'trial',
    subject: 'Trial paused — waiting on you',
    body: 'I’ve paused sending on your trial because {pending} hot lead(s) have been waiting on you for {days} business days, and the agreement asks for hot leads to be answered within one business day. It restarts as soon as you reply to this email or answer one of them.',
  },

  // ── To prospects (from the trial inbox, in the thread) ─────────────────────
  reply_interested: {
    from: 'trial', prospect: true,
    body: 'Thanks, {FirstName} — glad it’s of interest. Would either of these work for a quick call?\n\n{slot1}\n{slot2}\n\nOr pick any time that suits you here: {calendarUrl}',
  },
  reply_interested_soft: {
    from: 'trial', prospect: true,
    body: 'Thanks, {FirstName}. Worth a look? 15 minutes is plenty — {slot1} or {slot2} both work on our side, or grab any time here: {calendarUrl}',
  },
  interested_nudge: {
    from: 'trial', prospect: true,
    body: '{FirstName} — floating this back up. Worth 15 minutes? Any time here works: {calendarUrl}',
  },
  reply_notnow: {
    from: 'trial', prospect: true,
    body: 'Understood — I’ll check back in {month}. Thanks, {FirstName}.',
  },
  reply_no: {
    from: 'trial', prospect: true,
    body: 'Taken you off the list. Sorry for the interruption, {FirstName}.',
  },
  reply_wrongperson_thanks: {
    from: 'trial', prospect: true,
    body: 'Thanks for letting me know, {FirstName} — I appreciate you pointing me the right way.',
  },
  referral_intro: {
    from: 'trial', prospect: true,
    subject: '{Referrer} suggested I reach you',
    body: '{Greeting}\n\n{Referrer} suggested I reach you.\n\n{oneLiner}\n\nWorth a quick call to see if it fits {Company}?',
  },
  // Wording given in SPEC §8.3.
  holding_reply: {
    from: 'trial', prospect: true,
    body: 'Thanks — {SenderName} will be in touch shortly.',
  },
  notnow_followup: {
    from: 'trial', prospect: true,
    body: '{FirstName} — you mentioned checking back around now. Is this a better time to take a look?',
  },
  reminder_24h: {
    from: 'trial', prospect: true,
    body: 'Hi {FirstName}, a quick reminder: you’re booked with {SenderName} on {when}. If that time no longer works, just reply and we’ll move it.',
  },
  reminder_1h: {
    from: 'trial', prospect: true,
    body: '{FirstName} — talk in an hour ({when}) with {SenderName}.',
  },
  rebook_email: {
    from: 'trial', prospect: true,
    body: 'Hi {FirstName}, sorry we missed each other on {missedWhen}. Would either of these work instead?\n\n{slot1}\n{slot2}\n\nOr choose any time here: {calendarUrl}',
  },
  apology_reschedule: {
    from: 'trial', prospect: true,
    body: 'Hi {FirstName}, I’m sorry — we missed our call on {missedWhen}, and that was on our side. Would either of these work to make up for it?\n\n{slot1}\n{slot2}\n\nOr choose any time here: {calendarUrl}',
  },
  apology_customer: {
    from: 'trial', prospect: true,
    body: '{Greeting}\n\nI owe you an apology: you got an email from us that should never have been sent — you’re already a {ClientCompany} customer. You won’t receive any more of them.',
  },
};
