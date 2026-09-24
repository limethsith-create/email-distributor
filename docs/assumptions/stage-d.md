# Stage D assumptions (Phase 6 — report, close, Mission Control)

Everything below is a value or wording the spec or the owner's docs left
open. Each line says where it lives so it can be changed in one place.

## Wording (src/lib/templates/client/stage-d.js)

Verbatim from *The 30-Day Trial* §10: `day1_started` ("Day 1"), Friday update
line layout, Trial Report lines, `review_request`, `review_request_zero`,
`testimonial_approval`, the ladder lines for 44 ("the domain retires
tomorrow — say the word and it stays live"), the exit-interview questions,
"Fill this in and I'll fix the targeting for you" (disposition sheet), and
the decision-page FAQ answers (§6 "What they say"), lightly adapted from
spoken to written ("you told us you can take {capacityPerWeek} calls").

Written new, short, in the owner's voice (no source text exists):

1. `friday_update` build variant — the SPEC §9.1 example lines
   ("Inboxes warming: day 9 of 14 / List / Emails") plus "First send" and the
   same Waiting/Watch lines as the trial variant.
2. `disposition_sheet` — one row per booking: company · date · showed ·
   right fit · outcome, and a tap link (Stage C's `/c/[token]/tap`).
3. `decision_link` / `decision_link_zero` — the zero version opens with the §8
   "lead with the number" line; the normal one names the bonus and the
   warm-domain urgency (§6 rules).
4. `talk_ack`, `extension_notice` (built from §7 "The extension" bullets),
   `ladder_33` (+ `ladder_33_quote` when a quote is waiting), `ladder_37`,
   `handover`, `invoice_month1`, `invoice_reminder`.
5. `winback_90` — the Offboarding SOP step-6 line, with the doc's "[X]" filled
   from the new setting `WINBACK_TEXT.whatsNew` (held + `config_missing`
   until set) and the trial doc's "The list has moved on and we'd rebuild.
   Same offer, same price." The SOP's "your old system is archived, not
   deleted" is dropped: for a trial it is not true (data is deleted).
6. Every client email is signed `{ownerName}` = `OWNER.signerName`. While
   that is unset every Stage D client email is held and the owner gets
   `config_missing` (never a blank signature).
7. Trial Report "Call: [Day 30 date, time]" became "Your Day 30 page: {link}"
   (SPEC §16 #8: the Day 30 call is replaced by the decision page).

## Numbers and rules

8. **Friday running total** is qualified calls ("running total: N qualified —
   promise 1, target 3"); the doc's example is ambiguous between booked and
   qualified and the promise is about qualified calls.
9. **Friday "this week" numbers** = the last 7 ET days of day counters,
   summed; allowed only when `counters:total` has every field (rule 4).
   Reply % with no sends prints "n/a", never 0%.
10. **Watch line**: the metric furthest past its line wins: bounce vs
    `DIAGNOSIS.bounceMax` (2%), placement vs `DIAGNOSIS.placementMin` (85%),
    inbox rate vs `WARMUP.lowRate` (trial) / `WARMUP.readyRate` (build).
    Over the line → "…Fixing it now."; within 80% of the line → "…Watching
    it." (the doc's example); else "all green".
11. **Personal line** (first `FRIDAY.personalUpdates` = 4 updates), rules in
    order: a positive reply this week (company + weekday) → a booking made
    this week → (build) the warm-up start date → none.
12. **Projections** use `Math.floor(rate × reach)` — the doc's 0.73% example
    gives 14 and 29, which is floor.
13. **Rate text** has two decimals (0.73%); other percentages one decimal.
14. **Capacity missing** with ≥ 3 qualified → Starter with a sentence saying
    no capacity number was given (smallest plan; "step down, never
    discount").
15. **Zero positive after an extension** → no plan, "change the offer or the
    market; we'll check back in 90 days" (§8 third path). Before the
    extension it is "the extension is the recommendation" (§9.3).
16. **Placement** = client hash `canaryPlacement` (fraction or percent). When
    absent the report prints "not measured" — it is not a counter, so it does
    not block the report.
17. **"No-shows re-booked"** = bookings with status `rebooked`, or with
    `rebookAttempts > 0` that ended `held`/`booked`.
18. **"What produced it"** = this client's own best variant by reply rate
    (from lead `sequenceVariant` + replies) and the city with the most
    positive replies; `learning:{niche}` top variant is the fallback. "What
    didn't" = every Pace Check log entry, or "no pace check had to step in".
19. **Market Report** excludes `bounce` "replies" (they are infrastructure)
    and includes `ooo`. Open conversations = interested / question / unclear
    replies whose lead has no booking.
20. **Zero-call diagnosis** walks §7's four questions with
    `DIAGNOSIS` thresholds (bounce 2%, placement 85%, reply 1.5%, positive
    1%, positives→booked 50%) and reports the first that fails.
21. **EXTENSION_CAP (60)** is counted in trial days (calendar days from Day 1),
    matching "30 days + up to 30 more"; the extension ends when
    `trialDay ≥ 60`.
22. **Extension end on a qualified call**: the 09:00 day job that first sees
    `qualified ≥ 1` moves to `deciding` (that is the next morning after the
    call) and sends the final report, the handover and the decision link.
23. **Ladder day** = trial day − (decisionDay − 30), so a trial that decided on
    Day 47 gets its "Day 31" review request on Day 48 and retires on Day 62.
    Days 33/37/44 fire on that exact day; the review request (≥ 31) and the
    exit interview (≥ 33, `not_now` only) catch up if missed.
24. **Ladder messages** go to `deciding` and `not_now`; converted clients get
    only the review request (and testimonial approval).
25. **ladder_37** is skipped (logged) when there are no open conversations —
    nothing is invented to fill it.
26. **testimonial_approval** needs a booking with `quote` and no
    `quoteApprovedAt` (Stage C's Call D capture) and ≥ 1 qualified call;
    never for a zero-call trial (§8 "never ask for a results testimonial").
27. **Decision tokens** live 30 days (the page must work until Day 45 and
    beyond an extension), purposes `decision:report`, `decision:mail`,
    `decision:final` — all accepted by the page. This departs from SPEC
    §14.3's 24 h for decision tokens; the bonus still expires 24 h after the
    decision email.
28. **Start from `not_now`** is allowed until retirement (the state machine
    allows `not_now → converted`); the bonus is honoured only inside the
    24 h window.
29. **Start with no recommended plan** (zero positive) is not offered — only
    Talk / Not now ("never sell a plan off a campaign that produced no
    evidence").
30. **Talk slots**: the next 3 US business days (no federal holidays), at the
    start of `OWNER.usHours` and 3 h later (clipped to 30 min before the
    end). A promise "answer the talk request" is added, due next day.
31. **endedAt** for a not-now trial is the retirement moment (Day 45), so data
    is kept 30 days after the domain is retired; `winbackAt` = endedAt + 90.
32. **Stub after deletion** keeps name, contactName, contactEmail, mainDomain,
    state, plan, createdAt, endedAt, winbackAt(+SentAt), deletedAt — the
    win-back email at +90 needs the contact; ownerNotes and everything else
    are dropped. One `deleted` event is written after the purge.
33. **Early end** (Stage C sets `trial.endReason` + `trial.endedAt`): the day job
    sends the handover (`early_stop`) and retires after
    `DAYJOBS.stopRetireDays` (7). The move to `retired` from a running state is
    a logged forced transition (the state machine has no edge for it).
34. **Invoice number** = `AV-{YYYYMM}-{clientId}`; PayPal line =
    `{paypalMe}/{price}USD`; reminders at `INVOICE.reminderDays` [3, 7]; the
    last reminder also raises `invoice_unpaid` to the owner.
35. **Plan-mode shopping list** (`PLAN_SHOPPING`): Starter 13 domains / 26
    inboxes (spec). Growth and Scale are null until the owner fills them in
    from the cost model.
36. **Health colour**: "behind pace" = Day ≥ 15 in sending/paused/extension
    with 0 qualified; "client quiet" = `trial.lastClientEmailAt` (or
    `lastClientActivityAt`) older than `CLIENT.quietWarnDays` business days.
37. **Time per trial** = minutes the owner logs on the client page ("Log my
    time"), summed per trial; "not measured" when none were logged.
38. **Morning digest** "All green" = no unacknowledged alerts (digests
    excluded) and no promise due today or overdue. Config drift lines are
    appended when overrides differ from the defaults.
39. **Test Mode** simulated replies do not add the owner's addresses to
    `suppression:global` (that would block them for every client).
40. **Disposition sheet** is skipped (logged) when there are no bookings.
41. **Owner alerts added** (templates/owner.js Stage D block): `build_behind`,
    `invoice_unpaid`, `decision_made` (Not now pressed).
