# Connecting Google Meet — step by step

What this gives you: every call you confirm in the hub's Calendar gets its own
Google Meet link and shows up in your Google Calendar. The link goes into the
confirmation email and the calendar invite the client receives.

You do this **once**. It takes about 15 minutes. Nothing here costs money.

You need:
- The Google account you want the calls on (your Gmail is fine). Its calendar
  gets the calls, and the Meet links are made in its name.
- The hub open on your computer (a phone screen is too small for Google's pages).

The Google pages change their look from time to time. If a button has moved,
look for the same words nearby.

---

## Part 1 — Make a "project" in Google Cloud

Google Cloud is where you give your own app (the machine) permission to use
your calendar. A "project" is just a folder for that permission.

1. Go to **https://console.cloud.google.com** and sign in with the Google
   account you want the calls on. If Google asks you to agree to its terms
   the first time, pick your country and agree.
2. At the top of the page, left of the search bar, click the project picker
   (it says **Select a project**, or shows a project name).
3. In the window that opens, click **New project** (top right of the window).
4. **Project name:** type `Aviance`. Leave the rest as it is. Click **Create**.
5. Wait a few seconds. Open the project picker again and click **Aviance**, so
   it is the one shown at the top. Everything below happens inside it.

## Part 2 — Turn on the Google Calendar API

6. In the search bar at the top, type `Google Calendar API` and click the
   result with that name (under "Marketplace" or "Products").
7. Click the blue **Enable** button. When it says **API enabled** (or shows a
   **Manage** button), this part is done.

## Part 3 — The consent screen (what Google shows when you connect)

8. Click the menu (the three lines ☰ at the top left) → **APIs & Services** →
   **OAuth consent screen**. (Google may call this area **Google Auth Platform**;
   if it shows a **Get started** button, click it.)
9. Fill in the first page (**App information**):
   - **App name:** `Aviance`
   - **User support email:** choose your own email from the list.
   Click **Next**.
10. **Audience:** choose **External**. Click **Next**.
11. **Contact information:** type your own email. Click **Next**.
12. Tick the box to agree to Google's user data policy, click **Continue**,
    then **Create**.
13. Add yourself as a test user: in the left menu click **Audience**. Under
    **Test users** click **+ Add users**, type your own email, click **Save**.
14. **Publish the app** — this matters. On the same **Audience** page, under
    **Publishing status**, click **Publish app**, then **Confirm**. The status
    changes to **In production**.
    Why: while the app is left in "Testing", Google cuts the connection after
    7 days and you would have to connect again every week. Publishing does not
    make anything public — only people who have your hub can use it, and Google
    will still say the app is "not verified" (Part 6), which is fine.

## Part 4 — The keys (Client ID and Client secret)

15. In the left menu click **Clients** (or, in older layouts: **APIs &
    Services** → **Credentials** → **+ Create credentials** → **OAuth client ID**).
    Click **+ Create client**.
16. **Application type:** choose **Web application**.
17. **Name:** type `Aviance hub`.
18. Under **Authorized redirect URIs**, click **+ Add URI** and paste the
    address shown in the hub under **Settings › Google Meet** (there is a
    Copy button next to it). It is:

    `https://email-distributor.vercel.app/api/google/callback`

    It must be **exactly** this — no space, no extra `/` at the end. Leave
    "Authorized JavaScript origins" empty.
19. Click **Create**. A window shows your **Client ID** and your
    **Client secret**.
20. Copy both now (use the copy icons next to them, or **Download JSON** and
    keep the file somewhere safe). Google may show the Client secret only this
    once. If you lose it: open the client again and use **Add secret**.

Google says a new redirect address can take up to 5 minutes to start working.
If Part 6 fails with "redirect_uri_mismatch" right away, wait 5 minutes and try
again.

## Part 5 — Paste them into the hub

21. In the hub go to **Settings › Google Meet**.
22. Paste the **Client ID** (it ends with `.apps.googleusercontent.com`) and
    the **Client secret** (it usually starts with `GOCSPX-`). Click **Save**.
    The hub stores them locked (encrypted) and never shows them again.

## Part 6 — Connect

23. Click **Connect Google**. Google's sign-in page opens.
24. Pick the same Google account as in Part 1.
25. Google shows **"Google hasn't verified this app"**. That is expected: the
    app is your own, and only Google's big review process removes this
    warning. Click **Advanced** (small, bottom left), then
    **Go to Aviance (unsafe)**.
26. Google lists what the app may do. Make sure the calendar line
    ("View and edit events on all your calendars") is **ticked** — or tick
    **Select all**. Click **Continue** (or **Allow**).
27. You land back in the hub. It says **Connected** and shows your Google
    account.

You have 10 minutes from pressing **Connect Google** to finishing step 26. If
you take longer, just press **Connect Google** again.

## Part 7 — Test it

28. Click **Test it**. The machine makes a 15-minute test event with a Meet
    link in your Google Calendar and deletes it straight away. You should see
    "Works" and a link starting with `https://meet.google.com/`.

That's it. From now on, when you press **Yes** on a call (or a client says
"Yes, that works" to a time you suggested, or you add a call with a client),
the call gets a Meet link and appears in your Google Calendar. Moving a call
moves it there too; cancelling or declining removes it.

---

## If something goes wrong

What the hub says after **Connect Google**, and what to do:

| The hub says | What happened | What to do |
|---|---|---|
| `state` | More than 10 minutes passed, or the page was opened twice | Press **Connect Google** again |
| `denied` | **Cancel** was pressed on Google's page | Press **Connect Google** again and choose **Continue** |
| `calendar_permission` | The calendar line was not ticked in step 26 | Press **Connect Google** again and tick it |
| `exchange` | Google did not accept the keys | Paste the Client ID and Client secret again (Part 5), check the address in step 18, then connect again |
| `not_set_up` | The keys are not saved | Do Part 5 |
| `no_refresh_token` | Google did not hand over a lasting key | Press **Connect Google** again |
| `google_down`, `google`, `server` | Google or the machine had a hiccup | Wait a minute and press **Connect Google** again |

What Google itself may show:

- **"Error 400: redirect_uri_mismatch"** — the address in step 18 is not exactly
  the one in the hub. Fix it in Part 4 (open the client, correct the address,
  **Save**), wait 5 minutes, connect again.
- **"Access blocked: Aviance has not completed the Google verification process"**
  or **"Error 403: access_denied"** — the app is still in "Testing" and your
  email is not a test user. Do steps 13 and 14.
- **"The Google Calendar API is not turned on"** (in the hub, after **Test it**) —
  do Part 2 in the same project.

Later on:

- **"Google Meet disconnected — reconnect it in Settings"** (on your phone and by
  email) — Google stopped the connection: the access was removed in your Google
  account, the app was left in "Testing" (7-day limit — do step 14), or the
  keys were deleted. Calls are still confirmed; their emails say "I'll send the
  link before the call" until you reconnect. Go to **Settings › Google Meet**
  and press **Connect Google**.
- A call in the Calendar says **"No Meet link — …"** — it was confirmed while
  Google was not connected or did not answer. Send the client a link yourself
  (for example from Google Calendar or meet.google.com).

## Disconnecting

**Settings › Google Meet → Disconnect** removes the machine's access and
forgets it. Your saved Client ID and secret stay, so **Connect Google** works
again later without Parts 1–5. Calls already in your Google Calendar stay
there. (You can also remove the access from your Google account at
**myaccount.google.com → Security → Third-party apps & services**.)
