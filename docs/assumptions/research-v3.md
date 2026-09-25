# Research v3 — the full company file (2026-09-25)

The owner asked for "everything about the business, ten times more", then
"the financial side, the offers they run, the whole history", "the second they
reach out", built as a system that does it for every applicant (no Claude, no
AI at runtime). What the machine now collects automatically:

| Source (free, no key) | What it gives | Module |
|---|---|---|
| Their whole website: sitemap(s), else every link it can reach; up to `RESEARCH.deepMaxPages` pages, 5 at a time, robots.txt honoured, SSRF-guarded | people + titles, named clients, testimonials, case studies, certifications / partners / awards / ownership, industries, prices, packages, offers and guarantees, calls to action, lead magnets, addresses, open jobs, blog activity, website tools (CMS, analytics, CRM, chat, booking, visitor tracking, ad pixels), schema.org company data | deepsite.js |
| Their PDFs (up to `deepMaxDocs`) | title, pages, words, excerpt, certifications / industries named | deepsite.js `pdfText` (no library: Flate streams + Tj/TJ) |
| DNS | mail host, services allowed to send as them (SPF), DMARC policy, tools that verified the domain (TXT) | webintel.js |
| Wayback Machine CDX | online since, months captured; the home page once a year (title / headline / description) → rebrands and offer changes | webintel.js, bizintel.js |
| RDAP + DNS + HEAD | look-alike domains with mail servers pointing at their site (someone may already cold-email for them) | webintel.js |
| USAspending.gov API | PPP loans (→ 2019 payroll by the SBA formula: loan = 2.5 × monthly payroll), federal contracts, grants, totals — matched by exact name words and state | bizintel.js |
| SEC EDGAR full-text search | filings in their exact name; Form D = private fundraising | bizintel.js |

**Revenue is never a single guessed number.** Small private companies do not
publish it. The file shows a RANGE, each with its basis:
headcount × revenue per employee, and PPP payroll ÷ payroll share of revenue.
Benchmarks (small firms, 5–99 staff): US Census Statistics of U.S.
Businesses 2022 (receipts, payroll, employment by NAICS and firm size,
https://www2.census.gov/programs-surveys/susb/tables/2022/us_state_naics_detailedsizes_2022.xlsx),
with the trade surveys where public (Rosenberg for CPA firms, Zweig 2025 for
AEC, Promethean Research for agencies, Service Leadership for MSPs). The
ranges sit below the Census averages (averages run high; Census leaves owners
and partners out) — judgement recorded in bizintel.js `BENCHMARKS`. Staffing
has no fair figure (Census counts placed temps) and gets no range.

Not used: paid data brokers; LinkedIn (terms); Google Places without the key;
GDELT news (rate-limited to one request per 5 s from shared hosts — too flaky);
state registries (no common free API); OpenCorporates (key required).

Timing: research starts in `after()` of POST /api/apply the moment the form
is sent and hands over to a fresh function (`/api/cron/research`, cron key,
`RESEARCH.maxHops`) until done; the new_application alert goes out at once and
one application_scored alert follows with the score.
