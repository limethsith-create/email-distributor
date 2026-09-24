# Build progress (SPEC §15)

Merged to `main` and deployed on 2026-09-25 (the Aviance Hub's Trials tab
runs it — `docs/HUB-API.md`). Updated after the integration pass. `npm test` (145 tests, including the full simulated trial)
and `npm run build` pass.

| Phase | Code | Acceptance |
| --- | --- | --- |
| 0 — accounts & secrets | n/a | **Owner to do** — the list below |
| 1 — foundation (clients, scheduler, heartbeat, backups, Mission Control) | done | waits on Phase 0 (real tick, Telegram alert, backup commit) |
| 2 — intake (Gatekeeper, onboarding + agreement, Market Counter, Price Scout, purchase page, Setup Checker, Auth Guard, Booking Link Tester) | done | simulated end to end (`tests/full-run.test.mjs`); real DNS/SMTP/IMAP check waits on Phase 0 |
| 3 — warm-up, canary, ramp | done | simulated; real 14-day warm-up on owned inboxes = Phase 7 |
| 4 — Lead Finder, blocklist, sanity, copy engine + checker, approval page | done | simulated (webhook batches); a real workflow run needs the Places/Reoon keys |
| 5 — run systems (sender, compliance, replies, bookings, scorekeeper, client watch, pace, emergency, learning) | done | simulated: every reply kind, a booking `.ics`, taps, smoke test (unit tests cover the emergency sequence) |
| 6 — report and close (Friday, reports, recommender, decision, extension, ladder, handover, wrap-up, invoice, digests, Test Mode) | done | **simulated full `_test` run passes** (both runs in `tests/fixtures/full-run.json`); the real Test Mode run at 1 day = 1 hour needs Phase 0 |
| 7 — dress rehearsal with owned inboxes | n/a | owner: 14 days real warm-up, 7 days real sends to own addresses, 7 green morning digests |

Integration decisions and the Redis measurement: `docs/assumptions/integration.md`.
Per-stage decisions: `docs/assumptions/stage-a.md` … `stage-d.md`.

## The owner's complete setup list

### 1. Accounts (one-time)

1. **Vercel** project for this repo (Hobby is non-commercial — SPEC §16 #10; a $5 VPS is the drop-in alternative). Link an **Upstash Redis** (Vercel KV) store → `KV_REST_API_URL` / `KV_REST_API_TOKEN` appear by themselves.
2. **Owner Workspace inbox** with 2-Step on and an app password → `OWNER_INBOX` (`email:app-password:Name`); where alerts go → `OWNER_EMAIL`.
3. **Telegram bot** via @BotFather + your chat id → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. **Healthchecks.io**: check 1 "tick" (period 5 min, grace 15 min) → `HC_PING_URL`; check 2 "backup" (period 1 day) → GitHub secret `HC_BACKUP_PING_URL`. Alerts to email + Telegram.
5. **cron-job.org**: one job, every minute (every 2 minutes if you want the Redis headroom — see integration.md), `GET https://<app>/api/cron/tick?source=cronjob`, header `Authorization: Bearer <CRON_SECRET>`.
6. **Google Cloud**: Places API (New) enabled, billing card on file (free monthly allowance), an API key restricted to the Places API → `PLACES_API_KEY` (Vercel **and** GitHub secret).
7. **Reoon Email Verifier** account → `REOON_API_KEY` (Vercel and GitHub secret).
8. **GitHub**: a token that may send `repository_dispatch` to this repo (classic `repo`, or fine-grained Contents: read & write) → `GITHUB_TOKEN` (Vercel); `GITHUB_REPO` if the repo is not `limethsith-create/email-distributor`.
9. **Private backup repo** `aviance-backups` with a deploy key (write) → GitHub secret `BACKUP_DEPLOY_KEY`; repo variable `BACKUP_REPO` if it has another name.
10. **Warm-up helper accounts** (SPEC §16 #16): 3 Gmail, 3 Outlook.com, 2 Yahoo, 2 Zoho, each with IMAP on and an app password; add each on **/mc/warmup**. At least 8 must be healthy.
11. **Clutch** profile (for the review link) · **PayPal.me** link and/or **Wise** details.
12. Optional: **Porkbun** API key + secret and account credit (`PORKBUN_API_KEY`, `PORKBUN_SECRET`, then `AUTO_BUY=true`); a **DMARC collector** inbox (`DMARC_INBOX`, else `OWNER_INBOX` is used); **Upstash management API** (`UPSTASH_EMAIL`, `UPSTASH_API_KEY`, `UPSTASH_DB_ID`) so the Usage Meter shows real Redis numbers.

### 1b. The short way (owner, ~10 minutes)

1. GitHub → Settings → Billing: clear the billing lock (Actions runs say
   "account is locked due to a billing issue"; until then no workflow runs —
   no backup heartbeat, no nightly backup, no Lead Finder).
2. In the repo folder run `scripts/setup-secrets.sh` once: it makes every
   internal secret, stores the GitHub ones, and prints the lines to paste.
3. Paste the printed lines into Vercel → email-distributor → Settings →
   Environment Variables, then Redeploy.
4. cron-job.org: one job every minute (the script prints the exact URL and
   header). Until GitHub is unlocked this is the only heartbeat.

### 2. Vercel environment variables

Everything in `.env.example`, grouped there with one line each. The required
ones: `CRON_SECRET`, `ADMIN_SECRET`, `ENC_KEY` (32 random bytes, base64),
`PUBLIC_BASE_URL`, `OWNER_INBOX`, `OWNER_EMAIL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `HC_PING_URL`, `PLACES_API_KEY`, `GITHUB_TOKEN`,
`LEADFINDER_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `REOON_API_KEY`. Never change
`ENC_KEY` after inboxes are stored (passwords would no longer decrypt), nor
`TRACKING_SECRET`/`CRON_SECRET` lightly (old unsubscribe links stop working).

### 2b. Aviance Hub bridge (docs/HUB-API.md)

The hub at https://aviance.store runs the machine from its **Trials** tab.
Defaults already point at the right Supabase project and the owner's email;
set `HUB_ADMIN_EMAILS` (comma-separated) to let more hub admins in and
`HUB_ORIGINS` if the hub ever moves. "Open in Mission Control" from the hub
needs `ADMIN_SECRET` on the machine.

### 3. GitHub repository secrets and variables

| Name | Kind | Used by |
| --- | --- | --- |
| `CRON_SECRET` | secret | heartbeat.yml (same value as Vercel) |
| `HC_BACKUP_PING_URL` | secret | backup.yml |
| `BACKUP_DEPLOY_KEY` | secret | backup.yml (write key of aviance-backups) |
| `LEADFINDER_TOKEN` | secret | leadfinder.yml (same value as Vercel) |
| `PLACES_API_KEY` | secret | leadfinder.yml |
| `REOON_API_KEY` | secret | leadfinder.yml |
| `GITHUB_WEBHOOK_SECRET` | secret | leadfinder-watch.yml (same value as Vercel) |
| `APP_URL` | variable | heartbeat / leadfinder / backup (default `https://email-distributor.vercel.app`) |
| `BACKUP_REPO` | variable | backup.yml (default `limethsith-create/aviance-backups`) |

### 4. Mission Control → /mc/config (values the code will not guess)

| Key | What | Blocks until set |
| --- | --- | --- |
| `OWNER.signerName` | your legal name, signs the agreement and every client email | agreement, every client email (`config_missing`) |
| `OWNER.address` | your postal address (agreement, fallback footer) | agreement / footer fallback |
| `OWNER.usHours` | default 09:00–17:00 ET | — |
| `REVIEW.clutchUrl` | the Clutch review link | review requests, ladder, exit interview |
| `PAYMENT.paypalMe` / `PAYMENT.wiseDetails` | at least one | month-1 invoice |
| `WINBACK_TEXT.whatsNew` | "what's new since you left" line | the 90-day win-back email |
| `AUTH.dmarcCollector` | optional DMARC report address | — |
| `registrars.spaceship.prices`, `promos` | Price Scout tables (Spaceship has no price yet) | — |
| `PLAN_SHOPPING.growth` / `.scale` | domains/inboxes for those plans | plan-mode shopping list after Paid |
| `TESTMODE.clockScale` | default 24 (1 day = 1 hour) | — |

Then on **/mc** press "Run first-time setup" (moves the aviance env inboxes
into Redis) and fill **Aviance**'s sender name + postal address on its
client page.

### 5. Before the first real client

- Read the agreement text once more: clauses 3 and 7 still mention the
  kickoff call and the day-30 call, which the approval page and the decision
  page replaced (SPEC §16 #8/#9). Change the wording in
  `src/lib/templates/agreement.js`, and have a lawyer read it (§16 #20).
- Read the two client copy templates once (`src/lib/templates/sequence/msp.json`,
  `trial-default.json` + their `.backup.json`): new wording in Sequence T's
  structure (stage-b.md #34).
- Run Test Mode on **/mc/test** ("start from apply") with the helper
  accounts, then Phase 7.

## Known gaps

1. **Redis free tier**: 3 fully-sending trials measure ~814k commands/month
   at 1-minute ticks (~675k at 2-minute) against 500k; 1 trial fits, 2 fit at
   2-minute ticks. Levers and numbers in `docs/assumptions/integration.md`.
   The legacy aviance engine's own Redis use is not measured yet.
2. **Spec cadences relaxed for the budget**: replies every 5 min (spec: every
   tick in US hours), the Emergency Runner's full scan after new sends / daily
   (requests still every tick), booking watcher only after the first hot lead.
3. **Real services unverified**: Places (New) field masks and paging, Porkbun
   pricing/availability/auto-buy endpoints, Calendly availability endpoint,
   the DMARC report IMAP path, Upstash stats endpoint — all only against
   stubs so far.
4. **Test Mode in production** dispatches the real Lead Finder workflow for
   `_test` (Places spend); warm-up placement statistics use real-day keys, so
   a scaled run's warm-up readiness leans on the real warm-up volume.
5. **Early endings** (client quiet 14 days, Stop the trial) send the handover
   (CSVs + Market Report) but not a separate Day 29-style trial report.
6. **Exit interview** only for clients who pressed "Not now"; a no-click
   `not_now` at Day 45 retires the same day without one.
7. **Emergency no-reply trigger** (2 business days without a reply on a
   campaign that had replies) can fire early in a low-volume trial — spec
   behaviour, but expect it in the first real runs.
8. **Legal hold** has no automatic end: the owner clears it on the client
   page (by design — a legal reply always goes to the owner).
9. **Owner-edited copy** (`/mc/clients/[id]/sequence`) is checked at send
   time; a copy failure holds the client and alerts (no silent send).
10. **Warm-up reads**: each mailbox about every 30 min with up to ~14 pool
    members; a larger pool (more helpers or trials) stretches that.
