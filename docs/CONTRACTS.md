# Build contracts (read before writing any system)

The spec is `docs/SPEC.md`. Rules in SPEC §1 are non-negotiable: no silent
failure, no subscriptions, **no LLM calls**, never invent a number,
idempotent everything, hand up never drop, per-client isolation.

## Shared modules (do not rewrite; import them)
| Need | Use |
|---|---|
| Any Redis key | `K` in `src/lib/db/keys.js` (add new builders only inside your stage's marked block) |
| Any threshold | `await cfg(clientId, 'DOTTED.KEY')` from `src/lib/config.js` (new defaults only in your stage's block) |
| Client record / state | `src/lib/db/client.js`: `getClient`, `getAllClients`, `createClient`, `updateClient`, `setState(id, to, reason)` (legal transitions only), `getProfile/getTrial/getDomain`, state sets |
| Trial day | `trialDay(trial, now)` in `src/lib/time.js` (the only day math); `partsIn(tz, date)`, `dayKeyIn`, `addDays`, `tzForState` |
| Event log | `logEvent(clientId|null, system, event, detail)` |
| Owner alert | `alertOwner(key, {clientId, vars, body, did, scope})` — keys in `templates/owner.js` |
| Email a client | `notifyClient(clientId, templateKey, vars, {to, from, dedupe, attachments})` — templates in `templates/client/stage-x.js` |
| Inboxes | `src/lib/db/inboxes.js`: `saveInbox`, `getInboxRecords`, `getAccounts(clientId, {enabledOnly})`, `patchInbox`, `toAccount` |
| Send SMTP | `sendEmail(account, {to, subject, text, html, inReplyTo, references, headers, transactional, noTrack, attachments})` in `src/lib/mailer.js` |
| Leads | `src/lib/db/leads.js`: `insertLeads`, `getLead`, `saveLead`, `patchLead`, `getLeadsByStatus`, `countByStatus`, `isBlocked`, `suppress`, `addToBlocklist`, `hostOf` |
| Counters | `src/lib/db/counters.js`: `bump(clientId, field, n)`, `getTotals`, `getDay`, `sumDays`, `requireCounters` |
| Client page links | `src/lib/pagetokens.js`: `mintToken(clientId, purpose, {ttl, oneShot, data})`, `readToken(raw, {purpose, consume})`, `pageUrl(token, path)`. Pages live at `src/app/c/[token]/...` (public, no admin cookie). |
| Promises | `src/lib/db/promises.js` |
| External HTTP | `fetchExt` / `fetchJson` in `src/lib/ext/http.js` (timeout, retry, usage count); per-service wrappers go in `src/lib/ext/{service}.js` |
| Usage | `countUsage(service, field, n)`, `isThrottled(service)` in `src/lib/systems/usage.js` |
| Templates | `fill(name, text, vars)` throws `TemplateError` on any empty slot |

## Scheduler jobs
Add jobs to **your** `src/lib/joblist/stage-x.js` only. Shape:
`{ name, scope: 'client'|'global', cost, minBudgetMs?, claimTtl?, due(ctx) → period|null, run(ctx) }`
where ctx = `{ now, client, clientId, deadline, clients }`. Period helpers:
`src/lib/joblist/helpers.js` (`minuteKey`, `bucketKey`, `usBusinessHours`, `dailyAt`).
A tick has a 20 s budget: bounded work per run, continue next tick.
`due` must check `client.state`; never act on a client in the wrong state.

## Client (trial) inbox vs aviance
The `aviance` client keeps its legacy engine (`/api/cron/auto-send`, legacy
keys). Every new system is per-client and must skip `aviance` unless the spec
says otherwise (Mission Control shows it; Learning may read it).

## Counter field names (reports depend on these)
sent, sentD0, sentD3, sentD7, sentD10, bounces, replies, positive, booked,
held, qualified, noshows, wrongfit, warmupSent, warmupInbox, warmupSpam,
warmupRescued, companiesContacted. Call `initCounters(clientId)` when a
client enters `warming`.

## Lead record
`{ email, clientId, status (unsent|in_sequence|replied|bounced|suppressed|notnow|done),
first_name, name, title, company, website, host, city, state, tz, sizeBand,
source, score, dreamMatch, riskLevel (safe|risky|catchall), isRole,
sequenceVariant (A|B), touch fields sent_at/d3_sent_at/d7_sent_at/d10_sent_at,
message ids, replied_at, reply_kind, notnowDate, referrerName }`

## Ownership (no editing someone else's files)
- Stage A: gatekeeper, /api/apply, /c/[token]/onboard, market, pricescout, /mc/clients/[id]/purchase, /mc/queue, setupcheck, authguard, bookingtest
- Stage B: warmup, canary, ramp, leadfinder (workflow + scripts/leadfinder + /api/webhooks/leadfinder + /api/clients/[id]/profile), blocklist, sanity, copy, copycheck, /c/[token]/approve, /mc/warmup
- Stage C: sender, compliance, replies (classifier, wrong-person, not-now, hot-lead chaser), bookings, scorekeeper, clientwatch, pace, emergency, learning, /c/[token]/tap + client buttons (customer hit, stop, away), /mc/learning
- Stage D: friday, reports, recommender, /c/[token]/decide, extension, ladder, handover, wrapup, planstart, invoice, digests, promise register, Test Mode (/mc/test), /mc/config, board/client-page upgrades, nav

Shared files you may touch **only inside your marked block**: `db/keys.js`,
`config.js`, `templates/owner.js`. Anything else shared you need changed:
describe it in your final report instead of editing it.

## Assumptions and tests
Log every value/wording you had to decide in `docs/assumptions/stage-x.md`.
Tests: `tests/stage-x.test.mjs` using the in-memory fake KV (`npm test`).
Never make real network calls in tests (stub `globalThis.fetch`).
Source wording (verbatim templates): the owner's docs as text in
`/private/tmp/claude-501/-Users-limethsithweerasinghe-claude/f3ddb671-51df-40f1-8aa6-f8fb26fe1ec1/scratchpad/source/`
(read-only; never copy those files into the repo, quote only the template wording you need).
