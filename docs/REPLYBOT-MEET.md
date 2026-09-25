# Messages, the reply bot and Google Meet — shared contract (2026-09-25)

The owner's words: "After we send the booking details there should be a
reply bot, and a place inside each of the people where I can see the
messages between us. And a system that creates Google Meets through my
system for the time that is needed."

Three builds, in parallel:
- **Machine A — messages + reply bot** (`~/claude/email-distributor`, own worktree)
- **Machine B — Google Meet** (`~/claude/email-distributor`, own worktree)
- **Hub** (`~/claude/aviance-hub`)

No AI anywhere: the bot is fixed rules. Nothing real is sent in tests.

---

## 1. One conversation per client (Machine A)

Today the onboarding conversation lives in `client:{id}:onboardthread`
(docs/ONBOARD-CALL.md). It becomes THE conversation with that client:
every email the machine sends to the client's contact (any `notifyClient`
template, the onboarding and calendar emails, the owner's replies, the bot's
replies) and every email from them that arrives in the ONBOARDCALL inbox is
one entry, oldest first.

Entry (extends the ONBOARD-CALL thread entry; old entries stay valid):
```jsonc
{ "id": "…", "dir": "out|in", "at": "ISO", "from": "…", "to": "…", "subject": "…",
  "text": "plain text, ≤ 4 000 chars (quoted history cut)",
  "kind": "acceptance|reminder|reply|owner_reply|booking|auto_reply|system",
  "auto": true,                 // sent by the reply bot
  "rule": "wants_time|proposes_time|price|what_needed|reschedule|not_interested|thanks|null",
  "template": "notifyClient template key when kind = system" }
```

Hub detail (`GET /api/mc/hub/{id}`) gains:
```jsonc
"conversation": {
  "thread": [ entry ],            // oldest first, ≤ 200 newest kept
  "needsReply": true,             // their last message has no answer (bot or owner) yet
  "lastInAt": "ISO|null", "lastOutAt": "ISO|null",
  "bot": { "enabled": true, "sentToday": 1, "maxPerDay": 3 },
  "canReply": true,               // an inbox is set up to send from
  "fromInbox": "hello@…"
}
```
`onboardCall.thread` keeps working (same list) for the call card.

Owner reply from the hub, for any client (not only during onboarding):
`POST /api/mc/clients/{id}/messages` `{ action: 'reply', text }` → sent from
the ONBOARDCALL inbox, threaded (`In-Reply-To` / `References`), added as
`owner_reply` → `{ ok, conversation }`. `{ action: 'botOff' }` /
`{ action: 'botOn' }` turn the bot off/on for THIS client →
`{ ok, conversation }`. (The existing onboard-call `reply` action stays as an
alias.)

## 2. The reply bot (Machine A)

Runs when a new message from the client is found in the inbox (the
onboarding check: after(), the hub's check call, the job). Fixed rules on
the message text with the quoted history removed, in this order; the FIRST
match answers, nothing else:

| rule | when (plain rule, case-insensitive) | the bot does |
|---|---|---|
| `not_interested` | "not interested", "no longer", "changed my mind", "cancel the trial", "unsubscribe", "remove me", "stop" as the whole message | polite close ("No problem at all — I've closed it on my side…"), stops reminders, marks the onboarding call `stopped`, alerts the owner |
| `reschedule` | "reschedule", "move the call", "different time", "can't make it", "cant make", "something came up" | the booking page link ("pick any other time here…") — the existing request/booking stays until they pick |
| `proposes_time` | a day/date + a time that the calendar can read (reuse bookings.js `parseBodyDate` or a small parser: "Tuesday at 2pm", "Oct 7 3:30 pm ET", "tomorrow 11am CST"; their zone from the client) | if that time is free by the calendar rules → create the meeting **request** at it (source `reply_bot`) and answer "Tuesday 7 Oct at 2:00 pm your time works on my side — I'll confirm it shortly" (the owner still presses Yes in the Calendar); if not free → the three nearest free times in their zone + the booking page |
| `wants_time` | "what times", "when are you free", "your availability", "happy to jump on a call", "let's book", "sounds good", "works for me" with no readable time | the booking page link + three nearest free times in their zone |
| `price` | "cost", "price", "how much", "fee", "is it free", "catch" | the fixed answer: the 30-day trial is free, no card, the one ask is an honest review; the plans after it are on the call (numbers only from config — never invent a price) |
| `what_needed` | "what do you need", "what should I prepare", "what info", "anything I need" | the one-page onboarding link + "15 minutes, we go through who you sell to" |
| `thanks` | the whole message is thanks/ok/great/perfect (≤ 6 words) | nothing sent (no bot reply to a thank-you), not counted as needing an answer |

Never auto-reply to: out-of-office / auto-replies / bounces / no-reply
senders (existing junk filters), a message the owner already answered, a
message older than 3 days when first seen, a client whose bot is off, more
than `REPLYBOT.maxPerDay` bot emails to one client a day, outside
`REPLYBOT.hours` (the reply waits until the hours open), or anything that
matches no rule → **no reply**; the owner gets `onboard_reply` ("needs your
answer") exactly as today. After every bot reply the owner gets a quiet
`bot_replied` alert: "Auto-replied to Sam (eCreek IT): sent the booking
link." Bot emails are plain, short, signed like the owner, threaded, and
say nothing a rule doesn't know.

```js
REPLYBOT: {
  enabled: true,            // the whole bot on/off (per-client switch too)
  maxPerDay: 3,             // bot emails to one client in a day
  delayMinutes: 3,          // wait this long before answering (the owner can still answer first)
  hours: 'us',              // 'us' = US business hours (OWNER.usHours ET), 'any' = any time
  answers: {                // the text of each answer; {bookingLink}, {times}, {firstName}, {onboardingLink}, {ownerName} filled in
    not_interested: '…', reschedule: '…', proposes_time_ok: '…', proposes_time_busy: '…', wants_time: '…', price: '…', what_needed: '…',
  },
}
```

## 3. Google Meet (Machine B)

The owner connects his Google account once; from then on every confirmed
meeting gets a real Google Meet link and an event on his Google Calendar.

- Settings he pastes in the hub (stored ENCRYPTED in KV with the existing
  `ENC_KEY` crypto, never shown back): Google OAuth **Client ID** and
  **Client secret** (a "Web application" client with the redirect URI
  `https://email-distributor.vercel.app/api/google/callback`). Env vars
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` win when set.
- Scope: `https://www.googleapis.com/auth/calendar.events` (+ `openid email`
  to show which account is connected). Offline access, `prompt=consent`.
- The refresh token is stored encrypted in KV; access tokens refreshed as
  needed; a failed refresh (revoked / expired) → status `broken` + one owner
  alert `google_disconnected`.
- On **confirm** (and owner **add** with a client): create an event on his
  primary calendar — summary = meeting title, start/end = the meeting (UTC),
  attendee = the client's email, `conferenceData.createRequest`
  (`hangoutsMeet`, requestId = meeting id), `conferenceDataVersion=1`,
  `sendUpdates=none` (our own confirmation email + .ics carry it). Save
  `googleEventId`, `meetLink` (the `hangoutLink`) on the meeting. The
  confirmation email and the .ics LOCATION/description use `meetLink`
  (else `CALENDAR.meetingLink`, else "I'll send the link before the call").
- On **move** → patch the event's times (same Meet link). On **cancel /
  decline of a confirmed call** → delete the event. On **held / no-show** →
  nothing.
- Google down or not connected → the meeting is still confirmed, the email
  goes without a Meet link (fallback text), and the owner is told in the
  hub ("No Meet link — Google isn't connected").
- Endpoints (under /api/mc, hub token or admin cookie; the callback public):
  - `GET /api/mc/google` → `{ status: 'not_set_up|ready_to_connect|connected|broken', account: 'owner@gmail.com|null', redirectUri, hasClient: bool, connectedAt }`
  - `POST /api/mc/google` `{ action: 'saveClient', clientId, clientSecret }` · `{ action: 'connect' }` → `{ url }` (Google consent URL with a random `state` stored in KV for 10 min) · `{ action: 'disconnect' }` (revoke + forget) · `{ action: 'test' }` (create and delete a 15-min test event with Meet → `{ ok, meetLink }`)
  - `GET /api/google/callback?code&state` — public; checks `state`, swaps the code for tokens, stores them, redirects to `https://aviance.store/#settings/google?connected=1` (or `?error=…`). Must be added to middleware PUBLIC and must not reveal anything on a bad state.
- Hub meetings (`GET /api/mc/calendar`) gain `meetLink`, `googleEventId`.

## 4. Hub

- **Messages** — on every trial page, a clear "Messages" section (right
  after the three questions): the whole `conversation.thread` as a chat
  (theirs left, ours right; the bot's marked "Auto-reply" with the rule in
  plain words, e.g. "sent your booking link"; system emails collapsed to one
  line with "show"), a reply box ("Send to {firstName}"), and a switch
  "Reply bot for {firstName}: on/off". When `needsReply`, the trial's big
  "What do you need to do?" button is "Answer {firstName}'s message".
  The onboarding call card keeps its steps but points to Messages for the
  conversation (no duplicate thread).
- **Calendar** — a meeting with `meetLink` shows a big "Join Google Meet"
  button; without one: "No Meet link yet" + why.
- **Settings › Google Meet** — status, the account connected, and a
  step-by-step for the owner (plain words, numbered, with the exact redirect
  URI to copy): make a Google Cloud project → turn on the Google Calendar API
  → set up the consent screen (External, his email as the only user,
  publish it so the connection doesn't expire) → create an OAuth client
  (Web application) with the redirect URI → paste Client ID + Client secret
  here → press "Connect Google" → allow. Then "Test it" (creates and deletes
  a test Meet). A "Disconnect" button.
- **Settings › Reply bot** — the on/off switch for everyone and what each
  rule answers (read-only list in plain words; editing stays in Advanced).
