# Build progress (SPEC §15)

| Phase | Status |
|---|---|
| 0 — accounts & secrets | **Owner to do** (see list below) |
| 1 — foundation | **Code done** on branch `trial-machine`; acceptance test waits on Phase 0 |
| 2 – 7 | not started |

## Phase 1 — what exists
- `src/lib/db/keys.js` (every key), `config.js` (every threshold), `time.js`
- Client records + state machine (`db/client.js`), black box log (`db/events.js`)
- Encrypted Redis inboxes (`db/inboxes.js`), loaded by `smtp-accounts.js`
- Scheduler + job table (`scheduler.js`, `jobs.js`), `/api/cron/tick`
- Notifier (owner email + Telegram, daily dedupe, alert log)
- Watchdog: send-stall alarm, Healthchecks ping, nightly backup, keep-alive
- Usage Meter, admin lock (`middleware.js`), Mission Control board/client/alerts
- Sequence T wired into the sender (4 touches, no blanks)
- Tests: `npm test`

## Phase 0 — owner's list
1. Vercel env: `ADMIN_SECRET`, `ENC_KEY`, `CRON_SECRET` (keep the existing one if set), `OWNER_EMAIL`, `OWNER_INBOX`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HC_PING_URL`, `HC_BACKUP_PING_URL`
2. GitHub repo secrets: `CRON_SECRET` (same value), `HC_BACKUP_PING_URL`
3. cron-job.org job: every minute, GET `https://email-distributor.vercel.app/api/cron/tick?source=cronjob`, header `Authorization: Bearer <CRON_SECRET>`
4. Healthchecks.io: two checks (tick: period 5 min, grace 15 min; backup: 1 day)
5. Telegram bot via @BotFather, chat id
6. Mission Control → Aviance → fill sender name + postal address (+ default niche / ICP)
