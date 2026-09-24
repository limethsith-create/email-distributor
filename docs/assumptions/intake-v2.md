# Intake v2 — assumptions

These rules continue `stage-a.md` and are numbered on from its last item
(40). Where the v2 brief left a value or rule open, each item says what the
code does and where to change it.

## Intake v2 — Applicant Research (`systems/research.js`, 25 Sep 2026)

41. **When research runs.** Every application that is not declined on the
    spot gets research: website applications held for review, form
    applications that pass or join the queue, and the owner's New client.
    For a website application, research runs inside the same request for up
    to `RESEARCH.inRequestMs` (12 s). If it finishes in that time, the one
    `new_application` alert includes a `Research:` line, plus a `Watch:` line
    for any warn-level flags. If it does not finish, the `research` job
    completes it (every minute while `client.researchStep = running`) and
    **no second alert** is sent.
42. **Crawl.** robots.txt is fetched first, trying `https://domain`, then
    `https://www.domain`, then `http://domain`. The rules come from the
    `AvianceBot` group, or from `*` when there is none; the longest matching
    rule wins. Then the home page is read, followed by about, services, team,
    contact and locations. For each of those it uses the link found on the
    home page, or `/about`, `/services` and so on when there is none.
    Redirects are followed by hand, and every hop is checked with
    `isPublicUrl`. Each page gets 10 s and at most 1 MB; anything that is not
    HTML is skipped. Page fetches are counted in `usage:crawl` (field `pages`).
43. **Extraction rules.**
    - **Services**, in this order: links under `/services/…`, then H2/H3
      headings and list items on the services page, then H3 headings on the
      home page (only when fewer than 3 were found). Menu words, calls to
      action, questions and anything with a pronoun are dropped. At most 6
      words each and 12 in total.
    - **Locations:** "City, ST", "City, State name", and schema.org
      PostalAddress in JSON-LD or microdata. IN, ME, OR, OK, HI, OH and ID are
      also everyday words, so they count only when a ZIP follows.
    - **Team:** at least 2 person cards (by class name), person-name headings
      or schema.org Person entries on the team page. Failing that, the site's
      own "X employees" / "team of X" text or schema `numberOfEmployees`.
    - **Years:** "founded/established/est. YEAR", "since YEAR", schema
      `foundingDate`, or "N years of experience/in business". Future years are
      ignored.
44. **Google Places.** One Text Search for "{client name} {city}". The city is
    the one on the application, or else the first place found on the site.
    The field mask also asks for `websiteUri` (same Enterprise SKU, no extra
    cost) so the right listing can be picked: first by the same website, then
    by a shared name word, otherwise the first result. That last case is
    flagged and never described in the summary. Each lookup is counted as
    `usage:places` `enterprise` and is skipped while the Usage Meter throttles
    Places.
45. **Very new site** means RDAP shows the main domain was registered less
    than `RESEARCH.newSiteDays` (365) days ago.
46. **Market preview.** The customer phrase is the words after the first
    " for " or " to " in their sell-to sentence, skipping verbs and pronouns
    ("to help …"). It is cut at " in / across / who / …" and at commas, and
    kept to 5 words or fewer. The count uses Places IDs-only queries (free):
    "{phrase} in {City, ST}" and "{phrase} in {State}", at most 60 ids each.
    The estimate is unique ids × `MARKET.coverageFactor`, the Market Counter's
    own method. Without a Places key it uses the OpenStreetMap count for the
    state instead. With no phrase or no US place, `market` is null.
47. **Summary.** At most 3 sentences, built only from facts that were found.
    A missing fact drops its clause; nothing is filled in.
48. **Flags.**
    - **warn:** an agency keyword in the site's title, description, headline
      or services, or in their sell-to text or notes; website did not load;
      no US address on the site or in a matched listing; very new domain;
      Google's closest match has a different name.
    - **info:** robots.txt blocks us; site title does not mention the
      company; the Places lookup was skipped (no key or no budget), found
      nothing, or failed.
49. **Failure.** A website problem is only a flag, and the research still
    ends as `done`. An internal error sets `failed` with the error and sends
    one non-urgent `research_failed` alert. During the apply request, the
    failure goes into `new_application` instead. After 15 runs the research
    finishes with whatever it has. The application itself is never affected.
50. **Prefill.** Only empty onboarding fields are filled, and only before the
    agreement is signed:
    - `companyName` and `postalAddress` from a matched Google listing, when
      it is a US address with a ZIP;
    - `cities` from the website (at most 5);
    - `defaultIcp` from the customer phrase.

    On Approve, `cities` becomes the applicant's own city followed by the
    places the website names (at most 5).

## Intake v2 — Domains + inboxes (`systems/domains.js`, `pricescout.js`)

The sources behind every price and fact are in `docs/research/v2-domains.md`.

51. **Candidates.**
    - Brand stems: the whole label joined (`acmeplumbing`), plus its first
      word (`acme`) when there are several words. Stems containing digits are
      dropped.
    - Prefixes: get, try, use, hey, join, with. Suffixes: hq, team, mail, co,
      app, labs, group, usa.
    - Rules: at most 15 letters, letters only, and never the client's own
      domain. A join that doubles a letter or makes "rn"/"vv" is skipped
      ("fixtechhq").
    - TLDs: .com, then .net, then .co, intersected with `ALLOWED_TLDS` minus
      `BANNED_TLDS`.
52. **Score** starts at 50, then:
    - length: +15 at 8 letters or fewer, +10 at 10 or fewer, +5 at 12 or fewer;
    - the affix's weight from `DOMAINS.affixWeights` (get +8, hq +7, try/team +6, …, mail −2);
    - +5 when it uses the full brand;
    - .com +20, .net +8, .co +4;
    - −30 for a spam word and −40 for a big-brand look-alike, but only when
      the affix adds it. The client's own brand is never held against them.

    The result is clamped to 0–100, and `why` lists the parts.
53. **Availability.** Porkbun `checkDomain` when keys exist (premium names
    count as unavailable), otherwise RDAP (404 = free). Answers are cached in
    `intake:rdapcache`: free for 12 h, taken for 7 days. A 429 sets a 120 s
    back-off, and the list continues next minute. Names with unknown
    availability are only used to reach 5 offers, and they are flagged.
54. **Offers.** Names are checked in score order until 8 free ones are known.
    The list waits for that (at most 10 runs) and then goes out with what is
    known.
55. **Prices.** They come from the `REGISTRARS` table (with `checkedAt`) and
    from Porkbun's keyless price list. Porkbun is refreshed on every shopping
    list and monthly (job `registrar-prices`, 1st of the month at 09:10 ET).
    A live price is trusted for 40 days. Table rows older than
    `DOMAINS.tableMaxAgeDays` (35) are listed as unconfirmed; the .com
    wholesale price rises on 1 Nov 2026. `best` is the cheapest first-year
    list price; promo codes are shown but never counted. A tie goes to the
    cheaper renewal. Registrars appear in one stable order everywhere,
    cheapest .com first. `best.url` (the registrar's search link with the
    name filled in) and `best.promo` are extra fields on top of the HUB shape.
56. **Inboxes: CheapInboxes only.** The tier is set by the account's active
    mailboxes (2 → $3.50). Both inboxes carry the sender's full name, and
    their addresses are built as in v1 (`{prefix}@`, then first initial +
    last name). The steps recommend the Cloudflare DNS route, so DNS stays in
    the owner's hands for the setup checks. The API exists but is not used,
    no free warm-up is included, and app passwords must be confirmed with
    support before the first order.
57. **v1 leftovers.** The v1 tables (`registrars`, `inboxProviders`,
    `PRICE.candidatePatterns`) and v1 helpers (`candidateDomains`,
    `registrarQuotes`, `inboxQuotes`, `buildShoppingList`,
    `checkAvailability`) stay for reference and the Stage A tests. The v1
    fields of the shopping hash (`chosenDomain`, `backups`,
    `registrarQuotes`, `inboxQuotes`, `senderAddresses`, `total`,
    `unconfirmed`) are filled from the v2 data.
58. **New owner alert:** `research_failed` (not urgent).
