# Cold Email Setup — getaviance.site (Budget: $11)

## The plan
| Item | Where | Cost |
|---|---|---|
| Domain: getaviance.site | Namecheap (in cart, ready) | $1.18 first year |
| 2× pre-warmed Google Workspace inboxes | cheapinboxes.com | $7.00/mo ($3.50 each) |
| **Total today** | | **$8.18** |

Capacity after setup: ~30 cold emails/day (15/inbox), pre-warmed = no waiting period.
⚠️ Renewal warning: getaviance.site renews at ~$32/yr next year. Set a reminder.

## Step 1 — Buy the domain (YOU)
1. Namecheap tab is open with cart ready ($1.18 subtotal)
2. Sign in → Confirm Order
3. Leave "Stellar Web Hosting free trial" DISABLED (it renews at $5.88/mo)

## Step 2 — Order the inboxes (YOU)
1. Cheapinboxes signup tab is open → Sign up (Continue with Google is fastest)
2. Order: 2× Google Workspace mailboxes ($3.50/mo each)
3. Domain: choose "Bring your own domain" → getaviance.site (free)
4. Suggested mailbox names: lime@getaviance.site and hello@getaviance.site
   (use a real human display name, e.g. "Limethsith from Aviance")

### WhatsApp message to send them first (copy-paste):
> Hi! I want to order 2 Google Workspace mailboxes on 1 domain I already own
> (a .site from Namecheap). Can both mailboxes go in the same workspace on
> that one domain for $7/mo total? Also — can you connect them via SMTP/IMAP
> to my own sending tool (not Instantly/Smartlead)? I need the SMTP
> credentials/app passwords.

## Step 3 — DNS connection (THEM + ME)
- Cheapinboxes sets up MX, SPF, DKIM, DMARC automatically
- You'll need to point the domain's nameservers or DNS records where they say —
  ask me when they send instructions, I'll walk you through the Namecheap DNS panel

## Step 4 — Plug into MailDistro (ME)
Once they deliver the mailboxes (10 min–24 h), get from their dashboard:
- Email address + app password for each mailbox (Google Workspace → smtp.gmail.com)

Then update .env:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_ACCOUNT_1=lime@getaviance.site:APP_PASSWORD_1:Limethsith
SMTP_ACCOUNT_2=hello@getaviance.site:APP_PASSWORD_2:Aviance Team
MAX_EMAILS_PER_ACCOUNT=15
```

## Warmup ramp — NOW AUTOMATED IN CODE ✅
These inboxes are FRESH (not pre-warmed — that option was "Coming Soon").
The auto-sender now ramps the daily cap automatically based on
WARMUP_START_DATE (set to 2026-06-13):

| Period | Days | Cap per inbox/day | 2 inboxes total/day |
|--------|------|-------------------|---------------------|
| Week 1 | 0-6   | 5  | 10 |
| Week 2 | 7-13  | 8  | 16 |
| Week 3 | 14-20 | 12 | 24 |
| Week 4+| 21+   | 15 | 30 |

Implemented in src/app/api/cron/auto-send/route.js (getMaxPerAccountPerDay()).
To change the start date later, edit WARMUP_START_DATE in your env vars.

## Sending rules (so you don't burn the inboxes)
- Plain-text emails, 1 link max, no attachments
- Clean your list (no catch-alls, verify emails) — bounces kill domains fast
- Always include an opt-out line
- If replies say "stop" → remove immediately
- Don't override the warmup ramp to go faster — that's exactly what got
  your old Gmail accounts blocked

## Scale path (when money comes in)
- +1 domain (~$1–3) + 2 more inboxes (+$7/mo) = doubles capacity
- Same Cheapinboxes account, new workspace per domain
- Never more than 2–3 inboxes per domain
