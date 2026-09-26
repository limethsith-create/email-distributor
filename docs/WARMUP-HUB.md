# Warm-up in the hub — shared contract (2026-09-26)

The owner's words: "Signing the inboxes up for warm-up has to be automated.
Find the best free place to warm up, add it to the system, let me know
what's going on."

**Decision (researched 2026-09-26):** no free warm-up service covers our
case — TrulyInbox free = 1 inbox at 10 emails/day; Warmforge free = 1
Microsoft slot, then $10/inbox/month; EmailWarmup.com charges per inbox. The
machine's own warm-up circle (systems/warmup.js, free) stays the warm-up.
It is already automatic for client inboxes (they join the circle when the
client reaches `warming`). What it needs is **helpers**: ≥ `WARMUP.minPool`
(8) members in the circle. The circle also counts the aviance inboxes
(`includeAviance`) and every trial's inboxes, so it grows with each trial.
Helpers are free personal accounts the owner creates once (Gmail, Yahoo, AOL,
iCloud, GMX, WEB.DE, Yandex — `HELPER_PROVIDERS` in lib/smtp-providers.js,
each with its setup steps). The machine never creates accounts.

## Machine
- `POST /api/mc/warmup` `addHelper` **tests the login first** (SMTP send
  login + IMAP login via the existing `io.smtpVerify` / `imapLogin` paths,
  bounded ~20 s) and saves only when both work; a failure answers 400 with a
  plain reason per provider ("Gmail said the password is wrong — use the
  16-letter app password, not your normal password", "Yahoo: turn on
  'Allow apps that use less secure sign-in' is gone — create an app password
  under Account security", "IMAP is off — GMX: Settings › POP3 & IMAP ›
  enable"). New action `testHelper` {email} re-tests a saved helper and
  updates its health. `GET /api/mc/warmup` answers (plain, hub-ready):
  ```jsonc
  { "circle": { "members": 6, "helpers": 3, "clientInboxes": 1, "avianceInboxes": 2, "min": 8, "ready": false, "missing": 2,
                "label": "6 of 8 in the warm-up circle — add 2 more helpers" },
    "helpers": [ { "email": "…", "provider": "yahoo", "providerLabel": "Yahoo Mail", "health": "ok|new|failing|disabled", "lastOkAt": "ISO|null", "problem": "plain|null", "sentToday": 3 } ],
    "providers": [ { "key": "google", "label": "Gmail", "steps": ["…"], "note": "…", "passwordLabel": "16-letter app password" } ],
    …existing fields… }
  ```
- Trial detail gains `warmup` (null before the inboxes are connected):
  ```jsonc
  { "status": "waiting_for_helpers|warming|ready|paused",
    "label": "Warming up — day 5 of about 14 · 96% reach the inbox",
    "day": 5, "of": 14, "readyBy": "YYYY-MM-DD|null", "inboxRate": 0.96 | null,
    "inboxes": [ { "email": "…", "day": 5, "sentToday": 8, "inboxRate7d": 0.96, "ready": false } ],
    "problem": "plain|null" }
  ```
  `simple` for the warming step uses the same label. `waiting_for_helpers`
  when the circle is under `min` (with `needsYou: true` and a to-do "Add N
  warm-up helpers — Settings › Warm-up"); an owner alert `warmup_needs_helpers`
  once per day at most while a client waits.

## Hub
- **Settings › Warm-up**: the circle meter ("6 of 8 — add 2 more helpers"),
  the helpers list (health in plain words, "Test", "Remove"), and **Add a
  helper**: pick the provider → its numbered steps → email + app password
  (password field) → "Test and add" (`addHelper`) → a plain success or the
  plain reason. A short line on why: "Helpers are free email accounts that
  trade friendly emails with new inboxes so Gmail and Outlook learn to trust
  them. Make them once; they help every client."
- **Trial page**: a "Warm-up" card when `warmup` is set — the label, a simple
  bar (day N of ~14), inbox rate, each inbox, `readyBy`; when
  `waiting_for_helpers`, the big button is "Add N warm-up helpers".
