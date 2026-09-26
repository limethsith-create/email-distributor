# Buying a trial's domain and inboxes — step by step

What this gives you: for every trial you buy ONE thing — a domain and 2
inboxes on CheapInboxes. The machine does everything after that by itself:
it finds your purchase, points the domain at the client's website, collects
the inbox logins, checks the setup (SPF, DKIM, DMARC, the logins, a test
email) and starts the warm-up. You get a message when it is found and another
when it is ready.

**The machine never buys anything and never spends your money.** Only you
place orders, in your own CheapInboxes account. The machine can only look at
the account (and point a domain you bought at the client's website).

The one-time setup takes about 10 minutes. After that, each trial takes about
5 minutes of your time.

CheapInboxes changes its pages from time to time. If a button has moved, look
for the same words nearby.

---

## Once: connect your CheapInboxes account

### Part 1 — Make the account

1. Go to **https://www.cheapinboxes.com** and click **Sign up** (or
   **Get started**). Use your own email and a strong password.
2. If CheapInboxes sends you an email to confirm the address, open it and
   click the link.

### Part 2 — Add a card

3. In CheapInboxes, open **Billing** (in the menu on the left) →
   **Payment methods** → **Add card**. Enter your card and save it.
4. If there is more than one card, make the one you want to use the
   **default**.

CheapInboxes charges this card only when **you** place an order (and then
monthly for the inboxes you keep). The machine never uses it.

### Part 3 — Create an API key

The API key is what lets the machine *look at* your account.

5. Open **Integrations** → **API**.
6. Click **Create key** (or **New API key**). Name it `Aviance machine`.
7. Copy the key. It starts with `ci_live_`. CheapInboxes may show it only
   once — keep the page open until Part 4 is done.

Treat the key like a password: do not email it or paste it anywhere else.

### Part 4 — Paste it in the hub

8. Open the hub → **Settings** → **Inboxes & domains**.
9. Paste the key into the box and press **Save**.
10. Press **Test it**. You should see:
    - **Connected** and your CheapInboxes account name
    - **Card on file: yes**
    - **Webhook: registered** (this is how CheapInboxes tells the machine
      when something is ready)

If it says **"No card on your CheapInboxes account"**, do Part 2 again and
press **Test it**. If it says **"The key was refused"**, make a new key (Part 3)
and paste it again.

That's all for the setup. You never need to do it again unless you delete the
key.

---

## For each trial: buy the domain and 2 inboxes

When a trial is ready for its inboxes, the Trials list says **"Buy their
domain and 2 inboxes on CheapInboxes"** with a red dot, and you get a to-do.

1. Open the trial in the hub. You see:
   - **the domain to buy**, with its price (for example `acmehq.com — $9.99`)
   - up to **3 alternatives**
   - **the 2 inboxes**: the name on each (for example *Jordan Test*) and the
     address (for example `jordan@acmehq.com` and `jordan.test@acmehq.com`).
2. Press **Open CheapInboxes**. Their order page opens.
3. In the order:
   - **Domain:** search for **exactly** the domain the hub shows, and add it.
   - **Inboxes:** choose **Google Workspace**. Add **exactly 2** inboxes, with
     the first name, last name and address (the part before the @) the hub
     shows.
   - If it offers to connect a sending tool (Instantly, Smartlead …), **skip**
     it.
   - If it asks where the website should forward to, you can skip it — the
     machine sets that.
4. Pay and finish the order.

That's it. Within a few minutes the hub shows **"We found acmehq.com —
connecting it to {company}"**, and you get the same message on your phone.

CheapInboxes then takes **up to about 48 hours** to create the inboxes. You do
nothing during that time; the trial says **"Setting up their inboxes (about 2
days)"**. When everything is connected and checked you get **"acmehq.com and 2
inboxes are ready — warm-up has started"**.

**The domain is taken?** In the hub, press **Buy this one instead** next to one
of the alternatives *first* (so the inbox addresses change to match), then buy
that one.

**In a hurry?** Press **I've bought it — check now** on the trial to make the machine look at
your account straight away.

---

## If something goes wrong

Every message tells you what happened and what to do. The most common ones:

- **"You bought randomname.com — which trial is it for? Pick in Settings"** —
  you bought a domain that is not on any trial's list. Go to **Settings ›
  Inboxes & domains**, find the domain under *Bought, but not matched to a trial*, pick the trial under **This is for…** and press **Link it**.
  The machine connects it straight away.
- **The purchase was matched to the wrong trial** — open that trial and press
  **Wrong domain? Undo**. This only works before the inboxes are connected. Then
  pick the right trial in Settings.
- **"Inbox setup: The CheapInboxes order for acmehq.com failed"** — open
  **Orders** in CheapInboxes to see why, or ask their support (the chat on
  their site). If you buy again (or buy an alternative), the machine finds the
  new purchase by itself.
- **"Inbox setup: No login came back for jordan@acmehq.com"** — in
  CheapInboxes open **Mailboxes** → that inbox → **Credentials**. If nothing is
  shown, ask their support. The machine picks the login up by itself as soon
  as it is there.
- **"Inbox setup: acmehq.com is still not ready 72 hours after you bought
  it"** — ask CheapInboxes support what is holding it up. Nothing for you to
  do in the hub.
- **"DNS record wrong for acmehq.com"** (after the inboxes are in) — one of
  the setup checks did not pass. The message names the exact record. Open the
  domain in CheapInboxes (its DNS / DMARC page), set the record as the message
  says, and wait: the checks run again every hour.
- **"Inbox setup: CheapInboxes refused the API key"** — make a new key
  (Part 3), paste it in **Settings › Inboxes & domains** and press **Test it**.

---

## When a trial ends

The machine never cancels anything. When a trial ends without a plan, the hub
gives you a to-do: **"Cancel the trial inboxes at the provider, then tick
done"**. Cancel the 2 inboxes (and the domain) in CheapInboxes yourself, then
tick it in the hub.

## Without CheapInboxes connected

Nothing changes from before: buy the domain and inboxes wherever you like and
paste the logins on the trial's purchase page.

## Removing the connection

**Settings › Inboxes & domains → Forget the key** removes the key and the webhook
from the machine. Trials already set up keep running. You can also delete the
key in CheapInboxes under **Integrations → API**.
