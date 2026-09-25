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
