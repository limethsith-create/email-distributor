# One-click buy and set up (CheapInboxes API) — shared contract (2026-09-26)

The owner's words: "When I click purchase on the inboxes and the domains, the
system should do all the DKIM / DNS / connecting by itself. You get a message
when they're bought, you put them together and figure the whole thing out."

CheapInboxes (our inbox provider) has a full API
(`https://api.cheapinboxes.com/v1`, bearer API key `ci_live_…`; spec saved at
`docs/vendor/cheapinboxes-openapi.json`): one `POST /v1/orders/checkout`
registers the domain, creates Google Workspace (or Microsoft) mailboxes with
our persona, and sets DNS, DKIM, DMARC; webhooks say when things are ready;
`GET /v1/mailboxes/{id}/credentials` gives `email, password, app_password,
imap_host/port, smtp_host/port`; `PATCH /v1/domains/{id}/forwarding` sets the
domain's redirect. So the machine does the whole purchase + setup itself when
the owner presses ONE button. No AI; plain rules.

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

## 2. Picking the domain (machine, replaces the manual shopping list step)
When a client reaches `awaiting_purchase` (existing state), the machine
builds the domain candidates as today (systems/domains.js / pricescout.js)
and asks CheapInboxes which are free and what they cost
(`POST /v1/discovery/domains/search`, keyword + allowed TLDs from config
`ALLOWED_TLDS`), then prices the whole cart with `POST /v1/orders/quote`
(same shape as checkout: the best domain + `INBOX.count` mailboxes, provider
from config). The hub shows: the domain, "$X today, $Y a month", the two
inbox addresses it will create, and up to 3 other free names he can pick.

Personas: from the onboarding profile — `senderName` → first/last name,
`senderPrefix` → email prefixes (`jordan`, `jordan.<last>` or `j.<last>` for
the second; always 2 different ones, lower-case, a–z0–9 and dots).

## 3. The button (machine)
`POST /api/mc/clients/{id}/autobuy` `{ action: 'quote' | 'buy' | 'retry' | 'pick', domain? }`
- `quote` → fresh quote `{ domain, alternatives:[{domain, price}], mailboxes:[email], totalTodayCents, monthlyCents, currency }`.
- `pick` → choose another listed domain, returns the new quote.
- `buy` → safety first: client in `awaiting_purchase`; no order yet for this
  client (one order per client, KV claim); a fresh quote whose total ≤
  `CHEAPINBOXES.maxOrderCents` (default 4 000 = $40) and equal to what the hub
  showed (`expectCents` in the body — mismatch → 409 "price changed, check
  again"); then `POST /v1/orders/checkout` (name "Aviance trial — {company}").
  Stores `order_id`, domain id, mailbox ids; state → the existing
  purchase/setup path; owner alert `bought` ("Bought acmeoutreach.com and 2
  inboxes for $16.49 — setting up now, about 48 h").
- `retry` → after `order.failed`: re-sync; if the order is dead, allow a new
  order (the claim is released) — never two live orders.

## 4. Setup runs by itself
Truth always comes from the API, never from a webhook body: every webhook
(verified by HMAC-SHA256 of the raw body with the stored secret — accept the
signature in the common header forms, e.g. `x-cheapinboxes-signature`,
`x-webhook-signature`, `x-signature`, hex or base64, optional `sha256=` /
`t=…,v1=…`) is only a wake-up: the machine re-reads the order
(`GET /v1/orders/{id}`, `GET /v1/domains/{id}`, `GET /v1/mailboxes/{id}`).
An unverifiable delivery is still allowed to trigger a (rate-limited) re-sync
— it can never change anything by itself. The same sync also runs from the
hub's check call, the job on the tick, and `after()` of `buy`.

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
4. `order.failed` / a mailbox stuck > 72 h / checkout error → owner alert
   `autobuy_problem` with the plain reason and what to do.

Status for the hub (trial detail `autobuy`):
```jsonc
{ "status": "not_set_up|ready_to_buy|ordering|provisioning|connecting|done|failed",
  "label": "Setting up acmeoutreach.com — about 48 hours",
  "domain": "acmeoutreach.com", "orderId": "…", "chargedCents": 1649, "monthlyCents": 700,
  "steps": [ { "key": "ordered", "label": "Bought", "done": true, "at": "ISO" },
             { "key": "domain", "label": "Domain live + spam protection set", "done": false, "at": null },
             { "key": "inboxes", "label": "2 inboxes created", "done": false, "at": null },
             { "key": "connected", "label": "Connected to our system", "done": false, "at": null },
             { "key": "warmup", "label": "Warm-up started", "done": false, "at": null } ],
  "mailboxes": [ { "email": "jordan@acmeoutreach.com", "status": "provisioning|active|connected" } ],
  "problem": "plain words|null" }
```
`simple` (board rows): "Setting up their inboxes (about 2 days)" /
"Ready to buy — press Buy and set up" (`needsYou: true`).

Settings status: `GET /api/mc/cheapinboxes` →
`{ status: 'not_set_up|connected|broken', account, hasPaymentMethod, webhook: 'registered|missing' }`;
`POST /api/mc/cheapinboxes` `{ action: 'saveKey', apiKey }` · `{ action: 'test' }` · `{ action: 'forget' }`.

The manual path (buy anywhere, paste logins) stays for when the key is not set.
