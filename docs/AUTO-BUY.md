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
