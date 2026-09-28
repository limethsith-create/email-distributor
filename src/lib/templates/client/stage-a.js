/**
 * Client / prospect message templates for Stage A (SPEC §11).
 * Shape: { key: { subject, body, from: 'owner' | 'trial' } }. Slots are {name}.
 * Wording comes from the trial doc / SOPs verbatim where it exists; anything
 * written new is listed in docs/assumptions/stage-a.md.
 *
 * Verbatim sources (The 30-Day Trial, Section 10 / Section 2 / Section 5):
 *  - welcome_two_dates: "Welcome — Day −14", adapted to slots; the build call
 *    became the launch call near the end of warm-up (docs/LAUNCH-CALL.md).
 *  - onboarding_link opens with the Day −14 ask from Section 5.
 *  - decline_fit / decline_market reuse Section 2 wording.
 * Everything else is new, plain text, one ask, in the owner's voice.
 *
 * The voice (docs/IMPROVE-PASS.md §B, enforced by tests/voice.test.mjs): "Hi
 * {firstName}," and the owner's name as the sign-off, no title block; under
 * 120 words; one ask; contractions; no "!"; a subject under six words that
 * says the thing; and the fact that makes it theirs — {clientName} (their
 * company, filled by notifyClient on every client email), the exact date, the
 * count.
 */
export const TEMPLATES = {
  onboarding_link: {
    from: 'owner',
    subject: 'One page for your trial',
    body: `Hi {firstName},

Thanks for applying. You're in. Everything I'll ever need from {clientName} is on one page: who we write as, who to target, who to leave alone, and the one-page agreement.

{link}

It saves as you go, so you can stop and come back. Once it's signed, I check the size of your market, buy the domain, and the clock starts.

{ownerName}`,
  },

  onboarding_reminder: {
    from: 'owner',
    subject: 'Your trial page is waiting',
    body: `Hi {firstName},

Your trial page is still open, and nothing starts until it's filled in and signed. It keeps what you've already typed.

{link}

I'm holding the slot for {clientName} until {closeDate}. After that, it goes to the next company in line.

{ownerName}`,
  },

  // Paying clients (Starter / Growth / Scale): the same emails without the trial wording (notify.js picks `<key>_paid`).
  onboarding_reminder_paid: {
    from: 'owner',
    subject: 'Your onboarding page is waiting',
    body: `Hi {firstName},

Your onboarding page for the {planName} plan is still open, and nothing starts until it's filled in and signed. It keeps what you've already typed.

{link}

Once it's signed, we start setting everything up for {clientName}.

{ownerName}`,
  },

  closed_silent: {
    from: 'owner',
    subject: 'Closing your trial slot',
    body: `Hi {firstName},

I didn't hear back about the trial page, so I've closed the slot for {clientName} and passed it to the next company waiting. Nothing was bought, and nothing was sent in your name.

If the timing changes, reply to this email and I'll tell you when the next slot opens.

{ownerName}`,
  },

  queued_position: {
    from: 'owner',
    subject: "You're number {position} in line",
    body: `Hi {firstName},

Thanks for applying. {clientName} is a good fit. I run three trials at a time and every slot is taken right now, so you're number {position} in line. {expectedLine}

There's nothing to do until then. When your slot opens, you'll get one page to fill in and sign.

{ownerName}`,
  },

  decline_fit: {
    from: 'owner',
    subject: 'Your trial application',
    body: `Hi {firstName},

Thank you for applying. I'm going to say no to the trial for {clientName}, and here's the honest reason: {reason}

Every part of the fit check has to be true, because most trials that book nothing are decided at this step, not in the campaign. If that changes on your side, reply to this email.

{ownerName}`,
  },

  decline_market: {
    from: 'owner',
    subject: 'Your market count',
    body: `Hi {firstName},

Thanks for signing. Before I buy anything, I count the companies that match your profile, and the trial needs at least {minMarket} of them. I found about {estimate}{widenedLine}.

If that's your whole market, the trial would use up most of it in a month, with no room left for a paid plan after it. So I'm not going to start it. Nothing was bought, and nothing was sent in your name.

{ownerName}`,
  },

  decline_repeat: {
    from: 'owner',
    subject: 'Your trial application',
    body: `Hi {firstName},

Thanks for applying. {mainDomain} has already had a trial with us, and it's one trial per company, ever, so I can't run another.

If you'd like to talk about a paid plan instead, reply to this email.

{ownerName}`,
  },

  agreement_copy: {
    from: 'owner',
    subject: 'Your signed trial agreement',
    body: `Hi {firstName},

Here's a plain-text copy of the agreement you accepted for {companyName}. Keep it for your records. Nothing else is needed from you.

{agreementText}

Accepted by: {agreementName}, {agreementTitle}, {companyName}
Accepted at: {acceptedAt} (UTC) from IP {agreementIp}

{ownerName}`,
  },

  agreement_copy_paid: {
    from: 'owner',
    subject: 'Your signed agreement',
    body: `Hi {firstName},

Here's a plain-text copy of the agreement you accepted for {companyName}. Keep it for your records. Nothing else is needed from you.

{agreementText}

Accepted by: {agreementName}, {agreementTitle}, {companyName}
Accepted at: {acceptedAt} (UTC) from IP {agreementIp}

{ownerName}`,
  },

  setup_in_progress: {
    from: 'owner',
    subject: 'Your trial setup has started',
    body: `Hi {firstName},

Your market check passed, so we're going ahead with {clientName}. I'm setting up the sending domain and two inboxes now.

Once they pass their checks, they start warming up. When they're ready, I'll email you the exact day and time we start. Nothing's needed from you in the meantime.

{ownerName}`,
  },

  setup_in_progress_paid: {
    from: 'owner',
    subject: 'Your setup has started',
    body: `Hi {firstName},

Your market check passed, so we're going ahead with {clientName}. I'm setting up the sending domain and inboxes now.

Once they pass their checks, they start warming up. When they're ready, I'll email you the exact day and time we start. Nothing's needed from you in the meantime.

{ownerName}`,
  },

  welcome_two_dates: {
    from: 'owner',
    subject: 'We start on {day1Date}',
    body: `Hi {firstName},

Everything's on track, so we start on {startWhen}.

The emails go out {inWhoseName} from {inboxes}, {sendWindow}. That's Day 1 of your 30. Day 30 is {day30Date}.

Every Friday you'll get a short update from me, quiet weeks included.

Reply to this email any time.

{ownerName}`,
  },

  // A paying client has no Day 30: the same email without the trial's two dates.
  welcome_two_dates_paid: {
    from: 'owner',
    subject: 'We start on {day1Date}',
    body: `Hi {firstName},

Everything's on track, so we start on {startWhen}.

The emails go out {inWhoseName} from {inboxes}, {sendWindow}.

Every Friday you'll get a short update from me, quiet weeks included.

Reply to this email any time.

{ownerName}`,
  },

  booking_test_request: {
    from: 'owner',
    subject: 'Test your booking link',
    body: `Hi {firstName},

Before the first send, I want to be sure a prospect who says yes can book. It takes about 60 seconds. Please do this once:

1. Open {calendarUrl} from a personal email address, not your work one.
2. Book the first slot it offers.
3. Tap "It worked" below.
4. Cancel the test booking.

It worked: {link}

If anything went wrong, reply and tell me what you saw.

{ownerName}`,
  },

  booking_fix: {
    from: 'owner',
    subject: 'Your booking link needs fixing',
    body: `Hi {firstName},

I tested your booking link ({calendarUrl}) and found a problem: {problem}

Please fix it in your booking tool, or reply with a different link. The first send waits until a prospect can book.

{ownerName}`,
  },

  // ── Onboarding call (docs/ONBOARD-CALL.md) ──
  // from 'onboard' = the ONBOARDCALL inbox (else the owner sender). {bookingLine} is
  // "Book a time that suits you: <link>" or, with no booking link set, "Reply with two or
  // three times…". Follow-ups reuse the first subject ({threadSubject}) so they thread.
  accepted_call: {
    from: 'onboard',
    subject: "Let's book your onboarding call",
    body: `Hi {firstName},

Good news: we'd like to run your free 30-day trial for {companyName}.

First, a {callMinutes}-minute onboarding call, so I can hear how you sell and who you'd like to reach. {bookingLine}

There's also one page with your details and the agreement. Fill it in before we talk if you like, or we'll do it together on the call: {onboardingLink}

{ownerName}`,
  },

  // The same email for a paying client (a paid-plan request the owner said yes to).
  accepted_call_paid: {
    from: 'onboard',
    subject: "Let's book your onboarding call",
    body: `Hi {firstName},

Good news: we'd love to work with {companyName} on the {planName} plan.

First, a {callMinutes}-minute onboarding call, so I can hear how you sell and who you'd like to reach. {bookingLine}

There's also one page with your details and the agreement. Fill it in before we talk if you like, or we'll do it together on the call: {onboardingLink}

{ownerName}`,
  },

  accepted_call_reminder: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: `Hi {firstName},

The trial for {clientName} starts with a {callMinutes}-minute onboarding call, and we haven't booked it yet. {bookingLine}

{ownerName}`,
  },

  accepted_call_reminder_paid: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: `Hi {firstName},

Getting {clientName} started on the {planName} plan begins with a {callMinutes}-minute onboarding call, and we haven't booked it yet. {bookingLine}

{ownerName}`,
  },

  onboard_call_tomorrow: {
    from: 'onboard',
    subject: 'Our onboarding call {callDay}',
    body: `Hi {firstName},

A reminder that our {callMinutes}-minute onboarding call is {when}.

{joinLine}

If that time no longer works, reply to this email and we'll find another.

{ownerName}`,
  },

  // ── "What happens now" (docs/LAUNCH-CALL.md §1) ──
  // Goes once, after the onboarding call is held (or at the agreement, when that came first —
  // then it carries the setup news and setup_in_progress does not go). {opening} is the one line
  // that differs; {day1Line} is "about Wednesday 21 October" from the ramp, or "in about three
  // weeks" when nothing has started yet — never a made-up date.
  next_steps: {
    from: 'owner',
    subject: 'Your trial — what happens now',
    body: `Hi {firstName},

{opening}

Here's what happens now:

- Right now we're researching your business and market, and building your offer.
- This week we set up your sending address and inboxes.
- Then two weeks of warm-up, so your emails land in the inbox.
- We build your list of about {listSize} companies and write your emails in your words.
- Every Friday you get a short note from me, quiet weeks too.
- Near the end of warm-up, we have a {callMinutes}-minute launch call, where you OK the list and the emails.
- The first emails go out {day1Line}.

Nothing's needed from you until then.

{ownerName}`,
  },

  next_steps_paid: {
    from: 'owner',
    subject: 'What happens now',
    body: `Hi {firstName},

{opening}

Here's what happens now:

- Right now we're researching your business and market, and building your offer.
- This week we set up your sending address and inboxes.
- Then two weeks of warm-up, so your emails land in the inbox.
- We build your list of about {listSize} companies and write your emails in your words.
- Every Friday you get a short note from me, quiet weeks too.
- Near the end of warm-up, we have a {callMinutes}-minute launch call, where you OK the list and the emails.
- The first emails go out {day1Line}.

Nothing's needed from you until then.

{ownerName}`,
  },

  // The owner's own words from the hub, sent as they are (a sign-off is added unless he wrote one).
  onboard_owner_reply: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: '{text}',
  },

  // The reply bot's answer (docs/REPLYBOT-MEET.md §2): the text of REPLYBOT.answers.{rule}, filled
  // and signed by systems/replybot.js; "Re: " their subject, threaded under their message.
  bot_reply: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: '{text}',
  },

  // ── Calendar (docs/CALENDAR.md) ──
  // Same inbox as the onboarding call. {when} is their own time zone first, with
  // Eastern beside it when they are elsewhere ("Tuesday 30 September at 1:00 pm
  // Central Time (2:00 pm Eastern)"). {bookLink} is their booking page; {nextLine},
  // {linkLine} and {cancelText} are whole sentences built by systems/calendar.js.
  // Replies to a request thread under the acceptance email ({threadSubject});
  // confirmations, moves and cancellations carry their own subject and an .ics.
  meeting_received: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: `Hi {firstName},

Got it — you asked for {when}. I'll confirm shortly.

If you'd rather change it, pick another time here: {bookLink}

{ownerName}`,
  },

  meeting_confirmed: {
    from: 'onboard',
    subject: 'Confirmed: our call on {whenShort}',
    body: `Hi {firstName},

Confirmed: our {minutes}-minute call is {when}.

{linkLine}

I've attached a calendar invite. {nextLine}

{ownerName}`,
  },

  meeting_suggested: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: `Hi {firstName},

Thanks for picking a time. I'm sorry, {asked} doesn't work for me. How about {when}?

Yes, that works: {acceptLink}

Or pick any other time here: {bookLink}

{ownerName}`,
  },

  meeting_declined: {
    from: 'onboard',
    subject: 'Re: {threadSubject}',
    body: `Hi {firstName},

Sorry, I can't do {asked}: {reason}

Please pick another time here: {bookLink}

{ownerName}`,
  },

  meeting_moved: {
    from: 'onboard',
    subject: 'Our call moves to {whenShort}',
    body: `Hi {firstName},

I've had to move our call. The new time is {when}.

{linkLine}

The updated calendar invite is attached. {nextLine}

{ownerName}`,
  },

  meeting_cancelled: {
    from: 'onboard',
    subject: 'Cancelled: our call on {whenShort}',
    body: `Hi {firstName},

{cancelText}

{nextLine}

{ownerName}`,
  },
};
