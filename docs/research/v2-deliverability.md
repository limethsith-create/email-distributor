# Deliverability v2 — research

Checked 25 September 2026. Every line names its source. Markers:
**[site]** read on the vendor's or provider's own page · **[test]** confirmed by a
live read-only check that day (page fetch or DNS lookup; no email was sent) ·
**[3rd]** only a third-party page says so · **[unverified]** could not be confirmed.

The question from the owner: find the best free places to warm inboxes and
connect them, run inbox-placement tests with the best free tool, and make the
whole sending process automatic. Trial inboxes are Google Workspace seats from
CheapInboxes, two per trial. Rules that bound the answer: SPEC §1 (free tier or
one-time payment only, no human in the loop, never invent a number).

---

## 1. Free warm-up networks — verdict: none can be connected automatically

**Nothing free in 2026 is both a real shared warm-up network and connectable
without a person clicking in a dashboard.** The machine keeps its own circle
(trial inboxes + the owner's inboxes + free helper mailboxes) and makes it
stronger (section 6).

| Option | Free for good? | How it connects | Source |
| --- | --- | --- | --- |
| CheapInboxes (our inbox seller) | Sells Google Workspace mailboxes at $3.50/month (1–99), no minimum; claims mailboxes are pre-warmed, names no network and says nothing about warm-up continuing after delivery | Advertises OAuth export to Instantly, Smartlead, Reachinbox, Reply, lemlist; its API page does not mention app passwords/IMAP | [site] https://www.cheapinboxes.com/, https://www.cheapinboxes.com/developers |
| — "pre-warmed" claim | Disputed: one competitor (22 May 2026) says not pre-warmed, another (Apr 2026) says it is | — | [3rd] https://puzzleinbox.com/tools/cheapinboxes/, https://www.inboxkit.com/compare/cheapinboxes |
| Premium Inboxes | Warm-up starts inside a sequencer you already pay for (Smartlead/Instantly) | — | [site] https://www.premiuminboxes.com/ |
| InboxKit | Warm-up is a paid add-on, $3/mailbox/month | — | [site] https://www.inboxkit.com/compare/cheapinboxes |
| **AutoMailer** | **Yes, "free forever"**: unlimited accounts, 25 warm-up emails/day per mailbox (the warm-up page says "unlimited" — contradiction), runs on Mailivery's network, Google Workspace + Microsoft 365 only | One-time Google sign-in approval per mailbox in its dashboard (the workspace admin must allow the app once). **No public API confirmed** | [site] https://automailer.io/pricing, https://automailer.io/email-warmup; API [unverified] |
| TrulyInbox (Saleshandy) | Free plan: 1 account, 10/day | Google sign-in; API only on the $22/month plan | [site] https://www.trulyinbox.com/pricing/, https://support.trulyinbox.com/en/articles/10429348 |
| Snov.io | Free plan renewing every 30 days: 1 warm-up slot, no API | [unverified] connection method | [site] https://snov.io/pricing |
| Warmbly Cloud | Promised free for 10 mailboxes — **not launched** (waitlist) | — | [site] https://warmbly.com/pricing/ |
| Warmup Inbox, Warmy, Mailivery | 7-day trials; paid (Warmup Inbox from $15/inbox/month, Mailivery from $29/month); all have APIs | — | [site] https://www.warmupinbox.com/pricing, https://www.warmy.io/pricing, https://www.mailivery.io/pricing |
| MailReach, Warmbox, Mailwarm, Folderly, Warmforge | Paid ($15–$96/mailbox or plan); Folderly's free part is placement tests only | — | [site] mailreach.co/pricing, warmbox.ai/pricing, mailwarm.com/pricing, folderly.com/pricing, warmforge.ai/pricing |
| lemwarm, Instantly, Smartlead, Saleshandy | Only inside paid sending tools ($34–$55/month and up) | — | [site] lemlist.com/pricing, instantly.ai/pricing, smartlead.ai/pricing, saleshandy.com/pricing |
| GMass warm-up | Shut down (post updated 19 Dec 2023) | — | [site] https://www.gmass.co/blog/free-email-warm-up-tool/ |

**Open-source (GitHub, checked 25 Sep 2026):** warmbly/warmbly (318★, Apache-2.0,
self-hosted platform; warms only between your own mailboxes), WKL-Sec/Warmer
(97★, MIT, browser automation, abandoned 2023), darkzOGx/darkzwarmer (6★),
FassihShah/WarmGrid (3★, needs your own 30+ helper accounts). **No open-source
shared network exists to join** — every project needs its own pool, which is
what this machine already has. [site] github.com (each repository page)

**Why AutoMailer is not wired in automatically:** it has no API we could
confirm, so the machine could neither add an inbox nor see its status; joining
takes a Google sign-in per mailbox in their dashboard; the free plan's volume
statement contradicts itself; and it would give a third party OAuth access to
the trial inbox where prospects' replies arrive. What is built instead: the
owner may connect inboxes by hand and declare it in `/mc/config`
(`EXTERNAL_WARMUP.name` / `perDay`); the circle then sends that much less per
trial inbox so the 15/day warm-up ceiling (SPEC §14.8) still holds, and the hub
shows it as `external`.

**Does Google penalise warm-up?** Google's sender guidance asks senders to start
low with engaged recipients and raise volume slowly, and to keep spam
complaints under 0.3 % (aim under 0.1 %); it does not mention warm-up tools.
[site] https://support.google.com/a/answer/81126. GMass reports Google made it
shut its API-based warm-up in 2023 [site] https://www.gmass.co/blog/warmup-shutting-down/
(6 Feb 2023). Vendors say mailbox providers detect artificial engagement better
now (Warmforge, Jul 2026) [3rd]; nothing official says small closed pools are
discounted.

**Warm-up volumes (for the "~1/3 of cold volume" setting):** Instantly (11 Sep
2026): start 5–10/day, about 30/day per inbox in total (e.g. 20 warm-up + 10
cold) [3rd]; MailReach (3 Jun 2026): 5–10/day up to 50/day by day 14 [3rd];
LeadHaste (Aug 2026): keep warm-up at 5–15 % of sends indefinitely [3rd]. **No
reliable source backs exactly one third**; the machine uses the owner's report
figure (`WARMUP.sendingShare` 0.33) and never goes under the SPEC ramp table's
15+ row (8/day) or over 15/day.

---

## 2. Helper mailboxes — which free providers still allow IMAP + SMTP with a password

| Provider | Free IMAP+SMTP in 2026 | Login | IMAP | SMTP | Spam folder | Archive | Notes / source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Gmail** | Yes | App password (needs 2-Step Verification; not with security-keys-only or Advanced Protection) | imap.gmail.com:993 | smtp.gmail.com:465 / 587 | `[Gmail]/Spam` (\Junk) | `[Gmail]/All Mail` (\All) | IMAP always on since Jan 2025; 500 emails/day. [site] support.google.com/accounts/answer/185833, support.google.com/mail/answer/7126229, developers.google.com/workspace/gmail/imap/imap-extensions, support.google.com/mail/answer/22839. IMAP host [unverified on the consumer page; standard] |
| **Yahoo** | Yes | App password | imap.mail.yahoo.com:993 | smtp.mail.yahoo.com:465 / 587 | `Bulk` (older traces: "Bulk Mail"; no SPECIAL-USE seen) | `Archive` | Limits not disclosed; few simultaneous connections [3rd]. [site] help.yahoo.com/kb/SLN4075.html, SLN15241.html, SLN27791.html; the May 2024 basic-auth notice (SLN36636) is about Yahoo fetching *other* providers' mail. No source found moving IMAP to Yahoo Mail Plus |
| **AOL** | Yes | App password | imap.aol.com:993 | smtp.aol.com:465 | `Bulk` [unverified] | `Archive` [unverified] | Runs on Yahoo's system (same filter family). help.aol.com/articles/create-and-manage-app-password (search snippet; page did not load) |
| **iCloud Mail** | Yes | App-specific password (needs two-factor; up to 25) | imap.mail.me.com:993 (user = part before @, full address if that fails) | smtp.mail.me.com:587 STARTTLS | `Junk` | `Archive` | 1,000 messages/day. [site] support.apple.com/en-us/102525, 102654, 102198 |
| **GMX (gmx.com)** | Yes, once "POP3 & IMAP" is switched on (GMX switches it off again after long idle) | Password (app password with two-factor) | imap.gmx.com:993 | mail.gmx.com:587 STARTTLS (TLS 1.2+) | `Spam` [unverified] | — | [site] support.gmx.com/pop-imap/toggle.html, support.gmx.com/pop-imap/imap/outlook.html, support.gmx.com/security/2fa/application-specific-passwords.html |
| **GMX (gmx.net)** | Yes, once enabled | Password | imap.gmx.net:993 | mail.gmx.net:587 / 465 | `Spamverdacht` [3rd] | — | [site] hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html |
| **WEB.DE** | Yes, once enabled | Password | imap.web.de:993 | smtp.web.de:587 | [unverified] | — | [site] hilfe.web.de/pop-imap/imap/imap-serverdaten.html |
| **Yandex** | Yes, with two settings on (IMAP; app passwords) | App password; sign-up needs a phone | imap.yandex.com:993 | smtp.yandex.com:465 | `Spam` | `Archive` | [site] yandex.com/support/yandex-360/customers/mail/en/mail-clients/others |
| Outlook.com / Hotmail | **No** — basic auth ended 16 Sep 2024; OAuth2 only; IMAP off by default | — | outlook.office365.com:993 | smtp-mail.outlook.com:587 | Junk | Archive | [site] support.microsoft.com (modern-authentication article; POP/IMAP/SMTP settings for Outlook.com). A GitHub issue reports personal-account IMAP failing even with OAuth since 24 Sep 2026: github.com/simonrob/email-oauth2-proxy/issues/428 |
| Zoho Mail Forever Free | **No** — IMAP/POP/ActiveSync not included (SMTP reportedly removed too) | — | — | — | — | — | [site] zoho.com/mail/zohomail-pricing.html; SMTP [3rd] help.zoho.com community |
| mail.com | **No** — IMAP/POP is Premium only | — | — | — | — | — | [site] mail.com/premiummail/ |
| Proton Mail free | **No** — Bridge (IMAP) is paid only | — | — | — | — | — | [site] proton.me/support/imap-smtp-and-pop3-setup |

**Which ones matter for US B2B placement:** Microsoft 365 and Google Workspace
dominate (SPF records, March 2026: Microsoft 365 on 19.6 % of 5.5 M domains,
Google Workspace 13.6 %; W3Techs May 2026: Gmail 17.2 %, Microsoft 13.5 % of
top sites) [3rd] https://dmarcguard.io/blog/email-provider-market-share/.
Free Gmail is the closest free stand-in for Workspace; the only free stand-in
for Microsoft is Outlook.com, which needs OAuth (out of scope). Yahoo/AOL,
iCloud, GMX and Yandex add **different consumer spam filters**, which is what
"pair across providers" needs.

The machine: presets for Gmail, Yahoo, AOL, iCloud, GMX (.com and .net),
WEB.DE and Yandex (`src/lib/smtp-providers.js`, `helper: true`); Outlook.com,
Zoho free and mail.com are kept but marked `helper: false` with the reason, and
`/api/mc/warmup` refuses them as new helpers. Folder lookup: RFC 6154 flags
first, then the preset's names (Yahoo `Bulk`, GMX `Spamverdacht`, iCloud
`Junk`), then common names.

---

## 3. Free placement / spam tests that can run without a person

| Tool | Free | Automatable | What it measures | Source |
| --- | --- | --- | --- | --- |
| **mail-tester.com** | 3 tests in any 24 h, then one-time packs (from 10 tests at $0.50 each) or $10/month subscriptions | Test id is made in the browser (`test-` + up to 9 random base-36 chars @srv1.mail-tester.com) [test]; account holders use `{username}-{anything}@srv1.mail-tester.com`. JSON at `https://www.mail-tester.com/{id}?format=json` (with `?`, not `&`) [test]; a free id's JSON answers without an account [test], **but the FAQ says JSON is for paid plans** | Score out of 10 (10 + the summed deductions; `displayedMark` "9.5/10"), SPF/DKIM/DMARC/rDNS, SpamAssassin rules, 20 blacklists of the real sending IP, content, links, List-Unsubscribe. "Mail not found…" + `status:false` while waiting | [site] https://www.mail-tester.com/faq, https://www.mail-tester.com/manager/api-documentation.html, https://www.mail-tester.com/manager/ ; [test] app.js id format, JSON fields |
| **dkimvalidator.com** | Free, no account, no limits stated; messages deleted a few hours after arrival | Send to `{letters/digits}@dkimvalidator.com` (hyphens etc. rejected) [test]; results by GET `…/cgi-bin/sa.pl`, `dkim.pl`, `spf.pl`, `original.pl` `?email={id}` [test]; "I haven't received an email recently to {id}" while waiting [test] | SpamAssassin score + rule breakdown, DKIM `result = pass`, SPF `Result code: pass` (labels from a real sample [3rd] martech.zone) | [site] https://dkimvalidator.com/ ; scraper reference github.com/alexAubin/yunoScripts (yunoDKIM.py) |
| GlockApps | Free plan: 2 spam-test credits; API ticked on Free | `POST /projects/{id}/manualTest` returns seed addresses | Real inbox placement across seed mailboxes; credit renewal [unverified] | [site] https://glockapps.com/pricing/, glockapps.com/blog/how-to-use-glockapps-v2-api-step-by-step-tutorial/ |
| MailGenius | Free test, results on a web page; API is paid ($23–79/month via RapidAPI) | No | Spam score | [site] mailgenius.com, mailgenius.com/pricing/ |
| Postmark SpamCheck | Free JSON API [test: returned a score] | Yes | SpamAssassin score of raw text only | **Its terms allow transactional mail only and ban mass campaigns** → not usable for cold email. [site] spamcheck.postmarkapp.com/doc/, postmarkapp.com/terms-of-service-spamcheck |
| isnotspam.com | Now EXPERTE (bought Feb 2025); results on a page, no email-back, no API | No | Spam checks + Gmail tab | [site] experte.com/spam-checker/isnotspam |
| Warmup Inbox placement test | Free, no signup, no API | No | Seed placement (Gmail, Outlook, Yahoo, iCloud) | [site] warmupinbox.com/email-spam-test/ |
| Unspam | Free: 21 tests/month, API only on paid Custom plan | No | Spam + placement | [site] unspam.email/pricing |
| Mailtrap | Free plan has no sandbox address | No | — | [site] mailtrap.io/pricing/ |
| appmaildev, learndmarc, Mailmeteor | Free, page-only | No | Auth / text checks | [site] each tool's page |

**Chosen:**

- **Real inbox placement = our own seed test (the canary)**: every trial inbox
  mails the helper accounts daily from Day −3; the helpers' IMAP says Inbox or
  Spam per provider. It is free, unlimited, and measures what we care about.
- **Spam test = dkimvalidator by default** (free, no account, no stated limit,
  nothing in its pages forbids it): SpamAssassin points + DKIM + SPF on the
  client's real Day 0 copy. Pass = ≤ `PLACEMENT.maxSpamAssassin` (2.0) points
  with DKIM and SPF pass.
- **mail-tester when it is clean to use**: with `MAILTESTER_USERNAME` (the
  owner's account, one-time credits → official JSON) or when the owner turns
  `PLACEMENT.mailTesterFree` on knowing the FAQ reserves JSON for paid plans.
  Pass = ≥ `PLACEMENT.minScore` (8/10). Limit 3/day enforced with a global
  per-tool day counter (`PLACEMENT.dailyLimit`).
- Not used: Postmark SpamCheck (terms), GlockApps (2 credits; a future option
  for a one-off Day −3 seed test), everything page-only.
- Privacy: a free result can be read by anyone who has the id (a guessed
  `test-…` id returned a stranger's result [test]), so ids are random (9–18
  base-36 chars) and the test mail uses a **made-up company** ("Northfield
  Partners"), never a real prospect.

---

## 4. Free DNS blacklists for a low-volume sender (Vercel = shared resolvers)

Live lookups on 25 Sep 2026 through 8.8.8.8, 1.1.1.1 and 9.9.9.9 of each
list's test entry and a clean control [test].

| Zone | Type | Status | Terms | Codes | Used? |
| --- | --- | --- | --- | --- | --- |
| bl.spamcop.net | IP | Alive via all three [test] | No volume/commercial limits published [site] spamcop.net/fom-serve/cache/291.html | 127.0.0.2 | **Yes** |
| psbl.surriel.com | IP | Alive [test] | Free for anyone [site] psbl.org/usage/ | 127.0.0.2 | **Yes** |
| bl.mailspike.net | IP | Alive [test] | Free under 100k messages + 100k queries/day [site] mailspike.io/ip_verify/usage | .2 listed; .10–.12 bad reputation | **Yes** (.10–.12 = warning) |
| bl.0spam.org | IP | Alive [test] | "100 % free", commercial allowed, 4,000 req / 5 s [site] 0spam.org | codes [unverified] (standard 127.0.0.2 assumed; the test-entry control catches a mismatch) | **Yes** |
| all.s5h.net | IP | Alive [test] | Free, no limit stated [site] usenix.org.uk/content/rbl.html | 127.0.0.2 | **Yes** |
| bl.nordspam.com / dbl.nordspam.com | IP / domain | Alive; test.dbl.nordspam.com → 127.0.0.2 [test] | Free incl. commercial; ask above 10k/day [site] nordspam.com/usage/ | 127.0.0.2 | **Yes** |
| dnsbl-1.uceprotect.net | IP (L1) | Alive [test] | Free; L2/L3 list whole networks, paid delisting criticised [3rd] | 127.0.0.2 | **Warning only** |
| multi.surbl.org | Domain | Alive via Google + Quad9; Cloudflare SERVFAIL [test] | Free under 1,000 users / 250k messages a day [site] surbl.org/usage-policy | bitmask: 8 phishing, 16 malware, 64 abuse, 128 hacked; 127.0.0.1 = blocked | **Yes** |
| multi.uribl.com | Domain | Answers via Google/Cloudflare; **refused (127.0.0.1) via Quad9** [test] | For low-volume end users [site] uribl.com/about.shtml, uribl.com/refused.shtml | 2 black, 4 grey, 8 red, 1 refused | **Yes** (black = listed; grey/red = warning) |
| b.barracudacentral.org | IP | Alive | Needs the querying resolver's IPs registered [3rd] — impossible on Vercel | — | No |
| SORBS | — | Closed June 2024 [3rd]; sorbs.net gone, every lookup "not listed" [test] | — | — | No (removed) |
| zen / dbl.spamhaus.org | IP / domain | Alive | Free only non-commercial and not via public resolvers (Google/Cloudflare/Quad9/Amazon named) [site] spamhaus.org/faqs/dnsbl-usage/; Cloudflare returned .254, Google silently said "not listed" for the DBL test [test] | 127.255.255.252/.254/.255 errors | No |
| NiX Spam (ix.dnsbl.manitu.net) | — | Closed Jan 2025; listed every server in Mar 2025 [3rd]; refuses now [test] | — | — | No |
| spam.dnsbl.anonmails.de | — | Reported listing everything Nov 2024 [3rd] | — | — | No |
| dnsbl.dronebl.org, bl.blocklist.de | IP | Alive | Free | Hacked machines / attack IPs, not spam senders | No (low value) |
| Abusix | — | Free 5,000 queries/day with a sign-up key [site] abusix.com/pricing/ | — | — | Optional later |

**How the machine reads answers** (`src/lib/systems/blacklists.js`, `BLACKLISTS` config):

- Only a documented listing code counts as listed. A timeout, SERVFAIL, REFUSED,
  127.0.0.1 (URIBL/SURBL "refused"), 127.0.0.255, any 127.255.255.x, or an
  answer outside 127.0.0.0/8 means **unknown, never listed**.
- Each run also asks every zone for its **test entry** (must be listed:
  `2.0.0.127.<zone>`, `test.uribl.com`, `test.surbl.org`, `test.dbl.nordspam.com`)
  and a **clean control** (`1.0.0.127`, `example.com`, must not be listed); a zone
  failing either gives no verdict that run. This catches resolvers that quietly
  answer "not listed" and dead lists that list everything.
- The **domain** on domain lists is what can block: a hit is "listed" (setup
  check fails, Auth Guard pauses sending). The **A record** (usually the
  registrar's forwarding server) and **MX IPs** (Google) are not what our mail
  is sent from, so an IP-list hit on them is a `blacklist_warning`, not a pause
  (`BLACKLISTS.ipAction = 'block'` changes that). The real sending IP is
  covered by mail-tester's own blacklist step when mail-tester is on.

---

## 5. Bounce limits

The owner's report (Lead Engine, "Fixing deliverability"): pause at 1.5 %
bounce, stop entirely at 2 %; keep a warm-up baseline at roughly a third of
volume; confirm with mail-tester before a prospect is emailed. Built as
`BOUNCE.pause` 0.015 (halve every inbox cap + urgent alert; lifted after
`EMERGENCY.greenDays` business days under the line) and `BOUNCE.max` 0.02 (the
existing emergency stop), both over the Emergency Runner's window of at least
`SEND.smokeTestSends` (50) recent sends.

---

## 6. What was built from this

| Finding | In the code |
| --- | --- |
| No free external network connects automatically | Own circle kept; `EXTERNAL_WARMUP` lets the owner declare a hand-connected one (quota shrinks, hub shows it) |
| More members = better network | Aviance's own inboxes join (`WARMUP.includeAviance`, default on); every trial inbox warming → converted |
| Different filters matter more than more Gmail | Pairing prefers another *filter family* (Google / Yahoo+AOL / Apple / GMX+WEB.DE / Yandex); /mc/warmup warns under `WARMUP_V2.minFamilies` (3) |
| Human-looking threads | Replies quote the original like a mail client (rebuilt from the signed marker, no body download); later replies shorter and rarer; threads end at depth 4 |
| Warm-up after launch | `WARMUP.sendingShare` 0.33 of the cold cap, never below the 15+ row, never above 15 |
| Placement | Seed test (canary) + spam test (dkimvalidator / mail-tester) Day −3, Day 1, weekly; history `client:{id}:placement`; Day 1 gate needs both |
| Blacklists | 10 free zones, controls, unknown ≠ listed, IP hits warn |
| Bounces | 1.5 % pause, 2 % stop |

## 7. What the owner has to create (one-time)

1. **Helper accounts** (free), aiming for ≥ 8 pool members and ≥ 3 families,
   for example: 3 Gmail (2-Step + app password), 2 Yahoo (app password), 1 AOL
   (app password), 2 iCloud (two-factor + app-specific password), 1 GMX (switch
   on POP3 & IMAP), 1 Yandex (IMAP + app passwords on; needs a phone). Paste each
   on /mc/warmup; the page lists the steps per provider. **No Outlook.com, Zoho
   free or mail.com** — they cannot log in with a password.
2. **Nothing for the spam test** by default (dkimvalidator needs no account).
   Optional: a mail-tester account with a one-time credit pack → set
   `MAILTESTER_USERNAME` (and raise `PLACEMENT.dailyLimit['mail-tester']` to the
   credits you want used per day), or accept the terms question and turn on
   `PLACEMENT.mailTesterFree` (3 free tests a day).
3. Optional: connect trial inboxes to AutoMailer's free plan by hand and set
   `EXTERNAL_WARMUP` — not recommended while its API and volume are unclear and
   because it would read the trial inbox.

## 8. Not verified

AutoMailer API; CheapInboxes "pre-warmed"; Yahoo/AOL/GMX special-use flags and
exact spam-folder names (the code falls back through several names);
0spam return codes (the test-entry control guards it); mail-tester behaviour
over the free quota; GlockApps credit renewal.
