#!/usr/bin/env bash
# One-time secrets for the trial machine (docs/PROGRESS.md, Phase 0).
#
# Makes fresh random values for every INTERNAL secret the machine needs,
# stores the ones GitHub Actions uses as repository secrets (via `gh`), and
# prints the lines to paste into Vercel → email-distributor → Settings →
# Environment Variables. Run it once; running it again makes NEW values, so
# paste them all again (never change ENC_KEY after inboxes are stored).
#
# It does NOT create or touch any outside account (Telegram, Healthchecks,
# Google Places, Reoon, inbox providers) — those keys are pasted by the owner.

set -euo pipefail
REPO="${REPO:-limethsith-create/email-distributor}"
rand() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }

ADMIN_SECRET=$(rand 32)
CRON_SECRET=$(rand 32)
ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")   # exactly 32 bytes, base64
LEADFINDER_TOKEN=$(rand 32)
GITHUB_WEBHOOK_SECRET=$(rand 32)

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  printf '%s' "$CRON_SECRET" | gh secret set CRON_SECRET -R "$REPO"
  printf '%s' "$LEADFINDER_TOKEN" | gh secret set LEADFINDER_TOKEN -R "$REPO"
  printf '%s' "$GITHUB_WEBHOOK_SECRET" | gh secret set WATCH_WEBHOOK_SECRET -R "$REPO"
  gh variable set APP_URL -R "$REPO" --body "https://email-distributor.vercel.app" >/dev/null
  echo "GitHub secrets set: CRON_SECRET, LEADFINDER_TOKEN, WATCH_WEBHOOK_SECRET (+ variable APP_URL)"
else
  echo "gh is not signed in — set CRON_SECRET, LEADFINDER_TOKEN, WATCH_WEBHOOK_SECRET yourself under GitHub → Settings → Secrets"
fi

cat <<EOF

Paste these into Vercel → email-distributor → Settings → Environment Variables
(Production + Preview), one per line, then press "Redeploy" on the latest deployment:

ADMIN_SECRET=$ADMIN_SECRET
CRON_SECRET=$CRON_SECRET
ENC_KEY=$ENC_KEY
LEADFINDER_TOKEN=$LEADFINDER_TOKEN
GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET
PUBLIC_BASE_URL=https://email-distributor.vercel.app
OWNER_EMAIL=limethsith@gmail.com

Still yours to fill in (from each service's own page):
OWNER_INBOX=you@yourdomain.com:APP_PASSWORD:Your Name
TELEGRAM_BOT_TOKEN=   TELEGRAM_CHAT_ID=
HC_PING_URL=          (Healthchecks.io check "tick")
PLACES_API_KEY=       REOON_API_KEY=       GITHUB_TOKEN=

cron-job.org job: every minute, GET https://email-distributor.vercel.app/api/cron/tick?source=cronjob
with the header  Authorization: Bearer $CRON_SECRET
EOF
