# Integration pass — assumptions and decisions (2026-09-24)

The four stages were built in parallel and met for the first time here. This
file lists every value or behaviour the integration had to decide, and the
Redis budget measurement. Stage-specific assumptions stay in
`stage-a.md` … `stage-d.md`.

## Seams fixed

1. **Sender ↔ Copy Engine.** Stage B stores variants with only the lead slots
   left (`{FirstName} {Company} {City} {FirstLine}`); the Sender fills them
   with `copy.leadVars(lead, variant)` (the first line comes from the lead's
   Places types + city and the variant's first-line set) and runs Stage B's
   `copycheck.checkEmail` directly (the adapter is gone).
2. **Copy Checker verdict per lead.** When the email about to go out fails,
   the same touch is rendered for a plain sample lead. Sample passes → the
   lead's own values broke it (e.g. a company name that is a bare domain,
   which fails "no links in email 1"): that lead is skipped and logged.
   Sample fails too → the copy is at fault: the client is held and the owner
   gets `copy_blocked` (as before).
3. **Pace Day 7 backup copy** comes from `copy.buildBackupVariants(clientId)`
   (client slots filled). A missing profile value → `copy_blocked`, nothing
   changes (the old code stored the raw template with `@variant` subjects).
4. **Warm-up skip in the Reply Handler**: `warmup.isWarmupMessage`; a marker
   header signed with an older secret still counts as warm-up traffic.
5. **Emergency Runner step 3/4**: `leadfinder.deepVerify` (Reoon inside the
   20 free checks a day, shared with the Lead Finder; new `ext/reoon.js`),
   `leadfinder.requestRefill` (skipped while a run is going) and
   `pricescout.replacementShoppingList` (the burned domain is excluded).
6. **Onboarding submit → Blocklist Keeper**: accepting the agreement runs
   `blocklist.addBlocklistInput` over every pasted customer/competitor,
   including bare names (Places IDs-only lookup).
7. **Copy fields on the onboarding form**: new required `defaultNiche`
   ("what you offer, 2–4 words") and `defaultIcp` ("your customers, plural").
   `sellsTo` stays the `{oneLiner}` and goes into the emails as written.
8. **Readiness gate** also needs `profile.bookingTested` (SPEC §6.7 step 4).
9. **Day 1 no longer always slides.** Warm-up readiness is decided by the
   23:45 daily check, and Day 1 = signed + 14 is the first day a 14-day
   warm-up can pass — so the Day −1 slide check (before that last warm-up
   check) moved every trial's Day 1 by a day. The gate now runs hourly from
   00:30 and decides a slide on the morning of Day 1; green on Day 1 itself
   starts sending that day. The `day1_moved` email therefore goes out on the
   morning of the original Day 1 instead of Day −1.
10. **`converted` keeps sending** on the trial pair (SPEC §9.8):
    `SENDING_STATES` includes it; warm-up, canary, ramp, refills, bounce
    scans and the Emergency Runner keep running. A converted client is never
    moved to `paused` (it is a paying plan, not a trial): Auth Guard sets a
    `sendHold` flag and the Emergency Runner uses `emergencyActive`; the
    Sender honours both. The owner clears a send hold on the client page.
11. **Legal hold** is Stage C's `client.legalHoldAt`; clearing it does not
    change state (the hold never did).
12. **Tap links**: purpose `tap:{bookingId}`; both minters set
    `data.bookingId`, and the tap API also reads the id from the purpose.
    One token per purpose per client: a newer link (tap reminder, disposition
    sheet) replaces the older one.
13. **Early end**: Stop the trial's `trial.retireAt` is honoured; Client
    Watch's quiet end retires `DAYJOBS.stopRetireDays` (7) after `endedAt`.
14. **Exit interview** goes from the trial inbox so the answer reaches the
    Reply Handler (`kind: exit` → `trial.exitReason`); without a usable trial
    inbox it falls back to the owner inbox (logged, answer then read by hand).
15. **Client buttons** (customer hit / away / stop) ride under the Day 1
    notice and every trial-week Friday update (not counted in the 120 words).
16. **`trial.lastClientEmailAt`** is written by the Reply Handler for any
    mail from a client address; `booking.quoteAt` with the quote.
17. **Test Mode clock**: every client job of Stages A–C runs through
    `onClientClock` (due/run see `clientNow(client, now)`). Warm-up age uses
    the client clock and a `warmup-daily-scaled` job checks readiness once per
    virtual day for a scaled client. Test Mode "start from apply" now runs
    the Gatekeeper (pre-approved, over the cap).
18. **Unsubscribe** adds to `suppression:global` (all clients) as well as the
    legacy aviance set.
19. **Job names** are unique; the aviance engine's are `aviance-send`,
    `aviance-replies`, `aviance-eod-report` and refuse any other client even
    when forced.
20. **Morning digest** leads with "NOT BOUGHT" lines (Price Scout escalation,
    `shopping.escalatedAt`) and "Booking link untested" lines (request sent
    or problems found, not yet confirmed). Both make the digest non-green.

## Redis budget (Upstash free tier: 500k commands / month)

**Method.** `tests/redis-budget.test.mjs` runs the real scheduler minute by
minute over a US weekday (Tue) and a weekend day (Sat), with cron-job.org
every minute (or every 2) and GitHub every 5 minutes, all network stubbed,
warm-up mail really "arriving" (8 helper accounts), and counts every KV
command, pipelined ones included. Each sending client has 2 inboxes at the
25/day cap, 300 leads, and a hot lead already in (so the booking watcher,
reminders, no-show ladder and chaser poll too — the worst case). Month =
21.7 weekdays + 8.7 weekend days. The config memo is off in the
measurement (one config read per tick — a warm serverless instance does
better), so the numbers are conservative. The legacy aviance engine
(`aviance-send` every minute in US hours) is **not** included.

| Scenario | Weekday | Weekend | Month | Before this pass |
| --- | ---: | ---: | ---: | ---: |
| idle (no trial client) | 4,777 | 4,783 | **145k** | 1,041k |
| 1 client sending, 1-min ticks | 15,055 | 11,941 | **431k** | 2,847k |
| 1 client, 2-min ticks | 11,946 | 8,798 | **336k** | — |
| 2 clients, 1-min ticks | 22,572 | 15,931 | **628k** | — |
| 2 clients, 2-min ticks | 18,576 | 12,334 | **510k** | — |
| 3 clients, 1-min ticks | 29,528 | 19,859 | **814k** | 6,342k |
| 3 clients, 2-min ticks | 24,927 | 15,443 | **675k** | — |

**Per tick (1-min, 3 clients):** heartbeat read 1 + client hashes 3 +
config snapshot 1 + heartbeat write 1 ≈ 6 commands before any job works
(≈ 8.6k/day). Then, per weekday for 3 clients: sending ≈ 5.6k (150 emails,
~37 commands each), warm-up send + read ≈ 5k, reply scans ≈ 2.5k (every inbox
every 5 min in US hours), booking scans ≈ 1.6k, emergency ≈ 1.2k, canary,
reminders, client watch, no-show, chaser ≈ 2k.

**Choices made (all in code, each named in the commit):**

- Scheduler bookkeeping (`jp:`/`jl:`/`je:` fields) lives in the client hash /
  heartbeat hash the tick reads anyway, written once per client per tick; a
  job whose period is already recorded costs nothing. This alone removed the
  "claim every tick" cost of every daily/bucketed job.
- GitHub backup tick exits after one read while cron-job.org is fresh
  (< 150 s).
- Client ids and resting clients (declined / closed_silent) are kept on the
  heartbeat hash: no SMEMBERS per tick, resting clients never loaded.
- `cfg()` inside a tick reads one snapshot of the override hash (plus a
  client's own overrides only when it has any); 60-second memo on a warm
  instance. Throttle flags, the DMARC backlog flag and the Test Mode
  heartbeat-loss flag ride on the heartbeat hash.
- Send job: due only when `client.sendNextDueAt` (from pacing / caps / "no
  lead in window yet", 10 min) has passed.
- Replies: every inbox every 5 min in US business hours (staggered per
  client), 20 min otherwise; an empty scan writes nothing; hot-lead chaser
  and soft nudges moved to an hourly job. **Spec says every tick** — the
  reply → `reply_interested` latency is now ≤ 5 min instead of ≤ 1 min.
- Emergency Runner: requests (canary, smoke test, pace) still act every
  tick; the full trigger scan runs 15 min after new sends and daily at noon
  (no-reply and green-day checks). **Spec says every tick.**
- Booking watcher / reminders / no-show / chaser start after the first hot
  lead (`client.bookingWatch`); bookings every 15 min in US hours, hourly
  otherwise; reminders every 15 min.
- Warm-up rests when no client inbox is in the circle; sends every 20 min
  (5 pairs), reads every 15 min (up to 6 mailboxes, 06:00–23:30 ET), a day
  roll-up hash replaces one read per member; helper records memoised a
  minute. Each mailbox is still read about every 30 min.
- Hot path: one inbox read per send run, the lead written back without a
  re-read, blocklist check in 2 commands, counter TTL once a day, learning
  roll-up not per send, inbox-health success at most every 30 min.

**Where that leaves us.** One trial fits the free tier at 1-minute ticks;
two fit at 2-minute ticks (~510k, just over); three fully-sending trials do
not fit (~675k at 2-minute ticks, ~814k at 1-minute). Levers left, for the
owner to choose (none is applied, because each changes a spec value):

1. cron-job.org every 2 minutes (saves ~140k/month at 3 clients; sending
   and reply latency are paced in 5–60 minute steps anyway).
2. Reply scans every 10 min in US hours (≈ −40k/month at 3 clients).
3. Fewer warm-up helpers / less warm-up traffic after Day 1 (≈ −2k/day).
4. A Lua script that loads the heartbeat + every client hash in one call
   (Upstash may bill a script as one command — **not verified**, check the
   Upstash pricing page before relying on it).
5. Upstash pay-as-you-go ($0.20 per 100k) — spend, which SPEC §1 rule 2
   rules out unless the owner decides otherwise.

The legacy aviance engine (`/api/cron/auto-send` every minute in US hours)
reads the whole aviance lead list every run and is outside these numbers;
measure it with the Usage Meter (Upstash management API keys) once live.

## Tick budget (20 s)

Every job that emails, calls an API or opens IMAP/DNS now has a
`minBudgetMs` (set in `src/lib/jobs.js` where a stage file had none), so a
late start cannot run past cron-job.org's 30-second cut-off. The not-now
follow-ups stop at the deadline and continue hourly until 11:59 ET.

## Acceptance test (SPEC §15 Phase 6)

`tests/full-run.test.mjs` runs `_test` from apply to Start plan (run 1) and
through the extension to retirement (run 2). The test plays the client and
the owner: fills the onboarding form, signs, pastes the logins, posts the
Lead Finder batches, approves the copy, confirms the booking test, answers
hot leads in thread, taps Showed, presses Start. A trickle of "no thanks"
replies (one per weekday) keeps the Emergency Runner's no-reply trigger
quiet; without it the run shows a real emergency on Day 5 (spec behaviour:
two business days with no reply on a campaign that had replies).
Timestamps inside the event log are real time (only the order is compared).
