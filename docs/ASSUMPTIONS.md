# Build assumptions

Where the spec left a value or wording open, this is what the code does.
Each line says where it lives so it can be changed in one place.

## Phase 1 (2026-09-24)

1. **Sequence T wording** is copied verbatim from *The 30-Day Trial.docx*
   §10 into `src/lib/templates/sequence/default.json`. Timing follows the
   spec (Day 0 / 3 / 7 / 10), not the doc (Day 1 / 4 / 10 / 18) — spec §16 #18.
2. **Footer.** The doc's emails have no footer. Every touch gets
   `{SenderName}` + `{postalAddress}` + the existing opt-out line
   ("Not the right fit? Just reply STOP and I will not email you again.").
   Sending is held (owner alert `config_missing`) until both values exist.
3. **Slots with no data are never guessed.** `{niche}`/`{ICP}` come from the
   lead or the client profile (`defaultNiche` / `defaultIcp`, set in Mission
   Control). Email 3 needs `{Count}` `{City}` `{size}` `{dealValue}` per lead;
   when any is missing that touch is **skipped** and the lead moves on to
   email 4. A lead with no first name or company gets `skipped_copy`.
4. **Threading.** Email 2 replies in email 1's thread; email 3 starts a new
   thread (per the doc); email 4 replies in email 3's thread (email 1's if 3
   was skipped).
5. **Aviance leads stay on the legacy keys** (`leads`, `suppression`,
   `daily_sends`, …; listed in `db/keys.js` `LEGACY`) until the per-client
   Sender in Phase 5 moves them under `client:aviance:*`. The aviance inboxes
   now load from Redis (`inbox:aviance:*`), env still works.
6. **Reply scan cadence** for aviance: every 5 min in US hours, 20 min
   otherwise (the whole-inbox scanner is too heavy for every tick; the
   one-inbox-per-tick Reply Handler arrives in Phase 5).
7. **Bounce scan** stays on the existing Vercel daily cron (13:00 UTC); it
   can run longer than a 25-second tick.
8. **Redis usage** is only measured when Upstash management credentials
   are set; otherwise the Usage Meter records tick counts and raises no
   Redis alert (rule 4: no guessed numbers).
9. **Admin session** is a signed cookie (30 days), not a server-side
   session. Missing `ADMIN_SECRET` / `CRON_SECRET` = locked (fail closed).
10. **US holidays** list includes Juneteenth (11 federal dates/year).
11. **Backups** go to the private repo `limethsith-create/aviance-backups`
    via a deploy key (`BACKUP_DEPLOY_KEY` secret); the export strips inbox
    passwords, so a restore needs the inbox passwords pasted again.
