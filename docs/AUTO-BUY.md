# Buy once, the rest sets itself up (CheapInboxes API) — shared contract (2026-09-26)

The owner's words: "When I click purchase on the inboxes and the domains, the
system should do all the DKIM / DNS / connecting by itself. You get a message
when they're bought, you put them together and figure the whole thing out."

CheapInboxes (our inbox provider) has a full API
(`https://api.cheapinboxes.com/v1`, bearer API key `ci_live_…`; spec saved at
`docs/vendor/cheapinboxes-openapi.json`). When the OWNER buys a domain +
mailboxes in his CheapInboxes account, CheapInboxes registers the domain,
creates Google Workspace (or Microsoft) mailboxes and sets DNS, DKIM, DMARC
itself; webhooks say when things are ready; `GET /v1/mailboxes/{id}/credentials`
gives `email, password, app_password, imap_host/port, smtp_host/port`;
`PATCH /v1/domains/{id}/forwarding` sets the domain's redirect.

**The machine NEVER places an order or spends money** (it never calls
`/v1/orders/checkout`, `/v1/billing/*` actions, or anything that charges).
It tells the owner exactly what to buy, notices the purchase, matches it to
the client, and does everything after it. No AI; plain rules.

## 1. The owner's one-time setup (hub › Settings › Inboxes & domains)
- He makes a CheapInboxes account, saves a card there, creates an API key,
  and pastes the key into the hub (stored ENCRYPTED in KV with the existing
  crypto; env `CHEAPINBOXES_API_KEY` wins; never shown back).
- On save the machine checks the key (`GET /v1/org`), shows the account name
  and whether a default payment method exists (`GET /v1/billing/payment-methods`),
  and registers ONE webhook (`POST /v1/webhooks`, url
  `${PUBLIC_BASE_URL}/api/webhooks/cheapinboxes`, events `domain.provisioned,
  domain.dns_configured, mailbox.active, mailbox.credentials_ready,
  order.completed, order.failed, billing.invoice_failed`), storing its id and
  secret encrypted. Re-saving the key replaces the webhook.

## 2. What to buy (machine)
The machine never buys anything and never spends money: **the owner buys** in
his CheapInboxes account (their order form registers the domain and sets up
DNS, DKIM, DMARC by itself). The machine tells him exactly what to buy and
then does everything after the purchase.

When a client reaches `awaiting_purchase` (existing state), the machine
builds the domain candidates as today (systems/domains.js / pricescout.js),
checks which are free and their CheapInboxes price with the read-only
`POST /v1/discovery/domains/search` (keyword + allowed TLDs from config
`ALLOWED_TLDS`), and shows the owner: the domain to buy (+ up to 3
alternatives), provider (Google), 2 mailboxes with the persona (from the
onboarding profile: `senderName` → first/last name; `senderPrefix` → two
different lower-case prefixes, e.g. `jordan`, `jordan.test`), and a link to
the CheapInboxes order page. This is the "shopping list" (`autobuy.buy`).

## 3. Matching a purchase to a client (machine)
The machine finds new purchases itself — never from a webhook body:
- `GET /v1/domains` (+ each domain's mailboxes via `GET /v1/mailboxes`
  filtered by domain) lists what the account owns.
- A domain equal to a client's shopping-list domain (or any listed
  alternative) is that client's → linked automatically.
- A new domain that matches no client is listed as **unmatched** for the
  owner to assign in the hub (`link`).
- One domain belongs to at most one client; linking is idempotent.

Endpoints:
- `POST /api/mc/clients/{id}/autobuy` `{ action: 'recheck' }` (look for the
  purchase now) · `{ action: 'link', domain }` (this domain is this client's)
  · `{ action: 'unlink' }` (undo a wrong link before anything was connected)
  · `{ action: 'pick', domain }` (buy this alternative instead — updates the
  shopping list) → `{ ok, autobuy }`.

## 4. Setup runs by itself
Truth always comes from the API, never from a webhook body: every webhook
(verified by HMAC-SHA256 of the raw body with the stored secret — accept the
signature in the common header forms, e.g. `x-cheapinboxes-signature`,
`x-webhook-signature`, `x-signature`, hex or base64, optional `sha256=` /
`t=…,v1=…`) is only a wake-up: the machine re-reads the order
(`GET /v1/orders/{id}`, `GET /v1/domains/{id}`, `GET /v1/mailboxes/{id}`).
An unverifiable delivery is still allowed to trigger a (rate-limited) re-sync
— it can never change anything by itself. The same sync (find new
purchases, match, connect) also runs from the hub's check call, the job on
the tick, `recheck`, and `link`.

Sync steps, idempotent, in order:
1. domain `provisioned` / `dns_configured` → set forwarding to the client's
   main website (`PATCH /v1/domains/{id}/forwarding`, permanent), record
   `domainLiveAt`.
2. each mailbox `active` → `GET …/credentials` → create/update the client's
   inbox record (systems/db/inboxes.js; password + app password ENCRYPTED;
   SMTP/IMAP hosts and ports from the answer; sender display name = persona).
3. all mailboxes in → run the existing setup check (systems/setupcheck.js) →
   the existing path to `warming` (warm-up starts on its own); owner alert
   `inboxes_ready` ("acmeoutreach.com and 2 inboxes are ready — warm-up has
   started").
4. `order.failed` / a mailbox stuck > 72 h → owner alert
   `autobuy_problem` with the plain reason and what to do.

Status for the hub (trial detail `autobuy`):
```jsonc
{ "status": "not_set_up|ready_to_buy|provisioning|connecting|done|failed",
  "buy": { "domain": "acmeoutreach.com", "price": 9.99, "alternatives": [ { "domain": "…", "price": 9.99 } ],
           "provider": "google", "mailboxes": [ { "firstName": "Jordan", "lastName": "Test", "prefix": "jordan", "email": "jordan@acmeoutreach.com" } ],
           "orderUrl": "https://www.cheapinboxes.com/…" } | null,   // what to buy (while ready_to_buy)
  "label": "Setting up acmeoutreach.com — about 48 hours",
  "domain": "acmeoutreach.com",
  "steps": [ { "key": "bought", "label": "You bought it", "done": true, "at": "ISO" },
             { "key": "domain", "label": "Domain live + spam protection set", "done": false, "at": null },
             { "key": "inboxes", "label": "2 inboxes created", "done": false, "at": null },
             { "key": "connected", "label": "Connected to our system", "done": false, "at": null },
             { "key": "warmup", "label": "Warm-up started", "done": false, "at": null } ],
  "mailboxes": [ { "email": "jordan@acmeoutreach.com", "status": "provisioning|active|connected" } ],
  "problem": "plain words|null" }
```
`simple` (board rows): "Setting up their inboxes (about 2 days)" /
"Buy their domain and 2 inboxes on CheapInboxes" (`needsYou: true`).

Settings status: `GET /api/mc/cheapinboxes` →
`{ status: 'not_set_up|connected|broken', account, hasPaymentMethod, webhook: 'registered|missing', unmatched: [ { domain, mailboxes: n, boughtAt } ] }`;
`POST /api/mc/cheapinboxes` `{ action: 'saveKey', apiKey }` · `{ action: 'test' }` · `{ action: 'forget' }`.

The manual path (buy anywhere, paste logins) stays for when the key is not set.

---

## As built (2026-09-26, machine side)

The owner's steps: docs/CHEAPINBOXES-SETUP.md. The hub's endpoints:
docs/HUB-API.md "CheapInboxes auto-buy". Tests: tests/autobuy.test.mjs.

**Files**
- `src/lib/ext/cheapinboxes.js` — the API client (plain fetch through
  `io.fetchJson`, bearer key, 8 s per call, one 15 s budget per button; GETs
  retry once, a POST never), the key (env `CHEAPINBOXES_API_KEY` wins, else
  the pasted key encrypted in `cheapinboxes:account`), save / test / forget,
  the ONE webhook, the settings status, the domain index
  (`cheapinboxes:domains`) and the webhook signature check.
- `src/lib/systems/autobuy.js` — the shopping list, matching, the sync, the
  owner's actions (recheck / link / unlink / pick) and the hub's `autobuy`.
- Routes: `GET/POST /api/mc/cheapinboxes`, `GET/POST
  /api/mc/clients/{id}/autobuy`, public `POST /api/webhooks/cheapinboxes`;
  `POST /api/mc/onboard-calls/check` also runs the sync.
- Job `autobuy` (joblist/stage-a.js), config `CHEAPINBOXES`, KV keys
  `cheapinboxes:*` + `client:{id}:autobuy`, alerts `purchase_found`,
  `inboxes_ready`, `autobuy_problem`, `purchase_unmatched`.

**The machine cannot place an order.** Every request goes through `ciCall`,
which refuses anything outside `ALLOWED` before a byte leaves — checked on the
path given and again on the URL actually built (so `..` cannot walk out). The
allowed calls: `GET /org`, `GET /billing/payment-methods`,
`GET|POST /webhooks`, `DELETE /webhooks/{id}`, `POST /discovery/domains/search`,
`GET /domains`, `GET /domains/{id}`, `PATCH /domains/{id}/forwarding`,
`GET /mailboxes`, `GET /mailboxes/{id}`, `GET /mailboxes/{id}/credentials`.
tests/autobuy.test.mjs fails if (a) any of 24 order / billing / cancel /
traversal paths is not refused, (b) any file but ext/cheapinboxes.js names the
API host or calls `ciCall`, (c) a path named in ext/cheapinboxes.js is outside
`ALLOWED`, or (d) any call made anywhere in the test run was.

**Decisions**
- §4 says the webhook re-reads the order (`GET /v1/orders/{id}`); orders are
  not in the allowed calls, so the machine never reads them. A failed order is
  seen on the domain itself (`status` error / failed / cancelled / expired or
  a `provisioning_error`) and on a mailbox (`status` error / failed …);
  `order.failed` is only a wake-up like every other event.
- Shopping list: candidates in this order — the owner's pick of an
  alternative, the Price Scout's pick and offers (he may have seen them in the
  shopping_list alert), then `rankCandidates` (systems/domains.js); only
  `ALLOWED_TLDS` minus `BANNED_TLDS`. One discovery search per label answers
  all allowed TLDs of it; the search goes on until the best
  1 + `CHEAPINBOXES.alternatives` free names are known (nothing unknown before
  them) or `maxSearches` (6) is used. Suggestions are used only when they are
  our own candidates. A TLD the answer leaves out counts as not for sale.
  Rebuilt after `refreshHours` (24) while nothing is bought, hourly while none
  was free, and on `recheck` when over an hour old.
- Personas: `senderName` → first name = first word, last name = the rest (a
  missing part stays null); prefixes = `senderPrefix` (else the first name),
  then first.last, jlast, firstlast, first.team … — always different, never
  invented when both name and prefix are missing (`mailboxes: []`).
- Matching: a trial "was shown" its list's domain, every alternative ever
  listed (`shown`), and the Price Scout's `chosenDomain` + `backups`. A domain
  on exactly one waiting trial's set is linked; on two, or on none, it is
  `unmatched`. A trial gets at most one domain per look, and its own list
  domain wins over its alternatives. Domains already in the account at the
  first look after the key was saved are `preexisting` (never listed as
  unmatched, never alerted; still linked if they match, and linkable by hand).
- `unlink` is refused once any inbox is connected; the domain goes back to
  unmatched without an alert and is never matched to that trial again by
  itself (`blocked`) — an explicit `link` overrides that. Linking sets
  `shopping.boughtAt` (the Price Scout's reminders stop); unlinking removes it
  again only if linking set it.
- Forwarding: `https://{mainDomain}`, `permanent: true`, once the domain is
  live (or any of its inboxes is active); recorded in `forwardingSetAt` and
  never re-applied, so a change the owner makes in CheapInboxes stays.
- Inbox records: `saveInbox` as the purchase page uses it — `passwordEnc` = the
  app password (spaces removed; the account password when there is no app
  password), `loginPasswordEnc` = the account password (both ENC_KEY
  encrypted), SMTP/IMAP host + port from the credentials answer (the provider
  default only when one is missing or not a plain host / port), display name =
  the persona listed for that address (else CheapInboxes' first/last name,
  else `senderName`), `provider` google (microsoft → outlook),
  `source: 'cheapinboxes'`, `cheapinboxesId`, `enabled: '0'` until the setup
  check passes (as today). Every API answer drops all `*Enc` fields
  (`publicInbox`, db/inboxes.js); backups strip `loginPasswordEnc`,
  `apiKeyEnc` and `webhookSecretEnc`.
- All `CHEAPINBOXES.mailboxes` (2) connected → `client:{id}:domain`
  (`registrar: 'cheapinboxes'`, `purchasedAt` = when CheapInboxes created the
  domain, the listed price, `autoRenew` = CheapInboxes' own flag,
  `forwardsTo`) → `setup_check` → `startSetupCheck` + `runSetupCheck`, the
  existing path to `warming`. Extra inboxes on the domain are connected too;
  the count only decides when setup starts.
- Setup check change (the only one): the auto-renew check passes for a domain
  with `registrar: 'cheapinboxes'` — it is part of the CheapInboxes
  subscription and is cancelled there with the inboxes when the trial ends
  (the existing cancel-inboxes to-do), not at a registrar.
- Without the heartbeat the sync moves a running setup round on (the hub's
  check, a webhook); when a tick ran in the last 5 minutes it leaves the round
  to the `setup-check` job (no second loopback email).
- Problems (`autobuy_problem`, urgent, each once per trial + kind + subject,
  cleared from the hub when the next look no longer finds it): the order
  failed; the domain is gone from the account; an inbox failed; an active
  inbox's login missing for `credentialsGraceHours` (2); ENC_KEY missing;
  stuck — fewer than 2 inboxes connected `stuckHours` (72) after the purchase,
  only when nothing more precise was found. A key CheapInboxes refuses →
  status `broken`, one alert.
- Throttles: one look per `checkEveryMinutes` (2) shared by the hub's check
  and the job; the job itself every `jobEveryMinutes` (10) and only while a
  trial is `awaiting_purchase` or has `autobuyOpen = '1'` (linked, not yet
  warming); webhooks wake a look at most every 10 s (signed) / 2 min
  (unsigned or bad signature — kept apart so a flood cannot hold a real
  event back); one look at a time (a 90 s lock; the owner's buttons wait up
  to 4 s for it). The job always loads every client itself (a forced
  single-client tick must not make other trials' domains look unmatched).
- Webhook: HMAC-SHA256 over the raw body with the stored secret (as given,
  and for a `whsec_` secret its base64 body too); the signature in
  `x-cheapinboxes-signature`, `cheapinboxes-signature`, `x-webhook-signature`,
  `webhook-signature`, `x-signature`, `x-signature-256` or
  `x-hub-signature-256`, as hex or base64, bare, `sha256=…`, `t=…,v1=…`
  (signed `t.body`), `v1,…` (signed `id.timestamp.body` with `webhook-id` /
  `webhook-timestamp`), or with a separate timestamp header (signed
  `timestamp.body`). The body is never parsed or stored; the answer is always
  200 `{ received: true }`; the sync runs in `after()`.
- `saveKey` registers the webhook and runs the first look in `after()`;
  re-saving deletes the old webhook (with the key that made it) and any other
  pointing at our address, so there is always one. `test` re-registers a
  webhook that is missing (deleted in their dashboard, or the key came from
  env). `forget` deletes the webhook and the saved key and drops the index
  entries that belong to no trial; with the env key set it is refused (409).
- The hub (the coordinator's asks): every `POST /api/mc/clients/{id}/autobuy`
  answers `{ ok, autobuy }` — errors too, as `{ ok: false, error, autobuy }`
  with 400/404/409 — so the hub redraws from it; `GET /api/mc/cheapinboxes`
  carries `problem`, one plain sentence or null ("The key was refused by
  CheapInboxes — …", "No card on your CheapInboxes account — add one under
  Billing before you buy.", "The webhook is not registered … press Test").
  `autobuy.mailboxes[].status` is only `provisioning | active | connected` (a
  failed inbox shows as provisioning; `problem` says what is wrong). Extra
  fields: `linkedBy` (`match|owner`) and `canUnlink`.
- The Price Scout's 12 h / 48 h purchase reminders say "Buy them on
  CheapInboxes — the hub shows exactly which domain and inboxes (order page).
  The machine connects everything after." when a key is set, "Paste the
  logins" otherwise. Without a key nothing else changes: no calls, the old
  `buy` to-do and `simple` texts, the purchase page as before.

**Not known from their docs (check on the first real purchase)**
- The webhook signature's header name and format (the docs say only
  "HMAC-SHA256"); every common form is accepted, and a delivery we cannot
  verify still wakes a (slower) look, so nothing is lost if the guess is wrong.
- The order page: `CHEAPINBOXES.orderUrl` = `https://app.cheapinboxes.com/add`
  (the "New order" page named in INBOX_PROVIDER); no known way to pre-fill it,
  so the hub shows the domain and the users to type.
- Query names: pagination is sent as `limit` / `offset`
  (their `pagination: {total, limit, offset}`), the mailbox filter as
  `domain_id` — and mailboxes are filtered again locally by domain id or
  address, so an ignored filter is harmless; if a listing with parameters is
  refused as a bad request (400), the plain listing is read instead.
- Status words: the docs name domain `provisioning / active / error` and
  mailbox `active`; `provisioned`, `dns_configured`, `ready`, `completed` are
  also read as live, and `failed / cancelled / expired / suspended` as failed.
- Whether `app_password` always comes back for Google mailboxes. Without it
  the account password is stored for SMTP/IMAP, and the existing setup check
  (SMTP login) says so with its `inbox_auth_fail` alert.
- DMARC: the existing check wants `rua=mailto:dmarc@{domain}` (or
  `AUTH.dmarcCollector`). If CheapInboxes' own DMARC record reports elsewhere
  the setup check stops with the `dns_fail` alert naming the record to set;
  the machine may not change DMARC itself (`PATCH /domains/{id}/dmarc` is not
  an allowed call). If that happens, change the record in CheapInboxes (the
  domain's DNS / DMARC page) to the one the alert names; the check runs again
  every hour.
- The mailbox count in `GET /domains` (read as `mailbox_count` if present;
  otherwise counted once with `GET /mailboxes` for up to 3 new unmatched
  domains per look).
