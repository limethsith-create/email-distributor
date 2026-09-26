# Keys — what each one is for, and how to get it

The machine talks to a few outside services: Google (to find businesses and
count a market), four email checkers (so nothing goes to a dead address) and
GitHub (where the lead finder runs). Each needs a key, which is a long
password the service gives you.

You paste every key **once, in the hub: Settings › Keys**. You never need to
open Vercel or GitHub's settings for this. Each card in the hub shows the same
steps as below, a **Save** box, a **Test** button and **Forget**.

- **Save** first checks the key with the service (one small free call). A key
  the service refuses is not saved — the card says why, in plain words.
- **Test** checks a saved key again, any time. The card shows when it was last
  checked and what is left (for example "18 free checks left today").
- **Forget** removes the key from the machine.

Keys are stored encrypted and are never shown again, never in a report and
never in a backup. Treat a key like a password: do not email it or paste it
anywhere else.

Every service below has a free plan that covers a trial. Nothing here costs
money unless you buy a credit pack yourself.

The services change their pages from time to time. If a button has moved,
look for the same words nearby. Steps marked *checked* were compared with the
service's own help pages on 2026-09-26.

---

## Google Places key — finds businesses, reads reviews and market size

**What it does:** counts how many businesses match a trial's market, finds
the applicant's own business (rating, reviews) and gives the lead finder its
list of companies.

**Free:** the market count is free (it only asks for IDs). The lead finder's
detailed searches have 1,000 free a month, which a trial stays under. Google
needs a card on the project, but nothing is charged for this use.

Steps *(checked)*:

1. Go to **https://console.cloud.google.com** and sign in with your Google
   account.
2. At the top, open the project picker → **New project**. Name it `Aviance`
   and create it. Make sure it is the selected project.
3. **Billing → Link a billing account** → add your card. Google asks for one
   on every project; the free monthly allowance covers what the trial uses.
4. In the search bar type `Places API (New)`, open it and press **Enable**.
5. **APIs & Services → Credentials → Create credentials → API key**.
6. Click the new key's name → **API restrictions → Restrict key** → tick
   **Places API (New)** → **Save**.
7. Copy the key (it starts with `AIza`) and paste it in the hub.

If the hub says **"Places API (New) is not enabled for this key"**, do step 4
again. **"Billing is not turned on"** → step 3. **"This key's restrictions do
not allow Places API (New)"** → step 6.

## QuickEmailVerification key — checks 100 addresses a day free

**What it does:** the first email checker in line. Every lead's address is
checked before anything is sent to it.

**Free:** 100 checks a day. Sign up with a work email address (not Gmail).

Steps *(checked)*:

1. Sign up at **https://quickemailverification.com** with your work email and
   confirm it.
2. Sign in → **API Settings → Add API Key** → give it a name (for example
   `Aviance`) → **Add**.
3. Copy the key and paste it in the hub.

## Verifalia login — 25 a day free

**What it does:** the second email checker. Verifalia uses a user name and a
password instead of one key.

**Free:** 25 checks a day (one free account per organisation), reset at
midnight GMT.

Steps *(checked)*:

1. Sign up at **https://verifalia.com** and confirm your email.
2. In the client area open **Account → Users → Create a user**. Give it a user
   name (Verifalia calls it the *SID*) and a password (Verifalia calls it the
   *auth token*). On the **Permissions** tab tick email validations and the
   credit balance.
3. Paste that user name and password in the hub. Your own account email and
   password work too, but a separate user is safer.

## Reoon key — 20 a day free

**What it does:** the third email checker.

**Free:** 20 checks a day (up to 600 a month) plus 100 on signup. Paid packs
never expire ($11.90 for 10,000) if a big list ever needs clearing faster.

Steps *(check on their site — their menu names were not verified)*:

1. Sign up at **https://emailverifier.reoon.com** and confirm your email.
2. Sign in → **API Settings → Create API Key** → give it a name → **Create**.
3. Copy the key and paste it in the hub.

## ZeroBounce key — 100 a month free

**What it does:** another email checker, used when the daily ones are spent.

**Free:** 100 checks a month. Sign up with a business email address.

Steps *(check on their site — their docs only say the key is "found in your
account")*:

1. Sign up at **https://www.zerobounce.net** with your business email and
   confirm it.
2. Sign in → **API → API Keys**.
3. Copy the key and paste it in the hub.

## Hunter key — about 100 checks a month free (optional)

**What it does:** the last email checker in line. Optional: the machine works
without it.

**Free:** 50 credits a month; a check costs half a credit, so about 100
checks. Hunter allows one account per person.

Steps *(checked)*:

1. Sign up at **https://hunter.io** and confirm your email.
2. Open **https://hunter.io/api-keys** (Dashboard → API) and copy the key.
3. Paste it in the hub.

## GitHub token — starts the lead finder

**What it does:** the lead finder is a long job that runs on GitHub. The
token lets the machine press its start button — nothing else.

**Free.**

Steps *(checked)*:

1. On **github.com** click your profile picture → **Settings → Developer
   settings → Personal access tokens → Fine-grained tokens → Generate new
   token**.
2. **Token name:** `Aviance lead finder`. **Expiration:** the longest you are
   offered (you paste a new one when it runs out; the hub's Test tells you).
3. **Repository access: Only select repositories** →
   `limethsith-create/email-distributor`.
4. **Permissions → Repository permissions: Contents = Read and write.**
   *Metadata = Read* is set by itself.
5. **Generate token** → copy it (GitHub shows it once) → paste it in the hub.

If the hub says **"This token cannot start jobs on …"**, step 4 was missed.
**"This token cannot see …"** → step 3.

## GitHub repository

A plain setting, not a key: `owner/repository` of the code, where the lead
finder runs. Leave the default (`limethsith-create/email-distributor`) unless
the repository moved.

---

## How the machine uses them

- A key set on the server (Vercel) still wins over the hub's; the card then
  says **set on the server** and can only be tested, not changed, from the hub.
- The lead finder job on GitHub gets the keys it needs from the machine when
  it starts, so GitHub itself keeps no service keys any more (only its own
  `LEADFINDER_TOKEN` / `CRON_SECRET` and the app address).
- Every email checker with a key is used in turn, daily allowances first.
  With no checker key at all, leads are only "mail-server checked" and nothing
  is sent — the hub tells you.
- The technical contract for the hub is in docs/HUB-API.md ("Keys").
