# Ava's guide to Aviance and the hub

Ava gets the best-matching parts of this guide with every question (BM25 search, lib/ava/kb.js). Each `##`
section is one topic; a `<!-- pages: … -->` line names the hub views it is about (those parts are favoured
when the user is on that view). Keep it free of real people's names, email addresses and phone numbers.

## What Aviance is and what it sells
<!-- pages: trials, paying -->
Aviance runs cold-email outreach for small US businesses (plumbers, dentists, IT firms, roofers, law offices,
physical therapists and so on). The owner runs it from Sri Lanka. Every new client gets a free 30-day trial:
Aviance finds their best prospects, buys a look-alike sending domain and two inboxes, warms them up, writes
the emails with them, sends for 30 days, sorts the replies and books calls into the client's calendar. The
promise is at least one qualified call from the trial. After the trial the client can pick a paid plan
(Starter, Growth or Scale). The system that does the work is "the machine"; the owner's window onto it is the
hub (aviance.store).

## Plans and prices
<!-- pages: paying, client, money -->
The paid plans (monthly, in US dollars, as set in the machine's config PLANS):
- Starter — $2,497 a month, 10 qualified calls guaranteed, reaching about 2,000 companies.
- Growth — $3,997 a month, 20 qualified calls guaranteed, reaching about 4,000 companies.
- Scale — $8,497 a month, 50 qualified calls guaranteed, reaching about 10,000 companies.
Extra qualified calls beyond the plan cost $150 each. Pay per show is the other option: $250 for every qualified
call that actually attends, billed weekly (offered when a trial had interested replies but no qualified call).
The month-one bonus, if they start within 24 hours of the day-30 page: Starter 12 calls for the price of 10,
Growth 22 for 20, Scale 55 for 50. The owner can change prices in Advanced › config (PLANS, BONUS).
Money is only for the owner — team members never see amounts.

## Which plan to recommend (the plan recommender)
<!-- pages: client, paying -->
At day 30 the machine recommends one plan from the trial's numbers: 3 or more qualified calls → by how many
calls a week the client said they can take (up to 3 a week → Starter, 4–7 → Growth, 8 or more → Scale);
1–2 qualified calls → Starter; interested replies but no qualified call → Starter, with pay-per-show shown as
the honest alternative; no interested replies at all → no plan, the extension is the recommendation.

## The whole process (how a trial works, start to finish)
<!-- pages: trials, client -->
Every client goes the same way: they apply on the website → the owner reads it and says yes (or no) →
they book and have the onboarding call → their domain and two inboxes are bought and set up →
the inboxes warm up for about two weeks → near the end of warm-up there is the launch call, where the owner
goes through their list and their emails with them → sending runs for 30 days (a paying client keeps sending)
→ replies are sorted and the reply bot answers simple questions → prospects book calls into the client's calendar
→ day 29 report → on day 30 the trial client gets a decision page → if they pick a plan the month-one invoice goes
out and the owner marks it paid. The hub shows this as five steps: 1 Applied, 2 Onboarding call, 3 Setting up,
4 Sending emails, 5 Done.

## The five steps and the machine's states
<!-- pages: trials, client, behind -->
Step 1 Applied = new or queued (on the waiting list). Step 2 Onboarding call = said yes, call being booked or booked.
Step 3 Setting up = buying the domain and inboxes, checking DNS, warming up. Step 4 Sending emails = days 1 to 30
(or longer on the extension or a paid plan). Step 5 Done = deciding after day 30, converted to a plan, not now,
or ended. "Not taken" means the owner said no. Behind the scenes groups them as: Applied & queued, Onboarding,
Buying & setup, Warm-up & build, Sending, Deciding, Converted, Not now & closing, Ended.

## Applying (new applications)
<!-- pages: trials, paying, client -->
Someone applies on the website's trial form, or asks for a paid plan (Starter, Growth or Scale). They appear at the top
of Trials (or Paying clients for a paid plan) under New applications, with a match percent from the fit check.
Lead-generation, SDR and cold-email agencies or tools are not accepted as trial clients. Application (Word)
downloads everything they wrote plus "What we found": a short brief about the company with where each fact comes
from (their site, Google Maps, news, the web archive, Census figures). Research again looks the company up again.

## The fit check and "What we found"
<!-- pages: client, trials -->
Each application gets a fit check: each rule passes, fails or is unknown, with a note, and a match percent.
"What we found" shows the machine's research: Before the call (a brief of up to 12 plain sentences, each with its
source), a summary, flags in amber, About the company (services, locations, Google rating, team size and age hints,
socials, their market size) and the Full company file: who buys from them, in the news, competitors nearby
(never emailed) and what they write about.

## Your yes (say yes / say no)
<!-- pages: trials, paying, client -->
Say yes (Say yes and email them) emails them at once, asking them to book the onboarding call — from then on the
trial runs by itself and moves to step 2. If three trials are already running they join the waiting list and start
when a place opens. Say no asks for a short reason first, then sends a polite no; they move to Done, not taken.
Nothing is sent until the owner confirms. Only the owner can say yes or no; Ava cannot do it for him.

## How many trials can run at once (the waiting list)
<!-- pages: trials, behind -->
Three trials run at once. Anyone else the owner says yes to joins the waiting list (queued) and starts by itself
when a place opens; the to-do "free trial slot — start the next one" appears when one can start. While a trial is
on its free extension no new trials are accepted.

## The onboarding call
<!-- pages: client, calendar -->
After the yes they get one email asking them to book the onboarding call, and reminders if they don't book.
When they pick a time it waits in the Calendar for the owner's yes. The call card on the client page has
Mark call booked (date and time), Call done, They didn't show, Send the email again and Stop reminders. On the call
the owner learns what they sell, who they sell to, where, what a good call looks like for them and how many
calls a week they can take. A late booking becomes a to-do "late onboarding-call booking to chase".

## Setting up inboxes (step 3: domain and inboxes)
<!-- pages: client, settings, inboxes -->
Setting up means buying the client's own sending domain (a look-alike of their main one, e.g. get-brand.com or
brandhq.com) and two inboxes. With CheapInboxes connected (Settings › Inboxes & domains) the big button "Buy their
domain and 2 inboxes on CheapInboxes" shows exactly what to buy (the domain and its price, up to 3 other free names,
the two inboxes' names, each with Copy, and Open CheapInboxes). The owner buys it in his own CheapInboxes account
— the system never buys or spends anything — and the system finds the purchase and connects everything by itself
("I've bought it — check now" makes it look at once; "Wrong domain? Undo" until anything is connected).
Without CheapInboxes, Buy & paste compares registrar prices (Buy at … links, promo codes) and lets the owner paste
the domain and the inbox logins. The machine then checks the domain's DNS (SPF, DKIM, DMARC) before warm-up.

## Settings › Inboxes & domains (CheapInboxes)
<!-- pages: settings, inboxes -->
Status: Not set up, Connected as {account}, or Problem. Steps: make a CheapInboxes account → add a card under
Billing → create an API key → paste it → Save → Test it. Forget the key removes it. Purchases the system could not
match to a trial are listed with "This is for…" and Link it.

## Warm-up
<!-- pages: client, settings, warmup -->
Warming up means the new inboxes send and answer friendly emails with other accounts (the warm-up circle) for about
two weeks, so email providers learn to trust them and our emails land in the inbox, not spam. The client's Warm-up
card shows "day N of about 14", how many reach the inbox (the inbox rate), each inbox and "Ready to start sending
around …". An inbox is ready at 90% on two days in a row; below 80% is low.

## Warm-up helpers (Settings › Warm-up)
<!-- pages: settings, warmup -->
The circle needs at least 8 members. When it is short the trial's big button says "Add N warm-up helpers". Helpers
are free email accounts the owner makes once (Gmail, Yahoo, AOL, iCloud, GMX, WEB.DE or Yandex) — the system never
creates accounts. Settings › Warm-up: the circle meter ("6 of 8 in the warm-up circle"), each helper (Working, New,
Not working with the problem, Off) with Test and Remove, and Add a helper → pick the kind → follow its steps (usually
an app password) → type the address and the password → Test and add.

## The launch call
<!-- pages: client, calendar -->
Near the end of warm-up the client gets the launch-call invite: their list and their emails are ready. On the call
the owner goes through their lead list and their emails with them (sharing the approval page with Open the approval
page). He presses Approved on the call when they say OK — sending starts on Day 1. If they already approved on the
page, the call can be skipped (Skip the call). The card has the research brief at the top (Before the call).

## Sending (days 1 to 30)
<!-- pages: client -->
Sending runs for 30 days from Day 1 for a trial. Each inbox starts slowly and sends more each day: 8 cold emails per
inbox per day on days 1–2, 12 on days 3–4, 16 on days 5–6, then at most 25. The list shows "Day 12 of 30". One email
per person — follow-ups only when switched on. Every email is checked before it goes: at most 80 words, no link in
the first email, one question, a postal address and a "reply STOP" line, no spammy words. If bounces reach 1.5% the
sending speed is halved; over 2% it stops and the owner gets an alert. Sending only happens in US business hours
and never on US holidays.

## Opens are not tracked for clients
<!-- pages: client -->
Client emails go out without an open tracker (trackers hurt landing in the inbox), so Opened is blank for them.
Only the owner's own outreach on My stats tracks opens.

## Replies and the reply bot
<!-- pages: client, settings, replybot -->
Every reply is read and sorted: interested, question, not now, wrong person, no, unsubscribe, out of office, angry,
legal and unclear. Interested people are passed to the client as hot leads. A STOP or a no is never emailed again,
for any client. A legal reply puts a hold on sending until the owner reads it and clears it. The reply bot answers
simple questions with fixed answers — the booking link and free times, who we are, how we got their address,
"check back later" (it writes again in a few weeks) — it never makes things up. Switch it off for one person with the
switch under Messages on their page; Settings › Reply bot lists every rule and what it never does.

## Calls (booked calls, qualified calls, no-shows, disputes)
<!-- pages: client, calls, calendar -->
Calls booked from our emails land in the client's calendar. A call is qualified when it was held, with the right kind
of person (a title the client approved) at a company on the approved list, booked from our outreach. A late join or a
colleague with an approved title still counts; a competitor never does. No-shows get a rebook email with two new times
(up to 2 tries). If the client says a call doesn't count it shows as a dispute for the owner to decide (uphold or
overturn). The Calls tab on the client's page shows every call prospects booked (when, booked / showed / no-show).

## Day 29 report and the day-30 decision
<!-- pages: client -->
On day 29 the client gets the trial report: companies contacted, emails sent, bounces, inbox rate, replies,
interested, booked, held and qualified calls, what worked and what didn't, and one recommendation. On day 30 a trial
client gets the decision page with their numbers, one plan we recommend and the 24-hour month-one bonus. They can pick
a plan (Start), ask to talk to someone, or say not now. No decision by day 45 → not now (reminders on days 33, 37 and 44).
Paying clients have no day 30.

## The free extension (no qualified call by day 30)
<!-- pages: client -->
With no qualified call on day 30, the trial keeps sending free until the first qualified call, up to 60 sending days
in all (an extension). The client is told; the owner gets an alert. It ends at the first qualified call (the decision
page follows the next morning) or at the 60-day cap. There is never a second extension.

## Handover
<!-- pages: client -->
On day 30 (or at the first qualified call if later) the client gets a handover email with three spreadsheets — their
leads, the replies (with type) and the bookings — and the market report. They never get the inboxes' passwords.

## The invoice (money)
<!-- pages: client, paying, money -->
When a trial client picks a plan, or a paying client signs the plan agreement, the month-one invoice goes out with the
plan price, the bonus line and the PayPal.me or Wise details from Your details; reminders go on day +3 and +7 if unpaid.
When the money lands the owner presses Mark paid on the to-do ("invoice to mark paid when the money lands"). Money is
only for the owner — team members never see amounts. The owner can ask Ava "how much did we make this month?".

## Trials page
<!-- pages: trials -->
Lists every trial client. Needs you is at the top in red with what to do; In progress are the ones running with
nothing needed; Done, not taken is folded at the bottom. Each row: the company, the journey as five squares ("Step 2
of 5 — Onboarding call"), the machine's plain sentence and what happens next. The stage tiles (Applied, Booking the
call, Call booked, Setting up, Warming up, Sending, Finished) count clients at each stage — tap one to filter. At the
bottom: Add a trial client yourself (or press N). Tap a row to open the client. It refreshes itself every minute.

## Paying clients page
<!-- pages: paying -->
Works like Trials but for clients on Starter, Growth or Scale: new paid-plan applications, the stage tiles and
every paying client. The owner also sees money received at the top. Add a paying client yourself is at the bottom.
Plan call requests (inquiries) are here too.

## Inquiries (plan call requests)
<!-- pages: inquiries, paying -->
People who want a paid plan without a trial book a call from the website's "Book a call" form. Each one pops up on the
owner's phone and is an urgent to-do. The list has filters (Open, Won, Lost, All). One inquiry shows their call time,
what they sell and the plan; Reply by email; Where it stands (Mark contacted, won or lost, with a note); Start a free
trial and email them; and Notes. Nothing is sent to them automatically.

## Calendar page
<!-- pages: calendar -->
Every call in Sri Lanka time with US Eastern beside it: onboarding calls, launch calls, meetings the owner added and
busy blocks. A time a client asked for waits at the top: Say yes (sends the time and an invite), Suggest another
time, or Say no. A confirmed call has a Join Google Meet button when Google Meet is connected; without one it says
why and "Send them a link yourself". The Calendar badge counts times waiting for the owner's yes.

## Google Meet (Settings › Google Meet)
<!-- pages: settings, google, calendar -->
Connect Google so every confirmed call gets a Meet link. Steps: make a Google Cloud project → turn on the Google
Calendar API → the consent screen (External, your email, Publish app) → Credentials › OAuth client ID › Web
application → paste the redirect address (Copy button) → paste the Client ID and Client secret and Save → Connect
Google → Test it. Status: Not set up, Ready to connect, Connected, or Broken — connect again. Disconnect asks first.

## Team page
<!-- pages: team -->
Everyone who uses the hub: who is in the hub now, where they are, what they are working on (their status line —
write yours under "What are you working on"), and which clients each person looks after. The owner picks each
person's clients with Choose clients. Team members can see everything but change nothing, and never see money.

## My stats and Saved history
<!-- pages: mystats -->
My stats is the owner's own outreach (Aviance's own cold emails looking for clients): emails sent, opened, replies,
bounced, emails per day, by inbox, and every reply. Saved history keeps full copies as spreadsheets. Save and start
fresh saves a copy, then clears the numbers so My stats starts from zero — people already emailed are never emailed again.

## Activity page
<!-- pages: activity -->
The owner's page: who signed in and out, for how long, what they opened, and new accounts waiting for approval.
Approve lets a person in as a team member (read-only). The Activity badge counts people waiting.

## Settings sections
<!-- pages: settings -->
Settings has named sections, each saying its state in one word: Alerts, Phone alerts, Your details, Keys, Ava,
Google Meet, Inboxes & domains, Warm-up, Reply bot, Test run, Is everything running?, Behind the scenes, Advanced
(the full control panel, Mission Control), Light or dark, and Your account (log out). Settings is for the owner.

## Your details (Settings › Your details)
<!-- pages: settings, details -->
What the emails say about the owner: name (the signer), postal address (every cold email must carry one), email,
the onboarding inbox, the call link, PayPal.me, Wise details and Clutch. Each box has its own Save; "Still to fill in: N"
counts the empty ones, and the two the first trial needs are marked in amber.

## Keys (Settings › Keys)
<!-- pages: settings, keys -->
One card per service key: its state in words, the steps to get it and an "Open …" link, a password box, Test and save,
Test and Forget. A saved key is never shown again. A key set on the server (Vercel) shows no box. Cards: Google Places,
QuickEmailVerification, Verifalia (user name + password), Reoon, ZeroBounce, Hunter, GitHub token and repository (the
lead finder), and Ava's: Groq, Cloudflare Workers AI (account ID + API token), Tavily and Exa (web search), Cerebras,
Gemini (paid key only) and OpenRouter.

## Ava's keys: which ones and why
<!-- pages: settings, keys, ava -->
Ava only uses AI services that do not train on what is sent. Groq (free, no card; console.groq.com/keys → API Keys →
Create API Key; turn on Zero Data Retention under Data controls) is her main brain and her ears. Cloudflare Workers AI
(free 10,000 Neurons a day; dash.cloudflare.com → copy the Account ID → My Profile › API Tokens › Create Token with the
"Workers AI" template) is the second brain. Tavily (app.tavily.com, 1,000 free searches a month) and Exa
(dashboard.exa.ai) let her search the web for current facts. Cerebras is no longer free; Gemini only with a paid key
(free Gemini keys train on data); OpenRouter only with paid credits and no-training providers.

## Ava (the helper) — what she can do
<!-- pages: ava, settings -->
Ava answers any question: about the hub, the clients and the process, and general things (facts, how-tos, advice,
writing emails). She looks up live numbers (clients, calls, the team, money for the owner), searches the web when a
Tavily or Exa key is set, and offers buttons (open a page, a draft to copy, a confirm). Open her with Ctrl/Cmd J or the
Ava button; talk with the microphone or type. She cannot change anything herself and cannot edit the system's code:
she writes a wish down as a change request (Settings › Ava lists them; the owner marks them done). Settings › Ava shows
her brains and models, her voice and the Business facts note.

## Business facts (Settings › Ava)
<!-- pages: ava, settings -->
The owner can write a short note of facts Ava should know (what Aviance sells, the tone to use, what to say about
prices, the owner's working hours, anything else) — up to 4 KB. Ava reads the parts that fit each question. Only the
owner can change it.

## Ava and privacy
<!-- pages: ava -->
Ava answers from the hub's data through the machine. The AI services she uses do not train on what is sent (Groq,
Cloudflare Workers AI, and Cerebras, Gemini or OpenRouter only on paid, no-training settings). Her look-ups never send
prospects' names, email addresses, phone numbers or message text — only company names, counts, stages, dates and
rates. Web searches carry only the words of the question, with emails, phone numbers and contact names taken out.
What you type or say is sent as you wrote it, so avoid personal details. Speech is turned into text by Groq (not kept).

## Phone alerts
<!-- pages: settings, phone -->
Every machine alert can pop up on the owner's phone as a normal notification. On iPhone: open aviance.store in Safari
→ Share → Add to Home Screen → open Aviance from the home screen and sign in → Settings › Phone alerts → Set up phone
alerts → Turn on → Allow → Send a test. Tapping an alert opens the right page. If blocked later: iPhone Settings →
Notifications → Aviance.

## Test run
<!-- pages: settings, demo -->
Settings › Test run loads example clients (a finished trial, a paying client and a trial mid-way) marked with a Test
tag, so the owner can click through a whole month. No real email is ever sent for them and nothing can be changed on
them. Remove the test run takes them away; real clients aren't touched. Owner only.

## Is everything running? (the health check)
<!-- pages: settings, status -->
Settings › Is everything running? shows the last check-in of the machine (the cron heartbeat), the last email sent,
trials running, free extensions, alerts not seen, paid services used and setup still to finish. "Yes", "Mostly" or
"Needs a look". A missing heartbeat becomes a to-do: check the cron.

## Behind the scenes
<!-- pages: behind, settings -->
The full picture: every to-do in one list, every trial by stage, the waiting list and the owner's own sending. Inside a
client's email system, Behind the scenes has tabs: Growth, Parts (the 13 parts each OK / Working / Waiting / Blocked /
Off), Leads, Deliverability, Inboxes, Calls, Replies, Copy, Coming up, History and Actions.

## The client page
<!-- pages: client -->
One card per client: the five steps, a one-line status ("Sending — day 13 of 30, 1 call booked"), and — when
something needs the owner — "What do you need to do?" with one big button for the most important thing (read the
application, say yes to a call time, answer their message, mark the call done, write about booking, buy the domain and
inboxes, add warm-up helpers…). Under it, Open their email system shows everything else. Messages (the owner's emails
with the client, the reply box "Send to …", the reply-bot switch) are on the client page too.

## The email system: Shared and Only you tabs
<!-- pages: client -->
A client's email system has a switch with two sides. Shared with the client — exactly what the client sees on
their own page: Overview (emails sent, opened, replies, bounced, interested, calls booked, emails per day),
Conversations (every thread with a prospect), Emails sent, Calls and Messages. Never money or internal notes.
Only you (the owner and the team, never the client): Money & plan (the owner only), Health (inboxes, warm-up,
landing in the inbox, growth), Leads & emails, and Setup & history (who can see their page, the application, calls,
disputes, parts, history, actions).

## Health, Growth, Leads and Deliverability tabs
<!-- pages: client -->
Growth: emails sent per day with replies, positive replies and calls booked, warm-up emails and the 7-day inbox rate
against the 90% ready line, and placement tests (seed test ≥ 85% for Day 1, SpamAssassin 2 or less, mail-tester 8 or
more). Leads: ready to send, grades A/B/C/rejected, email checks, top reject reasons and the 25 best leads.
Deliverability: bounce rate for 7 days against the pause and stop lines, blacklists, spam tests, the warm-up circle
and the domain's DNS checks.

## Give access (the client's own page)
<!-- pages: client -->
Open the client → their email system → Setup. Under Who can see this, type an email address from their business and
press Give access: they get a private link to their own live page (read-only). Stop all access turns every old link
off. Only the owner can give access; Ava can open the place but never sends the email herself.

## Messages with a client
<!-- pages: client -->
Every email between the owner and the client as a chat: theirs on the left, ours on the right, the reply bot's marked
Auto-reply, automatic emails folded to one line. Under each of our emails: how it went (delivered, opened, replied,
bounced in red with why, "not opened yet" in amber for an important one). "… is waiting for your answer" in red when
they wrote. The reply box sends from the onboarding inbox (up to 2,000 characters).

## Alerts, the bell and search
<!-- pages: settings, alerts -->
The bell at the top lists what needs you right now (urgent to-dos, urgent alerts, call times waiting for your yes).
Settings › Alerts has every message, not seen first, with Mark as seen. Press Ctrl/Cmd K (or /) to find any client or
page, or type what you want to do; Ctrl/Cmd J talks to Ava.

## Roles (owner and team members)
<!-- pages: team, activity -->
The owner can do everything. A team member sees the same screens but changes nothing (the buttons are hidden), and
money is only for the owner. New team members make an account on the sign-in page ("Create an account") and the owner
approves them in Activity. Everyone can set their own status line and ask Ava to note a change request.

## How to: add a trial client yourself
<!-- pages: trials -->
Trials → at the bottom "Add a trial client yourself" (or press N) → fill in the company, the person, their email and
website → save. They start at step 1 like a website application; say yes to start. Ava can open the form for you.

## How to: add a paying client
<!-- pages: paying -->
Paying clients → "Add a paying client yourself" → the company, contact and plan (Starter, Growth or Scale) → save.
The plan agreement and the month-one invoice follow.

## How to: answer a client's message
<!-- pages: client -->
Open the client → Messages → type in the reply box ("Send to …") → Send. It goes from the onboarding inbox in the same
email thread. When they wrote and nobody has answered, the big button says "Answer … 's message".

## How to: say yes to a call time
<!-- pages: calendar -->
Calendar → the time waiting at the top → Say yes (they get the confirmation and an invite with a Meet link when
Google Meet is connected), Suggest another time, or Say no.

## How to: mark an invoice paid
<!-- pages: client, paying -->
When the money arrives (PayPal or Wise), open the to-do "invoice to mark paid" (the bell or the client's big button)
→ Mark paid. Only the owner can.

## How to: approve a new team member
<!-- pages: activity -->
They create an account on the hub's sign-in page. Activity (owner only) shows them under waiting for approval →
Approve. They become a read-only team member. Then Team → Choose clients to pick what they look after.

## How to: add or change a key
<!-- pages: settings, keys -->
Settings › Keys → the card → follow its steps and "Open …" link → paste the key → Test and save. A key the service
refuses is not saved and the reason is shown. Test re-checks a saved key; Forget removes it.

## FAQ: What is a bounce?
An email that came back because the address doesn't exist or the mailbox refused it. A few are normal; at 1.5% the
machine halves the speed and over 2% it stops sending to protect the inboxes, and alerts the owner.

## FAQ: How long until sending starts?
Roughly: onboarding call within a few days of the yes, a day or two to buy and set up the inboxes, about 14 days of
warm-up, then the launch call and Day 1. So about three weeks from the yes.

## FAQ: What does the client see?
Only their own page (the Shared tabs): numbers, conversations, emails sent, calls and messages. Never money, costs,
the fit score, internal to-dos or other clients.

## FAQ: Where do the leads come from?
The lead finder (a job started on GitHub with the GitHub token) searches Google Places and the web for companies that
match the client's ideal customer in their area, finds the right person's email, and checks every address with the
email checkers (QuickEmailVerification, Verifalia, Reoon, ZeroBounce, Hunter). Leads are graded A, B or C; rejected
ones are never emailed.

## FAQ: Why is a trial stuck?
Look at the client's big button and the red "You need to…" line: usually a call time waiting for a yes, a message to
answer, the domain and inboxes to buy, warm-up helpers to add, or a legal reply / send hold to clear. Settings › Is
everything running? shows if the machine itself is behind.

## FAQ: What time zone are times in?
The hub shows Sri Lanka time with US Eastern beside a call. Clients see their own time zone. Sending follows US
business hours.
