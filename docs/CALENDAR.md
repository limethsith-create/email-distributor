# The Calendar — shared contract (2026-09-25)

The owner's words: "a big calendar in the hub with every meeting that is
supposed to be held, US hours turned into Sri Lankan hours, 15–30 minutes a
call; they ask for a time, we say yes, and it is entered in our calendar.
I don't know how to make it work — just make it work."

How it works (no outside calendar needed; Calendly etc. stay optional):
1. The acceptance email's booking link is the machine's own booking page
   (`/c/{token}/book`) unless ONBOARDCALL.bookingUrl is set.
2. The applicant sees the owner's open slots **in their own US time zone**,
   picks one (and may add a note) → a meeting **request** is stored, the owner
   gets an alert (phone + email) "Sam (eCreek IT) asked for Tue 30 Sep,
   2:00 pm ET = 11:30 pm Colombo", the applicant gets "got it — I'll confirm".
3. In the hub's **Calendar** tab the owner presses **Yes** → the meeting is
   **confirmed**, the applicant gets a confirmation email with the time in
   their zone, the meeting link, and an .ics calendar invite; the onboarding
   call (docs/ONBOARD-CALL.md) becomes `booked`. Or **Suggest another time**
   (owner picks a free slot → the applicant gets that time with a one-click
   "Yes, that works" link and the booking page for anything else), or
   **Decline** (with a short reason). Afterwards **Call done** / **No-show**.
4. Every meeting from anywhere lands in the same calendar: requests from the
   booking page, "Mark call booked" in the onboarding card, calendar
   confirmations found in the inbox, and meetings the owner adds by hand.

Times are stored in UTC (ISO). Shown: Sri Lanka (Asia/Colombo, UTC+5:30, no
daylight saving) first for the owner, US Eastern next to it; the applicant
always sees their own zone (from their state, else Eastern).

## Settings (machine config)
```js
CALENDAR: {
  hours: ['09:00', '17:00'],     // the owner's call hours, US Eastern (≈ 6:30 pm – 2:30 am Colombo in summer, 7:30 pm – 3:30 am in winter)
  days: [1, 2, 3, 4, 5],         // Mon–Fri; US holidays are closed (isUsHoliday in lib/config.js)
  slotMinutes: 30,               // what the booking page offers (15 or 30)
  bufferMinutes: 15,             // kept free after every meeting
  maxPerDay: 6,                  // calls a day at most
  minNoticeHours: 12,            // no slot sooner than this
  daysAhead: 14,                 // how far ahead the booking page shows
  meetingLink: null,             // the owner's Zoom / Google Meet link put in confirmations (null → "I'll send the link before the call")
  ownerZone: 'Asia/Colombo',
  usZone: 'America/New_York',
}
```

## Data (machine)
`meetings` hash (id → meeting) + `meetings:byStart` sorted set (score = start ms).
```jsonc
{
  "id": "m…", "clientId": "ecreekit|null", "company": "eCreek IT", "person": "Sam Test", "email": "…",
  "kind": "onboarding|other", "title": "Onboarding call — eCreek IT",
  "start": "ISO (UTC)", "minutes": 30,
  "status": "requested|confirmed|held|no_show|declined|cancelled|blocked",
  "source": "booking_page|owner|inbox|onboard_card",
  "theirZone": "America/Denver", "note": "…", "declineReason": "…|null",
  "proposed": "ISO|null",          // when the owner suggested another time
  "createdAt": "ISO", "confirmedAt": "ISO|null", "history": [ { "at": "ISO", "what": "requested|confirmed|moved|declined|held|no_show|cancelled", "by": "them|owner|machine" } ]
}
```
`blocked` = a time the owner marked busy (no client, title "Busy").

## Booking page (public, client token — same token system as the onboarding page)
- `GET /c/{token}/book` — the page: next CALENDAR.daysAhead days, open slots in their zone (a zone switcher), a note box, one button. Shows the confirmed/requested meeting instead when one exists (with "ask for a different time").
- `GET /api/c/book/slots?token=` → `{ zone, slots: [ { start: ISO, label: "Tue 30 Sep · 2:00 pm" } ], existing: meeting|null }`
- `POST /api/c/book` `{ token, start, note }` → `{ ok, meeting }` (409 when the slot was just taken; rate-limited)
- `GET /c/{token}/book/accept?m={id}` — the one-click "Yes, that works" for an owner's suggested time.

## Hub API (under /api/mc, hub token or admin cookie)
- `GET /api/mc/calendar?from=ISO&to=ISO` → `{ meetings: [meeting], requests: [meeting] (status requested, oldest first), settings: { hours, days, slotMinutes, ownerZone, usZone, meetingLink }, free: [ { start, minutes } ] (open slots in range) }`
- `POST /api/mc/calendar` with one of
  - `{ action: 'confirm', id }` · `{ action: 'decline', id, reason }`
  - `{ action: 'suggest', id, start }` · `{ action: 'move', id, start }` (confirmed → new time, emails them)
  - `{ action: 'held', id }` · `{ action: 'noShow', id }` · `{ action: 'cancel', id, reason }`
  - `{ action: 'add', clientId|null, title, start, minutes }` (owner's own meeting, confirmed)
  - `{ action: 'block', start, minutes }` · `{ action: 'unblock', id }`
  → `{ ok, meeting }`
- Board rows / the onboarding card: the confirmed onboarding meeting is `onboardCall.bookedFor`; a pending request shows as "They asked for Tue 2 pm ET — say yes in the Calendar".

## Hub: the Calendar tab
A top-level tab next to Trials. Week view (Mon–Sun, "Today", ◀ ▶), the
owner's call hours as rows in **Sri Lanka time** with the US Eastern time in
small type beside each hour; meetings as blocks (green confirmed, amber
requested, grey held/blocked, red no-show); click → a panel with who, when (Sri
Lanka · Eastern · their zone), the note, and the buttons. Above the grid:
"Asked for a time — waiting for your yes" (each with Yes / Suggest another
time / Decline). On a phone: a day-by-day list instead of the grid. "Add a
meeting" and "Block time" buttons. Plain words; everything escaped.

---

## Machine — as built (2026-09-25)

Everything above holds. Code: `src/lib/systems/calendar.js` (slots, actions,
sync), `src/lib/templates/bookpage.js` (the page), routes
`src/app/c/[token]/book/route.js`, `src/app/c/[token]/book/accept/route.js`,
`src/app/api/c/book/route.js`, `src/app/api/c/book/slots/route.js`,
`src/app/api/mc/calendar/route.js`; tests `tests/calendar.test.mjs`. Where the
contract left a choice, the machine decided as follows. **(+)** = slightly
beyond the text above.

**Open times**
- A start every `slotMinutes` inside `hours` (US Eastern) on `days` (0 = Sun …
  6 = Sat, US Eastern day), US holidays closed. The call booked is
  `ONBOARDCALL.callMinutes` long and must end by the close of hours, so a
  15-minute grid still books 30-minute calls.
- `bufferMinutes` stays free after every meeting — including after the new
  one, so a 9:30 call cannot sit right before a 10:00 one.
- `maxPerDay` counts requested + confirmed calls on the US Eastern day; busy
  blocks take their time but do not count.
- The page shows today and the next `daysAhead − 1` days, never sooner than
  `minNoticeHours`. The hub's `free` list (for "Suggest another time") uses the
  same rules without the notice period, for the range asked (≤ 62 days).
- Requested, confirmed and blocked meetings hold their time. A request with an
  owner's suggestion holds the **suggested** time, not the one they asked for
  (the sorted set is scored by the held time); the hub should draw such a
  request at `proposed`.
- The owner's own times (suggest, move, add, block) may be outside the call
  hours; they must not overlap another held meeting (no buffer: his choice),
  and suggest / move must be in the future. Otherwise 409 / 400.

**Time zones**
- Their zone: the state on their application (`web_state`), else a state in
  their city or postal address, else US Eastern. Arizona is
  `America/Phoenix` (no daylight saving), Alaska and Hawaii their own zones.
  The page's switcher lists the seven US zones only (anything else in `?tz=`
  is ignored); the zone they picked in is stored as `theirZone`.
- All wall clocks come from `Intl.DateTimeFormat` with the zone, and back
  through `zonedToUtc`; no offset is ever written by hand.
- The owner's alert reads "Tue 6 Oct 2:00 pm ET = 11:30 pm Colombo"; when Sri
  Lanka is already on the next day (after 2:30 pm EDT / 1:30 pm EST) its day
  is written out: "… 3:00 pm ET = Wed 7 Oct 12:30 am Colombo".

**The booking page** **(+)**
- Plain server-rendered HTML (no script needed): radio buttons styled as big
  time buttons, a note box, one button. It posts to `/api/c/book` as a form;
  the route answers a form with a 303 back to the page (`?flash=sent|taken|
  pick|limit|error`) and JSON with JSON, as in the contract.
- Each email mints its own booking link (token purpose `book:{tag}`, 30 days),
  so an earlier link keeps working; only the token's hash is stored.
- One-click accept: opening `/c/{token}/book/accept?m=` shows the suggested
  time with ONE "Yes, that works" button (a form POST). Mail link scanners
  (Outlook Safe Links and the like) open GET links by themselves; a GET must
  never accept a meeting for someone. Picking the suggested time in the list
  also counts as their yes.
- Tries per link: 10 an hour (asks and accepts together) → 429 / `flash=limit`.
- The page is closed once the client leaves onboarding / awaiting_purchase /
  setup_check or the call is done. A request or booking whose time has passed
  no longer blocks a new pick.
- Asking for a different time on a **confirmed** call turns it back into a
  request at the new time: the old time is free again, the onboarding call is
  "not booked, they asked for …", the owner's alert says it is a move. Yes →
  the invite in their calendar is updated (same UID, next SEQUENCE); Decline →
  that old invite is cancelled in their calendar (METHOD:CANCEL).
- The same pick twice changes nothing and emails nothing (one meeting per
  client's onboarding call, one "got it").

**Emails** (templates `meeting_*` in `templates/client/stage-a.js`, from the
ONBOARDCALL inbox)
- "Got it", the suggestion and the decline answer the acceptance email
  (`Re: …`); the confirmation, the move and the cancellation have their own
  subject (`Confirmed: our call on Tue 6 Oct at 1:00 pm CT` …) but still carry
  `In-Reply-To` / `References`. All show in the trial's conversation in the
  hub as outgoing `booking` entries.
- Times in their zone, with Eastern beside it when they are elsewhere.
- The invite is nodemailer's `icalEvent`: a `text/calendar; method=…` part
  (mail apps show "Add to calendar") plus the `.ics` attachment. UID = the
  meeting id, SEQUENCE counts changes, DTSTART / DTEND in UTC (`Z`),
  ORGANIZER = the sending inbox (CN = OWNER.signerName), ATTENDEE = them,
  LOCATION = `meetingLink` when set.
- The owner's buttons send first and save second: if the email cannot go the
  answer is 502 and nothing changed (press again). The applicant's own ask /
  accept is saved first (the slot is theirs); a failed "got it" or
  confirmation is logged and, for an accept, named in the owner's alert.
- The decline reason is optional (default "that time doesn't work on my
  side."); a cancel reason is optional too. `add` and `block` email nobody.

**Meetings** **(+ fields)**
- Also stored: `requestedAt`, `sequence`, `updatedAt`, `cancelReason`.
  History `what` also takes `suggested`, `accepted`, `blocked`, `unblocked`;
  entries may carry `via` (the source), `from` (the old time), `reason`,
  `proposed`, `was`.
- `unblock` turns the block `cancelled`. `GET /api/mc/calendar` leaves
  declined and cancelled meetings out unless `all=1`.
- Every hub meeting also has `end` and `labels: { owner, eastern, theirs,
  proposed }` (ready-made "Tue 6 Oct, 11:30 pm" / "Tue 6 Oct, 2:00 pm ET").
- `add` takes an optional `kind: 'onboarding'` (with `clientId`): that
  meeting is then the client's onboarding call and books it (409 when one is
  already open for them).

**The onboarding call** (docs/ONBOARD-CALL.md)
- The acceptance email and its reminders link the booking page whenever
  `ONBOARDCALL.bookingUrl` is null; "reply with two or three times" only when
  the link cannot be made (logged as `booking_page_link_failed`).
- `client:{id}:onboardcall` gains `meetingId`, `requestedFor`, `requestedAt`,
  `firstRequestAt`, `proposedFor`, `theirZone`; `onboardCall` gains
  `requestedFor`, `requestedAt`, `proposedFor` (only while a request waits)
  and `meetingId`. Label: "They asked for Tue 6 Oct, 11:30 pm (your time) —
  say yes in the Calendar" / "You suggested … — waiting for them"; `simple`
  the same words with `needsYou: true` for a request; a to-do
  `meeting-request:{id}` (urgent) with action `{ type: 'view', view:
  'calendar', clientId, meetingId }`.
- A request counts as their answer: the "did you see my email" reminders stop
  (as after a reply), and it is never `overdue` while it waits for the owner.
- Confirmed → booked (`bookedBy: 'calendar'`); held / no-show in either place
  shows in the other; "Mark call booked" and calendar invites found in the
  inbox create or move the client's one onboarding meeting (no emails; a
  booking email with no readable time is not placed in the calendar); a
  calendar cancellation from their side cancels it. The day-before reminder
  uses their zone.
- The onboarding page's clock (gatekeeper `runOnboardingNudge`): one reminder
  track — while the call is still to happen only the call's reminders go; the
  page's Day +2 / +4 reminders run after the call is done, counted from it
  (clients without an acceptance email keep the old reminders). The Day +7
  close counts from their last sign of life (a reply, a time asked for, the
  booked call, the call) and waits while a request is unanswered or a booked
  call is ahead; the trial hash gets `onboardingClosesOn` ('YYYY-MM-DD' or
  'held') and the event `close_extended`.

**Alerts** — `meeting_requested` ("Sam (eCreek IT) asked for … — say yes in
the Calendar") and `meeting_accepted` ("Sam (eCreek IT) said yes to …"):
phone push + email, not urgent (the Calendar list and the trial's to-do carry
the red dot), push `url` = `/#calendar`.

**Not built** — no nudge to the owner when a request sits unanswered (the
red dot stays); unanswered requests whose time has passed stay in `requests`
until declined; nothing is written to an outside calendar (the invites put
the call in the applicant's calendar; the owner's is the hub). *Since
2026-09-25: with Google connected, confirmed calls also go on the owner's
Google Calendar with a Meet link — docs/REPLYBOT-MEET.md §3.*

**To set** — `CALENDAR.meetingLink` (the owner's Zoom / Google Meet link;
until then confirmations say "I'll send the link before the call"), and a
look at `CALENDAR.hours` / `days` (09:00–17:00 Eastern, Mon–Fri =
6:30 pm – 2:30 am Colombo in US summer, 7:30 pm – 3:30 am in winter).
