# Aviance Outreach

Done-for-you cold email engine for [aviance.online](https://www.aviance.online) — books qualified
sales calls onto B2B calendars. Runs on Next.js 14 (App Router) + Vercel + Vercel KV (Upstash).

## How sending works

- An external 10-minute heartbeat pings `GET /api/cron/auto-send` (auth: `Authorization: Bearer <CRON_SECRET>` or `?token=`).
- The route sends **at most one email per ping**, with a hard 12-minute global gap (anti-burst),
  only during **8 AM–7 PM US Eastern**, only from inboxes switched **ON** (Inboxes page),
  up to each inbox's daily cap.
- Sequence per lead: day 0 initial → day 3 follow-up → day 7 breakup (threaded replies).
  Copy lives in `src/lib/personalize.js`; every email ends with the 20-calls-or-refund guarantee.
- `GET /api/cron/check-replies` (2 h) marks replied leads and stops their sequence;
  `GET /api/cron/check-bounces` (4 h) records bounces.

## Pages

Dashboard · Inboxes (on/off + daily cap per inbox) · Leads · Replies · Activity · Offer (preview tool).

## Key API routes

`/api/leads` (list/add) · `/api/leads/bulk` (bulk import) · `/api/leads/cleanup` (archive/promote) ·
`/api/inboxes-control` · `/api/replies` · `/api/daily-log` · `/api/offer` · `/api/ai/personalize` ·
`/api/ai/verify-leads` (lead scoring; sender only sends `quality_score >= 9` US leads).

## Env

See `.env.example` — SMTP/IMAP accounts (`SMTP_ACCOUNT_*`), `CRON_SECRET`, KV credentials, optional `GEMINI_API_KEY`.
