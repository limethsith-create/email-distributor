# Stage B (build systems) — assumptions

Where SPEC §7 left a value or wording open, this is what the code does and
where to change it. Config values live in `src/lib/config.js` under `BUILD`
(Stage B block) unless named otherwise.

## Hand-off fields other stages read or write

| Field | Written by | Read by | Meaning |
|---|---|---|---|
| `client:{id}.emergencyActive` = `'1'` | Stage C (Emergency Runner) | Ramp Planner | every inbox cap = 0 |
| `client:{id}.emergencyHalved` = `'1'` | Stage C (Emergency Runner) | Ramp Planner | every inbox cap halved |
| `client:{id}.emergencyRequested` = `'canary'` (+ `emergencyRequestedAt`) | Canary (only while `sending`/`extension`, when any inbox < `CANARY.emergency`) | Stage C (Emergency Runner) | please run the emergency sequence |
| `client:{id}.canaryPlacement`, `canaryMinPlacement`, `canaryDay` | Canary | Stage C/D, board | overall and lowest-inbox placement of the last canary |
| `inbox:{id}:{email}.dailyCap`, `rampStage`, `rampReasons` | Ramp Planner (00:05 ET) | Stage C Sender | today's cold cap (≤ 25) |
| `inbox.capOverride` | owner (Inboxes page) | Ramp Planner | the owner may lower a cap, never raise it above 25 |
| `inbox.inboxRate7d`, `readyStreak`, `readyCheckedDay`, `warmupReady` | Warm-up Engine | Ramp Planner, readiness gate | warm-up placement and readiness |
| `inbox.warmupEnabled` = `'0'` | owner | Warm-up Engine | take an inbox out of warm-up (default in) |
| `inbox.tz` | optional | Warm-up Engine | the sender's tz for the 07:00–22:00 window (default America/New_York) |
| `client:{id}:sequence` `variantA`/`variantB` | Copy Engine / owner edit | Stage C Sender | same shape as `default.json` + `variantId`, `firstLineSet` |
| `lead.sequenceVariant` A/B, `tz`, `riskLevel`, `score`, `dreamMatch`, `isRole`, `types`, `campaign: 'trial'` | Lead Finder webhook | Stage C | see CONTRACTS lead record |

**Stage C must fill `{FirstLine}`.** The personalised first line depends on the
lead's Places `types` and city, so it is computed at send time:
`leadVars(lead, variant)` from `src/lib/systems/copy.js` returns
`{FirstName, Company, City, FirstLine}` — the only slots left in a stored
variant (every client-level slot is filled at build time, so the client
approves the real text). `sequence.js#varsFor` does not know `FirstLine`.

## Warm-up Engine (`systems/warmup.js`)

1. **Marker secret**: `WARMUP_SECRET`, falling back to `ENC_KEY`, then `CRON_SECRET`. Without one, warm-up does not send and alerts `config_missing`. Changing the secret makes older marked mails unrecognisable to the reader (they are then ignored, not counted).
2. **Marker format**: `X-Aviance-Warm: {nonce}~{hmac32}`; nonce `w.{rand}` for warm-up, `c.{clientId}.{day}.{rand}` for the canary. `isWarmupMessage()` accepts both.
3. **Placement is counted for the sender** (the mailbox that sent the mail): it is the sender's reputation being measured. Reader-side counts are only used for the pool page.
4. **Helper quota**: helpers send like a 15+ day inbox (`BUILD.warmupHelperQuota` = 8).
5. **Receive cap**: one member receives at most `BUILD.warmupReceiveCap` (30) warm-up mails a day so helpers are not flooded.
6. **Pairing preference**: client inboxes send first; the receiver is scored +4 for a different provider, +2 for a different client; same domain never pairs; a pair (either direction) is used once per ET day (`warmup:pair:{date}`, claimed with HSETNX before sending).
7. **Replies** count as warm-up sends of the replying mailbox and are capped by the 15/day hard ceiling. Only replies to pool members.
8. **Read cadence**: the job is due every 5 min (15 min when the Redis usage throttle is on); each run reads at most `BUILD.warmupReadPerRun` (2) mailboxes whose last read is ≥ 30 min old, oldest first. With the minimum pool (8) every mailbox is read about every 30 min.
9. **Rescue**: in the spam folder → `\Seen` + `$NotJunk`/`NotJunk` keywords where the server accepts them → move to INBOX (counts `warmupSpam` + `warmupRescued`). In INBOX → `\Seen`, 30 % `\Flagged`, 40 % reply, then moved to the `\All` (Gmail All Mail) or `\Archive` folder. A server with neither keeps the mail in INBOX, marked read.
10. **Readiness check** runs daily at 23:45 ET (`warmup-daily`), so "two consecutive daily checks" are two calendar days. A day with no observed landings is a fail (rate null), never a pass.
11. **Inboxes without `warmupStartedAt`** are not in the pool (Stage A sets it on entering `warming`).

## Canary (`systems/canary.js`)

12. **Runs from Day −3 (the gate) onwards**, daily from 07:30 ET, not during early warm-up: ten extra mails a day would break the Day 1–3 quota of 3.
13. **placement = inbox landings / canary mails sent to helpers that could be read.** A mail that never arrived counts against placement; a helper whose IMAP failed is left out of both sides (and the run gives up after `BUILD.canaryGiveUpMin` = 180 min).
14. Canary mails count toward the inbox's 15/day warm-up ceiling; when the ceiling leaves less room than 10 helpers, fewer are used.
15. `placement_low` fires when the overall or any inbox is below `CANARY.warn`.

## Ramp Planner (`systems/ramp.js`)

16. **"Sending day"** = US business days (Mon–Fri, not a federal holiday) from `day1Date` to today inclusive; before Day 1 the cap is 0.
17. "Bounces yesterday > 2 %" uses the client's counters for yesterday (`bounces / sent`, only when `sent > 0`); it halves every inbox of the client.
18. Modifiers stack (each halves, rounded down).

## Lead Finder (`.github/workflows/leadfinder.yml`, `scripts/leadfinder/`, `systems/leadfinder.js`)

19. **Query grid**: `{industry keyword} in {city}, {state}` for the first three industry keywords × every city. The "5 largest zips per city" part needs zip data we do not have for free; zip queries run only when the profile has `zips: {city: [zip…]}`.
20. **Overpass fallback**: one query per city (office/shop/craft/name tag matching the keyword, with a website), 1 request / 5 s. The Geofabrik-extract path (> 500 requests) is **not built** — per-city Overpass stays far below that.
21. **Places budget stop** at `BUILD.placesStopRatio` (80 %) of `PLACES.monthlyEnterprise`, using the Usage Meter count the app hands to the job; the job reports the requests it made in every batch post and the app counts them (`countUsage('places','enterprise',n)`).
22. **Reoon**: the app hands the job today's remaining free credits (`REOON.dailyFree` − used today, counted per ET day in `usage:reoon-day:{day}`); used only for guessed and role addresses. Found addresses: `mailto:` → `safe` after MX; anything else not Reoon-checked → `risky`. No credits left for a guess → `first@` kept as `risky`. Catch-all → `first@` + `catchall`.
23. **Contact choice**: named person with an approved title → named person → personal address on the host → role address (`info@`/`hello@`/`contact@` first) → any address found.
24. **dreamMatch** counts a dream customer only on facts recorded for it (`industry` keyword, `state`, `sizeBand` on `profile.dreamCustomers[]`); a dream with none of those never matches.
25. **Cross-client fairness**: `leadhosts:{niche}:{month}` records which client took a host this month; the job asks `POST /api/webhooks/leadfinder {type:'hosts'}` before crawling and the webhook re-checks before insert.
26. **Refill**: daily 02:00 ET when unsent < `LIST.refillBelow`, asking for `BUILD.refillNeed` (100) contacts; not within `BUILD.refillMinHoursBetween` (20 h) of the last run; skipped while `throttle:places` is set.
27. **Short list**: after an initial run with unsent < `LIST.need`, one widened run (adjacent states, static neighbour table in `scripts/leadfinder/lib.mjs`); still short → `list_short`. `listReady()` = unsent ≥ `LIST.startMin`.
28. **Rejected batch**: the webhook answers `{stop: true}` so the running job ends, and re-dispatches once per run with the failing pattern (titles, Places types, hosts, "state required") stored in `client:{id}:leadfinder.exclude`.
29. **Failure reporting**: the script posts `{type:'failed'}` itself; `leadfinder-watch.yml` (on `workflow_run`) posts to `/api/webhooks/github` with `Bearer GITHUB_WEBHOOK_SECRET` when a run did not succeed (a GitHub repo webhook with the same secret and `X-Hub-Signature-256` also works). The run title `leadfinder {clientId} {mode}` identifies the client.
30. **Sanity rows** shown on the approval page are the sample from the latest accepted batch until the approval link is sent, then frozen.

## Sanity Check (`systems/sanity.js`)

31. "Size band plausible": fails when Places `types` name a large organisation (hospital, university, airport, mall, supermarket, government office, …) or the crawled employee hint is below half the band minimum or above twice the maximum. Rows without either signal pass.
32. Title check uses substring matching both ways against the approved titles; an excluded title fails.

## Blocklist Keeper (`systems/blocklist.js`)

33. Company names are stored as `name:{normalised name}` (lower case, no punctuation or legal suffix). Places confirms a name with the cheap mask `places.id,places.displayName` (no website field, so no Enterprise charge); the canonical display name is stored too. A name therefore blocks by company-name match, not by domain.

## Copy Engine + Copy Checker (`systems/copy.js`, `systems/copycheck.js`)

34. **Client-facing copy is new wording.** `templates/sequence/msp.json` and `trial-default.json` follow Sequence T's structure (plain text, no links in email 1, one reply CTA, four touches) but are written for the client's own offer. The approval page is the client's review; the owner edits in Mission Control (`/mc/clients/{id}/sequence`) when a change is requested. **The owner should read both templates once before the first trial.**
35. **Niche choice**: `profile.niche` if it names a template, else `msp` when industry/sellsTo mentions MSP / managed IT / IT support, else `trial-default`.
36. Client-level slots: `ClientCompany` = `profile.companyName` or the client name; `oneLiner` = `profile.oneLiner` or `profile.sellsTo`; `niche` = `profile.defaultNiche` / `industry`; `ICP` = `profile.defaultIcp` / `icp`. A missing one blocks the build (`copy_blocked`), never a blank.
37. **First-line table**: 19 Places-type rules + 1 fallback ("local businesses") = 20 patterns, four phrasing sets (A, B for the main variants; C, D for the Pace Check backup), each with a city and a no-city form.
38. **Backup files** (`{niche}.backup.json`) change only the Day 0 subject and the first-line set. `buildBackupVariants(clientId)` returns them filled for the client (Stage C's Day 7 Pace Check).
39. **Learning seeding**: `learning:{niche}` variant ids must match template variant ids (`msp-a1`, `msp-b1`, …). Ranking by positive rate, then reply rate, over variants with ≥ 50 sends.
40. **CTA rule**: the "CTA sentence" is the body's last paragraph (the templates keep the ask on its own line); it must contain exactly one "?".
41. **ALL-CAPS rule**: any all-caps word longer than two letters fails, except a short allow-list of business acronyms (MSP, CEO, HVAC, CPA, LLC, …). "IT", "US" and state codes are two letters and pass.
42. **URL rule** also catches bare domains (`acme.com`) in email 1.
43. `config/spamwords.txt` is a starting list; edit freely.

## Approval page (`systems/approval.js`, `/c/{token}/approve`)

44. Three sections — profile, list, copy — each approved separately; all three approved = `approvalMode: click`.
45. A change request on any section uses one of the 2 rounds; after 2 rounds the page no longer takes change requests ("the owner's version stands") and only Approve remains.
46. The approval token lives 28 days and is stored encrypted so reminders reuse the same link.
47. Silence: 48 h after the Day −3 reminder with no click since that reminder → approved by silence. The "silence date" in the emails is the calendar day that falls on.
48. **Email wording** (`templates/client/stage-b.js`: approval_link, approval_reminder, approval_updated, approved_by_silence, day1_moved) is new — the owner's docs approve the copy on a live call, which the spec replaced. Signed with `OWNER.signerName`, or "The Aviance team" until that is set.

## Readiness gate (`systems/readiness.js`)

49. Checked hourly from 10:00 ET while `warming`; promotion to `ready` can happen on any check. A slide happens at most once per ET day, from Day −1 on.
50. A failed Day −3 canary does not slide Day 1 on Day −3; the gate simply stays red, and the slide happens on Day −1 if the Day −2 / −1 canaries have not recovered.
51. Day 30 moves with Day 1 (`day30Date = day1Date + 29`); the original date is kept in `trial.day1Original`.
52. After `WARMUP.maxSlideDays` (7) slides Day 1 is **held** (`trial.day1Held = 1`, daily `warmup_stalled`, no further client emails); when the gate turns green Day 1 is set to the next US sending day and the client gets `day1_moved`.
