# Aviance Trial Machine

The engine behind [aviance.online](https://www.aviance.online)'s 30-Day Trial:
it takes a prospect from "yes" to Day 45 with about 20 minutes of owner time
per trial and no person in the loop. Next.js 14 (App Router) on Vercel,
Upstash Redis (Vercel KV), nodemailer SMTP, imapflow IMAP, GitHub Actions for
the long jobs. The full design is `docs/SPEC.md`; build status and the
owner's setup list are `docs/PROGRESS.md`.

## How it runs

- **One heartbeat.** cron-job.org (every minute) and GitHub Actions (every
  5 minutes, backup) call `GET /api/cron/tick` with `Authorization: Bearer
  CRON_SECRET`. The scheduler (`src/lib/scheduler.js`) runs every job that is
  due, once per period (SET NX claims), inside a 20-second budget. A job that
  fails three times in a row alerts the owner. Healthchecks.io is pinged after
  every good tick (dead-man alarm).
- **Per-client systems** (`src/lib/systems/`): intake (Gatekeeper, onboarding
  + agreement, Market Counter, Price Scout, Setup Checker, Auth Guard, Booking
  Link Tester), build (Warm-up Engine, Canary, Ramp Planner, Lead Finder,
  Blocklist Keeper, Sanity Check, Copy Engine + Checker, approval page), run
  (Sender, Compliance Guard, Reply Handler, Booking Watcher, Scorekeeper,
  Client Watch, Pace Checks, Emergency Runner, Learning Library) and close
  (Friday update, Day 29 report + Market Report, Plan Recommender, decision
  page, extension, ladder, handover, wrap-up, invoice, digests). Every key,
  inbox, lead, reply and email is scoped by `clientId`.
- **Rules** (SPEC §1): no silent failure, no subscriptions, no LLM at runtime,
  never invent a number, idempotent everything, hand up never drop, per-client
  isolation.

## Where the owner works

- **Aviance Hub** (https://aviance.store, repo `aviance-hub`): the Trials tab
  shows every trial by stage, each client's thirteen systems with a status
  line, and "what you need to do". It talks to this app through
  `/api/mc/hub` with the hub's own sign-in (`docs/HUB-API.md`).
- **Mission Control** (`/mc`, admin password `ADMIN_SECRET`): the full
  screens — board, client page, purchase page, sequence editor, queue,
  warm-up circle, alerts, config, learning, Test Mode. The hub opens these
  signed in.
- **Client pages** (`/c/<token>/...`): onboarding + agreement, approval,
  booking test, call taps, decision, and the customer / stop / away buttons.

## Layout

```
src/lib/db/            keys.js (every Redis key), client.js (state machine), leads, counters, inboxes, events, promises
src/lib/systems/       one file per system (see above) + hubview.js (the hub's view), boarddata, health
src/lib/joblist/       scheduler jobs per stage (stage-a … stage-d)
src/lib/templates/     every email and page text; sequence/*.json is the copy
src/lib/config.js      every threshold (SPEC §12), overridable in /mc/config
src/lib/notify.js      the only module that emails a human (owner alerts, client emails)
src/app/api/cron/tick  the heartbeat
src/app/api/mc/        Mission Control + hub API (admin session or hub token)
src/app/api/c/         client-page APIs (signed tokens)
src/app/api/webhooks/  Lead Finder results, GitHub workflow failures
scripts/leadfinder/    the GitHub Actions lead finder
.github/workflows/     heartbeat, backup, keep-alive, leadfinder
tests/                 npm test — 150+ tests on an in-memory Redis, incl. a full simulated trial
docs/                  SPEC, PROGRESS, CONTRACTS, HUB-API, assumptions/
```

## Env

Everything is listed with one line each in `.env.example`. Secrets never
leave Redis: inbox passwords are encrypted under `ENC_KEY`, backups exclude
them, and the black box log never holds a password or token.

## Legacy

The owner's own outreach runs as client `aviance` on the pre-trial engine
(`/api/cron/auto-send`, the old dashboard pages) until the per-client Sender
takes it over; its inboxes now load from Redis and its copy is Sequence T.
