# Leads + Copy v2 — research notes

Checked on **2026-09-25** unless a line says otherwise. Every figure below is
what the cited page showed that day; where a page did not say something, or
two pages disagree, this document says so. Vendor free tiers change often —
re-check before relying on a number for money.

What this research changed in the code is listed at the end of each section
(**→ built**).

---

## 1. Free email verifiers and finders with an API

### 1.1 Free allowances that renew (API usable on the free plan)

| # | Service | Free allowance | Catch-all reported | Single-check API | Source |
|---|---|---|---|---|---|
| 1 | QuickEmailVerification | **100 / day** (~3,000 / month); work-email signup | yes (`accept_all`) | `GET https://api.quickemailverification.com/v1/verify?email=&apikey=` → `result` valid/invalid/unknown, `accept_all`, `disposable`, `role`, `safe_to_send`; remaining credits in `X-QEV-Remaining-Credits` | https://quickemailverification.com/plans · https://docs.quickemailverification.com/email-verification-api/verify-an-email-address |
| 2 | Verifalia | **25 / day** (reset at midnight GMT, do not roll over); one free account per organisation (ToS §5.7, effective 2026-01-15) | yes (`ServerIsCatchAll`) | `POST https://api.verifalia.com/v2.7/email-validations` `{"entries":[{"inputData":…}]}`, HTTP Basic; 200 = done, 202 = poll; `classification` Deliverable/Undeliverable/Risky/Unknown | https://verifalia.com/pricing · https://verifalia.com/developers/email-verifications/creating-jobs · https://verifalia.com/blog/terms-of-service-update-december-2025 |
| 3 | Reoon | **20 / day, up to 600 / month** + 100 at signup; "every feature, including the API"; unknowns not charged; ≤ 5 threads | yes, **power mode only** (quick mode does not check the mailbox) | `GET https://emailverifier.reoon.com/api/v1/verify?email=&key=&mode=power` → `status` safe/invalid/disabled/disposable/inbox_full/catch_all/role_account/spamtrap/unknown | https://emailverifier.reoon.com/ · https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/ |
| 4 | MailboxValidator | **300 / month** (API-FREE plan, auto-renewing); no Yahoo addresses | yes (`is_catchall`) | `GET https://api.mailboxvalidator.com/v2/validation/single?key=&email=` | https://www.mailboxvalidator.com/plans · https://www.mailboxvalidator.com/api-single-validation |
| 5 | ZeroBounce | **100 / month** (business-domain signup, refills monthly); unknowns not charged | yes (`catch-all`) | `GET https://api.zerobounce.net/v2/validate?api_key=&email=&ip_address=` | https://www.zerobounce.net/pricing · https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails |
| 6 | Hunter.io | **50 credits / month**; a verification costs 0.5 → **100 checks** (or 50 finds); API ticked for Free; one account per person (ToS) | yes (`accept_all`) | `GET https://api.hunter.io/v2/email-verifier?email=` + `X-API-KEY`; 202 = still checking, 222 = SMTP error | https://hunter.io/pricing · https://hunter.io/api-documentation/v2 · https://hunter.io/terms-of-service |
| 7 | Tomba.io | **conflicting**: pricing page "25 free searches every month"; Tomba's blog "25 searches + 50 verifications"; API page "75 free API credits on signup" | yes (`accept_all`) | `GET https://api.tomba.io/v1/email-verifier?email=` + `X-Tomba-Key`/`X-Tomba-Secret` | https://tomba.io/pricing · https://tomba.io/blog/hunter-vs-tomba-pricing · https://tomba.io/api |
| — | Abstract API | 100 / month, 1 req/s; the older docs say `is_mx_found` is null/UNKNOWN on free plans (weak) | field exists | `GET https://emailreputation.abstractapi.com/v1/?api_key=&email=` | https://docs.abstractapi.com/api/email-validation |
| — | UserCheck (ex Mailcheck.ai) | 1,000 / month — disposable/MX/role only, **no mailbox check** | no | `GET https://api.usercheck.com/email/{email}` | https://www.usercheck.com/docs/api/email-endpoint |

**No API on the free plan:** Snov.io ("API & webhooks access … not available in
Trial", https://snov.io/pricing) and Skrapp (API only on Enterprise,
https://skrapp.io/pricing).

### 1.2 One-time credits (allowed by SPEC §1 rule 2 — never a subscription)

| Service | One-time | Note | Source |
|---|---|---|---|
| Anymailfinder | 100 credits once (card check, not charged); verify = 0.2 credit → ~500 checks; resolves catch-alls to valid/risky/invalid | `POST https://api.anymailfinder.com/v5.1/verify-email`, `Authorization: <key>` | https://anymailfinder.com/pricing · https://anymailfinder.com/email-finder-api/docs/verify-email |
| Proofy | no free credits; **$5 for 5,000 checks** for new users, never expire | `GET https://apis.proofy.io/v1/verify/single?email=&api_key=` | https://proofy.io/price · https://docs.proofy.io/api-reference/endpoint/verify-single.md |
| Reoon | $11.90 per 10,000 instant credits, never expire | — | https://emailverifier.reoon.com/ |
| QuickEmailVerification | $4 for 500 persistent credits, never expire | — | https://quickemailverification.com/plans |
| Emailable / Clearout / Bouncer / DeBounce / MillionVerifier / Kickbox / EmailListVerify | 100–250 once each | reserve only | vendor pricing pages (see the service list in the research log) |

**Free recurring capacity, all seven renewing keys set:** about **4,900 checks
a month** on paper (QEV ~3,000 + Verifalia ~750 + Reoon 600 + MailboxValidator
300 + ZeroBounce 100 + Hunter 100 + Tomba ~50). Without QuickEmailVerification
it is about 1,900. Daily allowances expire, so a job must use them every day.

**Free email *finding* is the real bottleneck:** recurring free finds come to
about 125–175 a month (Prospeo 75–100 + Hunter up to 50 + Tomba 25; Prospeo's
own pages disagree between 75 and 100, https://prospeo.io/api-docs). The free
route for the rest is: find the person's name on their own website, infer the
company's address pattern, verify the guess.

**→ built:** `src/lib/systems/verify.js` + `src/lib/ext/{quickemail,verifalia,reoon,mailboxvalidator,zerobounce,hunter,tomba,proofy,anymailfinder}.js`.
Order = daily allowances first (they do not roll over), then monthly, then
one-time packs (`VERIFY.order`); Anymailfinder is used only to resolve
catch-all verdicts.

### 1.3 Why no home-made SMTP check

- **Vercel blocks outbound port 25** ("Vercel blocks port 25 while leaving ports 465 and 587 open", https://vercel.com/kb/guide/serverless-functions-and-smtp).
- **GitHub-hosted runners** are Azure VMs (https://docs.github.com/en/actions/concepts/runners/github-hosted-runners); Azure blocks outbound TCP 25 except on EA / MCA-E subscriptions (https://learn.microsoft.com/en-us/azure/virtual-network/troubleshoot-outbound-smtp-connectivity). GitHub does not document the runners' subscription type → treat port 25 as unavailable.
- **Microsoft 365** rejects unknown recipients at the edge only for "Authoritative" domains; "Internal relay" domains accept everything (https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-directory-based-edge-blocking).
- **Google Workspace** admins can route unknown addresses to a catch-all (https://support.google.com/a/answer/12943537), and Gmail defers unfamiliar senders (`421 4.7.0`, `421 4.7.28`, `450 4.2.1`, https://support.google.com/a/answer/3726730), so probes come back "unknown".
- The owner's own Lead Engine report (3 Sep 2026) reached the same conclusion: "What a free script cannot do reliably in 2026 is SMTP handshake verification."
- AfterShip's open-source verifier turns SMTP checks **off by default** because "most of the ISPs block outgoing SMTP requests through port 25" (https://github.com/AfterShip/email-verifier).

**→ built:** the Lead Finder job runs only syntax → throwaway domain → MX
(`scripts/leadfinder/verify.mjs`); everything else goes to the API waterfall.

### 1.4 Catch-all domains and bounce limits

- A catch-all ("accept-all") server accepts any address, so a check cannot tell whether the person's mailbox exists (Hunter: "valid but any email address is accepted", https://hunter.io/api-documentation/v2; Verifalia `ServerIsCatchAll`, https://verifalia.com/developers/email-verifications/retrieving-jobs).
- About **30 % of B2B servers** are catch-all according to Dropcontact (https://www.dropcontact.com/blog/catch-all-understand).
- Growtoro (2026-05-21) expects **5–12 % bounces on catch-alls vs under 1 % on verified** and advises skipping them while a domain is warming (https://growtoro.com/blog/catch-all-email-addresses-cold-outreach-strategy).
- Google: keep the Postmaster spam rate **below 0.10 %, never 0.30 %**; Google publishes **no numeric bounce threshold** (https://support.google.com/a/answer/81126). Yahoo: spam rate below 0.3 % (https://senders.yahooinc.com/best-practices/).
- Practitioners: Instantly keeps hard bounces ≤ 1 % (https://instantly.ai/blog/agency-email-verification-playbook/); Smartlead calls < 2 % good, 2–5 % warning (https://www.smartlead.ai/benchmarks/cold-email-bounce-rate). The owner's report uses "pause at 1.5 %, stop at 2 %".

**→ built:** catch-all → `riskLevel: catchall`, rejected while
`SEND.allowRiskyAfterDay` does not allow it (never in sending days 1–7);
a domain found catch-all is remembered 30 days (`verify:domains`) so no second
credit is spent on it.

### 1.5 Disposable domains

`disposable-email-domains/disposable-email-domains` — 8,971 domains, CC0,
pushed 2026-09-24 (https://github.com/disposable-email-domains/disposable-email-domains).
Company websites almost never publish one, so the app carries a short
built-in list (`src/lib/leadquality/rules.mjs`); the full list can be added as
a file later if junk shows up.

---

## 2. Free business data for US SMB prospects

### 2.1 Google Places API (New) — Text Search

| SKU | Free calls / month | After, per 1,000 |
|---|---|---|
| Essentials (IDs only) | unlimited | — |
| Pro | 5,000 | $32 |
| Enterprise | 1,000 | $35 |
| Enterprise + Atmosphere | 1,000 | $40 |

Source: https://developers.google.com/maps/billing-and-pricing/pricing (the
$200 monthly credit was replaced by per-SKU free thresholds on 2025-03-01,
https://developers.google.com/maps/billing-and-pricing/march-2025).

- `websiteUri`, `nationalPhoneNumber`, **`rating`, `userRatingCount`** are Enterprise fields; `businessStatus`, `primaryType`, `types`, `formattedAddress`, `viewport` are Pro fields (https://developers.google.com/maps/documentation/places/web-service/text-search). A request is billed at the highest SKU its field mask needs — our mask already needs Enterprise for the website, so rating / reviews / business status cost nothing extra.
- **At most 60 results per query** (20 a page); `locationRestriction` with a rectangle viewport works "for categorical queries only" (same page).
- **Caching:** place IDs may be stored indefinitely; latitude/longitude up to 30 days (https://developers.google.com/maps/documentation/places/web-service/policies, https://cloud.google.com/maps-platform/terms/maps-service-terms). ToS §3.2.3 forbids exporting Maps content "for use outside the Services", with "copy and save business names, addresses, or user reviews" as an example (seen as a search snippet of https://cloud.google.com/maps-platform/terms; the full page did not render). **Legal risk for the owner to review:** a lead record keeps the company name, website and phone that Places returned for the length of a trial (the website and phone are usually also on the company's own site, which is where the crawler reads them).

**→ built:** the field mask adds `rating, userRatingCount, businessStatus,
primaryType`; closed businesses are dropped; a query that returns 60 (the cap)
is re-run cell by cell over the city's viewport (3 × 3 grid, one Pro request
per city for the viewport) — without this a client with two cities could never
see more than ~120 companies per keyword; two other phrasings of the keyword
("dentist" → "dental clinic", "family dentistry") are searched after the grid.

### 2.2 OpenStreetMap

- Overpass public servers: one-off use < 10,000 queries and < 1 GB a day; regular use "divide those numbers by 100"; "Commercial use should use self-hosted or paid Overpass servers"; no parallel scripts; pause 30 s after 429/406 (https://wiki.openstreetmap.org/wiki/Overpass_API).
- Geofabrik state extracts (`.osm.pbf`, ODbL 1.0), US data current to 2026-09-23 (https://download.geofabrik.de/north-america/us.html). Attribution: "© OpenStreetMap contributors" + link + ODbL notice (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines).
- Useful tags (worldwide counts, taginfo 2026-09-24): craft=plumber 12,195 · roofer 6,032 · hvac 12,604 · electrician 14,797 · office=it 22,558 · accountant 18,742 · lawyer 54,811 · advertising_agency 11,434; `email` key 981,154, `contact:email` 510,658 (https://taginfo.openstreetmap.org/).
- Nominatim (geocoding) allows at most 1 request/s, needs an identifying User-Agent, and calls periodic app requests "strongly discouraged" (https://operations.osmfoundation.org/policies/nominatim/) — which is why the city grid uses the Places viewport instead.

**→ built:** the Overpass fallback now also queries the proper OSM tags for
the industry (`craft=plumber`, `office=accountant`, `healthcare=dentist`, …).

### 2.3 Registries and other sources (not built — listed for the owner)

- **State licence boards** are the best free data you may store: California CSLB master list (CSV, business name, address, phone, classifications, personnel names/titles; "Email addresses are not provided") https://www.cslb.ca.gov/onlineservices/dataportal/ContractorList ; Texas TDLR "All Licenses" (owner name and phone columns, updated ~2026-09-19) https://data.texas.gov/api/views/7358-krk7.json .
- State business registries on Socrata (NY, CO, PA, OR, CT; third-party list, not each verified) https://dev.to/bradju/124-million-us-business-registrations-are-sitting-on-state-open-data-portals-free-3h1n ; Florida Sunbiz daily files (page returned 403; from search snippets) https://dos.fl.gov/sunbiz/other-services/data-downloads/ .
- OpenCorporates free tier (50/day, 200/month) requires share-alike open licensing of the product → not usable for a closed product (https://api.opencorporates.com/documentation/API-Reference).
- Census County Business Patterns: counts by ZIP/county/NAICS, free key now required (https://www.census.gov/programs-surveys/cbp/data/api.html) — good for market sizing.
- SEC EDGAR (10 req/s, User-Agent with contact) and Form D — mostly startups and funds, little use for trades (https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).
- **Skip:** Yelp Fusion (30-day trial "not for commercial deployment", paid from $229/month, https://business.yelp.com/data/resources/pricing/); Foursquare (500 free Pro calls/month from 2026-06-01, https://docs.foursquare.com/developer/reference/upcoming-changes); Bing Maps free accounts ended 2025-06-30; SAM.gov (10 requests/day without a role); Clutch (ToS bans scraping, https://clutch.co/terms); LinkedIn (never scraped — the crawler only reads `linkedin.com/in/…` links on the company's own site as a name hint).
- Azure Maps Search Gen2: 5,000 free transactions/month (https://azure.microsoft.com/en-us/pricing/details/azure-maps/); TomTom Search: 2,500 free/month (https://docs.tomtom.com/pricing) — possible second sources later.

### 2.4 Intent signals that cost nothing

- ATS job boards with public JSON: Greenhouse `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` (no auth for GET, https://docs.greenhouse.io/job-board.html), Lever `api.lever.co/v0/postings/{site}?mode=json` (https://github.com/lever/postings-api), Ashby (https://developers.ashbyhq.com/docs/public-job-posting-api) — fit agencies/MSPs better than trades, and need a board-token list (the owner's report).
- On the company's own site: "now hiring / join our team", "new location / now serving", copyright year, https, mobile viewport.

**→ built:** the crawler records hiring, expansion, copyright year, https,
viewport, a street address, a franchise disclaimer and a free-mail contact
address; the grader turns them into "intent / problem" points per client niche
(e.g. an MSP's prospect using a Gmail address for the business, an agency's
prospect with a site last updated in 2019).

---

## 3. Open-source projects worth learning from

| Project | What we took | Source |
|---|---|---|
| reacherhq/check-if-email-exists (10.0k★, AGPL) | catch-all = a random 15-character address accepted at RCPT TO; catch-all / role / disposable / full inbox are **risky**; "outbound port 25 must be open" | https://github.com/reacherhq/check-if-email-exists · https://docs.reacher.email/getting-started/is-reachable |
| AfterShip/email-verifier (1.6k★, MIT) | SMTP off by default; catch-all → `unknown`; disposable list refreshed daily | https://github.com/AfterShip/email-verifier |
| omkarcloud/website-email-contact-scraper | crawl contact/about/careers first; `mailto:`, Cloudflare-encoded and "[at] [dot]" emails | https://github.com/omkarcloud/website-email-contact-scraper |
| scrapinghub/extruct | schema.org JSON-LD Person / Organization / LocalBusiness | https://github.com/scrapinghub/extruct |
| derek73/python-nameparser, humanparser | honorifics, suffixes (Dr., DDS, CPA, Jr.), middle initials | https://github.com/derek73/python-nameparser · https://github.com/chovy/humanparser |
| mailcheck/mailcheck | "show a suggestion; do not silently replace" for domain typos | https://github.com/mailcheck/mailcheck |
| gosom/google-maps-scraper | per-business website visits for emails — and its own warning that scraping may break Google's ToS (we use the API) | https://github.com/gosom/google-maps-scraper |

**Address patterns at small companies** — Interseller (5M+ companies, 2019):
1–10 staff `{first}` 71.48 %, `{f}{last}` 12.57 %, `{first}.{last}` 9.82 %;
11–50 staff 41.91 % / 26.63 % / 22.66 %
(https://www.interseller.io/blog/2019/02/04/top-email-address-patterns-by-company-size/).
Sendburg (336,782 profiles) finds `first.last` most common overall
(47.71 %), `first` 16.8 % at 1–10 staff (https://send-burg.com/research/b2b-email-formats) —
the two disagree; small-company data (Interseller) decides our order.

**→ built:** guess order first → flast → first.last (three candidates cover
~94 % of 1–10-person companies per Interseller); a pattern inferred from any
known address at the same domain is tried first with one fallback;
name extraction handles "Dr.", DDS/CPA/Jr., team cards, "I'm Jane, the owner",
"Jane is the founder of …", and JSON-LD `Person`.

---

## 4. Cold email copy for SMB owners (2025–2026)

| Rule | Evidence |
|---|---|
| First email 25–80 words | Lavender 25–50, max 75 (https://www.lavender.ai/blog/cold-email-101); Instantly "< 80 words per first-touch email" (https://instantly.ai/cold-email-benchmark-report-2026); Hunter: 20–39 words best reply rate 4.5 % (https://hunter.io/blog/cold-email-word-count) but its 2025 report found word count barely matters (r = −0.09) (https://hunter.io/the-state-of-cold-email-2025) |
| Easy reading | Lavender: "3rd to 5th-grade reading level gets 67 % more replies", mobile-friendly +83 % (https://www.lavender.ai/blog/cold-email-wizardry-101-understanding-the-readers-perspective) |
| Short plain subject | Belkins (5.5M emails): 2–4 words 46 % opens vs 10 words 34 %; lowercase vs Title Case both 29 % (https://belkins.io/blog/b2b-cold-email-subject-line-statistics); Lavender: 1–3 words, internal-looking, no first-name token |
| Personalise from public facts | Hunter 2026 (31M emails): no personalisation 3.6 % replies vs two custom fields 5.6 %; 69 % of decision-makers are bothered by AI-written emails (https://hunter.io/the-state-of-cold-email) |
| Problem first, not pitch | 30MPC: pitch language −57 % replies, leading with the problem +20 %, social proof +41 % (https://www.30mpc.com/newsletter/the-data-backed-cold-email-formula-the-exact-words-length) |
| Interest question, not a meeting time | Gong: interest-based CTA is "the highest performing call to action for cold emails" (https://www.gong.io/blog/this-surprising-cold-email-cta-will-help-you-book-a-lot-more-meetings); Josh Braun (https://joshbraun.com/cold-email-ctas/) |
| "You" twice as often as "I/we" | Alex Berman's 2:1 rule (https://alexberman.com/cold-email-strategy-what-actually-works) |
| No links / tracking in email 1 | Hunter 2026: untracked 7.4 % replies vs tracked 4.4 % (https://hunter.io/the-state-of-cold-email); HTML "bounce 674 % more" than plain text (https://hunter.io/blog/is-html-harming-your-cold-email-deliverability/) |
| 3–5 touches, new angle each | Belkins: steps 2–6 bring 58.6 % of replies, step 3 alone 35.6 % of meetings (https://belkins.io/blog/sales-follow-up-statistics); Instantly: 58 % of replies from step 1, 3–4 days apart |
| Phrases to drop | Gong: "Thoughts?" −20 % meetings, "never heard back" −14 %, "following up" −5 % (https://www.gong.io/blog/cold-email-stats); the owner's voice rules ban "Quick question", "Just following up", "I wanted to reach out", "Circling back" (Cold Email Bot App `voice.js`) |
| Spam words | HubSpot list: free, guarantee, act now, risk-free, no obligation, click here, limited time, urgent … — and filters weigh authentication and reputation more than words (https://blog.hubspot.com/blog/tabid/6307/bid/30684/the-ultimate-list-of-email-spam-trigger-words.aspx) |
| Benchmarks | Instantly 3.43 % average reply, top quarter 5.5 %+; Hunter 2026 4.5 % overall; Belkins counts per email sent (0.45 %) so it is not comparable (https://belkins.io/blog/cold-email-response-rates) |
| Compliance | CAN-SPAM: physical address + working opt-out, honour within 10 business days (https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) |

Talks found (titles confirmed through YouTube oEmbed, not watched): "We
Analyzed 85 MILLION Cold Emails…" (30MPC) https://www.youtube.com/watch?v=EDbuEGO01uM ;
"How AI will redefine cold email in 2025 | Instantly Masterclass"
https://www.youtube.com/watch?v=pgkwZlV71uI ; podcast "#570 - Cold Email
Masterclass: Everything You Need To Book Meetings in 2026" (30MPC, 2026-05-05)
https://podcasts.apple.com/nz/podcast/570-cold-email-masterclass-everything-you-need-to-book/id1510861233?i=1000766190276 .

**→ built:** four frameworks per niche (problem-first, question-led,
quick-idea, local-proof — the last only with a true proof line from the
client), five niches, four touches each, A/B differing only in subject and
opener; first lines from facts the crawler found (Google rating ≥ 4.5 with
25+ reviews, years in business, a service they list, a named service page) with
a type-based fallback; subjects 2–5 words with no first name; the Copy Checker
adds one-question, no-"!", stale-phrase, readability, you-focus and subject
rules and a longer spam list.

---

## 5. What to expect per client (estimate — to be replaced by measured numbers)

Nothing below is measured on a real trial yet; the hub's `leadQuality` block
shows the real funnel after the first run. Assumptions are marked.

1. **Search.** Need 400 → the finder collects 600 contacts (`GRADE.findOvershoot` 1.5) and aims at 1,800 candidates. With the city grid, one keyword in two cities costs roughly 60–180 Enterprise requests (up to ~1,200–2,000 listings before de-duplication). The free 1,000 a month (800 used at the 80 % stop) is shared by all clients: **about 4–8 full initial runs a month**.
2. **Filters** (no website, chain/franchise, closed, out of area, another client): *assumption* 30–50 % of listings drop.
3. **A named decision-maker on the company's own site** (about/team page, JSON-LD, "Name, Owner"): *assumption* 35–55 % of the remaining companies — the biggest unknown.
4. **Verification.** ~30 % of B2B domains are catch-all (Dropcontact) → not sendable in week one; guessed addresses need 1–3 checks (≈ 1.5–2 credits per contact on average, *assumption*).
5. **Result:** *roughly* 150–250 verified A/B contacts per 1,000 listings. A metro client usually gets to 400 with the grid search and one refill; a small-town niche may not, and the machine says so (`list_short`) instead of padding the list with unverified addresses.
6. **Verification credits:** ~1,000 checks per client → with all seven free renewing keys (~4,900 / month) about 4 clients a month; **with Reoon alone (20 / day) the build weeks cannot verify a full list** — set at least QuickEmailVerification (100/day) + Verifalia (25/day) + Reoon (20/day) = 145 checks a day, or buy one never-expiring pack (Proofy $5 / 5,000, Reoon $11.90 / 10,000).
