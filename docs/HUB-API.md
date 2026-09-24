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
| New client (pre-approved) | `POST /api/mc/clients/new` `{companyName, contactName, contactEmail, website, override?}` → `{ok, clientId, state}` or `400 {errors:[...]}` |
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
