/**
 * Client / prospect message templates for Stage A (SPEC §11).
 * Shape: { key: { subject, body, from: 'owner' | 'trial' } }. Slots are {name}.
 * Wording comes from the trial doc / SOPs verbatim where it exists; anything
 * written new is listed in docs/assumptions/stage-a.md.
 *
 * Verbatim sources (The 30-Day Trial, Section 10 / Section 2 / Section 5):
 *  - welcome_two_dates: "Welcome — Day −14", adapted to slots; the build-call
 *    date is replaced by the approval page date (SPEC §16 #9).
 *  - onboarding_link opens with the Day −14 ask from Section 5.
 *  - decline_fit / decline_market reuse Section 2 wording.
 * Everything else is new, plain text, one ask, in the owner's voice.
 */
export const TEMPLATES = {
  onboarding_link: {
    from: 'owner',
    subject: 'Your trial — one page to fill in',
    body: `Hi {firstName},

Thanks for applying — you're in. One page, and everything I'll ever ask you for is on it: who we write as, who to target and who to leave alone, and the one-page agreement.

{link}

It saves as you go, so you can stop and come back. Once it's signed I check the size of your market, then buy the domain and the clock starts.

{ownerName}`,
  },

  onboarding_reminder: {
    from: 'owner',
    subject: 'Your trial page is still open',
    body: `Hi {firstName},

A reminder that your trial page is waiting — nothing starts until it's filled in and signed. It keeps what you've already typed.

{link}

The slot stays yours until {closeDate}; after that I pass it to the next company in line.

{ownerName}`,
  },

  closed_silent: {
    from: 'owner',
    subject: 'Closing your trial slot',
    body: `Hi {firstName},

I didn't hear back on the trial page, so I've closed your slot and passed it to the next company waiting. Nothing was bought and nothing was sent in your name.

If the timing changes, reply to this email and I'll tell you when the next slot opens.

{ownerName}`,
  },

  queued_position: {
    from: 'owner',
    subject: "Your trial — you're number {position} in line",
    body: `Hi {firstName},

You fit — thank you for applying. I run three trials at a time and every slot is taken right now, so you're number {position} in line. {expectedLine}

There's nothing to do until then. When your slot opens you'll get one page to fill in and sign.

{ownerName}`,
  },

  decline_fit: {
    from: 'owner',
    subject: 'Your trial application',
    body: `Hi {firstName},

Thank you for applying. I'm going to say no to the trial, and here is the honest reason: {reason}

Every part of the fit gate has to be true, because most trials that book nothing are decided at this step, not in the campaign. If that changes on your side, reply to this email.

{ownerName}`,
  },

  decline_market: {
    from: 'owner',
    subject: 'Your trial — the market count',
    body: `Hi {firstName},

Thank you for signing. Before I buy anything I count the companies that match your profile, and the trial needs at least {minMarket} of them. I found about {estimate}{widenedLine}.

If your whole market is that size, the trial burns most of it in a month and there is no room for a paid plan behind it, so I'm not going to start it. Nothing was bought and nothing was sent in your name.

{ownerName}`,
  },

  decline_repeat: {
    from: 'owner',
    subject: 'Your trial application',
    body: `Hi {firstName},

Thank you for applying. {mainDomain} has already had a trial with us, and it's one trial per company, ever, so I can't run another.

If you'd like to talk about a paid plan instead, reply to this email.

{ownerName}`,
  },

  agreement_copy: {
    from: 'owner',
    subject: 'Your trial agreement — signed copy',
    body: `Hi {firstName},

Here is a plain-text copy of the agreement you accepted. Keep it for your records; nothing else is needed from you.

{agreementText}

Accepted by: {agreementName}, {agreementTitle}, {companyName}
Accepted at: {acceptedAt} (UTC) from IP {agreementIp}

{ownerName}`,
  },

  setup_in_progress: {
    from: 'owner',
    subject: 'Your trial — setup has started',
    body: `Hi {firstName},

Your market check passed, so we're going ahead. I'm buying the sending domain and two inboxes now.

Once they pass their checks you'll get an email with your two dates: the first send and Day 30. Nothing is needed from you in the meantime.

{ownerName}`,
  },

  welcome_two_dates: {
    from: 'owner',
    subject: 'Your trial — two dates',
    body: `Hi {firstName}, agreement's in — thank you. The domain is registered and both inboxes went into warm-up today.

Two dates. First send: {day1Date} — that's day 1 of your 30. Day 30 is {day30Date}.

Instead of a build call, on {approvalDate} you'll get a link to one page where you check the customer profile and approve the copy.

Every Friday you'll get a short update from me, including the quiet weeks.

{ownerName}`,
  },

  booking_test_request: {
    from: 'owner',
    subject: '60-second test of your booking link',
    body: `Hi {firstName},

Before the first send I want to be sure a prospect who says yes can actually book. Please do this once:

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
    subject: 'Your booking link needs a fix',
    body: `Hi {firstName},

I tested your booking link ({calendarUrl}) and found a problem: {problem}

Please fix it on your booking tool, or reply with a different link. The first send waits until a prospect can book.

{ownerName}`,
  },
};
