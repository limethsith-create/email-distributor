# Stage C — Run systems (SPEC §8, Phase 5): assumptions

Where the spec or the owner's files left a value or a wording open, this is
what the code does, and where to change it.

## Scope

- Every Stage C system and job skips `aviance` (legacy engine untouched) and
  `_helper`. Nothing in `auto-send/route.js`, `reply-checker.js` or the legacy
  keys was changed.
- The client's copy comes only from `client:{id}:sequence` (Stage B). If it has
  no variant, the Sender holds and alerts `config_missing`; it never falls
  back to `default.json` (that is Aviance's own pitch).

## Sender (`systems/sender.js`)

1. **Caps.** `inbox.dailyCap` (Ramp Planner) is used when set; when missing
   the cap comes from `RAMP.caps` by trial day. Always clamped to 25 in code.
   "I'm away" halves the cap on those days (floor).
2. **Day 1.** The `send` job runs in `ready`; the first business-day tick at or
   after 09:00 ET on/after `trial.day1Date` moves `ready → sending`. The first
   successful send writes `trial.firstSendAt`; when that ET day differs from
   `day1Date`, `day1Date` is moved to it, `day30Date` = day1 + 29 and
   `day1MovedFrom` keeps the old date.
3. **Smoke test.** Hold at 50 total sends; ask for a bounce scan at once and
   again 2 h after reaching 50 (`SMOKE.rescanHours`). Bounce rate > 3 % after
   either scan → `client.emergencyRequested = smoke_bounce`. The hold lifts
   only after the **second** scan (the spec says "run it immediately, then
   again after 2 h"; lifting after both is the conservative reading). The
   Emergency Runner's resume clears a failed smoke test (the list was
   re-verified).
4. **Pacing.** Same formula as the aviance engine (minutes left in the ET
   inbox window ÷ sends left, ±15 % jitter) with bounds `PACING.minGapMin` 10
   / `maxGapMin` 60. There is no cross-inbox 75-second spacing: one email per
   inbox per tick is the spec's rule.
5. **Risk rule.** `risky` leads are sent only when no `safe` or `catchall`
   lead is left in the client's whole unsent pool (not just the ones in
   window). Referral leads (whose address was guessed) are `risky` unless the
   reply gave the address.
6. **First-touch MX re-check** (cached per domain, from `email-verify.js`) is
   kept from the aviance engine; an address with no MX is closed (`done`).
7. **Pace settings** read from `client:{id}:pace`: `compressed` (gaps 3-2-3),
   `earlySend` (leads whose local clock is earliest in the day go first —
   "move send time to 9:00" is a priority, not a hard window, so volume is not
   cut), `narrowSlice` (that slice first), `exclude` (size bands / titles
   dropped from new sends).
8. **Lead statuses used:** `unsent → in_sequence → done` (after d10, expiry,
   skip), plus `replied`, `notnow`, `suppressed`, `bounced`. The legacy
   `sent-d0 … sequence_complete` strings are not used for trial clients.
9. **Stall marker.** A trial send clears `system:heartbeat.firstDueUnsentAt`;
   "inbox due + lead ready + nothing sent" sets it. Unlike the aviance job the
   Stage C job never clears it on a quiet minute (the field is shared).

## Compliance Guard (`systems/compliance.js`)

10. Opt-out line = `reply STOP` (regex `reply\s+"?stop`), the footer wording
    of Sequence T. Postal address is compared with whitespace/commas
    normalised.
11. Suppression / blocklist blocks are final for that lead (closed, no retry).
    Any other block holds the client's sending for the tick (it is systemic)
    and counts toward the 3-a-day alert.
12. Replies to prospects (reply_interested etc.) are sent **non-transactional**
    so the mailer adds the same List-Unsubscribe headers the guard requires,
    and they carry the sequence footer.
13. `reply_no` and `apology_customer` are sent **before** the address is
    suppressed / blocklisted (otherwise the guard would refuse them).

## Reply Handler (`systems/replies.js`)

14. **Classifier rows** in SPEC §8.3 are cut off in the markdown table
    (`interested`, and the `wrongperson` "contact (name)" cue). Implemented:
    - interested: `interested` (not after "not / no longer / never"), tell me
      more, how does, what does it/this cost, pricing, send (me) more / info /
      details / over, sounds good/great/interesting, let's talk/chat/connect,
      book/set up/schedule a call/time/meeting, happy to chat/talk, worth a
      chat/call/look, a reply starting yes/yep/sure/ok, I'm in, when are you free.
    - wrongperson: the listed phrases; "you want" only as "you('d) want to
      talk/speak/reach/contact…" or "you want <First Last> at/who/on" (plain
      "do you want…" would otherwise swallow interested replies); "reach out to"
      not followed by me/us; "contact <name>" not followed by me/us/you/our/
      my/sales/support/info….
    - legal and angry phrases match as prefixes ("harass" → harassment).
    - `no` needs ≤ 12 words (spec).
15. **Positive** = `interested` or `question` (the spec's actions table gives
    `question` the same state change as `interested`). `replies` and
    `positive` count once per lead (first reply / first positive).
16. **OOO with no parseable date** holds the lead `OOO.defaultHoldDays` (7).
17. **Not-now dates.** "after <month>" → the 1st of the month after that month;
    a bare month → the 1st of that month (next occurrence). "may"/"mar" count
    as months only after a time word (in, by, until, after, …). Holidays:
    Christmas, New Year, July 4th, Halloween fixed; Thanksgiving, Labor Day,
    Memorial Day from `US_HOLIDAYS`; Easter and unknown → +60 days.
    A 2nd not-now moves the date (`NOTNOW.maxMoves` = 1); a 3rd sets the lead
    `suppressed` for this client only (not global — it was not a STOP).
18. **Wrong person.** The original lead is `suppressed` for this client only
    (not global). With a name but no address, only the first guess in the
    §7.2 order (`first@host`) is MX-checked; Reoon is not called from Stage C. Referral lead:
    `source = referral`, `referrerName`, `referredFrom`, `guessed`.
19. **Hot lead** goes from the trial inbox (so the client's reply lands where
    we can see it) to `client.contactEmail` and, if different,
    `profile.hotLeadEmail` (also accepted: `alertEmail`, `hotLeadAlertEmail`).
    Unknown size/city/title are written as "… not on file" (a label, not a
    number). For question/unclear the doc's "I've offered two slots" sentence
    is replaced by a tag line ("needs answer" / "unclear — your call").
20. **Hot-lead chaser.** 4 h / 24 h are wall-clock hours. `trial.unansweredHot`
    is the **current** count of hot leads past 24 h without an answer
    (incremented at 24 h, decremented when the client answers later).
    "Answered" = a message from a client address whose thread ids contain the
    hot-lead email or the prospect's message.
21. **Exit interview.** Detected when a client address writes after
    `trial.exitInterviewSentAt`, in the thread of
    `trial.exitInterviewMessageId` (or, if that id is missing, any "Re:"
    subject). Stored verbatim (2,000 chars) in `trial.exitReason`.
22. **Quote.** The first Showed tap sends `quote_request`; a client reply in
    that thread is stored verbatim in `booking.quote`.
23. **Soft offer nudge** (Pace Day 20 fix): `interested_nudge` 2 days after a
    soft interested reply when no booking came — a new small template.

## Bookings + Scorekeeper

24. **Booking id** = hash of the ICS UID (else the Message-ID). Re-invites with
    a new DTSTART reschedule the booking (`rescheduleCount`, reminders reset);
    METHOD:CANCEL / STATUS:CANCELLED set `cancelledAt` (status unchanged — the
    tap decides).
25. **Floating ICS times** (no TZID, no Z) are read as US Eastern. Body-only
    confirmations need an explicit Eastern/Central/Mountain/Pacific zone;
    otherwise `scheduledAt = null` (never guessed).
26. **Colleague match:** an attendee at the same host as an emailed lead is
    matched to that lead with `colleague = true`; qualified then needs the
    attendee's own title (unknown → counts only with an undisputed Showed tap).
27. **Handoff "link to the thread"**: the client has no access to the trial
    inbox, so the handoff carries the reply thread as text.
28. **Prospect reminders:** 24 h reminder in [T−24 h, T−2 h), 1 h reminder in
    [T−1 h, T). Skipped when `profile.toolSendsReminders` is truthy.
29. **Tap links:** one token `tap:{bookingId}` (24 h, not one-shot — a second
    tap corrects the first); the tap reminder mints a fresh one. A fifth link
    "I could not make it (my side)" records a client-side no-show.
30. **Dispute window** = 24 hours counted only on US business days (ET).
    Reasons: `profile`, `title`, `attended`, `outreach` (the four criteria).
31. **No-show ladder:** re-book emails at day 0, 3 and 7 after the tap
    (`NOSHOW_EMAIL_DAYS`) — 2 attempts, 3 emails; after 14 days the booking
    becomes `closed_noshow` (an extra status next to the §3 list).
32. **Day 29 with no tap:** status `held`, `unconfirmed = true`, counted in
    `held`, **not** in `qualified`.
33. **noshow_high** fires on noshows / booked > 0.30 with no minimum sample
    (spec gives none).

## Client Watch

34. "Quiet" counts business days since the later of: the oldest unanswered
    hot lead, the client's last email / tap / button. Activity = any email from
    a client address into a trial inbox, a tap, or a button.
35. Pause → `paused` with `client.pausedReason = client_quiet`; the client's
    next email lifts it. 14 business days → `trial.endReason = client_quiet`,
    `trial.endedAt` (state stays `paused`; Stage D closes).
36. **Stop the trial** → `trial.stoppedAt`, `endedAt`, `endReason =
    client_stopped`, `retireAt = +7 days`; sending paused now.
37. **"You emailed my customer"** never blocklists a free-mail domain
    (gmail.com …), only the address.

## Pace Checks

38. Day 7 needs `templates/sequence/{niche}.backup.json` (Stage B) — either one
    sequence (`touches`) used for both variants or `{variantA, variantB}`. The
    old variants are kept as `variantA_v1` / `variantB_v1`. No file → nothing
    changes, owner alert `copy_blocked`.
39. Day 12 slice needs ≥ 10 sends in the slice and a reply rate > 0.
40. `pacelog` holds applied fixes only (passes go to the event log).

## Emergency Runner

41. **Cadence.** Every tick while `client.emergencyRequested` is set or an
    emergency is running; otherwise a full trigger scan every 5 minutes
    (Upstash free-tier budget; the spec says every tick).
42. **Bounce trigger window:** day counters summed back from today until ≥ 50
    sends (max `EMERGENCY_C.maxWindowDays` = 7), never including days on or
    before the last resume day.
43. **No-replies trigger:** 2 business days since the last reply (or the
    resume), only when sends went out in that time and the campaign had
    replies before.
44. Persistent readings (blacklist, DMARC, canary) do not re-fire on the day
    sending resumed.
45. Order of steps: the client `deliverability_notice` is sent right after the
    diagnosis (same day), not after the resume.
46. **Wording** (Deliverability Emergency SOP, adapted to a one-domain trial):
    "switched sending to your healthy backup domains" and the paid-plan
    rollover sentence are replaced by "are re-cleaning the entire list before
    anything else goes out" and "The trial promise is unaffected."
47. Step 2 never disables the last enabled inbox (it would stop the trial for
    good); step 3 re-verifies 25 unsent leads per tick (MX; a Stage B
    `leadfinder.deepVerify` is used for `risky` leads if it exists) and calls
    `leadfinder.requestRefill(clientId)` if it exists, else the daily refill
    job tops up.
48. Step 4 "canary < 50 % on both inboxes" = every inbox with a measured
    canary under 50 %. The new shopping list comes from Stage A's
    `pricescout.buildShoppingList(clientId)` when present; otherwise the alert
    asks the owner to run the Price Scout. The trial stays paused until the
    owner resumes it.
49. Step 5 halves every inbox's `dailyCap` immediately (Ramp keeps it halved
    from its next run via `emergencyHalved`). Green day = a business day with
    sends, bounce < 2 %, ≥ 1 reply, canary ≥ 85 % (skipped when no canary was
    measured). Days with no sends neither count nor reset.

## Learning Library

50. Niche = `profile.niche`, else `client.niche`, else the first
    `profile.industry` keyword, slugified; `default` if none.
51. Variant id = letter + sequence version (`A1`, `B1`, `A2` …). Hour slice =
    the lead's local hour of the send. Minimum sample for ranking / best
    hour / best city = `LEARNING.minSends` (20).

## Templates written new (no source wording)

hot_lead_nudge, call_handoff, slot_far_warning, call_tap, call_tap_reminder,
paused_quiet, reply_interested, reply_interested_soft, interested_nudge,
reply_wrongperson_thanks, referral_intro, notnow_followup, reminder_24h,
reminder_1h, rebook_email, apology_reschedule, apology_customer.
From the sources: hot_lead (trial doc §10, verbatim + action line),
quote_request (trial doc §5 ladder), offpace_day15 (trial doc §7 off-pace
script), deliverability_notice (SOP, adapted — see 46), reply_notnow and
holding_reply and reply_no (SPEC §8.3 wording).

## Config added (`config.js`, Stage C block)

`PACING.minGapMin/maxGapMin` 10/60, `SMOKE.rescanHours` 2,
`OOO.defaultHoldDays` 7, `COMPLIANCE.alertBlocksPerDay` 3,
`NOSHOW_EMAIL_DAYS` [0, 3, 7], `EMERGENCY_C.burnedCanary / maxWindowDays /
verifyPerTick` 0.50 / 7 / 25, `LEARNING.minSends` 20,
`REPLIES_C.maxMessagesPerRun / firstScanDays` 30 / 7.
Word lists: `config/angry.txt`, `config/claims.txt`,
`config/bookingSubjects.txt` (the code carries the same lists built in, used
when the file is not in the deployed bundle).

## Fields for other stages

Written by Stage C, read elsewhere:

| Where | Field | Meaning / reader |
| --- | --- | --- |
| `client:{id}` | `emergencyActive` '1'/'0' | emergency running (Ramp → cap 0) |
| `client:{id}` | `emergencyHalved` '1'/'0' | resumed at half volume until 3 green days (Ramp halves) |
| `client:{id}` | `emergencyRequested` | **consumed** (cleared) by the Emergency Runner; Stage B canary / Stage C smoke + pace set it |
| `client:{id}` | `pausedReason` (`emergency` / `client_quiet` / `client_stopped`), `pausedAt`, `pausedFrom` | why the trial is paused (board) |
| `client:{id}` | `legalHoldAt`, `legalHoldReply` | legal reply hold; cleared via `POST /api/mc/clients/[id]/holds {action:'clearLegalHold'}` |
| `client:{id}` | `bounceScanWantedAt`, `bounceRoundLeft`, `bounceDailyDay` | bounce-scan requests (read in the job's `due`) |
| `client:{id}:trial` | `firstSendAt`, `day1Date`/`day30Date` (moved on first send), `day1MovedFrom` | Stage D Day 1 notice + day jobs |
| `client:{id}:trial` | `unansweredHot` | current count of hot leads > 24 h unanswered (Friday "waiting on you", health colour) |
| `client:{id}:trial` | `lastClientActivityAt` | last client email / tap / button |
| `client:{id}:trial` | `exitReason`, `exitReasonAt` | exit interview answer (needs Stage D to set `exitInterviewSentAt` + `exitInterviewMessageId` and send `exit_interview` **from the trial inbox**) |
| `client:{id}:trial` | `endedAt`, `endReason` (`client_quiet` / `client_stopped`), `stoppedAt`, `retireAt` | early endings → Stage D handover / report / wrap-up |
| `client:{id}:profile` | `awayRanges` JSON `[{from,to,setAt}]` | "I'm away" |
| `client:{id}:replies` | `replyId → {leadEmail, inbox, receivedAt, subject, snippet, kind, handledAt, action, forwardedToClientAt, notnowDate}` + `text` (≤ 2,000 chars verbatim), `rule`, `messageId` | Market Report; kinds add `exit` |
| `client:{id}:bookings` | §3 fields + `id, attendeeEmail, attendeeName, colleague, manualMatch, rebookOf, rebookedAs, cancelledAt, rescheduleCount, previousScheduledAt, tapSentAt, tapReminderAt, heldAt, noshowAt, rebookEmails, closedNoshowAt, disputedAt, disputeNote, disputeResolution (upheld/upheld_auto/overturned), disputeResolvedAt, unconfirmed, clientNoshowAt, wrongfitAt, qualifiedReason, clientNote, quoteRequestedAt, quoteRequestMessageId, quoteReceivedAt, createdAt` | Friday / Day 20 / Day 29 / testimonial; status adds `closed_noshow` |
| `client:{id}:pacelog` | list of `{at, day, test, fix}` | Friday "what we changed", Day 29 "what didn't" |
| `client:{id}:pace` | `compressed, earlySend, softInterested, narrowSlice, exclude` | Day 29 report (wrong-fit exclusions) |
| `client:{id}:counters:*` | `sent, sentD0, sentD3, sentD7, sentD10, bounces, replies, positive, booked, held, qualified, noshows, wrongfit, companiesContacted` | reports |
| `client:{id}:hot` | `replyId → {leadEmail, kind, sentAt, nudgedAt, holdingAt, answeredAt, …}` | "waiting on you" list |
| `client:{id}:emergency` | runner state: `active, trigger, detail, startedAt, step, resumedAt, resumedDay, greenStreak, recoveredAt, noticeSentAt, burned, diagnosis` | board / Friday watch line |
| `client:{id}:sendstate` | smoke test (`smokeReachedAt, smokeClearedAt, smokeFailedAt`), `bounceScanDoneAt`, `lastReplyAt`, IMAP cursors | board |
| lead record | `status, sent_at, account_used, original_subject, original_message_id, d3/d7/d10_sent_at/_message_id/_subject, sentVariant, sentVersion, replied_at, reply_kind, positiveAt, notnowDate, notnowRule, notnowCount, notnowFollowups, holdUntil, bookedAt, bookingId, referrerName, referredFrom, bouncedAt, skipReason` | Market Report, Day 29 not-now list |
| inbox record | `enabled` '0' + `disabledReason`, `emergencyDisabledAt` (emergency diagnosis — **warm-up must not key off `enabled`**), `dailyCap` halved on resume, `capHalvedAt` | Ramp / warm-up |
| `inbox_health` (legacy hash, keyed by email) | send success/failure, IMAP results for trial inboxes too | Inboxes page |
| `learning:{niche}` / `learning:{niche}:raw` | rolled-up variants, `_rank`, `_bestHour`, `_bestCity`, `_emergencies`, `_rankedAt`; raw flat counters | Copy Engine (`topVariants(niche)` in `systems/learning.js`), Day 29 "what produced it" |

Functions other stages can call: `clientButtonLinks(clientId)` (customer /
stop / away URLs, 14-day token — put them in the Day 1 notice / Friday
update), `getPaceLog(clientId)`, `topVariants(niche)`, `applyTap`,
`resolveDispute`.
