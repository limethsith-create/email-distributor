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
  "invoice": { "number", "amount", "issuedAt", "paidAt", "dueDate" } | null,
  "promises": [ { "id", "text", "dueAt", "doneAt" } ],
  "upcoming": [ { "date", "time", "what" } ],
  "events": [ { "at", "system", "event", "detail" } ],   // newest 150
  "jobs": { "send": { "at", "ms", "ok", "error" }, ... },
  "holds": { "legalHoldAt": null, "sendHold": null, "emergencyActive": false, "emergencyHalved": false, "pausedReason": null },
  "links": { "onboarding": "https://.../c/<token>/onboard", "approval": "...", "decision": "..." }   // current client links where they exist
}
```

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
| Warm-up circle | `GET /api/mc/warmup` · `POST` `{action:'addHelper'|'removeHelper'|'helperEnabled', ...}` |
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
  "step": "new|accepted|call_booked|setting_up|warming_up|sending|finished|declined|queued",
  "label": "Accepted — waiting for them to book the call",   // one plain sentence
  "next": "Nothing for you: we remind them tomorrow",        // what happens next / what the owner must do
  "needsYou": true,                                          // red dot + top of the list
  "since": "ISO|null",                                       // when this step started
  "person": "Sam Test|null", "company": "eCreek IT",
  "dayOf30": 12 | null                                       // only while sending / extension (can pass 30 in an extension)
}
```
`needsYou` is true for a new application to review, a reply to answer, an
overdue booking, a call to mark done/no-show, domain buying, a failed domain
check, a "talk to someone" request, and anything in the row's `todo` marked
urgent. Times in labels are the owner's (Sri Lanka) time.

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
