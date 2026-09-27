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

---

## 7. Machine — as built (2026-09-27)

Everything above holds. Code: `src/lib/systems/launchcall.js` (the plan
email, when the invite may go, the invite, the OK buttons, the hub's
`launchCall`), `src/lib/systems/onboardcall.js` (the call machinery, now
generalised by `kind`: `CALL_KINDS`, every function takes `kind`),
`src/lib/systems/calendar.js` (kind `launch` meetings), `systems/replybot.js`
(the launch thread), `systems/approval.js` (`approveAllOnCall`, the job),
`systems/hubview.js` (`simple`, to-dos, detail), route
`src/app/api/mc/clients/[id]/launch-call/route.js`; templates `next_steps`
(templates/client/stage-a.js), `launch_invite`, `launch_invite_reminder`,
`launch_call_tomorrow` (stage-b.js); tests `tests/launch-call.test.mjs` and the
journey's steps 15–21 (`tests/fixtures/journey/15…21-*.json`). Where the
contract left a choice, the machine decided as follows; **(+)** = beyond the
text above.

**Two calls, one machinery.** `client:{id}:launchcall` is the same hash shape
as the onboarding call's plus `approvedOnCall`, `approvedOnPage`, `skipped`;
the client hash carries `launchCallSentAt` and `launchCallOpen` ('1' while the
inbox is watched for it), read by the tick like the onboarding flags. The
`onboard-calls` job is due when either flag is '1'; the check
(`checkOnboardCalls`, the hub's `POST /api/mc/onboard-calls/check`) watches
both kinds — `checked` counts both. `activeCall(clientId)` = the launch call
once its invite is out and it is still to happen, else the onboarding call:
what the conversation, the owner's reply and the reply bot go by.

**"What happens now" (`next_steps`).** Sent once per client (trial hash
`nextStepsSentAt`, `nextStepsMoment`): on Call done for the onboarding call
(the card or the Calendar) with the line "Good to talk with you today", or —
when the agreement came first — at the Price Scout moment with "Your agreement
is in and your market check passed"; then `setup_in_progress` does NOT go (it
is folded in). Day 1 line: `trial.day1Date` when set, else the slowest inbox's
first warm-up day + BUILD.warmupReadyMinDays moved to the next US business day,
else "in about three weeks" — never anything else. Conversation entry kind
`next_steps`. `welcome_two_dates` now names the launch call ({callMinutes})
instead of an approval date.

**When the invite goes.** The hourly `approval` job asks the launch step first.
`readyForLaunch`: warm-up day (the slowest inbox, as the warm-up card counts
it) ≥ `LAUNCH.earliestWarmupDay`, the list ≥ LIST.startMin sendable contacts
(`listReady`), the sequence built and the Copy Checker green on both variants
for a sample lead; the job builds the sequence once the list is in **(+)**.
Once the invite went, the approval job does nothing more for this client: no
page reminders, no silence rule — the call's own reminders and overdue carry
it (the page keeps working). `approval.sentAt` is set with `status:
'launch_invite'` (the copy card reads it; `links.approval` is filled).
**Fallback (+)** `LAUNCH.fallbackDay` (default −3): still not ready by that
trial day → the plain approval email goes and the old path continues
(reminders, silence). A client none of whose inboxes has a warm-up start (from
before this feature) keeps the old Day −7 path.

**The invite.** From the ONBOARDCALL inbox (replies land where the machine
reads them); the booking line is the owner's `ONBOARDCALL.bookingUrl` or the
machine's booking page whose link carries `kind: 'launch'` (an older link
books the call in play); the approval page link below; "the first emails go
out about {day}" from the ramp; one open pixel (purpose `launch`); `dueBy` =
`LAUNCH.bookWithinDays` US business days; their zone copied from the
onboarding call; entry kind `launch_invite`; owner alert `launch_ready` (info).
`resend` from the card: same thread, reminders and the booking clock restart,
only while the call is still to happen.

**Tracking.** States and reminders exactly as the onboarding call, with
`launch_invite_reminder` (ONBOARDCALL.reminderHours, carries the approval
page) and `launch_call_tomorrow` (the Meet link and the approval page).
"Book it" reminders and overdue run while the client is `warming`; the inbox
is read while `warming`, `ready` or `sending` until the call is held or
skipped. Both also stop once they approved on the page or the call was
skipped. Alerts **(+)**: `launch_booked`, `launch_overdue`, `launch_cancelled`
(info, like the onboarding ones); replies raise `onboard_reply` and booking
requests `meeting_requested` as today. The booking page reads "Aviance ·
launch call" / "Book your launch call".

**Meetings.** `kind: 'launch'`, title "Launch call — {company}",
`LAUNCH.callMinutes` long (the slots offered are that long); one per client —
a second pick moves it, `add` with `kind: 'launch'` refuses while one is open;
`source` `booking_page` / `reply_bot` / `inbox` / `launch_card` (the card's
Mark call booked, Call done, They didn't show). The Calendar's `meetings[]`
and `requests[]` carry `kind`; request, confirm, held, no-show, decline and
cancel sync to the launch hash. Google Calendar event: "Launch call with …".

**Reply bot on the launch thread.** Only `reschedule`, `proposes_time` (→ a
launch meeting request, the owner still says yes), `wants_time` (the launch
booking page + the next open times) and `thanks` answer; `not_interested`,
`price` and `what_needed` go to the owner (`onboard_reply`) — mid-trial those
are his. Eligible while the launch call is in play.

**The OK.** `approvedOnCall`: every section `{ status: 'approved', by: 'call' }`,
the sequence `approvedAt` / `approvedBy` (the owner's name) / `approvalMode:
'call'` — what the readiness gate reads (Day 1 unchanged in shape) — the call
held (its meeting too), `launchCallOpen` '0'; pressing it again changes
nothing; refused after a skip. `approvedOnPage` is set by the approval page
when the third section is approved while the invite is out; the label says
"They approved on the page — the call is optional" and the reminders stop.
`skip`: only once they approved on the page, never while a time waits for the
owner or a call is booked ahead (answer or cancel it in the Calendar first —
they get a note there; skipping is silent); sets `skipped` (ISO),
`launchCallOpen` '0'. Call done in the Calendar without the OK: label "Call
done — press Approved on the call if they gave the OK" and the `launch-mark`
to-do.

**Hub (docs/HUB-API.md "The launch call").** `launchCall` = the `onboardCall`
shape plus `kind`, `approvedOnCall`, `approvedOnPage`, `skipped`,
`approvalUrl`. To-dos: `meeting-request:{id}` with `action.kind: 'launch'`,
`launch-reply:{id}`, `launch-overdue:{id}`, `launch-mark:{id}` (booked and
past: "Hold the launch call with {who}, then press Approved on the call";
held without the OK: "Press Approved on the call for {who} — the launch call
is done"), all with `section: 'launchCall'`. `simple` while warming: the
warm-up card's sentence, then " · launch call Tue 20 Oct, 8:30 pm (your time)"
/ " · waiting for them to pick a launch-call time" / " · they asked for … —
say yes in the Calendar" / " · they approved on the page (launch call
optional)" / " · launch call still not booked (overdue)"; after the OK
"Launch call done — first emails on Wednesday 21 October". Copy card: "Launch
invite sent … · {label}", "Approved by the launch call …".

**Config.** `LAUNCH.callMinutes`, `earliestWarmupDay`, `bookWithinDays`, and
**(+)** `fallbackDay` (null = never fall back).

**Fixtures.** The full-run milestone list changed in two places: `client
setup_in_progress` → `client next_steps` (the agreement came first there), and
`client approval_link` + `approval link_sent` → `client launch_invite` +
`owner launch_ready` (that client approves on the page). The journey now has
34 steps; 15–21 are the launch call.
