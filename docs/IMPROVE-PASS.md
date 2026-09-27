# Improvement pass — shared contract (2026-09-27)

The owner's words: "Go through the whole system again and improve the
efficiency and the effectiveness. Studying the business of whoever messages
us should be improved. The email sending sequence and the reply bot should
sound like a human. The invite email and the plan email should sound human
and be well monitored. Two calls. Warm-up completely automated from buying.
Then an email saying we start at this time."

No AI at runtime, ever. Improvements are better rules, better words, better
tracking — and every email the client gets must read like one person wrote
it to one person. Three builds, each in its own worktree:

## A. Studying the business (research)
Files: `src/lib/systems/deepsite.js`, `webintel.js`, `bizintel.js`,
`fitsignals.js`, `fitscore.js`, `research.js`; hub `research.deep`.
Add, all free and keyless unless noted:
1. **News** — Google News RSS (`https://news.google.com/rss/search?q="{name}"+{city}`,
   keyless): the last 5 items (title, source, date, link) in `deep.news`;
   a `flags` line when a story mentions layoffs, lawsuit, acquisition,
   funding, new office, award (rules on the titles).
2. **What they talk about** — from the crawled blog/news pages: the 8 most
   frequent meaningful word pairs (stop words out) as `deep.topics`, and
   the posting rhythm ("about 2 posts a month, last one 12 days ago").
3. **Who buys from them** — from testimonials, case-study titles, client
   logos and industry pages: `deep.customers.segments` (industries named,
   counted) and `deep.customers.examples` (up to 8 named clients with the
   page); `deep.customers.line` = one plain sentence ("They mostly serve
   law firms and accounting practices; named clients include …").
4. **Competitors nearby** (only with the Places key): 5 businesses of the
   same category within their city (`deep.competitors`: name, rating,
   reviews, website) — never contacted, only shown on the call.
5. **The research brief** — `research.brief`: 8–12 plain sentences built by
   rules from the facts, for the owner to read before the launch call:
   what they sell, to whom, since when, size, proof, offers they run, what
   their website is missing (no booking link / no case studies / no
   pricing), the two angles to use on the call (from fit-score strengths),
   the risk to raise (from dealbreakers/warnings). Every sentence cites
   its source page in `brief.sources`. Shown at the top of the trial's
   research section and on the launch-call card as "Before the call".
6. **Speed** — the deep crawl runs 5 pages at a time; raise to 8 when the
   site answers fast (median < 800 ms), keep the same page budget; skip
   pages whose sitemap `lastmod` is older than 3 years when the budget is
   short (blog posts first to go).
Tests for each; the journey snapshots regenerated; HUB-API updated.

## B. Sounding human (every client-facing email + the reply bot + the cold sequences)
Files: `src/lib/templates/client/*.js`, `src/lib/templates/sequence/*.json`,
`src/lib/systems/replybot.js` (`REPLYBOT.answers` in config.js),
`src/lib/systems/copycheck.js`, `copy.js`.
Rules for every client email (acceptance, next_steps, launch_invite,
reminders, meeting_*, welcome/Day 1 "we start on …", Friday note, Day 29
report cover, decision, invoice, review ask): first name only in the
greeting; under 120 words unless it carries a report; one ask per email;
no "we're excited", "reach out", "leverage", "seamless", "just checking in",
"circle back", "hope this finds you well"; contractions; the owner's name
as sign-off with no title block; the specific fact that makes it personal
(their company name, the exact date/time in their zone, the number of
companies found); a subject line under 6 words that says the thing
("Your list is ready", "Tuesday 2 pm works"); no exclamation marks.
Reply bot: each answer rewritten in that voice, and two new rules —
`who_are_you` ("who is this / how did you get my email" → one honest line
+ the website) and `later` ("not now / after the holidays" → "no problem,
I'll check back {when}" + stop reminders, remind the owner in N weeks).
Cold sequences (`sequence/*.json`, all niches): rewrite to the same voice —
under 80 words for touch 1, under 50 for follow-ups, one question, a
first line that only fits that company (the existing {FirstLine} facts),
no links in touch 1, a plain opt-out line; copycheck gains a "sounds
like a template" rule (three or more of: "I hope", "I wanted to", "quick
question", "just", "touching base", "!"), and a reading-grade rule (≤ 8).
Add a `tests/voice.test.mjs` that renders every client template and every
sequence with sample vars and asserts the rules above (word counts, banned
phrases, greeting, one question mark max in cold touches).

## C. Well monitored (every email the client gets, and the two milestone emails)
Files: `src/lib/notify.js` (`notifyClient`), `src/lib/mailer.js`,
`src/lib/systems/conversation.js`, `onboardcall.js`, `check-bounces`,
`hubview.js`, templates/owner.js.
1. Every client email records in the conversation entry: `accepted` (SMTP
   accepted), `messageId`, `openedAt` (the existing pixel, extended to all
   client templates), `bouncedAt` + reason (from the bounce checker, matched
   by Message-ID / recipient), `repliedAt` (a reply threads to it).
2. Milestone emails get a **delivery watch**: `accepted_call`, `next_steps`,
   `launch_invite`, `welcome_two_dates` (the "we start on …" email),
   `day1_moved`, `report_day29`, `decision` — if not accepted → retry once
   after 10 min then alert `client_email_failed`; if bounced → alert; if
   not opened within 48 h (business hours) → a to-do "Sam hasn't opened
   the {what} email — call or text them?" (needsYou, quiet alert).
3. The "we start on" email: sent once when Day 1 is fixed (readiness green),
   in their zone, naming the date, the time window, the inbox name they
   will see, and "reply to this email any time"; re-sent automatically if
   Day 1 moves (`day1_moved` already exists — make it the same voice).
4. Hub: each conversation entry shows a small status ("delivered · opened
   Tue 8:10 pm" / "not opened yet" / "bounced"); the trial's big button
   picks up the not-opened to-do.
Tests for each; HUB-API updated.

## D. Warm-up from purchase (audit, not a rebuild)
Walk the path buy → webhook/check → credentials → setup check → warming →
ready → Day 1 in `tests/journey.test.mjs` and list every place a human
hand is still needed or a wait is longer than necessary (e.g. the setup
check waiting for the next tick, the readiness check only nightly, the
canary needing 8 helpers). Fix what is safe: readiness checked at every
warm-up run once past day 12 (not only nightly), the setup check re-run on
the hub's check call, the canary at 4+ members with a note. Report the rest.
