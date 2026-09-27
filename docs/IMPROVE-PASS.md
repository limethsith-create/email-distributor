# Improvement pass — shared contract (2026-09-27)

The owner's words: "Go through the whole system again and improve the
efficiency and the effectiveness. Studying the business of whoever messages
us should be improved. The email sending sequence and the reply bot should
sound like a human. The invite email and the plan email should sound human
and be well monitored. Two calls. Warm-up completely automated from buying.
Then an email saying we start at this time."

No AI at runtime, ever. Improvements are better rules, better words, better
tracking — and every email the client gets must read like one person wrote
it to one person. Three builds, each in its own worktree:

## A. Studying the business (research)
Files: `src/lib/systems/deepsite.js`, `webintel.js`, `bizintel.js`,
`fitsignals.js`, `fitscore.js`, `research.js`; hub `research.deep`.
Add, all free and keyless unless noted:
1. **News** — Google News RSS (`https://news.google.com/rss/search?q="{name}"+{city}`,
   keyless): the last 5 items (title, source, date, link) in `deep.news`;
   a `flags` line when a story mentions layoffs, lawsuit, acquisition,
   funding, new office, award (rules on the titles).
2. **What they talk about** — from the crawled blog/news pages: the 8 most
   frequent meaningful word pairs (stop words out) as `deep.topics`, and
   the posting rhythm ("about 2 posts a month, last one 12 days ago").
3. **Who buys from them** — from testimonials, case-study titles, client
   logos and industry pages: `deep.customers.segments` (industries named,
   counted) and `deep.customers.examples` (up to 8 named clients with the
   page); `deep.customers.line` = one plain sentence ("They mostly serve
   law firms and accounting practices; named clients include …").
4. **Competitors nearby** (only with the Places key): 5 businesses of the
   same category within their city (`deep.competitors`: name, rating,
   reviews, website) — never contacted, only shown on the call.
5. **The research brief** — `research.brief`: 8–12 plain sentences built by
   rules from the facts, for the owner to read before the launch call:
   what they sell, to whom, since when, size, proof, offers they run, what
   their website is missing (no booking link / no case studies / no
   pricing), the two angles to use on the call (from fit-score strengths),
   the risk to raise (from dealbreakers/warnings). Every sentence cites
   its source page in `brief.sources`. Shown at the top of the trial's
   research section and on the launch-call card as "Before the call".
6. **Speed** — the deep crawl runs 5 pages at a time; raise to 8 when the
   site answers fast (median < 800 ms), keep the same page budget; skip
   pages whose sitemap `lastmod` is older than 3 years when the budget is
   short (blog posts first to go).
Tests for each; the journey snapshots regenerated; HUB-API updated.

## B. Sounding human (every client-facing email + the reply bot + the cold sequences)
Files: `src/lib/templates/client/*.js`, `src/lib/templates/sequence/*.json`,
`src/lib/systems/replybot.js` (`REPLYBOT.answers` in config.js),
`src/lib/systems/copycheck.js`, `copy.js`.
Rules for every client email (acceptance, next_steps, launch_invite,
reminders, meeting_*, welcome/Day 1 "we start on …", Friday note, Day 29
report cover, decision, invoice, review ask): first name only in the
greeting; under 120 words unless it carries a report; one ask per email;
no "we're excited", "reach out", "leverage", "seamless", "just checking in",
"circle back", "hope this finds you well"; contractions; the owner's name
as sign-off with no title block; the specific fact that makes it personal
(their company name, the exact date/time in their zone, the number of
companies found); a subject line under 6 words that says the thing
("Your list is ready", "Tuesday 2 pm works"); no exclamation marks.
Reply bot: each answer rewritten in that voice, and two new rules —
`who_are_you` ("who is this / how did you get my email" → one honest line
+ the website) and `later` ("not now / after the holidays" → "no problem,
I'll check back {when}" + stop reminders, remind the owner in N weeks).
Cold sequences (`sequence/*.json`, all niches): rewrite to the same voice —
under 80 words for touch 1, under 50 for follow-ups, one question, a
first line that only fits that company (the existing {FirstLine} facts),
no links in touch 1, a plain opt-out line; copycheck gains a "sounds
like a template" rule (three or more of: "I hope", "I wanted to", "quick
question", "just", "touching base", "!"), and a reading-grade rule (≤ 8).
Add a `tests/voice.test.mjs` that renders every client template and every
sequence with sample vars and asserts the rules above (word counts, banned
phrases, greeting, one question mark max in cold touches).

## C. Well monitored (every email the client gets, and the two milestone emails)
Files: `src/lib/notify.js` (`notifyClient`), `src/lib/mailer.js`,
`src/lib/systems/conversation.js`, `onboardcall.js`, `check-bounces`,
`hubview.js`, templates/owner.js.
1. Every client email records in the conversation entry: `accepted` (SMTP
   accepted), `messageId`, `openedAt` (the existing pixel, extended to all
   client templates), `bouncedAt` + reason (from the bounce checker, matched
   by Message-ID / recipient), `repliedAt` (a reply threads to it).
2. Milestone emails get a **delivery watch**: `accepted_call`, `next_steps`,
   `launch_invite`, `welcome_two_dates` (the "we start on …" email),
   `day1_moved`, `report_day29`, `decision` — if not accepted → retry once
   after 10 min then alert `client_email_failed`; if bounced → alert; if
   not opened within 48 h (business hours) → a to-do "Sam hasn't opened
   the {what} email — call or text them?" (needsYou, quiet alert).
3. The "we start on" email: sent once when Day 1 is fixed (readiness green),
   in their zone, naming the date, the time window, the inbox name they
   will see, and "reply to this email any time"; re-sent automatically if
   Day 1 moves (`day1_moved` already exists — make it the same voice).
4. Hub: each conversation entry shows a small status ("delivered · opened
   Tue 8:10 pm" / "not opened yet" / "bounced"); the trial's big button
   picks up the not-opened to-do.
Tests for each; HUB-API updated.

## D. Warm-up from purchase (audit, not a rebuild)
Walk the path buy → webhook/check → credentials → setup check → warming →
ready → Day 1 in `tests/journey.test.mjs` and list every place a human
hand is still needed or a wait is longer than necessary (e.g. the setup
check waiting for the next tick, the readiness check only nightly, the
canary needing 8 helpers). Fix what is safe: readiness checked at every
warm-up run once past day 12 (not only nightly), the setup check re-run on
the hub's check call, the canary at 4+ members with a note. Report the rest.

### D — as built (2026-09-27, machine side)
Tests: tests/warmup-audit.test.mjs, tests/autobuy.test.mjs (the two setup
tests), tests/journey.test.mjs (Day 1 assertions).

**Fixed (each only shortens a wait; no quota, gate or rule changed)**
- Readiness at every warm-up run (warmup.js `readinessCheckpoint`, end of
  each send / read run, inboxes past day 12): a nightly check the 23:45 run
  missed (a tick-less 15 minutes broke the streak → Day 1 slid ≥ 1 day, 3
  over a weekend) is made up with that day's own window; today's check is
  made once the day's warm-up is over (23:30 ET, the inbox's own send hours
  closed), not only at 23:45; the Day 1 gate runs right after the check that
  makes a trial's last inbox ready (also from the nightly run) — a held Day 1
  moves a day sooner; the journey's trial is `ready` the evening before Day 1.
  `estimateReadyBy` keeps a passing streak alive across a made-up check;
  `simple.next` gives the real first-emails day when a measured `readyBy` is
  on or after Day 1 (hubview.js, one marked block).
- Setup check without the heartbeat: a failed round of a CheapInboxes
  purchase is re-run by the sync (the hub's check, a webhook) once per clock
  hour under the setup-check job's own claim — before, it waited for a tick,
  and none runs before warm-up. With the key forgotten mid-setup, carry.js
  runs it.
- The canary never needed 8 helpers (it ran with one); it needed *helpers*:
  a circle of other inboxes (the owner's, other trials') held Day 1 with
  `canary_incomplete`. Seeds are now helpers first, then circle members on
  another domain (never the trial's own), up to `BUILD.canaryHelpers`; the
  result (and the seed entry's `detail[0]`, the gate's `checks.canary.note`)
  carries a plain note when fewer than usual, not all helpers, one filter
  only, or under 4 ("one email in spam moves the rate a lot"). No new floor:
  a 4-seed minimum would hold Day 1 where it passes today.

**Left as they are**
- Safety rules: 14 warm-up days; ≥ 90 % on 2 consecutive daily checks; the
  quota ramp (3 / 8 / 15); the canary ≥ 85 % per inbox and the spam test from
  Day −3, once a day each (a same-day retry would fish for a pass); Day 1
  slides at its 00:30 run (the client is told then) and a held Day 1 never
  restarts the same day (under 9 hours' notice).
- Human hands by design: buying the domain + inboxes (the machine never
  spends); making the warm-up helpers (the machine never creates accounts;
  `waiting_for_helpers` under 8 members is the SPEC's minimum); starting the
  heartbeat (cron-job.org) before warm-up; a DNS fix a failed check names
  (manual path); the client's "It worked" booking test (from Day −4) and the
  launch call / approval (docs/LAUNCH-CALL.md).
- Vendor / tool waits: CheapInboxes 10 min–48 h to provision; mail-tester's
  3 tests a day across all trials (dkimvalidator is the default).
- A failed setup round is retried hourly (the owner-facing texts say "every
  hour"; the owner's "re-run" button runs it at once).
- **Safety gap found, not fixed (it lengthens a wait — needs a decision):**
  warm-up day 1 is the setup-pass day, so the 14 days also count while the
  circle is short (the trial's two inboxes share a domain and never pair) or
  the heartbeat is not running yet; a trial whose helpers come late can
  reach "day 14" with a few real warm-up days, and its first real day starts
  at that day's quota (e.g. 15). Suggested: start `warmupStartedAt` at the
  first warm-up email actually sent.

## Integration (2026-09-27, after A–D merged)

- **The warm-up gap above — decided and fixed.** The setup check marks each
  new inbox `warmupAwaitingFirstSend: '1'`; until its first warm-up email
  really goes out it is on warm-up day 1 (day-1 quota), and that first send
  (a new mail or a reply, `noteFirstWarmupSend` in warmup.js) moves
  `warmupStartedAt` to that day (`warmupStartMovedFrom` keeps the old one,
  `warmupFirstSentAt` the moment). The 14 days and the ramp count only days
  that warmed. Inboxes from before the mark and Test Mode are left as they
  were. Test: warmup-audit "warm-up day 1 is the first day …".
- **The seed test's small sample.** A run tests each inbox with a handful of
  emails (often 8), so one normal day reads 6 of 8 = 75 %. Two changes, no
  line moved:
  - the urgent `placement_low` needs the whole run under `CANARY.warn`, or
    an inbox under it today AND on its last canary day, or an inbox under
    `CANARY.emergency` with ≥ 3 emails missing (`placementLow`); a one-day
    dip of one inbox is logged (`canary` / `dip`) and shown in the
    placement history, not alerted;
  - the Day 1 gate pools the latest run with the one before it (`gateCanary`,
    `priorCanary`): every inbox and the whole run ≥ `CANARY.gate` over both,
    and no inbox under `CANARY.emergency` in the latest run alone. With one
    run (Day −3) it is as strict as before. `checks.canary` gains
    `pooledWith` (the earlier run's day or null) and `pooledMin`.
  The journey showed both: a one-inbox 6-of-8 day slid Day 1 and emailed
  the client "first send moves".
- **The "we start on" email** (`welcome_two_dates`, now sent when Day 1 is
  fixed): subject "We start on {day1Date}"; the start in their zone
  (`startWhen`), the name and inboxes the prospects see, the send window,
  Day 30, the Friday note, "Reply to this email any time". `day1_moved`
  names `startWhen` and uses the same date format; `setup_in_progress` no
  longer promises a "two dates" email at the setup check.
- Voice notes applied: the call fallback subjects ("Let's book your
  onboarding call", "Your list is ready") and the next-steps opening.
- Brief wording: no "schema.org" or Census table codes (the source is the
  Census survey page), "it mentions a new office", names keep their capitals
  in the topics ("Microsoft 365").
- The journey's clock runs forward at every step (15 → 16, 27 → 28).
