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

---

## As built (2026-09-26, machine side)

The hub's fields: docs/HUB-API.md "Warm-up in the hub". Tests:
tests/warmup-hub.test.mjs.

**Files**
- `src/lib/systems/warmup.js` — `addHelper` (checks, login test, save),
  `testHelper`, `testHelperLogin` + `helperFailure` (the plain reasons),
  `helperView`, `helperProviders`, `circleOf`, `waitingClients`,
  `helpersAlert`, and the trial card: `warmupView`, `estimateReadyBy`,
  `warmupHubSettings`, `hubWarmupData`. `poolStatus` (GET) adds `circle`,
  `helpers`, `providers`.
- `src/lib/smtp-providers.js` — each helper preset gains `helperLabel`
  (Gmail), `passwordLabel`, `wrongPassword`, `imapOff` (the plain reasons).
- `src/app/api/mc/warmup/route.js` — `addHelper` / `testHelper`
  (`maxDuration` 30 s); `src/lib/systems/hubview.js` — the trial's `warmup`,
  `simple`, the to-do, the warm-up system card; `src/app/mc/warmup/page.js`
  — "Test and add", a Test button, the plain problem line.
- `src/lib/systems/intake-io.js` — `io.imapLogin` logs in as
  `account.imapUser` when set (iCloud).
- Alert `warmup_needs_helpers`, KV key `warmup:needshelpers:{day}`.

**Decisions**
- **The login test.** SMTP first (`io.smtpVerify`, nothing is sent), then
  IMAP (`io.imapLogin`), inside one 20 s budget (IMAP keeps at least 8 s);
  an answer that has not come by then is "did not answer — try again in a
  minute". A refused SMTP login is the wrong password (the provider's
  app-password hint) and IMAP is not tried. When SMTP took the password but
  IMAP refused it, the password is right, so IMAP is what is off: GMX, GMX.net,
  WEB.DE and Yandex get "IMAP is off — …where to switch it on"; iCloud tries
  the full address as the IMAP user after the part before the @ and keeps the
  one that worked; Gmail / Yahoo / AOL (IMAP cannot be switched off there)
  get "took the password for sending but refused the mailbox login — create a
  new app password". A server that says "IMAP disabled" in words is IMAP-off
  anywhere. Nothing is saved on any failure; spaces in the app password are
  dropped (as `saveHelper` always did).
- **Health.** Stored values stay (`new`, `ok`, `auth_failed`, `imap_error`,
  plus `unreachable` from a Test the server did not answer); the hub gets
  `ok | new | failing | disabled` and the stored one as `state` (the old
  page's Retry). A Test that is refused (wrong password, IMAP off) sets
  `auth_failed` — out of the circle until a Test or a re-add passes; a Test
  the server did not answer only notes the problem (it stays in). A good
  warm-up read or Test sets `lastOkAt`. A failed Test answers 400 with the
  reason and the updated `helper`.
- **The circle** is `getPool` (read-only in views): working members only —
  switched-off helpers, helpers whose login failed and aviance inboxes whose
  warm-up login failed are not counted. `missing` = `minPool` − members.
- **waiting_for_helpers** = the trial is in `warming`, an inbox is not ready
  yet, and the circle is under `WARMUP.minPool`. Warm-up keeps running with
  the members it has (≥ 2). Trials in `ready` / sending are not "waiting".
- **The alert** `warmup_needs_helpers` ("Add 2 warm-up helpers — the warm-up
  circle has 6 of 8", phone + email, not urgent, opens `/#settings/warmup`)
  is checked by every warm-up run and the end-of-day run, and claimed once
  per ET day (`warmup:needshelpers:{day}`, on top of the alert dedupe). While
  a trial waits it replaces the older `warmup_pool_small` of the daily run;
  with nobody waiting `warmup_pool_small` is unchanged.
- **The trial card** is built from what is stored: `warmupStartedAt` per
  inbox (its day = ET days since, on the client's clock), `inboxRate7d` /
  `readyStreak` / `readyCheckedDay` / `warmupReady` from the daily readiness
  run (the 7-day rate is the stored one, refreshed nightly — null until the
  first check), today's sends from the day roll-up, the quota from the ramp.
  `day` = the slowest inbox, `inboxRate` = the lowest known rate, `of` =
  `BUILD.warmupReadyMinDays` (14). The rules are read globally, like the
  daily readiness run. `null` outside setup_check…converted, before any
  inbox has a stored login, and for the aviance row. `paused` = setup_check
  ("Warm-up starts when the setup checks pass") or warm-up switched off for
  every inbox. `ready` = every warming inbox passed the rule, or the trial is
  past `warming`.
- **readyBy** (only while `warming`): per inbox not yet ready, its day 14
  (first warm-up day + 13), or later when the rule's
  `readyConsecutiveDays` passing nightly checks (≥ `readyRate`) cannot finish
  by then — counting the streak already built, the next check tonight (or
  tomorrow night when today's already ran). The trial's date is the latest
  inbox's. `null` when unknown: no start day; an inbox under the line (or
  never measured) whose earliest date is past `maxSlideDays` after its day 14
  (Day 1 is held then — no date is made up); `waiting_for_helpers`, `ready`,
  `paused`.
- **To-do** `warmup-helpers:{id}` (urgent) "Add N warm-up helpers —
  Settings › Warm-up", `action: {type:'view', view:'settings', section:'warmup'}`;
  on the board several waiting trials become ONE to-do `warmup-helpers`
  (`clientId: null`, detail "… · waiting: Acme, Bolt"). `simple` in
  `warming`: the card's label; next "Nothing for you: first emails on …" —
  or, waiting, "Add N warm-up helpers — Settings › Warm-up" with
  `needsYou: true`. The `warmup` system card turns `waiting` then.
- **Auto-buy** needed no change: CheapInboxes inboxes are stored as normal
  inbox records, the setup check's `finishSetup` sets `warmupStartedAt` and
  `warming`, and `getPool` takes every such inbox (the test runs the whole
  purchase with a fake CheapInboxes and finds both inboxes in the circle,
  day 1, quota 3).
- The machine never creates an account; the owner makes each helper once at
  the provider (the steps are in `providers`).
