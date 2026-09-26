# Hub ↔ Machine contract

The Aviance Hub (`limethsith-create/aviance-hub`, live at https://aviance.store,
one static HTML page signed in through Supabase) is the owner's command
centre. The trial machine (this repo, `email-distributor`) keeps running where
its database is. The hub's **Trials** section talks to the machine through
the endpoints below.

## Auth

Every `/api/mc/*` request from the hub carries the hub user's Supabase access
token: `Authorization: Bearer <supabase access_token>`. The machine verifies
it against the Supabase project's public signing keys (JWKS, ES256), checks it
has not expired, and checks the token's `email` is an allowed admin
(`HUB_ADMIN_EMAILS`, default `limethsith@gmail.com`). Nothing else is needed
— no ADMIN_SECRET in the hub.

CORS: the machine answers `/api/mc/*` for the origins in `HUB_ORIGINS`
(default `https://aviance.store,https://aviance-hub.vercel.app`) and handles
`OPTIONS` preflights. Cookies are not used cross-site.

Errors: `401 {error:'Unauthorized'}` (bad/expired token, not an admin),
`403 {error:'...'}`, `503 {error:'...'}` when the machine is not configured
yet (e.g. ENC_KEY missing). The hub shows the `error` text as-is.

### Opening a Mission Control page from the hub (single sign-on)

For screens that stay in the machine (config, warm-up circle, test mode,
sequence editor, queue), the hub opens them signed in by POSTing a plain HTML
form (target `_blank`) to `POST /api/mc/login` with fields
`hubToken=<supabase access_token>` and `next=/mc/...`. The machine verifies
the token the same way, sets its own admin session cookie and redirects
(303) to `next`. This needs `ADMIN_SECRET` set on the machine (the cookie is
signed with it); otherwise it answers 503 with a plain-text explanation.

## `GET /api/mc/hub` — everything the Trials board needs (one call)

```jsonc
{
  "machine": {
    "ok": true,
    "baseUrl": "https://email-distributor.vercel.app",
    "heartbeat": { "lastTickAt": "ISO|null", "ageSec": 42, "source": "cronjob|github|null", "lastSendAt": "ISO|null" },
    "activeTrials": 1, "maxActiveTrials": 3, "extensions": 0,
    "openAlerts": 2,
    "usage": { "redis": {"used":123,"limit":500000,"pct":0}, "places": {...}, "reoon": {..., "remaining": 12} },
    "setup": { "migrated": true, "encKey": true, "cronSecret": true, "telegram": false, "healthchecks": false, "ownerInbox": true },
    "queue": [ { "id": "acme", "name": "Acme", "position": 1, "expectedDate": "2026-10-20" } ]
  },
  "stages": [
    { "key": "intake",   "label": "Applied & queued",  "states": ["applied","queued"],                 "clients": [ /* row */ ] },
    { "key": "onboard",  "label": "Onboarding",        "states": ["onboarding"],                       "clients": [] },
    { "key": "setup",    "label": "Buying & setup",    "states": ["awaiting_purchase","setup_check"],   "clients": [] },
    { "key": "build",    "label": "Warm-up & build",   "states": ["warming","ready"],                  "clients": [] },
    { "key": "live",     "label": "Sending",           "states": ["sending","paused","extension"],     "clients": [] },
    { "key": "decide",   "label": "Deciding",          "states": ["deciding"],                         "clients": [] },
    { "key": "won",      "label": "Converted",         "states": ["converted"],                        "clients": [] },
    { "key": "closing",  "label": "Not now & closing", "states": ["not_now","retired"],                "clients": [] },
    { "key": "ended",    "label": "Ended",             "states": ["declined","closed_silent","deleted"], "clients": [] }
  ],
  "todos": [ /* every row.todo item, flattened, with clientId + clientName, urgent first */ ],
  "alerts": [ /* last 50 open (unacknowledged) alerts: {id, at, key, clientId, title, urgent, delivered} */ ]
}
```

`aviance` (the owner's own outreach) and `_test` (Test Mode) are returned
under `machine.others: [row]`, not inside `stages`.

### Client row (board card)

```jsonc
{
  "id": "acme-plumbing", "name": "Acme Plumbing", "state": "sending",
  "stateLabel": "Sending — Day 12 of 30",      // human wording, ready to print
  "plan": "trial", "trialDay": 12, "day1Date": "2026-10-06", "day30Date": "2026-11-04",
  "contactName": "Ann Lee", "contactEmail": "ann@acme.com", "website": "https://acme.com",
  "health": "green|yellow|red", "healthReasons": ["..."],
  "five": { "sent": 230, "replies": 9, "positive": 4, "booked": 2, "qualified": 1 },   // null = not tracked yet
  "inboxRate": 0.91,                         // lowest inbox warm-up inbox rate, null before warm-up
  "openAlerts": 1, "urgentAlerts": 0,
  "todo": [ /* todo items for this client, see below */ ],
  "systems": [ /* 12 system cards, see below */ ],
  "nextUp": { "date": "2026-10-17", "what": "Friday update" }   // next dated milestone or null
}
```

### To-do item ("what you're supposed to do")

```jsonc
{
  "id": "buy:acme-plumbing",
  "text": "Buy acme-team.com and 2 inboxes, then paste the logins",
  "detail": "Shopping list sent 14 h ago · Porkbun $9.13 + Premium Inboxes 2 × $3.50",
  "urgent": true,
  "since": "ISO",                     // when this became due
  "action": { "type": "view", "view": "purchase" }
}
```

Action types the hub must handle:

| type | fields | hub behaviour |
| --- | --- | --- |
| `api` | `method`, `path`, `body`, `confirm?` (text) | ask `confirm` if present, call the machine, then reload |
| `view` | `view` (`purchase` \| `detail` \| `sequence`), `clientId` | open the hub's own screen for it |
| `mc` | `path` (e.g. `/mc/config`) | open the machine page signed in (SSO form POST) |
| `link` | `url` | open in a new tab |
| `none` | — | informational only |

### System card (the per-client "systems, duplicated per client")

```jsonc
{ "key": "warmup", "label": "Warm-up", "status": "working", "line": "Day 9 of 14 · inbox rate 91% · 2 inboxes", "detail": ["inbox a@x.com 92%", "inbox b@x.com 90%"] }
```

`status`: `ok` (done/green) · `working` (running as expected) · `waiting`
(waiting on the owner or the client) · `blocked` (needs a fix) · `off` (not
yet at this stage). Keys, in order: `intake`, `market`, `purchase`, `setup`,
`warmup`, `list`, `copy`, `canary`, `sending`, `replies`, `calls`, `reports`,
`closing`.

## `GET /api/mc/hub/[id]` — one trial in full

Everything in the row above plus:

```jsonc
{
  "row": { /* the row */ },
  "profile": { /* client:{id}:profile, arrays as arrays */ },
  "trial": { /* client:{id}:trial */ },
  "domain": { "name": "...", "setupPhase": "passed|failed|null", "checks": { "spf": {"status":"pass|fail|warn|pending","detail":"..."}, ... }, "dmarcPassRate7d": 0.98, "blacklist": "clean|listed|null", "retiredAt": null },
  "shopping": { "chosenDomain": "...", "backups": [], "registrarQuotes": [], "inboxQuotes": [], "total": 16.13, "sentAt": "...", "boughtAt": null, "unconfirmed": [] },
  "inboxes": [ { "email": "...", "displayName": "...", "provider": "google", "enabled": "1", "dailyCap": "12", "warmupStartedAt": "...", "inboxRate7d": 0.91, "canaryPlacement": 0.9, "health": "ok|warning", "disabledReason": null, "hasPassword": true } ],
  "leadsByStatus": { "unsent": 380, "in_sequence": 120, "replied": 9, "bounced": 3, "suppressed": 2, "notnow": 1, "done": 30 },
  "leadfinder": { "status": "...", "lastRunAt": "...", "found": 412, "need": 400 },
  "sequence": { "active": "both", "version": 1, "approvedAt": "...", "approvalMode": "click|silence|null", "round": 0, "changes": [] },
  "counters": { /* counters:total */ },
  "repliesByKind": { "interested": 4, "question": 2, ... },
  "replies": [ { "id", "kind", "leadEmail", "receivedAt", "snippet" } ],   // newest 50
  "bookings": [ { "id", "leadEmail", "scheduledAt", "status", "qualified", "tapped", "disputeReason" } ],
  "pacelog": [ { "at", "day", "test", "fix" } ],
  "reports": [ { "name": "friday:2026-10-10", "renderedAt": "...", "blockedReason": null } ],
  "invoice": { "number": "AV-202611-acme", "amount": 2497, "issuedAt": "ISO", "paidAt": "ISO|null", "dueDate": "YYYY-MM-DD",   // due the day it is issued
               "remindersSent": 0, "plan": "starter", "calls": 10, "bonus": true, "status": "sent|paid|blocked", "sentAt": "ISO|null", "blockedReason": null } | null,
  "promises": [ { "id", "text", "dueAt", "doneAt" } ],
  "upcoming": [ { "date", "time", "what" } ],
  "events": [ { "at", "system", "event", "detail" } ],   // newest 150
  "jobs": { "send": { "at", "ms", "ok", "error" }, ... },
  "holds": { "legalHoldAt": null, "sendHold": null, "emergencyActive": false, "emergencyHalved": false, "pausedReason": null },
  "links": { "onboarding": "https://.../c/<token>/onboard", "approval": "...", "decision": "..." }   // current client links where they exist
}
```

`links`: tokens are stored hashed, so the machine keeps the LAST link of
each purpose it emailed the client (the acceptance email and its resends, the
onboarding reminders, the reply bot's answer; the approval emails; the Day 29
report and the Day 30 email) on the trial hash (`onboardingLink`,
`approvalLink`, `decisionLink` + `…LinkAt`) and returns it here while its
token still works. A link whose token expired, was replaced or used up drops
out; a purpose with no link sent yet is absent.

## Actions the hub calls (all existing; JSON bodies)

| What | Call |
| --- | --- |
| New client (pre-approved) | `POST /api/mc/clients/new` `{companyName, contactName, contactEmail, website, override?}` → `{ok, clientId, outcome}` or `400 {ok:false, errors:{field: message, _form?: message}}` |
| Profile edit | `POST /api/mc/clients/{id}` `{action:'profile', fields:{senderName, senderTitle, senderPrefix, postalAddress, calendarUrl, defaultNiche, defaultIcp, sellsTo, industry, capacityPerWeek, winCondition}}` |
| Add / remove / switch inbox | `POST /api/mc/clients/{id}` `{action:'addInbox', email, password, displayName, provider}` · `{action:'removeInbox', email}` · `{action:'inboxEnabled', email, enabled}` |
| Pause / resume / any state move | `POST /api/mc/clients/{id}` `{action:'setState', to, reason}` |
| Run a job now | `POST /api/mc/clients/{id}` `{action:'runJob', job}` |
| Owner note / promise | `{action:'addNote', text, dueDate?}` · `{action:'completePromise', promiseId}` |
| Mark inboxes cancelled | `{action:'inboxesCancelled'}` |
| Mark paid | `{action:'markPaid'}` |
| Clear legal hold / send hold | `{action:'clearLegalHold'}` · `{action:'clearSendHold'}` |
| Review captured / log owner time | `{action:'reviewCaptured'}` · `{action:'logTime', minutes}` |
| Purchase page data / paste logins | `GET /api/mc/clients/{id}/purchase` · `POST` `{domain, registrar?, price?, autoRenewOff:true, inboxes:[{email,password,displayName}]}` |
| Intake actions | `POST /api/mc/clients/{id}/intake` `{action:'marketOverride'|'rerunMarket'|'rerunPriceScout'|'rerunSetup'|'rerunBookingTest'|'resendWelcome'}` |
| Copy / build | `GET /api/mc/clients/{id}/sequence` · `POST` `{action:'save'|'rebuild'|'setActive'|'sendLink'|'resend'|'blocklist'|'dispatch', ...}` |
| Disputes | `GET /api/mc/clients/{id}/bookings` → `{bookings, pacelog, hot}` · `POST` `{bookingId, action:'uphold'|'overturn'}` |
| Queue | `GET /api/mc/queue` · `POST` `{action:'promote'|'decline', clientId, reason?}` |
| Alerts | `GET /api/mc/alerts` → `{alerts}` · `POST` `{action:'ack', id}` |
| Setup (first-time) | `POST /api/mc/setup` `{action:'migrate'|'test-alert'}` |
| Config | `GET /api/mc/config` → `{settings:[{key, default, value, overridden, toSet}]}` · `POST` `{action:'set', key, value}` / `{action:'reset', key}` |
| Warm-up circle | `GET /api/mc/warmup` · `POST` `{action:'addHelper'|'testHelper'|'removeHelper'|'helperEnabled', ...}` (see "Warm-up in the hub" below) |
| Test Mode | `GET /api/mc/test` · `POST` `{action:'start', from}` / `reset` / `{action:'jump', day}` / `{action:'simulate', kind}` / `tick` |

Every state name → plain label (for the hub): applied "Applied", queued
"In the queue", onboarding "Onboarding", awaiting_purchase "Waiting for you to
buy", setup_check "Checking the setup", warming "Warming up", ready "Ready for
Day 1", sending "Sending", paused "Paused", extension "Free extension",
deciding "Deciding", converted "Converted", not_now "Not now", retired
"Retired", deleted "Deleted", declined "Declined", closed_silent "Never
finished onboarding".

## Trial applications from the website

aviance.online/trial.html posts its form to `POST /api/apply` (CORS for
`SITE_ORIGINS`, default `https://www.aviance.online,https://aviance.online`).
The site asks different questions from the Gatekeeper's, so a website
application is saved in state `applied` and **held for the owner**
(`systems/webapply.js`): the owner gets `new_application` (email + Telegram),
the hub gets a to-do `review:{id}` → detail section `application`, and
nothing reaches the applicant until the owner decides.

`GET /api/mc/hub/{id}` → `application` (null when none):
```jsonc
{ "receivedAt": "ISO", "source": "website|form|owner", "review": "pending|approved|declined|null",
  "decidedAt": "ISO|null", "decision": "approve|decline|null", "declineReason": "text|null",
  "answers": [ { "q": "What do you sell, and who to?", "a": "…" } ],
  "fit": { "verdict": "fit|fails", "summary": "Looks like a fit — 3 checks unknown",
           "lines": [ { "rule": "deal_value", "label": "Customer worth ≥ $2,000 in year one", "status": "pass|fail|unknown", "note": "They said $5,000–$20,000" } ] } }
```
Owner actions: `POST /api/mc/clients/{id}/intake` `{action:'approveApplication'}`
→ `{ok, outcome:'onboarding'|'queued'|'declined'}` (the repeat rule and the
3-trial cap still apply; `onboarding` = the one `accepted_call` email went out,
see "Onboarding call" below; if that email cannot go, the answer is a 500 with
the reason and the application is waiting again) · `{action:'declineApplication', reason}` →
`{ok, outcome:'declined'}`; the reason is emailed to the applicant
(`decline_fit`), 400 when empty.

---

# v2 additions (2026-09-25) — research, domains, warm-up, placement, leads, growth

Every field below is additive; the hub must render gracefully when a field is
missing or null (older clients, a system that has not run yet).

## Growth — `GET /api/mc/hub/{id}/growth?days=45` (7–90)

Load it **only when the Growth tab is opened** (it costs ~days×(2+inboxes)
Redis reads) — never on the 60-second auto-refresh.

```jsonc
{ "days": ["2026-09-01", …],                        // oldest → today (ET)
  "email":  { "sent": [n|null…], "sentD0": […], "replies": […], "positive": […], "booked": […], "held": […], "qualified": […], "bounces": […] },
  "warmup": { "sent": […], "inbox": […], "spam": […], "rate": [0.93|null…] },   // rate = 7-day rolling inbox/(inbox+spam)
  "inboxes": [ { "email": "…", "dailyCap": 12|null, "warmupStartedAt": "ISO|null", "sent": […], "rate": […] } ],
  "placement": [ { "day": "…", "at": "ISO", "tool": "seed|mail-tester|dkimvalidator", "inboxRate": 0.9|null, "score": 9.1|null, "spamAssassin": 1.2|null, "min": 0.8|null, "perProvider": {…}|null, "perInbox": {…}|null } ] }
```
`null` in a series = nothing recorded that day (draw a gap). On a recorded day a
counter that did not move is `0`. `score` is mail-tester's /10; dkimvalidator
gives a SpamAssassin score (`spamAssassin`, lower is better, ≥ 5 = spam).

## Applicant research — `application.research` (in `GET /api/mc/hub/{id}`)

Built automatically when an application arrives (website crawl + Google
Places + a quick market count). No AI: extracted facts only. Re-run:
`POST /api/mc/clients/{id}/intake {action:'rerunResearch'}`.
```jsonc
"research": {
  "status": "pending|done|failed", "at": "ISO", "error": "text|null",
  "summary": "Acme Plumbing is a commercial plumbing company in Charlotte, NC (4.7★, 128 Google reviews) …",
  "website": { "url": "…", "title": "…", "description": "…", "headline": "…", "services": ["…"], "locations": ["Charlotte, NC"], "phones": ["…"], "emails": ["…"], "socials": { "linkedin": "…", "facebook": "…" }, "teamHint": "12 people on the team page|null", "yearsHint": "Since 2009|null", "pagesRead": 4 },
  "business": { "name": "…", "address": "…", "category": "Plumber", "rating": 4.7, "reviews": 128, "mapsUrl": "…", "phone": "…" } | null,
  "market": { "query": "property management companies in Charlotte, NC", "estimate": 1450, "source": "places|overpass" } | null,
  "flags": [ { "level": "warn|info", "text": "Website mentions 'appointment setting' — could be an agency" } ],
  "score": {                                          // Fit Score (systems/fitscore.js), null until research is done
    "score": 82 | null,                               // points earned out of the points that could be checked, 0–100
    "grade": "A|B|C|D" | null,                        // A ≥ 80, B ≥ 65, C ≥ 50 (FITSCORE.grades); any dealbreaker → D
    "label": "Strong fit|Good fit|Borderline|Poor fit|Not a fit|Needs a look",
    "confidence": 74,                                 // how many of the 100 points could be checked
    "summary": "82/100 — strong fit (74 of 100 points checked). Strongest: …; weakest: ….",
    "parts": [ { "key": "b2b|deal|size|proof|market|ready", "label": "Sells to businesses", "points": 18, "checked": 20, "max": 20, "pct": 90 | null,
                 "items": [ { "text": "Website talks to businesses (9 mentions)", "status": "good|ok|bad|unknown", "max": 12, "points": 12 | null,
                              "evidence": { "quote": "sentence from their site", "page": "/services" } | null, "known": true } ] } ],
    "dealbreakers": [ { "text": "Sells cold outreach themselves (“cold email”) — a competitor", "evidence": { "quote": "…", "page": "/" } | null } ],
    "questions": [ "How many people work at the company?" ]   // one per unknown, for the call
  }
}
```
`research.deep` — the full company file (Research v3, systems/deepsite.js,
webintel.js, bizintel.js), null when the deep pass did not run:
```jsonc
"deep": {
  "facts": 212, "pagesRead": 48, "sitemapPages": 130, "words": 31240,
  "people": [ { "name": "Jane Hill", "title": "Founder & CEO", "page": "/team" } ],
  "clients": [ { "name": "Smith & Lowe Law", "page": "/" } ], "testimonials": [ { "quote": "…", "by": "Ann Lowe", "page": "/" } ],
  "caseStudies": [ { "title": "…", "page": "/case-studies/x" } ], "industries": ["law firms"],
  "credentials": [ { "name": "SOC 2", "quote": "…", "page": "/about" } ], "prices": [ { "text": "$129 per user per month", "page": "/pricing" } ],
  "addresses": ["100 Main St, Charlotte, NC 28202"], "jobs": [ { "title": "Account Executive", "sales": true, "page": "/careers" } ],
  "blog": { "posts": 30, "dated": 28, "first": "2019-02-01", "latest": "2026-08-01", "recent": [ … ] },
  "tech": [ { "name": "HubSpot", "kind": "crm / marketing" } ], "forms": 6, "ads": ["Meta Pixel"],
  "company": { "name": "Hill IT", "founded": "2011", "employees": 18, "rating": null, "reviews": null } | null,
  "documents": [ { "url": "…pdf", "title": "Capabilities", "pages": 2, "words": 800, "credentials": ["CMMC"], "industries": [], "excerpt": "…" } ],
  "offers": { "ctas": ["Get a free network assessment"], "promos": [ { "offer": "No long-term contracts", "quote": "…", "page": "/pricing" } ],
              "magnets": [ { "title": "…guide", "page": "/" } ], "plans": [ { "name": "Essentials", "price": "$99 per user / month", "page": "/pricing" } ] },
  "emailSetup": { "mailHost": "Microsoft 365", "mailHosts": […], "spf": true, "senders": ["HubSpot"], "dmarc": "quarantine|none|reject|missing", "verifiedTools": ["DocuSign"] } | null,
  "history": { "firstSeen": "2012-03-04", "lastSeen": "…", "monthsCaptured": 120, "years": 14 } | null,
  "timeline": [ { "year": 2012, "date": "2012-06-01", "title": "…", "headline": "…", "description": "…", "url": "https://web.archive.org/web/…", "changed": ["title"] } ],
  "lookalikes": [ { "domain": "gethillit.com", "registeredAt": "…", "mail": true, "pointsHome": true } ],
  "money": {
    "federal": { "searched": ["Hill IT"], "state": "NC", "ppp": [ { "amount": 150000, "date": "2020-04-20", "forgiven": true, "recipient": "HILL IT LLC" } ] | null,
                 "payroll": { "annual": 720000, "fromLoan": 150000, "loanDate": "…", "basis": "…" } | null,
                 "contracts": [ { "amount": 250000, "agency": "…", "date": "…", "what": "…" } ] | null, "grants": [ … ] | null, "federalTotal": 250000 | null, "errors": [] } | null,
    "sec": { "total": 0, "filings": [ { "form": "D", "date": "…", "entity": "…", "url": "…" } ], "raisedMoney": false } | null,
    "revenue": [ { "low": 2520000, "high": 4500000, "basis": "18 people × $140,000–$250,000 revenue per employee …", "floor": false, "year": 2019 } ] | null,
    "benchmark": "IT services / MSPs" | null
  }
}
```
Research runs the moment an application arrives (after() in /api/apply,
RESEARCH.* limits) and hands over to a fresh function when it needs more time
(`POST /api/cron/research?client=&hop=`, cron key, RESEARCH.maxHops).

The board row of an applicant under review carries the short form:
`row.fitScore = { score, grade, label, confidence } | null`, and the review
to-do's detail says "fit score 82/100 (Strong fit)". When research finishes
after the `new_application` alert, one `application_scored` alert follows.

## Domains + inboxes — `shopping` (in `GET /api/mc/clients/{id}/purchase` and `GET /api/mc/hub/{id}`)

```jsonc
"shopping": {
  …existing fields…,
  "offers": [ { "domain": "getacme.com", "tld": "com", "available": true, "score": 92, "why": "short, brand + 'get', .com",
                "prices": [ { "registrar": "Cloudflare", "firstYear": 10.44, "renewal": 10.44, "promo": null, "url": "https://…", "confirmedAt": "ISO|null", "source": "live|table" } ],
                "best": { "registrar": "Porkbun", "firstYear": 9.73, "renewal": 11.08, "url": "registrar search link with the name filled in", "promo": "code|null" } } ],      // best 5–8 names, best first
  "registrars": [ { "name": "Porkbun", "why": "…", "url": "…" } ],                                   // the 5 compared, cheapest .com first
  "inboxes": { "provider": "CheapInboxes", "url": "https://cheapinboxes.com", "perInbox": 3.50, "count": 2, "monthly": 7.00, "notes": "…", "steps": ["…"] },
  "totals": { "domainFirstYear": 9.73, "inboxesMonthly": 7.00, "firstMonth": 16.73 }
}
```

## Deliverability — `deliverability` (in `GET /api/mc/hub/{id}`)

```jsonc
"deliverability": {
  "warmup": { "pool": 14, "helpers": 10, "providers": { "gmail": 4, "yahoo": 2, … }, "todayPairs": 11, "external": { "name": "…", "status": "connected|not connected" } | null },
  "placement": [ { "at": "ISO", "tool": "mail-tester|seed", "score": 9.1, "inboxRate": 0.9, "detail": ["SPF pass", "DKIM pass", …], "reportUrl": "https://…|null" } ],   // newest first, max 10
  "blacklists": { "checkedAt": "ISO", "listed": ["…"], "clean": 7, "lists": ["bl.spamcop.net", …] },
  "bounce": { "rate7d": 0.012, "pauseAt": 0.015, "stopAt": 0.02 },
  "gates": { "seedPlacement": 0.85, "mailTesterMin": 8, "spamAssassinMax": 2, "spamTestRequired": true }   // the Day 1 limits (from config)
}
```

## Lead quality — `leadQuality` (in `GET /api/mc/hub/{id}`)

```jsonc
"leadQuality": {
  "graded": 812, "grades": { "A": 140, "B": 210, "C": 90, "rejected": 372 },
  "sendable": 350,                                   // A+B that passed verification
  "verification": { "valid": 330, "risky": 40, "catchall": 25, "invalid": 60, "unknown": 12, "pending": 30, "budgetLeftToday": 45 },
  "rejectReasons": [ { "reason": "Role address (info@)", "count": 120 }, … ],
  "sources": [ { "source": "google-places", "count": 600 }, … ],
  "sample": [ { "email": "…", "name": "…", "title": "…", "company": "…", "city": "…", "grade": "A", "score": 87, "reasons": ["Owner title", "Verified email", "Matches dream customer"] } ]   // top 25
}
```

## Phone alerts (Web Push)

Every owner alert is also pushed to the owner's phones (the hub installed on
the home screen; iOS 16.4+). Under `/api/mc/push/*`, same auth as the rest:
`GET key` → `{publicKey}` (503 without VAPID keys) · `POST subscribe {subscription, device}` →
`{ok, count}` · `POST unsubscribe {endpoint}` · `GET status?endpoint=` → `{subscribed, count}` ·
`POST test {endpoint?}` → `{ok, sent, failed}`. Payload: `{title, body, url, tag, urgent, at}`;
`url` is `/#trial/{id}` or `/#alerts`; the same `tag` replaces the previous notification.

## Plan inquiries (paid plans, no trial)

The website's "Book a call" form posts to public `POST /api/inquiry` (CORS for
SITE_ORIGINS). Each inquiry is saved, the owner gets `new_inquiry` (phone push
+ email; push `url` = `/#inquiry/{id}`), and nothing is sent to the enquirer.

`GET /api/mc/hub` adds `inquiries: { counts: {new, contacted, won, lost}, open, latest: [ {id, at, name, company, plan, status, slotStart, whenHost} ] }`
and, for each `new` one, a to-do `{ id: "inquiry:{id}", clientName: company, urgent: true, action: { type: "view", view: "inquiry", inquiryId } }`.

`GET /api/mc/inquiries` → `{ inquiries: [record…] (newest first), counts }` where a record is
`{ id, at, source, status: new|contacted|won|lost, statusAt, notes: [{at, text}], name, email, company, website, sells, plan: starter|growth|scale|null, slotStart, slotEnd (ISO), theirTz, whenTheirs, whenHost (text, owner's time), clientId?, trialOutcome? }`.
`POST /api/mc/inquiries` `{action:'status', id, status, note?}` · `{action:'note', id, text}` · `{action:'toTrial', id}` (runs the Gatekeeper pre-approved → the accepted_call email or queue; returns `{ok, clientId, outcome}`).

---

# Onboarding call + the simple Trials status (2026-09-25)

Contract: docs/ONBOARD-CALL.md. Every field is additive.

When the owner says yes (Approve, New client, a plan inquiry turned into a
trial, a queue slot opening) the applicant gets ONE email, `accepted_call`
("You're in — let's book your onboarding call": the booking link or "reply
with two or three times", plus the one-page onboarding link) from the
ONBOARDCALL inbox (config `ONBOARDCALL.inbox`; null → the owner sender). The
machine then tracks the call and collects the conversation.

## `GET /api/mc/hub` — every row gains `simple`

The ONLY status the simple Trials list shows:
```jsonc
"simple": {
  "step": "new|accepted|call_booked|setting_up|warming_up|sending|deciding|finished|declined|queued",
  "label": "Accepted — waiting for them to book the call",   // one plain sentence
  "next": "Nothing for you: we remind them tomorrow",        // what happens next / what the owner must do
  "needsYou": true,                                          // red dot + top of the list; then `next` is what to do, never "Nothing for you"
  "since": "ISO|null",                                       // when this step started
  "person": "Sam Test|null", "company": "eCreek IT",
  "dayOf30": 12 | null                                       // only while sending / extension (can pass 30 in an extension)
}
```
`needsYou` is true for a new application to review, a reply to answer, an
overdue booking, a call to mark done/no-show, domain buying, a failed domain
check, a "talk to someone" request, and anything in the row's `todo` marked
urgent. Whenever it is true, `next` is the thing to do (for an urgent alert:
"Read the angry reply and mark it as seen"). Times in labels are the owner's
(Sri Lanka) time. `step` `deciding` = Day 30 has passed and their decision
is pending ("Trial finished — waiting for their decision", next "Nothing.
Dana chooses on the decision page."); the hub draws it at the same place as
`finished`, which stays for after the decision.

Rows of trials with an onboarding call may also carry these to-dos
(`action: {type:'view', view:'detail', clientId, section:'onboardCall'}`, all
urgent): `onboard-reply:{id}` (they replied, not answered yet),
`onboard-overdue:{id}`, `onboard-mark:{id}` (the call time has passed).

## `GET /api/mc/hub/{id}` gains `onboardCall`

`null` when no acceptance email was sent (older clients got the plain
onboarding link; "resend" below starts the onboarding call for them).
```jsonc
"onboardCall": {
  "status": "sent|opened|replied|booked|held|no_show|overdue|stopped",
  "label": "Email sent — waiting for them to book",           // plain words
  "sentAt": "ISO", "openedAt": "ISO|null", "lastReplyAt": "ISO|null",
  "bookedFor": "ISO|null",          // null while booked = the confirmation had no readable time
  "bookedAt": "ISO|null", "bookedBy": "calendar|owner|null",
  "heldAt": "ISO|null", "dueBy": "ISO", "overdue": false,
  "remindersSent": 1, "nextReminderAt": "ISO|null", "stopped": false,
  "bookingUrl": "https://…|null", "fromInbox": "hello@…",
  "noShowAt": "ISO|null", "stoppedAt": "ISO|null", "lastOwnerReplyAt": "ISO|null",
  "needsReply": true,               // their last message came after the owner's last reply (and after any booking)
  "callMinutes": 30,
  "steps": [ { "key": "sent|opened|replied|booked|held", "label": "Acceptance email sent", "done": true, "at": "ISO|null" } ],
  "thread": [ { "id": "…", "dir": "out|in", "at": "ISO", "from": "…", "to": "…", "subject": "…",
                "text": "plain text, ≤ 4 000 chars (quoted history cut)", "kind": "acceptance|reminder|reply|owner_reply|booking" } ]   // oldest first
}
```
`status` is worked out from the stored times: held > no_show > booked >
stopped > overdue > replied > opened > sent.

## `POST /api/mc/clients/{id}/onboard-call`

One of:
- `{ action: 'reply', text }` — plain text, ≤ 2 000 characters; sent from the
  ONBOARDCALL inbox to the applicant, `In-Reply-To` their last message (else
  our last one), `References` the whole conversation; the owner's name is
  added as a sign-off unless his last line already has it. A double click
  within 2 minutes sends once.
- `{ action: 'markBooked', when: ISO }` — the call time (±30/180 days from now)
- `{ action: 'markHeld' }` · `{ action: 'markNoShow' }` (needs a booked call)
- `{ action: 'resend' }` — the acceptance email again, same thread, a fresh
  onboarding link (the old one keeps working); reminders and the booking
  deadline restart from now. Only while the client is `onboarding`.
- `{ action: 'stopReminders' }`

→ `{ ok, onboardCall }` · `400 {error}` (bad input, plain words) · `409
{error}` (nothing sent yet / no booked call / past onboarding) · `404`.
`GET` on the same path → `{ onboardCall }`.

## `POST /api/mc/onboard-calls/check`

Call it when the Trials screen or a trial opens (the heartbeat is not running
yet). Reads the ONBOARDCALL inbox (replies + calendar confirmations), sends the
reminders that are due, raises overdue alerts. Throttled to
`ONBOARDCALL.checkEveryMinutes` (shared with the `onboard-calls` job and the
check that runs right after Approve), so calling it on every open is fine.
→ `{ ok, checked, newReplies, booked, remindersSent, skipped?: 'too soon', error? }`
(`ok: false` + `error` when the inbox could not be read; reminders still ran).
Reload the board / trial after it when `newReplies` or `booked` > 0.

Owner alerts (phone + email, not urgent): `onboard_reply`, `onboard_booked`,
`onboard_overdue`, `onboard_cancelled`; push `url` = `/#trial/{id}`.

---

# Calendar (2026-09-25)

Contract: docs/CALENDAR.md (its "as built" section lists every decision).
Every meeting from anywhere is in one calendar: times the applicants ask for
on the machine's booking page, the owner's "Mark call booked", calendar
invites found in the onboarding inbox, meetings he adds, and busy blocks.
Times are UTC ISO; each meeting also carries ready-made labels in Sri Lanka
time, US Eastern and their zone.

## `GET /api/mc/calendar?from=ISO&to=ISO[&all=1]`

Defaults: `from` = now − 1 day, `to` = `from` + `CALENDAR.daysAhead` days
(at most 62 days). `400 {error}` when `to` ≤ `from`.
```jsonc
{
  "meetings": [ meeting ],        // held time in [from, to), by start; declined + cancelled only with all=1
  "requests": [ meeting ],        // every request still waiting for a yes (any date), oldest ask first
  "settings": { "hours": ["09:00","17:00"], "days": [1,2,3,4,5], "slotMinutes": 30, "ownerZone": "Asia/Colombo",
                "usZone": "America/New_York", "meetingLink": null,
                "bufferMinutes": 15, "maxPerDay": 6, "minNoticeHours": 12, "daysAhead": 14, "callMinutes": 30,
                "googleMeet": "not_set_up|ready_to_connect|connected|broken" },
  "free": [ { "start": "ISO", "minutes": 30 } ]   // open times in the range: call hours, buffer, maxPerDay (no notice period)
}
```
`meeting`:
```jsonc
{
  "id": "m…", "clientId": "ecreek|null", "company": "eCreek IT|null", "person": "Sam Test|null", "email": "…|null",
  "kind": "onboarding|other", "title": "Onboarding call — eCreek IT",
  "start": "ISO", "end": "ISO", "minutes": 30,
  "status": "requested|confirmed|held|no_show|declined|cancelled|blocked",
  "source": "booking_page|owner|inbox|onboard_card",
  "theirZone": "America/Denver|null", "note": "…", "declineReason": "…|null", "cancelReason": "…|null",
  "proposed": "ISO|null",         // the owner's suggestion, waiting for them: the time HELD is `proposed` — draw it there
  "createdAt": "ISO", "updatedAt": "ISO", "requestedAt": "ISO|null", "confirmedAt": "ISO|null", "sequence": 0,
  "meetLink": "https://meet.google.com/…|null",   // Google Meet: show a big "Join Google Meet" button
  "googleEventId": "…|null",                      // its event on the owner's Google Calendar
  "meetError": "Google isn't connected|null",     // no link: show "No Meet link — {meetError}"
  "history": [ { "at": "ISO", "what": "requested|confirmed|suggested|accepted|moved|declined|held|no_show|cancelled|blocked|unblocked",
                 "by": "them|owner|machine", "via?": "booking_page|inbox|onboard_card|owner", "from?": "ISO (old time)", "reason?": "…" } ],
  "labels": { "owner": "Tue 6 Oct, 11:30 pm", "eastern": "Tue 6 Oct, 2:00 pm ET",
              "theirs": "Tue 6 Oct, 12:00 pm MT|null", "proposed": "Wed 7 Oct 10:00 am ET = 7:30 pm Colombo|null" }
}
```

## `POST /api/mc/calendar`

One of (→ `{ ok, meeting }`):
- `{ action: 'confirm', id }` — Yes to a request: they get the confirmation
  (their zone + Eastern, the call's Google Meet link, else `meetingLink`, else
  "I'll send the link before the call") with an .ics invite; an onboarding meeting books the onboarding call
  (`bookedBy: 'calendar'`).
- `{ action: 'suggest', id, start }` — another time for a request: they get
  "how about …?" with a one-click "Yes, that works" link and the booking page.
  The suggested time is held; their yes confirms it (alert `meeting_accepted`).
- `{ action: 'decline', id, reason? }` — the reason goes to them (default
  "that time doesn't work on my side."); the time is free again.
- `{ action: 'move', id, start }` — a confirmed call (or a busy block) to a new
  time; they get the new time and the updated invite.
- `{ action: 'cancel', id, reason? }` — a request or a confirmed call; they
  are told, and a confirmed call is cancelled in their calendar (.ics CANCEL).
- `{ action: 'held', id }` · `{ action: 'noShow', id }` — after a confirmed
  call (either can correct the other); kept in step with the onboarding card.
- `{ action: 'add', clientId|null, title, start, minutes, kind?: 'onboarding' }`
  — his own meeting, confirmed, nobody emailed. `kind: 'onboarding'` (with a
  client) makes it that client's onboarding call.
- `{ action: 'block', start, minutes }` (title "Busy") · `{ action: 'unblock', id }`.

Errors in plain words: `400` (bad input, a time in the past), `404` (no such
meeting / client), `409` (wrong status for the button, or the time overlaps
another meeting), `502` (the email to them could not go — nothing changed,
press again), `503` (the calendar was busy for a moment — press again).

## What changes elsewhere

- `onboardCall` (in `GET /api/mc/hub/{id}`) gains `requestedFor`,
  `requestedAt`, `proposedFor` (set only while a request waits for the owner),
  `meetingId` and `meetLink` (the confirmed call's Google Meet link, from its
  meeting — so "Join Google Meet" works on the trial page without the
  Calendar week loaded; null before the call is confirmed or without Google).
  Its `label` reads "They asked for Tue 6 Oct, 11:30 pm (your
  time) — say yes in the Calendar" or "You suggested … — waiting for them".
- `simple` on board rows: "They asked for Tue 6 Oct, 11:30 pm your time — say
  yes in the Calendar" with `needsYou: true`.
- A new to-do `meeting-request:{id}` (urgent) with action
  `{ type: 'view', view: 'calendar', clientId, meetingId }` — the hub opens
  its Calendar tab on that request (new `view` value).
- The trial's conversation (`onboardCall.thread`) shows the calendar emails
  as `dir: 'out', kind: 'booking'`.
- Owner alerts (phone + email, not urgent): `meeting_requested` ("Sam (eCreek
  IT) asked for Tue 6 Oct 2:00 pm ET = 11:30 pm Colombo — say yes in the
  Calendar"), `meeting_accepted` ("Sam (eCreek IT) said yes to …"); push
  `url` = `/#calendar`.

## Google Meet — Settings › Google Meet (2026-09-25)

Contract: docs/REPLYBOT-MEET.md §3 (its "as built" lists every decision); the
owner's steps to show in the hub: docs/GOOGLE-SETUP.md. Once connected, every
call that is confirmed (Yes, their "Yes, that works", `add` with a client) gets
an event on his Google Calendar with a Meet link, made before the confirmation
email, so the email and the .ics carry the link. `move` moves the event;
`cancel` / `decline` delete it. Google failing never blocks a button: the call
is confirmed, the email says "I'll send the link before the call", and the
meeting has `meetError`.

`GET /api/mc/google` →
```jsonc
{
  "status": "not_set_up|ready_to_connect|connected|broken",
  "account": "owner@gmail.com|null",        // connected / broken only
  "redirectUri": "https://email-distributor.vercel.app/api/google/callback",  // show with a Copy button
  "hasClient": true, "clientFrom": "saved|env|null",
  "connectedAt": "ISO|null", "brokenAt": "ISO|null",
  "problem": "the connection was removed or has expired|null",   // broken only, plain words
  "encKey": true                              // false: the keys cannot be saved (ENC_KEY missing)
}
```
The Client ID, the Client secret and the tokens are never in any answer.

`POST /api/mc/google`, one of:
- `{ action: 'saveClient', clientId, clientSecret }` → `{ ok, …status }` ·
  400 (not a Google Client ID / empty secret) · 409 (set on the server
  instead) · 503 (no ENC_KEY). A different Client ID disconnects the old
  account.
- `{ action: 'connect' }` → `{ url }`: open it in the same tab
  (`location.href = url`). Google sends him back to
  `https://aviance.store/#settings/google?connected=1`, or `?error=<code>`
  (`state`, `denied`, `calendar_permission`, `exchange`, `not_set_up`,
  `no_refresh_token`, `google_down`, `google`, `no_code`, `server`; plain
  words for each in docs/GOOGLE-SETUP.md "If something goes wrong"). The link
  works for 10 minutes, once. 409 before the keys are saved.
- `{ action: 'disconnect' }` → `{ ok, revoked, …status }` (the saved keys
  stay; status `ready_to_connect`).
- `{ action: 'test' }` → `{ ok: true, meetLink, removed }` (a 15-minute event
  with a Meet tomorrow, deleted straight away; `note` when it could not be
  deleted) · 409 not connected / broken · 502 `{ error }` Google's refusal in
  plain words (for example "The Google Calendar API is not turned on in your
  Google Cloud project (step 2 of the guide).").

`GET /api/google/callback?code&state` is public (Google calls it) and only
ever redirects (303) as above.

Hub: a meeting with `meetLink` → "Join Google Meet"; without one and with
`meetError` → "No Meet link — {meetError}"; `settings.googleMeet` in
`GET /api/mc/calendar` tells the Calendar whether to point at Settings ›
Google Meet. Alert `google_disconnected` ("Google Meet disconnected
(owner@gmail.com) — reconnect it in Settings"), phone + email, once per
broken connection, push `url` = `/#settings/google`.

## Public (the applicant, signed link token)

- `GET /c/{token}/book` — the booking page (HTML). `?tz=` one of the seven US
  zones, `?change=1` shows the times under an existing request / booking.
- `GET /api/c/book/slots?token=&tz=` → `{ zone, slots: [ { start, label } ], existing, closed }`
- `POST /api/c/book` `{ token, start, note?, tz? }` → `{ ok, meeting }` · 409
  (the time was just taken) · 400 · 401 · 429 (10 tries per link per hour).
- `GET /c/{token}/book/accept?m={id}` — the suggested time with one "Yes, that
  works" button (POST to the same address accepts).

---

# Messages + the reply bot (2026-09-25)

Contract: docs/REPLYBOT-MEET.md §1–2 (its "as built" lists every decision).
Every field is additive. Each client has ONE conversation: every email the
machine sent to their contact (templates, the onboarding and calendar emails,
the owner's replies, the reply bot's answers) and every email from them found
in the ONBOARDCALL inbox — in any state, not only during onboarding.

## `GET /api/mc/hub/{id}` gains `conversation`

```jsonc
"conversation": {
  "thread": [ {                     // oldest first, the 200 newest kept (onboardCall.thread is the same list)
    "id": "…", "dir": "out|in", "at": "ISO", "from": "…", "to": "…", "subject": "…",
    "text": "plain text, ≤ 4 000 chars (quoted history cut)",
    "kind": "acceptance|reminder|reply|owner_reply|booking|auto_reply|system",
    "auto": true,                   // sent by the reply bot → show "Auto-reply" + the rule in plain words
    "rule": "not_interested|reschedule|proposes_time|wants_time|price|what_needed|thanks|null",
                                    // out + auto: the rule it answered; in: what the bot read in it (null when it may not answer them)
    "template": "setup_in_progress|null"   // kind 'system' only: collapse to one line with "show"
  } ],
  "needsReply": true,               // their last message has no answer (bot or owner) yet → "Answer {firstName}'s message"
  "lastInAt": "ISO|null", "lastOutAt": "ISO|null",
  "bot": {
    "enabled": true,                // on for everyone AND for this client (the switch "Reply bot for {firstName}")
    "sentToday": 1, "maxPerDay": 3, // bot emails to them this US-Eastern day
    "everyone": true,               // REPLYBOT.enabled
    "forClient": true,              // this client's switch
    "answersNow": true,             // it can answer them right now (they are onboarding, both switches on)
    "why": "The reply bot only answers while they are onboarding (after the acceptance email).|null",
    "pending": { "rule": "price", "messageAt": "ISO", "answerAfter": "ISO" } | null   // an answer waiting to go
  },
  "canReply": true,                 // an inbox is set up to send from
  "fromInbox": "hello@…|null"
}
```
Rule words for the hub (suggested): not_interested "they're not interested —
sent a polite close", reschedule "sent the booking link to move the call",
proposes_time "answered the time they asked for", wants_time "sent your
booking link and times", price "answered the price question", what_needed
"sent what the call needs", thanks "a thank-you — nothing to answer".

## `POST /api/mc/clients/{id}/messages`

One of (→ `{ ok, conversation }`):
- `{ action: 'reply', text }` — plain text, ≤ 2 000 characters, any client.
  From the ONBOARDCALL inbox, "Re: " their last subject, `In-Reply-To` their
  last message (else our last email), `References` the conversation; the
  owner's name is added as a sign-off unless his last line has it; a double
  click within 2 minutes sends once. An answer the bot was waiting to send is
  dropped. (`POST /api/mc/clients/{id}/onboard-call` `{ action: 'reply' }`
  stays as an alias.)
- `{ action: 'botOff' }` / `{ action: 'botOn' }` — the reply bot for THIS
  client.

Errors in plain words: `400` (empty / too long / unknown action), `404` (no
such client), `409` (no email address on file). `GET` on the same path →
`{ conversation }`.

## Board rows

- `simple.needsReply` (bool) — the same rule as `conversation.needsReply`:
  show "{firstName} wrote — answer them" in red; `simple.needsYou` is true
  whenever it is.
- A new to-do `message-reply:{id}` (urgent, `action: { type: 'view', view:
  'detail', clientId, section: 'conversation' }`) when their message waits
  outside the onboarding call (during the trial, after the call) — during the
  call the existing `onboard-reply:{id}` says it. Outside onboarding
  `simple.next` is "Answer {firstName}'s message".

## Calendar

A time the bot read in their email and found free is a meeting request like
one from the booking page, with `source: 'reply_bot'` (history `via:
'reply_bot'` when it replaced their earlier time) and a `note` "By email: “…”"
— the owner still says Yes / Suggest / Decline. Their emailed yes to his
suggestion confirms it as the one-click link does.

## `POST /api/mc/onboard-calls/check`

Also reads every other client's mail into their conversation and sends the
reply bot's answers that are due; the answer may carry `botReplies: n` (only
when > 0). Reload the trial when `newReplies` or `botReplies` > 0.

## Alerts

- `bot_replied` (quiet: phone at low urgency + email): "Auto-replied to Sam
  (eCreek IT): sent the booking link to pick another time"; push `url` =
  `/#calendar` when it asked for a time in the Calendar (say yes there), else
  `/#trial/{id}`.
- `onboard_reply` now reads "{person} wrote — needs your answer" (also for
  messages during the trial); when the bot saw the message but left it to the
  owner, the body ends with why ("The reply bot left this one to you: …").

## Settings › Reply bot

Config `REPLYBOT` (machine-wide; `/mc/config`): `enabled`, `maxPerDay` (3),
`delayMinutes` (3), `hours` (`'us'` = OWNER.usHours on US business days,
`'any'`), `answers.{not_interested|reschedule|proposes_time_ok|
proposes_time_busy|wants_time|price|what_needed}` (plain text with
`{firstName}` `{ownerName}` `{bookingLink}` `{times}` `{when}`
`{onboardingLink}` `{callMinutes}`). The on/off switch for everyone is
`REPLYBOT.enabled`; show each answer read-only.

---

# CheapInboxes auto-buy (2026-09-26)

Contract: docs/AUTO-BUY.md (its "As built" lists every decision); the
owner's steps to show in the hub: docs/CHEAPINBOXES-SETUP.md. The owner buys
a domain + 2 inboxes in his CheapInboxes account; the machine never buys or
pays for anything — it writes the shopping list, finds the purchase, and
connects it (forwarding, logins, setup checks, warm-up). Without a key
everything below is `not_set_up` and today's manual path (paste the logins)
is unchanged. Every field is additive.

## Settings › Inboxes & domains

`GET /api/mc/cheapinboxes` →
```jsonc
{
  "status": "not_set_up|connected|broken",
  "account": "Aviance Outreach|null",         // their organization name
  "hasPaymentMethod": true|false|null,        // a default card on file (null = unknown)
  "webhook": "registered|missing",
  "unmatched": [ { "domain": "randomname.com", "mailboxes": 2, "boughtAt": "ISO" } ],  // bought, on no trial's list — pick the trial
  "keyFrom": "saved|env|null",
  "checkedAt": "ISO|null", "lastSyncAt": "ISO|null",
  "problem": "No card on your CheapInboxes account — add one under Billing before you buy.|null",  // one plain sentence, null when fine
  "encKey": true                              // false: the key cannot be saved (ENC_KEY missing)
}
```
`problem` (first that applies): "The key was refused by CheapInboxes — create
a new one (Integrations → API), paste it here and press Test." · "No card on
your CheapInboxes account — add one under Billing before you buy." · "The
webhook is not registered, so purchases are found a little later — press Test
to register it again." The API key and the webhook secret are never in any
answer.

`POST /api/mc/cheapinboxes`, one of:
- `{ action: 'saveKey', apiKey }` → `{ ok, …status }` · 400 (not a
  `ci_…` key / CheapInboxes refused it — nothing saved) · 409 (set on the
  server: `CHEAPINBOXES_API_KEY`) · 503 (no ENC_KEY). Checks the key, reads
  whether a card is on file, registers the ONE webhook (a re-save replaces
  it); may carry `webhookError` (saved anyway, `webhook: 'missing'`). The
  first look at the account runs right after the answer.
- `{ action: 'test' }` → `{ ok, …status, webhookRenewed }` (a missing webhook
  is registered again) · 400 refused (→ `status: 'broken'`) · 409 not set up.
- `{ action: 'forget' }` → `{ ok, …status, webhookRemoved }` · 409 when the
  key is set on the server.
Show `unmatched` with a trial picker (trials in "Waiting for you to buy")
that calls `POST /api/mc/clients/{id}/autobuy { action: 'link', domain }`.

## `GET /api/mc/hub/{id}` gains `autobuy`

`null` outside the buying / setup / warm-up steps (and for trials that never
used this path once past buying).
```jsonc
"autobuy": {
  "status": "not_set_up|ready_to_buy|provisioning|connecting|done|failed",
  "buy": {                                     // only while ready_to_buy (null while the list is being made)
    "domain": "acmehq.com", "price": 9.99, "currency": "USD",
    "alternatives": [ { "domain": "tryacme.com", "price": 9.99 } ],     // up to 3; "Buy this instead" → pick
    "provider": "google",
    "mailboxes": [ { "firstName": "Jordan", "lastName": "Test", "prefix": "jordan", "email": "jordan@acmehq.com" },
                   { "firstName": "Jordan", "lastName": "Test", "prefix": "jordan.test", "email": "jordan.test@acmehq.com" } ],
    "orderUrl": "https://app.cheapinboxes.com/add",                    // the "Open CheapInboxes" button (new tab)
    "builtAt": "ISO"
  } | null,
  "label": "Buy acmehq.com and 2 inboxes on CheapInboxes",            // one plain sentence for the card
  "domain": "acmehq.com|null",
  "steps": [ { "key": "bought", "label": "You bought it", "done": true, "at": "ISO" },
             { "key": "domain", "label": "Domain live + spam protection set", "done": false, "at": null },
             { "key": "inboxes", "label": "2 inboxes created", "done": false, "at": null },
             { "key": "connected", "label": "Connected to our system", "done": false, "at": null },
             { "key": "warmup", "label": "Warm-up started", "done": false, "at": null } ],
  "mailboxes": [ { "email": "jordan@acmehq.com", "status": "provisioning|active|connected" } ],
  "problem": "No login came back for jordan@acmehq.com|null",          // plain words; also "none of the names is free …" while ready_to_buy
  "linkedBy": "match|owner|null",
  "canUnlink": true                                                    // show "Not this trial" only when true
}
```
Labels: ready_to_buy "Buy {domain} and 2 inboxes on CheapInboxes" ·
provisioning "Setting up {domain} — about 48 hours" · connecting "Connecting
{domain} to our system" (or "… — a setup check failed") · done "{domain} and 2
inboxes are ready — warm-up has started", or, while the warm-up circle is
short (`warmup.status` `waiting_for_helpers`), "{domain} and 2 inboxes are
ready — add N warm-up helpers to start warm-up" with the `warmup` step not
done · failed = the problem · not_set_up "CheapInboxes is not connected — buy
by hand and paste the logins, or connect it in Settings › Inboxes & domains".

## `POST /api/mc/clients/{id}/autobuy`

- `{ action: 'recheck' }` — look for the purchase now (the shopping list is
  made again when over an hour old).
- `{ action: 'link', domain }` — this domain (in the CheapInboxes account) is
  this trial's (the trial must be waiting to buy).
- `{ action: 'unlink' }` — undo a wrong link; refused once an inbox is
  connected. The domain goes back to `unmatched` and is not matched to this
  trial again by itself.
- `{ action: 'pick', domain }` — buy this alternative instead (the old domain
  stays listed as an alternative).

Every answer is `{ ok: true, autobuy, sync? }` or `{ ok: false, error,
autobuy }` with 400 (bad domain / not an alternative / unknown action) · 404
(client, or the domain is not in the account yet) · 409 (not connected,
already linked — to this trial or another —, not waiting to buy, already
connected). Redraw from `autobuy`. `GET` on the same path → `{ ok, autobuy }`.

## Board rows and to-dos

- `simple` while buying with CheapInboxes connected: step `setting_up`,
  "Buy their domain and 2 inboxes on CheapInboxes", next "Open CheapInboxes
  and buy {domain} with 2 inboxes — the rest sets itself up", `needsYou:
  true`. After the purchase (awaiting_purchase or setup_check): "Setting up
  their inboxes (about 2 days)", next "Nothing for you: the domain and inboxes
  connect by themselves, then warm-up starts" — or "Setting up their inboxes
  (about 2 days) — needs you", next "Fix: {problem}", `needsYou: true`. A
  failed setup check keeps today's text.
- To-do `buy:{id}` while ready to buy: "Buy {domain} and 2 inboxes on
  CheapInboxes", detail "$9.99 for the domain · we connect everything by
  ourselves after you buy", `action: { type: 'view', view: 'detail',
  clientId, section: 'autobuy' }` (urgent after 12 h).
- Machine to-do `unmatched:{domain}` (urgent, `clientId: null`, clientName
  "CheapInboxes"): "You bought {domain} — which trial is it for? Pick in
  Settings", `action: { type: 'view', view: 'settings', section: 'inboxes',
  domain }` — a new `view` value: open Settings › Inboxes & domains.
- System card `purchase`: the `autobuy.label` with the steps as detail lines
  while buying / setting up.

## `POST /api/mc/onboard-calls/check`

Also looks at the CheapInboxes account (in parallel, throttled to
`CHEAPINBOXES.checkEveryMinutes`, shared with the `autobuy` job): shopping
lists made, purchases found and connected, setup checks moved on. The answer
carries `autobuy: { ok, found: [{clientId, domain}], connected: [ids],
ready: [ids], unmatched: n, problems: n, skipped?: 'too soon'|'busy', error? }`
only while a key is set. Reload the board when `found`, `connected` or
`ready` is non-empty.

## Public

`POST /api/webhooks/cheapinboxes` — CheapInboxes' events (registered by
`saveKey`). Always 200 `{ received: true }`; only wakes a look (see
docs/AUTO-BUY.md "As built").

## Alerts (phone + email)

- `purchase_found` "We found acmehq.com — connecting it to Acme" · push
  `url` `/#trial/{id}`.
- `inboxes_ready` "acmehq.com and 2 inboxes are ready — warm-up has started" ·
  `/#trial/{id}`.
- `autobuy_problem` (urgent, also Telegram) "Inbox setup: {what}" — e.g. "The
  CheapInboxes order for acmehq.com failed", "No login came back for …",
  "acmehq.com is still not ready 73 hours after you bought it", "CheapInboxes
  refused the API key" (that one `/#settings/inboxes`).
- `purchase_unmatched` "You bought randomname.com — which trial is it for?
  Pick in Settings" · `/#settings/inboxes`.

## Config `CHEAPINBOXES` (machine-wide, `/mc/config`)

`provider` ('google'), `mailboxes` (2), `stuckHours` (72), `orderUrl`,
`alternatives` (3), `maxSearches` (6), `refreshHours` (24),
`credentialsGraceHours` (2), `checkEveryMinutes` (2), `jobEveryMinutes` (10).

# Warm-up in the hub (2026-09-26)

Contract: docs/WARMUP-HUB.md (its "As built" lists every decision). The
machine's own warm-up circle is the warm-up; it needs free **helper**
accounts the owner makes once (the machine never creates accounts). Every
field is additive.

## Settings › Warm-up — `GET /api/mc/warmup`

Adds three plain blocks; every older field (`day`, `members`, `pairs`,
`minPool`, `minFamilies`, `summary`, `presets`, `external`, `aviance`,
`encKey`) stays for /mc/warmup.
```jsonc
{
  "circle": {
    "members": 6,              // working members: helpers + trial inboxes + aviance inboxes
    "helpers": 3, "clientInboxes": 2, "avianceInboxes": 1,
    "min": 8, "ready": false, "missing": 2,
    "label": "6 of 8 in the warm-up circle — add 2 more helpers",   // or "9 in the warm-up circle — enough (at least 8 needed)"
    "waiting": [ { "clientId": "acme", "name": "Acme Co" } ]         // trials waiting for the circle
  },
  "helpers": [ {                                  // every helper, switched-off and failing ones too
    "email": "pat@yahoo.com", "provider": "yahoo", "providerLabel": "Yahoo Mail",
    "health": "ok|new|failing|disabled",
    "lastOkAt": "ISO|null",                       // last login test / mailbox read that worked
    "problem": "plain sentence|null",             // e.g. "Yahoo Mail refused the login — … Add the helper again with it"
    "sentToday": 3,
    "displayName": "Pat Lee", "enabled": "1|0", "hasPassword": true,   // (kept for /mc/warmup)
    "providerOk": true, "providerNote": "", "state": "ok|new|auth_failed|imap_error|unreachable"
  } ],
  "providers": [ {                                // the free-helper providers, in this order: Gmail, Yahoo, AOL, iCloud, GMX (.com), GMX (.net/.de), WEB.DE, Yandex
    "key": "google", "label": "Gmail",
    "steps": [ "Create a Gmail account", "Turn on 2-Step Verification (…)", "…" ],   // numbered one-time steps
    "note": "Free Gmail works with an app password …",
    "passwordLabel": "16-letter app password"     // the password field's label
  } ]
}
```
Health in plain words: `ok` works · `new` not tried yet · `failing` (see
`problem`; "Test" re-checks) · `disabled` switched off.

## `POST /api/mc/warmup`

- `{ action: 'addHelper', provider, email, password, displayName? }` — "Test
  and add". Tests the send (SMTP) and mailbox (IMAP) logins first (up to
  ~20 s — show a spinner) and saves only when both work →
  `{ ok: true, email, provider, helper }` (`helper` as in the list, health
  `ok`). Otherwise nothing is saved and the answer is `400 { ok: false,
  error, kind }` — `error` is one plain sentence to show as-is, e.g. "Gmail
  said the password is wrong — use the 16-letter app password
  (myaccount.google.com/apppasswords, needs 2-Step Verification), not your
  normal password", "IMAP is off — GMX: Email › Settings › POP3 & IMAP ›
  enable access, then press Test and add again", "Unknown provider …",
  "Outlook … OAuth2 …", "Yahoo Mail did not answer within 20 seconds — try
  again in a minute"; `kind` = `wrong_password | imap_off | imap_user |
  unreachable | other` (absent for form errors). `503` when ENC_KEY is not
  set. `provider` = a `providers[].key` (default: from the address's domain).
- `{ action: 'testHelper', email }` — "Test" on a saved helper; the same two
  logins → `{ ok: true, helper }` or `400 { ok: false, error, kind, helper }`
  (redraw the row from `helper`) · `404` unknown helper. A refused login
  takes the helper out of the circle until it passes again.
- `removeHelper` / `helperEnabled` / `retryMember` unchanged. Passwords are
  never in any answer.

## `GET /api/mc/hub/{id}` gains `warmup`

`null` before the inboxes are connected (and outside setup_check…converted;
`deciding` keeps it, status `ready`, so the card does not vanish between Day
30 and their decision).
```jsonc
"warmup": {
  "status": "waiting_for_helpers|warming|ready|paused",
  "label": "Warming up — day 5 of about 14 · 96% reach the inbox",   // one plain sentence for the card
  "day": 5, "of": 14,                  // the slowest inbox's warm-up day (0 before it starts — also while waiting_for_helpers)
  "readyBy": "2026-10-15|null",        // estimate while warming; null when unknown (see below)
  "inboxRate": 0.96,                   // lowest 7-day inbox rate, null until first measured (nightly)
  "inboxes": [ { "email": "jordan@acmehq.com", "day": 5, "sentToday": 8, "quota": 8, "inboxRate7d": 0.96, "ready": false } ],
  "problem": "plain sentence|null",
  "helpersNeeded": 0                   // N for the "Add N warm-up helpers" button (only while waiting_for_helpers)
}
```
Labels: warming "Warming up — day 5 of about 14 · 96% reach the inbox" (the
rate part only once measured) · waiting_for_helpers "Waiting for warm-up
helpers — 6 of 8 in the circle, add 2 more" · ready "Warm-up done · 96% reach
the inbox" · paused "Warm-up starts when the setup checks pass" / "Warm-up is
switched off for these inboxes". Problems: "The warm-up circle has 6 of the 8
members it needs — add 2 warm-up helpers in Settings › Warm-up" · "Warm-up
could not log in to … — check its app password" · "…: 85% reach the inbox —
it needs 90% on 2 days in a row[, so Day 1 waits for it]".
`readyBy` = day 14 from the first warm-up day, later when an inbox's rate
lags; `null` when there is no honest date (not warming, waiting for helpers,
or an inbox still under the line past the Day 1 slide window).

## Board rows and to-dos

- `simple` in `warming`: `label` = `warmup.label`; `next` "Nothing for you:
  first emails on Monday 26 October". While `waiting_for_helpers`: `next`
  "Add 2 warm-up helpers — Settings › Warm-up", `needsYou: true`.
- To-do `warmup-helpers:{id}` (urgent) "Add 2 warm-up helpers — Settings ›
  Warm-up", detail = the problem, `action: { type: 'view', view: 'settings',
  section: 'warmup' }` — a new section: open Settings › Warm-up. On the
  board, several waiting trials give ONE to-do `warmup-helpers`
  (`clientId: null`, clientName "Warm-up", detail ending "waiting: Acme Co,
  Bolt Co").
- System card `warmup`: status `waiting` while waiting for helpers.

## Alerts (phone + email)

- `warmup_needs_helpers` "Add 2 warm-up helpers — the warm-up circle has 6
  of 8" — at most once a day while a trial waits; push `url`
  `/#settings/warmup`. (It replaces the daily `warmup_pool_small` while a
  trial waits.)

# Journey run (2026-09-26) — what changed for the hub

A full simulated journey of one applicant (tests/journey.test.mjs: the website
form → the owner's yes → the reply bot → the booking page and the Calendar with
Google Meet → the onboarding page → CheapInboxes → warm-up → Day 1 → Day 30 →
converted → paid), through the real routes, found the problems below; each is
fixed. Every change is additive for the hub.

**The hub's answers after every step** are saved in
`tests/fixtures/journey/NN-step.json` (`{ step, what, at, check, board, detail,
extra? }` — `extra.calendar` = `GET /api/mc/calendar`, `extra.cheapinboxes`,
`extra.warmupSettings`). Real shapes; tokens, pixel tokens and Message-IDs are
replaced by `TOKEN_n` / `PIXEL_n` / `MSGID_n`; `detail.events` is cut to its
newest 40. Regenerate: `JOURNEY_SNAPSHOTS=1 node --import ./tests/register.mjs --test tests/journey.test.mjs`
(`JOURNEY_REPORT=dir` also writes a readable journey.md of every step).

## Alerts and to-dos
- The machine acknowledges a trial's alerts once what they were about is done
  (`acknowledgedBy: 'machine'`, `ackReason`): `new_application` /
  `application_scored` on Say yes / Say no, `legal_reply` on clearing the legal
  hold, `dns_fail` when DNS passes again, `blacklisted` when clean, the setup
  alerts when the setup passes, `shopping_list` / `purchase_reminder` once
  bought, `placement_low` on a good canary day, `emergency` when resolved. Before,
  an urgent alert stayed a to-do (and a red dot) until the owner found it.
- An open urgent alert is ONE to-do per kind: repeats read "… (3 alerts)" and the
  button acknowledges them all — `POST /api/mc/alerts` takes `{ action: 'ack',
  ids: [...] }` as well as `{ action: 'ack', id }` (→ `{ ok, acknowledged: n }`).
  No alert to-do where a to-do already says it (the application review, the legal
  hold, the buy to-do).
- Alert titles name the trial ("Angry reply: Ridgeline IT"), not its id.
- `ALERTS[key].info` (news: a purchase found, a bot answer, a conversion; or a
  heads-up whose own to-do clears itself: a reply to answer, a time to confirm)
  never turns a trial yellow and is left out of the morning digest.
- `inboxes_ready` says "… are ready — add 6 warm-up helpers to start warm-up"
  while the circle is short (title `{domain} and {count} inboxes are ready — {next}`).

## Statuses
- `simple` while sending is held: "Sending stopped — a prospect replied with a
  legal threat" / "Sending on hold — …" (`needsYou: true`), "Sending paused — a
  deliverability problem the machine is fixing".
- After the reply bot answered: "Accepted — the reply bot answered, waiting for
  them to pick a time" (+ `onboardCall.lastBotReplyAt`; the card's label "The reply
  bot answered — waiting for them to book").
- `application.research.market.capped: true` when a Google search was cut off at
  60 places: the count is a floor ("at least 360") — never "Market too small".

## Without the heartbeat
`POST /api/mc/onboard-calls/check` (and the agreement's after()) also carry the
intake on when no tick ran in the last 5 minutes — the research, the market
count, the Price Scout (the shopping list + the client's "setup in progress"),
a pasted purchase's setup round, the welcome email and the onboarding page's
reminders (`carried: [{ job, clientId }]` in the answer). With CheapInboxes the
webhook and the check carry the purchase to `warming`. **Still needs the
heartbeat**: warm-up itself, the Lead Finder, copy/approval, the canary and spam
tests, sending, replies, bookings, reports, the decision and everything after —
and, until it runs, the reply bot's answers and the onboarding call's reminders
go only when the owner opens the hub.

# Keys — Settings › Keys (2026-09-26)

The owner's steps to show in the hub: docs/KEYS.md (every card carries them
too, see `steps`). One card per service key the machine needs; he pastes it
in the hub, the machine checks it with the service before storing it
encrypted, and never shows it again. A key set on the server (Vercel env)
still wins: its card says `from: 'env'` and can only be tested. CheapInboxes
and Google Meet keep their own cards (above). Every field is additive.

`GET /api/mc/keys` →
```jsonc
{
  "keys": [ {
    "name": "PLACES_API_KEY",            // the card id — save/test/forget with it
    "label": "Google Places key — finds businesses, reads reviews and market size",
    "short": "Google Places key",
    "optional": false,                   // ZeroBounce and Hunter are optional
    "secret": true,                      // false only for GITHUB_REPO (a plain setting, shown as `value`)
    "fields": ["PLACES_API_KEY"],        // env names behind the card (Verifalia: two)
    "parts": ["username", "password"],   // Verifalia only: the body fields of a save
    "set": true, "from": "hub|env|null",
    "savedAt": "ISO|null", "testedAt": "ISO|null",
    "ok": true|false|null,               // the last check: null = not tested yet
    "problem": "Google said the key is invalid|Out of credits — …|not tested yet|null",  // plain words, null when fine
    "detail": "Google answered a test search with 2 places|18 free checks left today|null",
    "url": "https://console.cloud.google.com/",   // where to get it
    "free": "…what the free plan gives…",
    "steps": ["Go to console.cloud.google.com …", "…"],
    "note": "Steps checked against their own help pages on 2026-09-26.|Their menus may have moved — check on their site."
  } ],
  "encKey": true                         // false: keys cannot be saved (ENC_KEY missing)
}
```
Cards, in order: `PLACES_API_KEY`, `QUICKEMAILVERIFICATION_API_KEY`,
`VERIFALIA` (username + password), `REOON_API_KEY`, `ZEROBOUNCE_API_KEY`,
`HUNTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO` (`value`, `default`
`limethsith-create/email-distributor`). A secret's value is never in any
answer.

`POST /api/mc/keys`, one of:
- `{ action: 'save', name, value }` — Verifalia: `{ action: 'save', name:
  'VERIFALIA', username, password }` → `{ saved: true, …card }`. The machine
  first makes ONE cheap call to the service (Places: an IDs-only text search,
  free; QuickEmailVerification: their free sandbox; Verifalia: the credit
  balance; Reoon: the account balance; ZeroBounce: `getcredits`; Hunter:
  `/account`; GitHub: reads the repository and checks the token may push —
  it never starts a job). A key the service refuses is NOT saved → 400
  `{ error }` with the reason ("Google said the key is invalid", "Places API
  (New) is not enabled for this key — turn it on in Google Cloud", "This
  token cannot start jobs on limethsith-create/email-distributor — it needs
  Contents: Read and write on that repository" …). A working key whose
  credits are used up is saved with `problem: "Out of credits — …"`. When the
  service could not be reached the key is saved with `ok: null, problem:
  'not tested yet'`. 400 for a value with blanks / an unknown name · 409 when
  set on the server · 503 no ENC_KEY.
- `{ action: 'test', name }` → `{ tested: true, …card }` (`ok` / `problem` /
  `detail` = the outcome; works for env keys too) · 409 not set.
- `{ action: 'forget', name }` → `{ forgotten: true, …card }` (the hub's
  value and its test outcome go; an env value stays and the card still says
  `env`).

Elsewhere: the Lead Finder job gets the keys it needs with
`GET /api/clients/{id}/profile` (`keys: { places, quickEmailVerification,
verifalia: { username, password }, reoon, zeroBounce, hunter }`) — with the
LEADFINDER_TOKEN only, never for a browser session and never in any
`/api/mc/hub` answer; the keys store is left out of backups whole. Alert
`verify_no_keys` now points at Settings › Keys.

# Hub screens check (2026-09-26) — what changed for the hub

A check of every hub screen against the journey snapshots
(tests/fixtures/journey) found these; each is fixed and the snapshots are
regenerated. Every change is additive except where a field is named.

- `GET /api/mc/hub/{id}` `row` is built with the same alert log as the board,
  so `health`, `openAlerts` and `urgentAlerts` match the board row.
- `links` is filled (see "GET /api/mc/hub/[id]" above): the last onboarding /
  approval / decision link emailed, while its token works.
- `simple.next` is never "Nothing for you" while `needsYou` is true: an
  urgent alert gives the thing to do ("Read the angry reply and mark it as
  seen"; other alerts "Read the alert “…” and mark it as seen").
- `simple.step` `deciding` (Day 30 passed, decision pending) with `next`
  "Nothing. {firstName} chooses on the decision page."; `finished` stays for
  after the decision. `stateLabel` while deciding: "Deciding — bonus until Fri
  20 Nov, 7:30 pm Sri Lanka time (9:00 am Eastern)".
- `invoice` follows the contract: `number` (was `invoiceNo`), `dueDate`,
  `remindersSent` a count; the to-do reads "Mark the month-one invoice paid
  when the money lands (AV-…)" — no "(invoice)".
- To-do `legal:{id}` detail is plain words: "{email} wrote on Wed 28 Oct, 8:10
  pm (your time): “first line”", never the reply's id.
- To-do `buy:{id}` detail: "we connect everything by ourselves after you buy".
- `autobuy` while the circle is short: label "… are ready — add N warm-up
  helpers to start warm-up" and the `warmup` step not done; `warmup.day` and
  `warmup.inboxes[].day` are 0 (nothing due) until warm-up really runs.
- `warmup` stays on the trial in `deciding` (status `ready`).
- `onboardCall.meetLink`: the confirmed call's Google Meet link.
- Alerts that pile up: the morning and Monday digests acknowledge the earlier
  ones of their kind when they go out (one of each open at most; they are
  `info`); `meeting_requested` is acknowledged when the owner answers in the
  Calendar (Yes, Suggest, Decline, Cancel); `onboard_reply` ("{person} wrote —
  needs your answer") when the owner or the reply bot answers.
- Client emails: every time is written the Calendar's way ("Tuesday 6 October
  at 11:00 am Eastern Time"), the day-before reminder included; the approval
  emails greet by first name ("Hi Dana,") — the full name stays only where a
  name is signed ("in Dana Whitfield's name"). Every client template may use
  `{firstName}`.
