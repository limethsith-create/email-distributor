# Stage A (intake) — assumptions

Where SPEC §6 left a value or wording open, this is what the code does and
where to change it.

## Gatekeeper (`systems/gatekeeper.js`)

1. **Fit rules** are the §6.1 list plus two items from the trial doc's fit
   gate (§2) that are application answers: *US-based* and *three dream
   customers named*. Order = table order in `FIT_RULES`; the first failure is
   the reason in `decline_fit`.
2. **Agency check** matches `INTAKE.agencyKeywords` (config) against the
   website `<title>` + meta description + company name + free-text notes.
3. **One trial per company**: any earlier client with the same `mainDomain`
   blocks, including `deleted` — except records that never had a trial
   (`declined`, `closed_silent`). A fit-declined company can re-apply later.
   Lookup = scan of `clients` plus the `intake:maindomains` index.
4. **Owner "New client"** (`POST /api/mc/clients/new`) skips the fit rules
   only. Repeat, cap and "no new trials during an extension" still apply
   unless `override: true` is sent.
5. **Queue expected date** for position *n* = the *n*-th earliest `day30Date`
   among active trials + `QUEUE.expectedExtraDays` (16). No date known → the
   email says so instead of guessing.
6. **Queue pops** on `closed_silent` (spec) and daily at 10:05 ET (so a slot
   freed by any Stage D ending is used next morning). Owner *Promote* on
   `/mc/queue` overrides the cap after a confirmation.
7. **Double submit**: the same domain within `INTAKE.applyClaimSeconds` (600 s)
   is acknowledged but not decided twice. `/api/apply` also has a honeypot and
   `INTAKE.applyPerHourPerIp` (5); the IP is stored hashed only.
8. **Promise "answer within 1 business day"** is recorded as done for every
   decision (onboarding, queue, decline), not only onboarding.
9. **Sign-off name** on every Stage A client email is `OWNER.signerName`.
   While it is not set, emails are held and `config_missing` is raised
   (and for Gatekeeper decisions, `gatekeeper_error`).

## Onboarding page (`systems/onboarding.js`, `/c/[token]/onboard`)

10. **Reminder links**: each reminder mints a new token under purpose
    `onboarding:r{day}` so the original link keeps working (only hashes are
    stored, so an old raw link cannot be re-sent).
11. **A client who has signed is never closed silent** (it is waiting on the
    Market Counter, not silent).
12. **Profile storage**: arrays are JSON strings; `industry` is kept as typed
    and split into `industryKeywords`. Extra fields beyond §3:
    `companyName, hotLeadEmail, suppressCustomers, competitors, suppressNames,
    awayDates`. Cities split on lines only ("Dallas, TX" keeps its comma).
13. **Blocklist**: pasted domains/emails go to `client:{id}:blocklist` at once;
    bare company names are kept in `profile.suppressNames` for Stage B's
    Blocklist Keeper to resolve (Places lookup).
14. **Required fields** before signing: everything in `FIELDS` marked
    required, plus at least one city or state.
15. **Agreement** is Section 9 verbatim with `[Company]`, `[date]`, the owner's
    US hours and signer filled. Clauses 3 and 7 still mention the kickoff call
    and the day-30 call although SPEC §16 #8/#9 replace them with pages — the
    owner (and a lawyer) should update that wording; code does not change a
    legal text on its own. The client also types a title (for "Name, title,
    date"). The accepted text, its SHA-256 and a version stamp are stored in
    `client:{id}:trial`.
16. Server-side fetches of user-supplied URLs (calendar link, website) are
    refused for non-public hosts (localhost, private IPs, `.internal`).

## Market Counter (`systems/market.js`)

17. **Queries** = industry keyword × location, round-robin, cities first then
    whole states, 3–5 queries (`MARKET.queriesMin/Max`), up to 60 ids each.
18. **Coverage factor 3 applies to Places only** (it compensates Places' 60-id
    cap). The Overpass fallback is a real count per state and uses
    `MARKET.overpassFactor` (1).
19. **Widening** = land-border neighbours of the target states
    (`systems/usgeo.js`), once; ids/counts from the first round are kept.
20. Both sources failing → `market_unavailable` alert, state unchanged,
    retried hourly. A market decline emails `decline_market` at once (spec);
    the owner's override afterwards forces `declined → awaiting_purchase`
    and the owner talks to the client personally.

## Price Scout (`systems/pricescout.js`)

21. **Static prices** (Inbox Provider Research, 10 Sep 2026): Cloudflare .com
    $10.44; Porkbun .com $10.99 is only the fallback when the live pricing API
    fails (it is the research's renewal figure) and is marked unconfirmed.
    Spaceship has no published figure in the owner's files → `null`, not used
    until the owner enters one. `.net`/`.co` static prices are `null`.
22. **Inbox providers**: Premium Inboxes, InboxKit, CheapInboxes $3.50 (app
    passwords allowed — admin access stated); Zapmail $3.90 (min 10) and
    ColdInfra $3.00 (min 10) are excluded by min order; Hypertide $3.30 is
    excluded because admin/app-password access is not stated. Ties are
    broken by the research's ranking.
23. **Total** = domain first year + 2 inboxes × one month.
24. **Sender addresses**: `{senderPrefix}@domain` and `{first initial}{last
    name}@domain` (else `first.last`).
25. **Availability**: Porkbun `checkDomain` when keys exist, else RDAP
    (`404` = free); names are checked in candidate order until chosen + 2
    backups are found. Unknown availability is used last and flagged.
26. **Auto-Buyer** uses the endpoints named in the spec (`/user/balance`,
    `/domain/create` with `dryRun`) plus Porkbun's `/domain/updateAutoRenew`
    (the spec's "setAutoRenew"). These are unverified against a live account;
    any error falls back to the manual list with `autobuy_failed`.
27. **Nudges**: one reminder at 12 h, one escalation at 48 h
    (`shopping.escalatedAt` is set for the morning digest's top line).
28. **Monthly job** (1st of the month, 09:00 ET): alerts `promo_expired` per
    expired promo and refreshes the Cloudflare .com price from tld-list.com
    into the price cache (static table kept if parsing fails).

## Purchase page + Setup Checker + Auth Guard

29. Purchase requires the auto-renew-off tick and a 16-letter Google app
    password per inbox; re-pasting replaces the inbox set (fixes typos) and is
    allowed in `setup_check`.
30. **Loopback**: inbox 1 → inbox 2 (to itself if only one). A message found
    without an `Authentication-Results` header passes (Google often omits it
    for same-domain delivery); found in spam still passes with a note.
31. **DKIM fix text** points to Google Admin (the key value is generated
    there, so it cannot be named in advance). MX fix is `1 smtp.google.com`.
    DMARC collector = `AUTH.dmarcCollector`, else the `DMARC_INBOX`/`OWNER_INBOX`
    address, else `dmarc@{domain}`.
32. **DNSBL**: a listing is an answer in 127.0.0.2–127.0.0.99; 127.255.x
    ("query refused") and timeouts are skipped, not failures.
33. **Rounds**: a failed round re-runs only the failed checks every hour.
    Auto-renew failing raises the new alert `autorenew_on`.
34. **Dates**: `signedDay` = the day all checks pass (spec), Day 1 =
    signedDay + 14 moved to the next US business day (weekends + `US_HOLIDAYS`),
    Day 30 = Day 1 + 29.
35. **welcome_two_dates**: the doc's "Build call" date is replaced by the date
    the approval link arrives (Day −7 = signedDay + 7, SPEC §16 #9). The doc's
    paragraph asking for the calendar link and postal address is dropped —
    both were already collected on the onboarding page. Retried hourly until
    sent (`intakeStep = welcome`).
36. **DMARC**: a row passes when DKIM or SPF passes in `policy_evaluated`;
    counted on the ET day of the report's `begin`. No reports → no rate (no
    alert). Reports are deduped by `org:report_id`.

## Booking Link Tester (`systems/bookingtest.js`)

37. **Day −4** = `day1Date − 4` (so a Day 1 that slid past a weekend is still
    tested four days ahead). Re-tested whenever `calendarUrl` changes, and
    daily while problems remain.
38. Slots are read from Calendly's public booking endpoints (undocumented,
    best effort) or from `start_time` JSON in the page when at least 3 appear;
    otherwise unknown and not a failure. Meeting length is checked when
    exposed (15–30 min).
39. The "It worked" tap is a POST from a button page, so mail scanners that
    open links cannot confirm it.

## New wording (templates/client/stage-a.js)

Written new in the owner's voice (plain text, one ask): `onboarding_link`
(opens with the Day −14 line from §5), `onboarding_reminder`, `closed_silent`,
`queued_position`, `decline_fit` (reason sentences in `FIT_RULES`),
`decline_market` (reuses the §2 "burns most of it in a month" sentence),
`decline_repeat`, `agreement_copy`, `setup_in_progress`,
`booking_test_request` (the §6.7 60-second test), `booking_fix`.
Verbatim-adapted: `welcome_two_dates` (see 35).

## New owner alerts (templates/owner.js, Stage A block)

`market_unavailable` (U), `autorenew_on` (U), `promo_expired`,
`booking_link_broken`.

## Scheduler

40. The client hash gets a small `intakeStep` flag (`market`, `market_wait`,
    `pricescout`, `setup_running`, `welcome`) so the per-minute `due` checks
    read nothing beyond the hash the tick already loaded.
