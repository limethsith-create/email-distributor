# Aviance Machine

The engine behind [aviance.online](https://www.aviance.online)'s done-for-you
cold email service: it takes a paying client (Starter, Growth or Scale) from
the sales call to sending and booked calls, with little owner time and no
person in the loop. Next.js 14 (App Router) on Vercel, Upstash Redis (Vercel
KV), nodemailer SMTP, imapflow IMAP, GitHub Actions for the long jobs. The
original design is `docs/SPEC.md` (written for the free trial, which is gone —
see "What changed" below); build status and the owner's setup list are
`docs/PROGRESS.md`.

## How a client comes in

1. **The website's "Book a call" form** (`POST /api/inquiry`) is the only way
   in. The booking lands in the hub's Inquiries with the sales call on the
   Calendar; when they gave a website, a record is held for the call
   (state `applied`) and researched, so "What we found" is ready before the
   call. Nothing is emailed to them except the call confirmation.
2. **After the sales call** the owner marks the booking **Won** (the record
   becomes a paying client: onboarding starts with the one onboarding-call
   email) or **Lost** (the record is declined; nothing is emailed).
3. The owner can also **add a paying client by hand** (Clients → "Add a paying
   client yourself", `POST /api/mc/clients/new`) for someone closed elsewhere.

From there: onboarding call and page → plan agreement (with the month-one
invoice) → domain + inboxes → setup checks → warm-up → launch call → sending,
Friday updates, replies and booked calls — until they stop.

## How it runs

- **One heartbeat.** cron-job.org (every minute) and GitHub Actions (every
  5 minutes, backup) call `GET /api/cron/tick` with `Authorization: Bearer
  CRON_SECRET`. The scheduler (`src/lib/scheduler.js`) runs every job that is
  due, once per period (SET NX claims), inside a 20-second budget. A job that
  fails three times in a row alerts the owner. Healthchecks.io is pinged after
  every good tick (dead-man alarm).
- **Per-client systems** (`src/lib/systems/`): intake (client intake,
  onboarding + plan agreement, Market Counter, Price Scout, Setup Checker,
  Auth Guard, Booking Link Tester), build (Warm-up Engine, Canary, Ramp
  Planner, Lead Finder, Blocklist Keeper, Sanity Check, Copy Engine + Checker,
  approval page), run (Sender, Compliance Guard, Reply Handler, Booking
  Watcher, Scorekeeper, Client Watch, Pace Checks, Emergency Runner, Learning
  Library) and close (Friday update, Market Report, handover, wrap-up,
  invoice, digests). Every key, inbox, lead, reply and email is scoped by
  `clientId`.
- **Rules** (SPEC §1): no silent failure, no subscriptions, no LLM at runtime,
  never invent a number, idempotent everything, hand up never drop, per-client
  isolation.

## Where the owner works

- **Aviance Hub** (https://aviance.store, repo `aviance-hub`): the Clients tab
  shows every client by stage, each client's systems with a status line, and
  "what you need to do"; Inquiries holds the bookings (Won / Lost). It talks to
  this app through `/api/mc/hub` with the hub's own sign-in
  (`docs/HUB-API.md`).
- **Mission Control** (`/mc`, admin password `ADMIN_SECRET`): the full
  screens — board, client page, purchase page, sequence editor, warm-up
  circle, alerts, config, learning. The hub opens these signed in.
- **Client pages** (`/c/<token>/...`): onboarding + agreement, approval,
  booking test, call taps, their dashboard, and the customer / away buttons.

## Layout

```
src/lib/db/            keys.js (every Redis key), client.js (state machine), leads, counters, inboxes, events, promises
src/lib/systems/       one file per system (see above) + hubview.js (the hub's view), boarddata, health
src/lib/joblist/       scheduler jobs per stage (stage-a … stage-d)
src/lib/templates/     every email and page text; sequence/*.json is the clients' copy
src/lib/config.js      every threshold (SPEC §12), overridable in /mc/config
src/lib/notify.js      the only module that emails a human (owner alerts, client emails)
src/app/api/cron/tick  the heartbeat
src/app/api/inquiry    the website's "Book a call" form — the only way in
src/app/api/mc/        Mission Control + hub API (admin session or hub token)
src/app/api/c/         client-page APIs (signed tokens)
src/app/api/webhooks/  Lead Finder results, GitHub workflow failures
scripts/leadfinder/    the GitHub Actions lead finder
.github/workflows/     heartbeat, backup, keep-alive, leadfinder
tests/                 npm test — 500+ tests on an in-memory Redis, incl. a full simulated client journey
docs/                  SPEC, PROGRESS, CONTRACTS, HUB-API, assumptions/
```

## Env

Everything is listed with one line each in `.env.example`. Secrets never
leave Redis: inbox passwords are encrypted under `ENC_KEY`, backups exclude
them, and the black box log never holds a password or token.

## What changed (November 2026)

- **No free trial.** Removed: the trial application (`/apply`, `/api/apply`),
  the trial cap and waiting list, Day 20 / Day 29 report / Day 30 decision
  page, the extension, the review ladder and win-back, the trial agreement,
  Test Mode / the Test run, and every trial line in emails and pages. Every
  client is on a plan and signs the plan agreement. Internal names kept for
  stored data: the `client:{id}:trial` hash (now "the client's dates and
  milestones") and the `trial-default` copy niche (general B2B).
- **Aviance's own cold email is gone**: `/api/cron/auto-send`, the reply
  checker, the EOD / daily report, the outreach queue and archive, the old
  dashboard pages (`/activity`, `/inboxes`, `/leads`, `/replies`) and the hub's
  My stats. The per-client Sender is untouched. `/api/unsubscribe`,
  `/api/track/open` and `/api/cron/check-bounces` still read the old lead list
  so past recipients can always unsubscribe.
