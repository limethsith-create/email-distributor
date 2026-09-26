# The launch call — shared contract (2026-09-27)

The owner's words: "I want confirmation with the customer about the email
copy before we send. I need another call in the system: the first is the
onboarding call; the second explains the lead list and the email copy and
gets their OK. While warm-up runs, tell them we are researching their
business and building an offer. Change it up so it makes sense."

**Decision on timing.** The launch call happens at the END of warm-up — the
invite goes out once the list (≥ LIST.startMin verified leads) and the copy
(Copy Checker passed) exist AND warm-up is at least `LAUNCH.earliestWarmupDay`
(default 10 of ~14) — so the call lands around warm-up day 11–13, about
3 business days before Day 1, with the real list and the real emails on
screen. Not on day one: there is nothing to show yet. Right after the
onboarding call the client gets one "what happens now" email with the plan
and the launch call named; the Friday updates carry the middle weeks.

Two calls, one machinery: the launch call reuses the onboarding-call system
(docs/ONBOARD-CALL.md: invite → booking page → request → owner's Yes in the
Calendar → Google Meet + .ics → reminders → held) with `kind: 'launch'`.

## 1. "What happens now" (client email, after the onboarding call)
Sent once when the onboarding call is marked held (`markHeld` / calendar
`held`) — or, if the agreement was signed first, right after the agreement
(fold into the existing `setup_in_progress` / `welcome_two_dates` moment if
that email already goes out then; never two "what happens now" emails).
Plain, short, in the owner's voice. Points: we are researching your
business and your market now; this week we set up your sending address and
inboxes; two weeks of warm-up so your emails land in the inbox; meanwhile we
build your list of ~400 companies and write your emails in your words; a
Friday note each week; near the end of warm-up you get an invite to a
{LAUNCH.callMinutes}-minute **launch call** where we go through the list and
the emails together and you give the OK; first emails go out about
{day1Estimate} (a plain estimate from the ramp: warm-up start + 14 days +
the next business day — null → "in about three weeks").
Template `next_steps` (client), tracked in the client's conversation.

## 2. The launch invite (replaces the plain approval email)
Today the Day −4 approval job emails the approval page link
(`sendApprovalLink`, systems/approval.js; the page shows the profile, the 20
sample companies and the copy; the client approves per section, `approvedAt`
on the sequence; the readiness gate needs it for Day 1).

From now on, when `readyForLaunch(clientId)` is true — list ≥ LIST.startMin
sendable, sequence built and Copy Checker green, warm-up day ≥
`LAUNCH.earliestWarmupDay` — the machine sends `launch_invite` instead:
"Your list and your emails are ready — let's go through them together"
with the booking page (kind `launch`, `LAUNCH.callMinutes`, same open-slot
rules) and, below, the approval page link "if you'd rather read it first".
The approval page keeps working exactly as today (a client may approve on
the page without a call; then the call is optional).

Owner alert `launch_ready` ("Ridgeline IT is ready for the launch call —
invite sent"), later `meeting_requested` / `onboard_reply` as today.

## 3. On the call: "Approved on the call"
The owner shares the approval page on the call. In the hub's launch-call
card he presses **Approved on the call** → the machine approves every
section (`approvalMode: 'call'`, `approvedAt` now, logged) and marks the
call held. Or the client approves on the page themselves → the call card
shows "They approved on the page" and the call becomes optional (owner
may still hold it, or press **Skip the call**).

Day 1 rule (unchanged shape): Day 1 = the first business day after BOTH
warm-up is ready AND the approval is in (`approvedAt`), respecting
`maxSlideDays`; the Day 1 estimate shown to the client is only ever from
the ramp, never a promise.

## 4. Tracking (machine) — the second call
`client:{id}:launchcall` hash + the same conversation thread. Same states
and fields as `onboardCall` (`sent → opened → replied → booked → held`,
`no_show`, `overdue`, `stopped`, reminders at `ONBOARDCALL.reminderHours`,
overdue after `bookWithinDays` business days, day-before reminder with the
Meet link), plus `approvedOnCall: ISO|null`, `approvedOnPage: ISO|null`,
`skipped: ISO|null`. Meetings: `kind: 'launch'`, title "Launch call —
{company}", one per client (like the onboarding one), same calendar actions,
same Google Meet.

```js
LAUNCH: {
  callMinutes: 30,
  earliestWarmupDay: 10,   // no invite before this warm-up day
  bookWithinDays: 3,       // business days to have it booked → overdue alert
}
```

## 5. Hub API
- `GET /api/mc/hub/{id}` gains `launchCall` (same shape as `onboardCall`, plus
  `approvedOnCall`, `approvedOnPage`, `skipped`, `approvalUrl`) — null until
  the invite is sent.
- `POST /api/mc/clients/{id}/launch-call` with `reply` (alias of the
  messages reply), `markBooked {when}`, `markHeld`, `markNoShow`, `resend`,
  `stopReminders`, **`approvedOnCall`**, **`skip`** → `{ ok, launchCall }`.
- `POST /api/mc/onboard-calls/check` also checks launch calls (same throttle);
  the job too.
- `simple` during warm-up: "Warming up — day 11 of about 14 · launch call
  Tue 6 Oct, 8:30 pm (your time)" / "… · waiting for them to pick a
  launch-call time" / "Launch call done — first emails Wed 21 Oct";
  `needsYou` + to-do when: a launch-call time waits for the owner's yes,
  the call is booked and past ("Hold the launch call, then press Approved on
  the call"), overdue, or they wrote.
- Calendar meetings carry `kind: 'launch'` (the hub labels it "Launch call").

## 6. Hub screens
- Trial page: a **Launch call** card (the onboarding-call card, reused with
  the launch wording) right under the warm-up card once `launchCall` exists:
  the 5 steps, "Book by", the conversation link, the buttons — and two
  extra: **Approved on the call** (primary while booked/held and not yet
  approved; confirms: "This approves their list and emails — sending can
  start.") and **Skip the call** (only when they approved on the page).
  The big button follows the to-dos above. The journey stays ① Applied → ②
  Onboarding call → ③ Setting up → ④ Sending emails → ⑤ Done; step ③'s words
  say where the launch call is.
- Calendar: launch calls drawn like onboarding calls with the "Launch call"
  title; the panel's "Approved on the call" shortcut opens the trial.
- Settings › Advanced already shows LAUNCH; nothing else new.
