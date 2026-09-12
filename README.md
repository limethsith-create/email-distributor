# Aviance Outreach

Cold-email sending engine for [aviance.online](https://www.aviance.online) — books qualified
sales calls onto B2B calendars. Next.js 14 (App Router) + Vercel + Vercel KV (Upstash).

This is the trimmed engine: sending, timing, reply tracking, deliverability and reporting.
The old two-campaign copy, the AI layer and the auto-booking bot were removed for the
30-Day Trial model (one offer, one sequence, handled by a person). Copy lives in
`src/lib/personalize.js` as a placeholder scaffold until Sequence T is written in.

## How sending works

- An external heartbeat pings `GET /api/cron/auto-send` every ~10 minutes
  (auth: `Authorization: Bearer <CRON_SECRET>` or `?token=`). The app is serverless
  and cannot tick itself, so this pinger is what drives all sending.
- Each ping sends **at most one email**, with a global anti-burst gap, **only** during
  **8 AM–7 PM US Eastern, Mon–Fri**, **only** from inboxes switched **ON** (Inboxes page),
  up to each inbox's daily cap.
- Sequence per lead: day 0 → day 3 follow-up → day 7 breakup (threaded as "Re:").
  Each inbox reserves a share of its daily cap for fresh day-0 sends (`FRESH_MIN_SHARE`)
  so follow-ups can never starve new leads; follow-ups more than `FOLLOWUP_GRACE_DAYS`
  past due are retired instead of sent.
- The heartbeat also emails the owner a **switch-off alarm** (from 10 AM ET if no inbox
  is on) and an **end-of-day report** (after 7 PM ET). See `src/lib/daily-report.js`.
- `GET /api/cron/check-replies` (every 1–2 h) records replies and stops their sequence
  (replies are handled by a person — there is no auto-reply bot).
  `GET /api/cron/check-bounces` (daily) records bounces.

## Pages

Dashboard · Inboxes (on/off + daily cap per inbox) · Leads · Replies · Activity.

## Key API routes

`/api/cron/auto-send` (the sender) · `/api/cron/check-replies` · `/api/cron/check-bounces` ·
`/api/inboxes-control` · `/api/leads` (list/add) · `/api/leads/bulk` (spreadsheet import) ·
`/api/leads/cleanup` · `/api/leads/export` · `/api/replies` · `/api/daily-log` ·
`/api/track/open` · `/api/unsubscribe`.

## Env

See `.env.example` — SMTP/IMAP accounts (`SMTP_ACCOUNT_*`), `CRON_SECRET`, KV credentials,
optional `DAILY_REPORT_TO`, `FRESH_MIN_SHARE`, `FOLLOWUP_GRACE_DAYS`.
