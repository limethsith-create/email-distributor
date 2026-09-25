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

### §1–2 — as built (Machine A, 2026-09-25)

Everything above holds. Code: `src/lib/systems/conversation.js` (the list,
the `conversation` object, the owner's reply to any client, the messages
endpoint), `src/lib/systems/replybot.js` (the rules, the time reader, the
answers), the hooks in `systems/onboardcall.js` (every message goes past the
bot before the owner is alerted; the check reads every client's mail) and
`notify.js` (every `notifyClient` email to the contact is an entry); route
`src/app/api/mc/clients/[id]/messages/route.js`; config `REPLYBOT`; keys
`client:{id}:convo`, `replybot:pending`; template `bot_reply`; alert
`bot_replied`; tests `tests/replybot.test.mjs`. Endpoints in
`docs/HUB-API.md` (Messages + reply bot). **(+)** = slightly beyond the text
above.

**The conversation**
- `notifyClient` logs every email whose recipient is the client's
  `contactEmail` (`kind: 'system'`, `template` = its key); an email to another
  address (a colleague, a prospect) is not in it. The onboarding, calendar,
  owner and bot emails add their own entry (`thread: false`), so nothing is
  there twice. A calendar email for a client with no onboarding call is a
  `booking` entry too.
- `in` entries carry `rule`: what the bot read in the message (only when it
  may answer that client, else `null`). **(+)** A `thanks` there is what makes
  the message need no answer.
- Their mail is read for every client (any state but deleted, with a contact
  address): from their contact address; answering our Message-IDs from
  another address still only counts for an onboarding applicant, as before.
  Mail dated before the client was created is ignored. The check's
  `newReplies` counts them all; `checked` still counts onboarding calls. The
  `onboard-calls` job keeps its cadence (only while an onboarding call is
  open) — the other clients' mail is read on those checks and whenever the hub
  calls `POST /api/mc/onboard-calls/check`, so the Redis budget is unchanged.
- `needsReply` is one rule (`needsReplyFor`) for `conversation.needsReply`,
  the row's `simple.needsReply` and the to-dos: their newest message needing
  an answer (`msgWaitingAt` on the client hash, set on arrival) came after the
  last answer — the owner's reply, the bot's answer, the calendar confirming
  the time they wrote, or a booking of the onboarding call (as the onboarding
  card has always counted it). During the onboarding call its own rule
  (replies recorded before this build) counts too. A thank-you the bot read
  needs no answer, unless an earlier message still does.
- **(+)** Board rows: `simple.needsReply` (bool) and `needsYou` when true; a
  to-do `message-reply:{id}` (urgent, `view: 'detail', section:
  'conversation'`) when their message waits and the onboarding card's
  `onboard-reply` does not already say so (during the trial, after the call).
  Outside onboarding `simple.next` reads "Answer Pat's message".
- The owner's reply for a client with an onboarding conversation is the
  card's reply (same code, same thread). **(+)** Its subject is now "Re: "
  THEIR last subject (else the acceptance email's), so a new email of theirs
  ("Question about the trial") is answered in its own thread. For any other
  client: from the ONBOARDCALL inbox, In-Reply-To their last message (else our
  last email), References every Message-ID we know, "Re: " their last subject
  (else our last email's). Either way it drops an answer the bot was waiting
  to send.
- `onboard_reply` keeps its key; its title is now "{person} wrote — needs
  your answer" (it also covers messages during the trial) and the body says
  "wrote to you" outside the onboarding call.

**The bot — who and when**
- It answers only a client who is `onboarding` with the acceptance email sent
  (**decision**: "after we send the booking details"; later, a "cancel the
  trial" mid-trial must reach the owner, never a "closed it on my side").
  Later messages still land in the conversation and alert the owner.
- The booking rules (reschedule, proposes_time, wants_time) need the booking
  page open (the call not done); `proposes_time` also needs the machine's own
  booking page (with `ONBOARDCALL.bookingUrl` set there is no calendar to ask;
  `wants_time` then sends that link without times). `wants_time` only while
  nothing is booked or asked for, and only when no time is readable (a
  readable time is a proposal, or not a question).
- Decided on arrival (before the entry is stored): no rule → alert; thanks →
  nothing; automatic sender (the junk filter's no-reply/bounce rules) → alert;
  older than 3 days → alert; the owner answered after it was written → alert;
  **(+)** a second message while an answer waits, or an earlier message still
  unanswered → the bot leaves both to the owner (alert) — two messages are a
  conversation the rules cannot be sure of. Otherwise it is queued
  (`botPending` in the convo hash, `replybot:pending` set) and the owner gets
  no "needs your answer" for it.
- Sent by `runReplyBot` at the end of every check, when all hold: the owner
  has not answered since, the bot is still on (everyone + this client), still
  onboarding (and the page still open for a booking rule), `delayMinutes`
  after the message's own time, inside `hours`, fewer than `maxPerDay` bot
  emails to them that US-Eastern day. A wait (delay, hours) keeps it queued;
  anything else hands it to the owner with `onboard_reply` saying why ("The
  reply bot left this one to you: …"). A failed send hands over too — no
  retry loop. Each email is deduped per message (`bot_reply:{entryId}`).
- `maxPerDay` counts the bot's emails and its confirmations through the
  calendar.

**The rules** (exact patterns in `replybot.js`; the text is their words with
quoted history cut, lower-cased, curly quotes straightened)
- `not_interested` **deviation**: "no longer" only with its object (no
  longer interested / need / want / looking / going ahead …) — "Tuesday no
  longer works" must never close a trial. "cancel the/my/our trial",
  "remove me/us", "stop" as the whole message.
- `reschedule`: + "cannot make", "something's come up"; "different time
  zone" is not one.
- `price`: "catch" but not "catch up"; "how much" but not "how much time".
- `thanks`: ≤ 6 words once their and the owner's names are left out, every
  word an ok-word (thanks, ok, great, perfect, cheers, got it, noted …) or
  filler, no question mark.
- **The time reader** (`readTimes`, own small parser — `parseBodyDate` needs
  a year and a zone word): a day within 40 characters of a time. Days: dates
  ("Oct 7", "7 October", "10/8", with or without a year — the next such date),
  today / tomorrow, weekdays = the NEXT such day in their zone (today's
  weekday is next week's). Times: "2pm", "2:30 p.m.", "14:30", "noon", "at 3"
  / "3 o'clock" (no am/pm: 8–11 morning, 12–7 afternoon), a range "2-3pm" /
  "11-1pm" is its start. Not a time: "after / before / by / until 2pm", a
  range's end, "Mon-Fri 9am-5pm" (office hours in a signature). Zone: the one
  named right after the time or anywhere (ET/EST/EDT/Eastern, CT…, MT…,
  PT…, Alaska, Hawaii, Arizona — "MT" from an Arizona client is Arizona
  time), else theirs (their meeting's, else from their state, else Eastern).
  Up to three proposals, in the order written: the first free one is taken.
- "Free" = one of the booking page's own open times (grid, hours, buffer,
  notice, maxPerDay, their own request set aside). Free → `requestMeeting`
  with `source: 'reply_bot'` and **no** separate "got it" (the bot's answer is
  it; the owner still gets `meeting_requested`, whose body says it came by
  email). **(+)** Their proposal equal to the owner's suggestion confirms it
  (the calendar's own accept: the confirmation email with the invite goes, the
  bot sends nothing more). The time they already have confirmed is no
  proposal ("see you Tuesday at 2pm" → the owner). Taken (or taken a moment
  ago) → the three open times nearest to it, either side.
- `wants_time` lists the first open time on each of the next three open days
  (**decision**: three days to choose from, not three slots of one morning).

**Answers** (`REPLYBOT.answers`) — slots `{firstName}`, `{ownerName}`,
`{bookingLink}` (a fresh booking-page link per answer, or the owner's own
`bookingUrl`), `{times}` ("• Tue 6 Oct at 2:00 pm CT" lines), `{when}`
**(+)** ("Tuesday 6 October at 2:00 pm", their zone), `{onboardingLink}` (a
fresh onboarding-page token), `{callMinutes}` **(+)** (the `what_needed` text
says the call's real length rather than a fixed "15 minutes"). A paragraph
whose slot is empty is left out; an unknown `{slot}` stops the answer (the
owner gets the message). The defaults name no price. The email: template
`bot_reply` from the ONBOARDCALL inbox, "Re: " their subject, In-Reply-To
their message, References the conversation, plain text + clickable links,
no pixel.

**Alerts** — `bot_replied` (not urgent, `quiet: true`: the push goes at
urgency "low" with `quiet: true` in its payload): "Auto-replied to Sam
(eCreek IT): sent the booking link to pick another time"; the body has their
words and the reply; push `url` `/#calendar` when a request waits for his
yes, else the trial. `not_interested` says so and that the reminders stopped
(the onboarding call is `stopped`; closing the application stays his call).

**Changed elsewhere** — `calendar.requestMeeting` takes `{ source, gotIt }`;
`onboardcall` exports `threadHeaders`, `markAnswered`, `talksWith`; the
onboarding hash gains `lastAnsweredAt` and `lastInSubject`; the existing
onboarding-call tests turn the bot off (they are the owner answering by
hand).

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

### §3 — as built (Machine B, 2026-09-25)

Everything above holds. Code: `src/lib/ext/google.js` (OAuth, tokens, the
Calendar calls, the hooks the Calendar uses), the hooks in
`src/lib/systems/calendar.js`, routes `src/app/api/mc/google/route.js` and
`src/app/api/google/callback/route.js` (in middleware PUBLIC), alert
`google_disconnected` (`templates/owner.js`), keys `google:oauth`,
`google:access`, `google:state:{sha256}` (`db/keys.js`); tests
`tests/google-meet.test.mjs`; the owner's steps `docs/GOOGLE-SETUP.md`.
Endpoints in `docs/HUB-API.md` (Calendar › Google Meet). **(+)** = slightly
beyond the text above.

**Connecting**
- Consent URL: `client_id`, `redirect_uri`, `response_type=code`, `scope`
  (`…/auth/calendar.events openid email`), `access_type=offline`,
  `prompt=consent`, `include_granted_scopes=true`, `state`. The state is 24
  random bytes; only its SHA-256 is a key (EX 10 min). One use: read + DEL
  (the DEL decides between two racing callbacks), and also refused when its
  own timestamp is older than 10 minutes. A callback without a good state
  never reaches Google and changes nothing.
- The callback always answers 303 to `https://aviance.store/#settings/google`
  (`HUB_URL` env overrides the site) with `?connected=1` or `?error=` one of
  `state | denied | google | no_code | not_set_up | exchange | google_down |
  calendar_permission | no_refresh_token | server`. **(+)**
  `calendar_permission`: Google lets the user untick the calendar box, and a
  connection without `calendar.events` is refused, not stored.
- The account shown is the `email` in the id_token from the token endpoint
  (straight from Google over TLS, so no signature check is needed), else the
  userinfo endpoint.
- The client: the env pair wins only when both are set. **(+)** Pasting while
  it is set → 409 (the pasted values would not be used). The Client ID must end
  in `.apps.googleusercontent.com`. A different Client ID forgets (and revokes)
  the old connection, since tokens only work with their own client. The same ID
  with a new secret keeps it. No `ENC_KEY` → 503, nothing stored.
- Encrypted in KV: the Client ID, the Client secret, the refresh token and the
  cached access token. None is ever returned. **(+)** They are also left out of
  the backup export (after a restore the owner reconnects).
- **(+)** The status also has `clientFrom` (`env|saved`), `brokenAt`, `problem`
  (plain words when broken) and `encKey`.

**Tokens**
- The access token is cached for `expires_in − 60 s`. A 401 from the Calendar
  API refreshes once and tries again.
- `invalid_grant` / `invalid_client` / `unauthorized_client` on refresh →
  `broken`: the refresh token is deleted and `brokenAt` is set with HSETNX,
  so exactly one `google_disconnected` alert goes out (phone + email, not
  urgent, push url `/#settings/google`). Nothing more is sent to Google until
  he reconnects. A timeout or 5xx is not "broken".
- Disconnect revokes the refresh token (best effort) and forgets the tokens
  and the account. The pasted client stays (→ `ready_to_connect`).

**Meetings**
- The owner's Yes, **(+)** their "Yes, that works" on a suggestion, and `add`
  with a client all make the event before the email: insert on `primary`,
  `conferenceDataVersion=1`, `sendUpdates=none`, start/end as `…Z`, attendee =
  the client (displayName = the person), `requestId` = the meeting id, **(+)**
  `extendedProperties.private.avianceMeetingId`. Description: "Onboarding call
  with Sam Test (eCreek IT), booked through Aviance." + "In the hub:
  https://aviance.store/#trial/{clientId}" (`/#calendar` without a client). A
  conference still `pending` is looked at up to twice more, 1 s apart.
- A meeting that already has an event (they asked to move a confirmed call
  and he says Yes again) is patched, keeping the same Meet. If the event was
  deleted by hand in Google Calendar, a new one is made with a new request id.
- Time limits: each Google call ≤ 8 s, one button press ≤ 15 s in all. An
  insert is never retried automatically, so there are no double events.
- If the email fails after the event was made (502, still a request), the event
  is kept on the request. The next Yes patches that event instead of making a
  second one.
- Move → patch, after the email went (the Meet link does not change). Cancel,
  or decline of a call that has an event → delete, after the email went. A
  cancellation from their calendar found in the inbox deletes it, and "Mark
  call booked" at a new time patches it. Held / no-show → nothing.
- `meetError` is plain words; the hub shows "No Meet link — {meetError}".
  Examples: "Google isn't connected", "Google is disconnected — reconnect it in
  Settings › Google Meet", "Google didn't answer in time", "The Google Calendar
  API is not turned on in your Google Cloud project (step 2 of the guide)",
  "Google was still making the Meet link". It is null when there is a link.
  **(+)** It is also null when Google was never set up but
  `CALENDAR.meetingLink` is, because his own link went out.
- Emails, .ics (`LOCATION` and description) and the booking page use the
  meeting's `meetLink`, else `CALENDAR.meetingLink`, else "I'll send the link
  before the call."
- A failed patch or delete is logged (`google` events `move_failed`,
  `delete_failed`) but not shown to him: the Meet link still works, and the
  event may stay at the old time in his Google Calendar.
- **(+)** `GET /api/mc/calendar` `settings.googleMeet` = the status word.

**Not built**
- The day-before reminder (onboardcall.js) does not repeat the link.
- There is no "make the Meet now" button for a call confirmed while Google
  was down. The hub shows why there is no link, and he sends one by hand.
- The client is an attendee, so a Google-calendar user may also see the event
  in their own calendar (Google emails nothing), next to our .ics invite.
- Events made before a disconnect stay in his Google Calendar. Later moves and
  cancels cannot reach them (logged).

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
