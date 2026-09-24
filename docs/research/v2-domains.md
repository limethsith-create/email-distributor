# Domains + inboxes research (Intake v2)

Checked 25 September 2026. USD. Every .com/.net/.co price includes the $0.20
ICANN fee. These numbers are in `src/lib/config.js` (Stage A block) as
`REGISTRARS` and `INBOX_PROVIDER`, each with a `checkedAt` date. The owner can
change them in `/mc/config`.

## The five registrars

We picked the five well-regarded registrars with the lowest .com prices, looking
at the first year and the renewal together. Registrars with a bad record were
left out.

| # | Registrar | .com 1st yr / renew | .net 1st / renew | .co 1st / renew | Public promo (.com) | Free WHOIS privacy | Auto-renew can be turned off | Price feed without an API key |
|---|---|---|---|---|---|---|---|---|
| 1 | **Spaceship** | **9.08** / 10.18 | 11.40 / 11.40 | 15.53 / 31.05 | COM67 → $3.80 ("limited time", no end date shown) | yes | yes, a toggle in Domain Manager | no (API returns 401 without a key) |
| 2 | **Cloudflare** | 10.46 / 10.46 | 11.86 / 11.86 ‡ | 30.00 / 30.00 ‡ | none (sells at cost) | yes (redacted) | yes, at least 30 days before expiry | no (needs an account id + token) |
| 3 | **Dynadot** | 10.88 / 10.88 | 12.52 / 12.52 | **4.99** / 31.20 | 899COM → $8.99 (limited quantity; help page dated 29 May 2026, not re-checked) | yes | yes ("Do Not Renew") | no (the prices page has the numbers in its HTML, but it is not an API) |
| 4 | **Porkbun** | 11.08 / 11.08 | 12.52 / 12.52 | 15.76 / 31.20 | none (`coupons: []` in the API) | yes | yes | **yes**, see below |
| 5 | **Namecheap** | 11.48 / 18.68 | 12.68 / 18.78 | 19.98 / 45.48 | NEWCOM679 → $6.99, first order of a new customer only | yes | yes | no (needs a user, key, allow-listed IP and 20 domains or $50 spent) |

‡ Cloudflare only shows its price list to signed-in users. Its .net and .co
prices therefore come from cfdomainpricing.com (updated 24 Sep 2026). The .com
price is the wholesale price ($10.26) plus the ICANN fee.

The code ranks by list price only. It shows promo codes but never uses them to
pick `best`, because codes can end without notice. With auto-renew off, the
renewal price only decides ties.

**Why these five**
1. **Spaceship.** Lowest .com list price and lowest renewal. Its first year
   ($9.08) is below Verisign's wholesale price, so expect it to rise. Some users
   report new accounts frozen for an ID check.
2. **Cloudflare.** Sells at cost with no mark-up at renewal. The domain has to
   use Cloudflare DNS. That works for Google Workspace, and it is the DNS route
   CheapInboxes supports without taking over your nameservers.
3. **Dynadot.** Renews at the same price, adds nothing at checkout, and has the
   cheapest .co first year.
4. **Porkbun.** Renews at the same price and has a strong reputation. It is
   also the only registrar with a price feed that needs no key, so the machine
   refreshes its prices live.
5. **Namecheap.** Well known and reliable. Its renewal is expensive, but that
   matters little with auto-renew off.

The runner-up was **Regery**: $10.99 first year on sale, $11.49 to renew, 4.6 on
Trustpilot. We could not confirm free privacy, an auto-renew switch or a search
link that pre-fills the name, so it was not added.

**Rejected**
- **Sav** ($10.87 / $10.15). 2026 reviews say it charged renewals while
  auto-renew was off and let a domain go to auction during the grace period.
- **Cosmotown** ($8.59 / $11.35). Mixed reviews, suspensions after complaints,
  and slow handling of abuse reports.
- **NameSilo**. Its own page now shows .com at $17.29. The $11.05 price needs
  its paid Discount Program.
- **IONOS**. $1 the first year, about $20 to renew, and a hard cancellation
  process.
- **GoDaddy** ($14.84 / $22.17), **Hostinger** ($10.19 / $20.19),
  **Squarespace** (about $12 / $20), **Gandi** ($11.00 / $38.38),
  **Name.com** ($12.99 / $19.99) and **Wix** ($7.90 only with a code, renews at
  $21.35) all have dearer renewals or heavy upsells.

**Wholesale .com price.** Verisign charges $10.26 today. That rises to
**$10.97 on 1 November 2026**. Porkbun expects its .com to reach about $11.81.
The table's .com rows will therefore go up by about $0.71 then. After
`DOMAINS.tableMaxAgeDays` (35 days) every table price shows as "unconfirmed"
on the shopping list until someone re-checks it.

### Porkbun's price feed (verified)

`https://api.porkbun.com/api/json/v3/pricing/get` answered HTTP 200 without a
key, both to a plain GET and to a POST with an empty `{}` body. Porkbun's own
API spec says it does not require authentication. You can limit the reply with
`?tlds=com,net,co`. The prices come back as text:

```json
{"status":"SUCCESS","pricing":{"com":{"registration":"11.08","renewal":"11.08","transfer":"11.08","coupons":[]},
 "net":{"registration":"12.52","renewal":"12.52",...},"co":{"registration":"15.76","renewal":"31.20",...}}}
```

The `/domain/checkDomain` availability check still needs keys, and Porkbun
limits it to 10 calls per 10 seconds.

### Search links that pre-fill the domain (`REGISTRARS[].search`)

Porkbun `https://porkbun.com/checkout/search?q={domain}` (tested) ·
Namecheap `https://www.namecheap.com/domains/registration/results/?domain={domain}` (tested) ·
Spaceship `https://www.spaceship.com/domain-search/?query={domain}&tab=domains` (tested) ·
Dynadot `https://www.dynadot.com/domain/search?domain={domain}` (tested) ·
Cloudflare `https://domains.cloudflare.com/?domain={domain}` (seen in search results; a bot check blocked our own test).

### Sources (all checked 2026-09-25)

- Spaceship pricing: https://www.spaceship.com/domain-search/?tab=pricing · a report of an ID-check freeze: https://www.blackhatworld.com/seo/stay-away-from-spaceship-they-froze-my-domain-and-asked-for-kyc.1624967/
- Cloudflare Registrar: https://www.cloudflare.com/products/registrar/ · FAQ (Cloudflare DNS required): https://developers.cloudflare.com/registrar/faq/ · renewals: https://developers.cloudflare.com/registrar/account-options/renew-domains/ · .net/.co: https://cfdomainpricing.com/
- Dynadot prices: https://www.dynadot.com/domain/prices · ICANN fee: https://www.dynadot.com/help/question/icann-fee · 899COM: https://www.dynadot.com/help/question/com-registration-promotion · auto-renew: https://www.dynadot.com/help/question/auto-renew-domain-settings
- Porkbun domains: https://porkbun.com/products/domains · API: https://porkbun.com/api/json/v3/documentation · price feed: https://api.porkbun.com/api/json/v3/pricing/get · auto-renew off: https://kb.porkbun.com/article/70-how-to-turn-off-auto-renew · .com price rise: https://kb.porkbun.com/article/201-why-did-com-prices-go-up-and-how-high-will-they-go
- Namecheap domains: https://www.namecheap.com/domains/ · API rules: https://www.namecheap.com/support/api/intro/ · auto-renew: https://www.namecheap.com/support/knowledgebase/article.aspx/10564/2207/can-i-set-up-automatic-billing-for-my-namecheap-services/
- .com across registrars: https://tld-list.com/tld/com
- Verisign's wholesale increase: https://domainnamewire.com/2026/04/23/breaking-verisign-raising-wholesale-com-prices/
- Reviews of rejected registrars: https://www.trustpilot.com/review/www.sav.com · https://www.trustpilot.com/review/www.cosmotown.com

## Inboxes: CheapInboxes only

The owner decided that all inboxes are bought from CheapInboxes. The other
providers stay in `inboxProviders` for reference only.

| Item | Finding | Source |
|---|---|---|
| Price per inbox per month | $3.50 (1–99) · $3.25 (100–249) · $3.00 (250–999) · $2.80 (1,000+). Google and Microsoft cost the same. The tier follows the account's total active mailboxes. (The API example still shows $2.75 for 1,000+.) | [1], [5] |
| Minimum order / setup fee | None / none | [1] |
| Billing | Monthly per active inbox. The card is charged 5 days before renewal, and unpaid inboxes are switched off on the renewal date. | [2] |
| Cancellation | 7 days' notice, in the portal or by email to support@cheapinboxes.com | [2], [3] |
| Product | "Official Business Starter with Admin Access", one Workspace per domain, "full admin access" | [1] |
| App passwords | Probably yes, but not confirmed. The API's example credentials include a 16-letter `app_password` plus imap.gmail.com:993 / smtp.gmail.com:587. The website only promises one-click sign-in to sequencers, and no credentials spreadsheet is offered. | [1], [4], [5] |
| **API** | **Yes.** A public REST API with 70+ endpoints; the key is created in the dashboard (Integrations → API); limited to 120 requests a minute. The machine does not use it yet. | [4], [5] |
| **Free warm-up** | **No.** The home page says "Pre-warmed", but their own blog says they do not sell warm-up. Their sister product Cheap Sequencer ($9.99/mo) includes warm-up. We warm the inboxes with our own Warm-up Engine. | [1], [6], [9] |
| Your own domain | Imported free. DNS can go one of three ways: point the nameservers to CheapInboxes; keep DNS in your own Cloudflare account and give them a limited API token (Zone Read + DNS Edit), after which they add MX, SPF, DKIM and DMARC; or let them do it with your registrar login. **The choice cannot be changed later.** | [1], [4], [5] |
| Domains they sell | From $2.50/yr; .com is now **$11.99** (it was $9.99 in the owner's notes and on 23 Aug) | [1], [5], [8] |
| Setup time | "10 minutes" and "same day" in the FAQ; "about 48 hours" in the fulfilment policy | [1], [3] |
| Reviews | Trustpilot 4.5 from 30 reviews. Both 1-star reviews come from one company (August 2026). | [7] |

**Why the machine uses the Cloudflare DNS route.** With this route DNS stays in
the owner's hands. The Setup Checker may ask for one record to change, for
example the DMARC `rua` address or the redirect. The route is also mandatory
for domains registered at Cloudflare.

**Buying checklist** (`INBOX_PROVIDER.steps`, filled with the domain and the
sender names):
1. Keep the domain on Cloudflare DNS. A domain bought at Cloudflare already is.
   For one bought elsewhere, add it to your free Cloudflare account and switch
   its nameservers at the registrar.
2. Sign in at https://app.cheapinboxes.com. The first time, create the account
   and add a card.
3. Start a new order at https://app.cheapinboxes.com/add. Import the domain (no
   charge) and choose Google Workspace.
4. For DNS, choose the Cloudflare option and paste a Cloudflare API token
   limited to that domain (Zone Read + DNS Edit). This choice is permanent.
5. Add 2 users with the sender's name (e.g. John Smith → john@…, John Smith →
   jsmith@…). Skip the sequencer connection.
6. If offered, forward the website to the client's main site.
7. Pay 2 × $3.50 = $7.00 a month. There is no setup fee.
8. When both inboxes show Active (10 minutes to 48 hours), copy each app
   password. If none is shown, sign in as the user, turn on 2-Step
   Verification, and create one at myaccount.google.com/apppasswords.
9. Paste everything on the purchase page. The setup checks start at once.

Steps 3–5 are worded from the API reference, because the dashboard has no
public help pages. Before the first order, ask support on WhatsApp to confirm
that each mailbox comes with an app password.

Sources: [1] https://www.cheapinboxes.com/ · [2] https://www.cheapinboxes.com/terms ·
[3] https://www.cheapinboxes.com/fulfillment · [4] https://www.cheapinboxes.com/developers ·
[5] https://api.cheapinboxes.com/docs (spec: https://api.cheapinboxes.com/docs/openapi.json) ·
[6] https://www.cheapinboxes.com/blog/email-warmup-tools (13 Aug 2026) ·
[7] https://www.trustpilot.com/review/cheapinboxes.com ·
[8] https://www.infraforge.ai/blog/cheapinboxes-review (a competitor, 23 Aug 2026) ·
[9] https://cheapsequencer.com/rebel
