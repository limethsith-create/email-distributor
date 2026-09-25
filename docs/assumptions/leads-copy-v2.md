# Leads + Copy v2 — assumptions and decisions (2026-09-25)

Research and sources: `docs/research/v2-leads-copy.md`. Config lives in the
Stage C block of `src/lib/config.js` (`VERIFY`, `GRADE`) plus one line in
`SEND` (`allowRiskyAfterDay`). Keys: `K.leadQuality`, `K.verifyQueue`,
`K.verifyDomains` (Stage C block of `src/lib/db/keys.js`).

## Lead Finder v2 (`scripts/leadfinder/*`, `src/lib/leadquality/rules.mjs`)

1. **Rules shared by the job and the app** live in `src/lib/leadquality/rules.mjs` (plain ESM, no imports): the job imports it by relative path, the app as `@/lib/leadquality/rules.mjs`.
2. **Crawl:** the home page first, then up to 6 pages it links to that look like people pages (about / team / staff / leadership …) or the contact page, then the fixed fallbacks; 250 ms between pages of one site (`LEADFINDER_PAGE_DELAY_MS`); https first, plain http only when https does not answer at all.
3. **People:** JSON-LD `Person`; "Name, Title" / "Title: Name" / "founded by Name" / "I'm Name, the owner" / "Name is the owner of"; team cards (a line that is only a name followed by a line that is only a title). Names must pass `looksLikeName` (2–4 capitalised words, no stop words). LinkedIn `/in/` links on the company's own pages are read as **name hints only** (LinkedIn is never fetched).
4. **Contact choice:** a title on the client's list first, then the decision-maker tier (owner 100 · GM/partner 85 · VP/director/ops 70 · office/practice manager 55), then who has their own address. **One contact per company** unless `profile.contactsPerCompany` (1–3) says more.
5. **Role addresses are never kept** — info@, sales@, office@, dispatch@, careers@, `owner@` … and prefixes like `info.dallas@`, `sales2@`, suffixes like `dallasoffice@`. A local part that is a known first name is never a role. Ambiguous words (care, staff, press, book) count only as the whole local part.
6. **Free-mail addresses** (gmail.com …) are kept only when the local part matches the person's name; a company-named free-mail inbox is treated like a role address.
7. **No named person but a personal address on the host** → kept with the first name from the address when it is a known first name ("jane@") or first.last. Otherwise the company is rejected `no_name`.
8. **Pattern inference:** from any known personal address on the same host (with the person's name when we have it). Candidates: inferred pattern + 1 fallback; else `first@`, `flast@`, `first.last@` (Interseller small-company data). Each candidate costs a verifier credit, so the list is capped.
9. **Filters:** closed (Places `businessStatus`), chain/franchise (host list `config/chains.txt`, brand names in `rules.mjs`, location-page website URLs, one host on 3+ listings, "independently owned and operated" on the site), outside the US (state / country TLD) or outside the client's states (+ neighbours in widen mode), duplicate host, duplicate person, another client in the same niche within 90 days.
10. **Search:** the v1 grid, then other phrasings of the keyword; a query that returns 60 results (Text Search's cap) is re-run over a 3 × 3 grid of the city's Places viewport (the viewport lookup is a Pro-field request, counted as `usage:places:{month}.pro`). The job collects `need × GRADE.findOvershoot` (1.5) contacts because some will fail verification.
11. **The job never calls a paid verifier.** It runs syntax → throwaway domain → MX and posts every lead `verifyStatus: pending`, with `emailCandidates`, `facts` (services, service page, since/years, rating/reviews and their source, primary type) and `signals` (https, copyright year, viewport, address, phone, hiring, expansion, franchise, free-mail contact, pages read), and reject counts per reason with every batch and the done post. `REOON_API_KEY` is no longer passed to the workflow.

## Verification waterfall (`src/lib/systems/verify.js`, `src/lib/ext/*.js`)

12. **App side, not in the job:** the keys, the per-day / per-month budgets and the grade update all live in one place, and the daily free allowances are used every day of the build weeks.
13. **Order:** `VERIFY.order` = quickemail (100/day) → verifalia (25/day) → reoon (20/day, 600/month) → mailboxvalidator (300/month) → zerobounce (100/month) → hunter (100 checks/month) → tomba (50/month) → proofy (one-time pack). Daily allowances first because they do not roll over. A service without its key is skipped.
14. **Budgets are global** (one vendor account serves all clients): `usage:verify:{ET day}`, `usage:verify:{UTC month}`, `usage:verify:total`, one field per service. A credit is taken before the call and given back when the service answered "out of credits", "skip" or had no key. An "out of credits" answer marks the service spent for the day (`{service}:out`).
15. **Answers:** a definite `valid` / `invalid` / `catchall` / `risky` stops the waterfall; `unknown` (or a service error) moves on to the next service. No answer and budget left nowhere → the lead stays `pending` and the queue resumes at 00:05 ET (owner told once a day: `verify_budget_out`).
16. **No key at all** → MX level only → `risky` with `verifiedBy: mx` (not sendable); owner alert `verify_no_keys` once a day per client; re-queued automatically the day a key appears.
17. **Catch-all** verdicts are remembered per domain for `VERIFY.catchallCacheDays` (30) in `verify:domains` (a technical fact, no personal data, global like `mx_verify`); a catch-all answer goes to Anymailfinder (one-time credits) when its key is set, which can turn it into `valid` / `invalid`.
18. **Guessed addresses:** `invalid` → the lead is re-keyed to the next candidate (only while it is unsent, never onto an existing or blocked address) and queued again; out of candidates → `invalid` → rejected.
19. **`unknown`** is retried once after `VERIFY.unknownRetryHours` (48 h), max `VERIFY.maxAttempts` (2); after that it stays `unknown` (not sendable).
20. **Queue:** `client:{id}:verifyq` (sorted set, best grade score first). Only leads that could reach a sendable grade once verified are queued (no credit is spent on a C lead).
21. **Job `lead-verify`** (Stage C joblist): from `warming` through `converted`, every `VERIFY.everyMin` (5) minutes while `client.verifyPending = 1`, `VERIFY.perRun` (4) leads a run, stopping 4 s before the tick deadline. **Job `lead-verify-daily`** (00:10 ET): re-queues MX-only / unknown / fallen-out pending leads and v1-style guessed records (e.g. Wrong-Person referrals), regrades, rebuilds the rollup, and brings week-one catch-all rejects back once `SEND.allowRiskyAfterDay` allows them.
22. **Emergency Runner re-verify** (`leadfinder.deepVerify`) now goes through the same waterfall and budgets.

## Lead Grader (`src/lib/systems/grader.js`)

23. **Points:** ICP ≤ 30 (industry word 15 · your city 8 / your state 5 · size band 5 · 3 per dream-customer match) · title ≤ 20 (tier; +4 when on the client's list) · named person 10 (first name only 6) · verified 20 (catch-all 4, risky/unknown 2, pending 0) · website ≤ 10 (https 3, updated this or last year 3, street address 2, phone 1, mobile layout 1) · Google ≤ 6 (≥ 4.5★ & ≥ 25 reviews 6; ≥ 4★ & ≥ 5 reviews 3) · intent/problem ≤ 8 per client niche · referral +15.
24. **Grades:** ≥ `GRADE.A` (70) A, ≥ `GRADE.B` (50) B, else C. **Sendable** = grade in `GRADE.sendable` (A, B) **and** `verifyStatus: valid`; risky / catch-all only when `SEND.allowRiskyAfterDay` = N and the sending day ≥ max(8, N) — never in week one; `pending` never.
25. **Hard rejects** (grade `rejected`, reason first in `reasons[]`): role address, invalid email / no MX, throwaway domain, chain/franchise, no US state / outside the client's states, too big (> 2 × size max, or a large-organisation Places type) / too small (< ½ size min), excluded title, no name, duplicate company, catch-all while risky is not allowed.
26. **Rejected at insert are counted, not stored** (`client:{id}:leadfinder.rejects`, summed with the job's own counts). A stored lead that becomes rejected later (verification) gets **status `rejected`** — a new status next to the CONTRACTS list (outside `INDEX_STATUSES`, so `countByStatus` ignores it).
27. **v1-style records with no grade** (Test Mode, manual imports, Wrong-Person referrals) are judged by `riskLevel`: `safe` counts as verified (a mailbox we own or an address a person gave us).
28. **Rollup** `client:{id}:leadquality` (`data` JSON + `builtAt`), rebuilt after every batch, at most every `GRADE.rollupEveryMin` (10) minutes during verification, and daily. `graded` = stored leads + the job's graded rejects (search artefacts `no_website`, `duplicate_host`, `no_state` are not counted as graded companies). `leadQualityView(clientId)` adds the live `budgetLeftToday` and an extra `sendableUnsent` field (additive to HUB-API).
29. **List gate** (`listReady`) and **refill** (`refillDue`) now count sendable unsent leads (graded A/B + verified; ungraded records as in v1). The readiness message shows that number.
30. **Sanity Check** grades each sampled row (as unverified) and counts the grader's pattern rejects as failures: role, no_name, chain, state (outside the area), size, title. The approval page's "20 companies" are now the best-graded rows of the batch (the check itself still samples at random).
31. **Fairness:** "no company contacted by two clients in the same niche/city in 90 days" — a company is one host in one city, so the check is per host and niche over the monthly `leadhosts:{niche}:{month}` keys of this month and the three before (≥ 90 days), kept 130 days.

## Copy Engine v2 (`src/lib/systems/copy.js`, `templates/sequence/*.json`)

32. **Niches:** `msp`, `trades` (plumbing, roofing, HVAC, electrical, cleaning … selling to commercial customers), `agency`, `pro-services` (accounting, legal, insurance, consulting, staffing), `trial-default`. `nicheOf` reads the client's offer first (`defaultNiche`, `sellsTo`, `oneLiner`), then its industry words.
33. **Frameworks** per niche: problem-first (default), question-led, quick-idea, local-proof. Local-proof needs `profile.proofLine` — one true sentence from the client; without it the framework is never chosen. Choice: `profile.copyFramework` → the Learning Library's best-ranked variant → the default.
34. **Variant ids:** the default framework keeps v1's ids (`msp-a1`, `msp-b1`, `default-a1` …) so Learning data carries over; others are `{niche}-q-a1`, `-qi-`, `-lp-`. Backups (`-c2`, `-d2`) are the **same framework's bodies** with new subjects and C/D openers. The `.backup.json` files are gone (merged into each niche file).
35. **First lines** (per set, first safe fact wins): A rating → years → service; B service → years → rating; C service page → years → rating; D years → service → rating. A rating is used only at ≥ 4.5★ with ≥ 25 reviews; a founding year only if ≥ 5 years ago; a service only if 1–4 plain words, not generic, not a button label ("… now", "call …"). Anything that would break a Copy Checker rule falls back to the v1 type line.
36. **Company names** in copy are cleaned: SEO tail after " - " / " | " dropped, "(…)" dropped, legal suffix dropped ("Alpha Inc" → "Alpha"), ALL-CAPS words over 3 letters title-cased, a bare domain turned into its name.
37. **No claim about the client** beyond `{oneLiner}` / `{proof}` in any template. The client still approves the text.

## Copy Checker v2 (`src/lib/systems/copycheck.js`)

38. New rules (constants in `LIMITS` so the approval page and the send gate always agree): `one_question` (no "?" before the closing paragraph), `no_exclamation`, `stale_phrase`, `readability` (average ≤ 16 words per sentence, none over 28; skipped when the body already fails `word_count`), `you_focus` (I/we words ≤ 3 or no more than you/your words), `subject_length` (≤ 6 words, ≤ 60 characters).
39. The prospect's own company name, first name and city (`exemptWords`) are not judged as copy: an ALL-CAPS brand is not shouting, and a long legal name counts as one word in the subject and sentence-length rules.
40. `EXTRA_SPAM_WORDS` (built in, merged with `config/spamwords.txt`) adds HubSpot's list and the owner's banned words — including **"free"**: a client one-liner that says "free" now blocks the copy until it is reworded.

## Sender (`src/lib/systems/sender.js`, minimal edit)

41. First touches go only to `isSendable` leads; a lead that is not sendable yet stays `unsent` (skipped, not closed). Follow-ups are not re-gated (the lead was sendable at Day 0). The sending day is ramp.js's `sendingDayNumber`.

## Tests changed (legitimate v2 behaviour changes)

- `tests/stage-b.test.mjs`: `pickContact` of a role-only site is now `null`; `nicheOf('commercial roofing')` is `trades`; the webhook-insert test's client targets TX, CA and CO (out-of-area leads are now rejected); the pipeline-step test now expects guessed candidates posted `pending` (the job no longer calls Reoon).
- `tests/stage-c.test.mjs`: the subject regex accepts "idea for Alpha" (legal suffix dropped); the jobs test lets `lead-verify*` run in `warming`.
- `tests/full-run.test.mjs`: `prepare()` sets a Reoon key, answers Reoon `safe` for the simulated prospects and lifts its daily budget. **The milestone fixture `tests/fixtures/full-run.json` is unchanged.**
