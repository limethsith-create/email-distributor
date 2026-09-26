# Onboarding call + the simple Trials screen — shared contract (2026-09-25)

The owner's words: "When we say yes to a customer an email goes to them: we
accept your business, book your onboarding call. There should be a reply
system and a tracking system for getting the onboarding call on time. The
Trials screen must be dumbed down: the names of the people and where they
are — no stages board, no '3 trials on the machine / 5 things waiting /
heartbeat'. Easy for anyone to understand." The inbox that sends these emails
and receives the replies is not decided yet: it is ONE setting.

Two builds, in parallel, against this contract:
- **Machine** (`~/claude/email-distributor`): the acceptance email, the
  tracking, the replies, the reminders, and the simple status for every row.
- **Hub** (`~/claude/aviance-hub`): the simple Trials list and the
  onboarding-call card with the conversation and a reply box.

No AI anywhere. Plain words. Nothing is sent to anyone in tests.

---

## 1. Settings (machine config, editable in /mc/config)

```js
ONBOARDCALL: {
  inbox: null,            // the email address that sends + receives onboarding emails. null → the owner sender used today (OWNER_INBOX env, else the first SMTP account)
  bookingUrl: null,       // the owner's calendar link for onboarding calls (Calendly / Cal.com / Google). null → the email asks them to reply with 2–3 times that suit them
  callMinutes: 30,
  bookWithinDays: 3,      // business days after the acceptance email to have the call BOOKED — later = "overdue"
  reminderHours: [24, 72],// reminder emails to the applicant while the call is not booked
  dayBeforeReminder: true,// a reminder to the applicant ~24 h before a booked call
  checkEveryMinutes: 2,   // how often the inbox may be checked (by the job or by the hub opening the Trials screen)
}
```

## 2. What happens when the owner presses Approve

`approveApplication` → `decide` → `startOnboarding` today sends
`onboarding_link` (the one-page form). From now on Approve sends ONE email,
`accepted_call` (from the ONBOARDCALL inbox, in the owner's voice):

> Subject: You're in — let's book your onboarding call
> Hi {firstName}, good news: we'd like to run your free 30-day trial for
> {companyName}. The next step is a {callMinutes}-minute onboarding call…
> Book a time that suits you: {bookingUrl}   ← or "reply with two or three
> times that suit you" when there is no link
> Before the call (or on it, together): {onboardingLink} — one page, your
> details and the agreement.
> {ownerName}

Tracked: a signed open-tracking pixel (reuse lib/tokens.js v2 tracking with
its own purpose) — the only tracking on the email; plain text + a minimal
HTML part. The machine records the Message-ID so replies can be threaded.
The existing onboarding page + its reminders keep working unchanged.

## 3. Tracking (machine) — `client:{id}:onboardcall` (hash) + `client:{id}:onboardthread` (list)

States, in order (one current state, every step time-stamped):
`sent` → `opened` → `replied` → `booked` → `held`   (+ `no_show`, `overdue`, `stopped`)

- **opened**: the tracking pixel was loaded.
- **replied**: a message from the applicant's address (or a reply to our
  Message-ID) arrived in the ONBOARDCALL inbox. It is added to the thread,
  and the owner gets an alert `onboard_reply` (phone + email).
- **booked**: (a) a calendar confirmation for this applicant arrived in the
  inbox (Calendly / Cal.com / Google Calendar invite with an ICS or a
  "New Event" email naming their email — reuse systems/bookings.js
  `parseIcs` / imap-scan.js `scanMailbox`), or (b) the owner pressed
  "Mark call booked" with a date/time. Owner alert `onboard_booked`.
- **held / no_show**: the owner presses "Call done" / "They didn't show".
- **overdue**: not booked `bookWithinDays` business days after the email →
  owner alert `onboard_overdue` (once); the row says so in red.
- **stopped**: the owner pressed "Stop reminders".

Reminders (never more than listed, never after booked/stopped, in US
business hours only): at `reminderHours` after sending while not booked —
`accepted_call_reminder` 1 and 2 (short, "just checking you saw this", same
booking link, replies thread); and `onboard_call_tomorrow` the day before a
booked call.

**Runs without the heartbeat** (it is not running yet): the check (inbox
scan + due reminders + overdue) runs (1) in `after()` of Approve, (2) when the
hub opens the Trials screen or a trial — `POST /api/mc/onboard-calls/check`,
throttled to `checkEveryMinutes`, (3) as a normal job on the tick when the
heartbeat exists.

## 4. Replies from the hub

The owner writes a reply in the hub → `POST /api/mc/clients/{id}/onboard-call`
`{ action: 'reply', text }` → sent from the ONBOARDCALL inbox to the
applicant, `In-Reply-To` / `References` set to the thread, added to the
thread as `out`. Plain text only, 2 000 characters max.

## 5. API (machine) — all under /api/mc (hub bearer token or admin cookie)

- `POST /api/mc/onboard-calls/check` → `{ ok, checked: n, newReplies: n, booked: n, remindersSent: n, skipped?: 'too soon' }`
- `POST /api/mc/clients/{id}/onboard-call` with one of
  - `{ action: 'reply', text }`
  - `{ action: 'markBooked', when: ISO }`
  - `{ action: 'markHeld' }` · `{ action: 'markNoShow' }`
  - `{ action: 'resend' }` (the acceptance email again) · `{ action: 'stopReminders' }`
  → `{ ok, onboardCall }` (the object below)
- `GET /api/mc/hub/{id}` gains `onboardCall` (below).
- `GET /api/mc/hub` rows gain `simple` (below).

### `onboardCall` (in the trial detail)
```jsonc
{
  "status": "sent|opened|replied|booked|held|no_show|overdue|stopped",
  "label": "Email sent — waiting for them to book",      // plain words for the hub
  "sentAt": "ISO", "openedAt": "ISO|null", "lastReplyAt": "ISO|null",
  "bookedFor": "ISO|null", "bookedAt": "ISO|null", "bookedBy": "calendar|owner|null",
  "heldAt": "ISO|null", "dueBy": "ISO", "overdue": false,
  "remindersSent": 1, "nextReminderAt": "ISO|null", "stopped": false,
  "bookingUrl": "https://…|null", "fromInbox": "hello@…",
  "meetingId": "m…|null", "meetLink": "https://meet.google.com/…|null",   // the confirmed call's Google Meet link (docs/CALENDAR.md)
  "steps": [ { "key": "sent", "label": "Acceptance email sent", "done": true, "at": "ISO" },
             { "key": "opened", "label": "They opened it", "done": true, "at": "ISO" },
             { "key": "replied", "label": "They replied", "done": false, "at": null },
             { "key": "booked", "label": "Call booked", "done": false, "at": null },
             { "key": "held", "label": "Call done", "done": false, "at": null } ],
  "thread": [ { "id": "…", "dir": "out|in", "at": "ISO", "from": "…", "to": "…", "subject": "…", "text": "plain text, ≤ 4 000 chars", "kind": "acceptance|reminder|reply|owner_reply|booking" } ]
}
```
`null` when no acceptance email was sent for this client.

### `simple` (on every board row) — the ONLY status the simple Trials list shows
```jsonc
{
  "step": "new|accepted|call_booked|setting_up|warming_up|sending|deciding|finished|declined|queued",   // deciding = Day 30 passed, their click pending (drawn where finished is)
  "label": "Accepted — waiting for them to book the call",   // one plain sentence, no jargon
  "next": "Nothing for you: we remind them tomorrow",        // what happens next / what the owner must do
  "needsYou": true,                                            // red dot + top of the list
  "since": "ISO",                                              // when this step started
  "person": "Sam Test", "company": "eCreek IT",
  "dayOf30": 12 | null                                         // only while sending
}
```
Plain labels (examples, machine decides): "New application — read it and say
yes or no" · "Accepted — waiting for them to book the call" · "Call booked
for Tue 3 pm" · "Call booked — didn't happen? mark it" · "Setting up their
emails (about 2 weeks)" · "Sending — day 12 of 30, 2 calls booked" ·
"Finished — became a client" · "Declined". `needsYou` when the owner must
act: a new application, a reply to answer, an overdue booking, a call to
mark done, anything the existing to-do list marks urgent.

---

## 6. Machine — as built (2026-09-25)

Everything above holds. Where the contract left a choice, the machine
(`src/lib/systems/onboardcall.js`, tests in `tests/onboard-call.test.mjs`)
decided as follows. Items marked **(+)** go slightly beyond the text above.

**Sending**
- Every road into onboarding sends `accepted_call` (not only Approve): the
  owner's New client, a plan inquiry turned into a trial and a queue slot
  opening all go through the same `startOnboarding`. The queue itself is
  unchanged (`queued_position` while trials are full).
- ONBOARDCALL.inbox set to an address the machine cannot log into (not
  OWNER_INBOX, not an Aviance inbox saved with its password) is an error, never
  a silent switch to another inbox: Approve answers 500 with the reason and
  the application goes back to waiting, so Approve can be pressed again. **(+)**
- Follow-ups (reminders, the owner's replies, a resend) reuse the first
  subject ("Re: …") and set `In-Reply-To` / `References`, so they thread in
  the applicant's mail app. Message-IDs keep their case in headers.
- The open pixel is also on the two reminders (same purpose); never on the
  owner's replies or the day-before reminder.
- The owner's reply gets his name as a sign-off unless his last line already
  has it. A double click within 2 minutes sends once.
- `resend` sends the email again in the same thread with a fresh onboarding
  link (its own token; the first link keeps working) and restarts the
  reminders and `dueBy` from the resend; `sentAt` stays the first email.
  Only while the client is `onboarding`. The onboarding page's own clock
  (Day +2/+4 reminders, Day +7 close) is not touched.

**Tracking**
- `status` is never stored: it is worked out from the times, in the order
  held > no_show > booked > stopped > overdue > replied > opened > sent.
- `dueBy` = `bookWithinDays` US business days (weekends and US holidays
  skipped) after the (last) acceptance email, at the same US Eastern clock
  time. `overdue` only while the client is still `onboarding`.
- Replies: a message in the ONBOARDCALL inbox (INBOX and spam) from the
  applicant's address, or answering one of our Message-IDs from any address,
  dated after the acceptance email. Out-of-office, bounces and other
  automatic mail do not count. The thread keeps the words they typed (quoted
  history cut). The owner "owes a reply" (`needsReply`) while their last
  message is newer than his last reply and than any booking. **(+ field)**
- Bookings (no AI, no names): (a) a calendar invite (.ics) whose attendee or
  organizer is the applicant's address — a REQUEST/REPLY books it at DTSTART,
  a CANCEL or a DECLINED reply cancels it; (b) a booking-tool email whose
  subject matches `config/bookingSubjects.txt` ("New Event:", "Invitation:",
  "Booking confirmed" …) and whose body contains the applicant's address and a
  date with a US time zone ("Wednesday, October 7, 2026 3:00pm (Eastern
  Time)"). A booking under another address is not matched — the owner uses
  "Mark call booked". A booking email with no readable time still marks the
  call booked with `bookedFor: null`.
- A calendar cancellation takes the call back to not booked and raises
  **`onboard_cancelled`** (a fourth alert). **(+)**
- The inbox is read for an applicant while the client is `onboarding`,
  `awaiting_purchase` or `setup_check` and the call is not marked done;
  after that the flag `onboardCallOpen` on the client hash goes to `0`.
  First read of a new inbox looks back 3 days; at most 60 messages per check.

**Reminders**
- US business hours = `OWNER.usHours` (US Eastern) on US business days.
- `accepted_call_reminder` at `reminderHours` after the (last) acceptance
  email, only while the client is `onboarding` and the call is not booked,
  not stopped, not done/no-show **and they have not replied** (once they
  write, the conversation is the owner's; overdue still covers silence
  after that). **(+)**
- If several are due at once (a weekend, a holiday) only the latest goes;
  two automatic emails to them are never closer than `reminderHours[0]`
  (so a 24 h reminder pushed to Monday cannot land an hour before the 72 h
  one). Each reminder goes at most once.
- `onboard_call_tomorrow` goes on the US business day before the call's day
  (from the start of US hours; never in the last 2 hours before the call; not
  when the call was booked less than 24 hours ahead) — once per booked time.

**Alerts** — `onboard_reply` (one per message), `onboard_booked` (one per
booked time, not when the owner marked it himself), `onboard_overdue` (once
per acceptance email), `onboard_cancelled`. All go by phone push + email and
are not "urgent" (no Telegram): the hub's own to-dos for the trial
(`onboard-reply`, `onboard-overdue`, `onboard-mark`, urgent) carry the red
dot and clear themselves once handled, where an urgent alert would linger
until acknowledged.

**Check** — the job (`onboard-calls`, global), the hub's
`POST /api/mc/onboard-calls/check` and the check in `after()` of Approve share
one throttle (`onboardcall:checkedat`). `ok: false` + `error` when the inbox
could not be read (reminders and overdue still run).

**`onboardCall` extra fields** **(+)**: `noShowAt`, `stoppedAt`,
`lastOwnerReplyAt`, `needsReply`, `callMinutes`. `steps[opened].done` is also
true once they replied or booked (they read it even if the pixel was
blocked); its `at` stays the real open time or null.

**`simple`** — times in labels are the owner's (Sri Lanka) time, e.g. "Call
booked for Tue 29 Sep, 7:30 pm your time". `dayOf30` is also set in a free
extension (it can pass 30). Rows of clients accepted before this feature (no
acceptance email) say "Accepted — waiting for them to fill in the onboarding
page".

**The Calendar** (docs/CALENDAR.md, built 2026-09-25 — see its "as built"
section): with no `bookingUrl` the booking line links the machine's own
booking page ("reply with two or three times" only when that link cannot be
made). A time they ask for there counts as their answer (the reminders to
book stop, never overdue while it waits for the owner) and shows as "They
asked for … — say yes in the Calendar"; the owner's Yes books the call
(`bookedBy: 'calendar'`). "Mark call booked", "Call done", "They didn't show"
and calendar invites in the inbox keep the client's one calendar meeting in
step. The onboarding page's own clock changed with it: one reminder track
(its Day +2 / +4 reminders only after the call is done) and a Day +7 close
that counts from their last sign of life and waits while a request or a
booked call is pending.
