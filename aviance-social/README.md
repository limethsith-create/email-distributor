# Aviance Social - Automated Social Media Posting System

A Next.js web dashboard that connects LinkedIn, Facebook, and Instagram together. Upload media, write your caption, pick platforms, set a time — and the system auto-posts for you.

**Deployed on Vercel | Code on GitHub | Cron-based auto-publishing every 5 minutes**

---

## Features

- **Unified Dashboard** — One place to manage all three platforms
- **Media Upload** — Drag & drop images and videos, stored on Vercel Blob
- **Multi-Platform Posting** — Select LinkedIn, Facebook, Instagram (or all three) per post
- **Scheduled Publishing** — Set a date/time and it auto-publishes via Vercel Cron
- **Instant Posting** — Or post immediately with one click
- **Post Queue** — See all scheduled, published, and failed posts
- **OAuth Connections** — Connect each platform via secure OAuth2 flow
- **Calendar View** — Visual schedule of upcoming posts by week

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Database | PostgreSQL (Vercel Postgres) |
| File Storage | Vercel Blob |
| Hosting | Vercel |
| Cron Jobs | Vercel Cron (every 5 min) |
| APIs | LinkedIn v2, Meta Graph API v19.0 |

---

## Setup Guide (Step by Step)

### 1. Prerequisites

- Node.js 18+ installed
- A GitHub account
- A Vercel account (free at vercel.com)

### 2. Push to GitHub

Open a terminal in this folder and run:

```bash
cd aviance-social
git init -b main
git add -A
git commit -m "Initial commit: Aviance Social Media Automation System"
```

Create a new repo on GitHub (github.com/new), name it `aviance-social`, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/aviance-social.git
git push -u origin main
```

### 3. Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your `aviance-social` GitHub repo
3. Vercel auto-detects Next.js — click **Deploy**
4. After deploy, go to **Settings > Storage**:
   - Add **Vercel Postgres** (free tier) — this sets `DATABASE_URL` automatically
   - Add **Vercel Blob** (free tier) — this sets `BLOB_READ_WRITE_TOKEN` automatically

### 4. Set Up Platform APIs

#### LinkedIn API

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps)
2. Click **Create App**
3. Fill in: App name = "Aviance Social", Company = your LinkedIn company page
4. Under **Auth** tab:
   - Copy **Client ID** and **Client Secret**
   - Add redirect URL: `https://YOUR-APP.vercel.app/api/auth/callback?platform=linkedin`
5. Under **Products** tab, request access to:
   - **Share on LinkedIn** (for posting)
   - **Sign In with LinkedIn using OpenID Connect**

#### Meta (Facebook + Instagram) API

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click **Create App** > Choose **Business** type
3. Add these products:
   - **Facebook Login** — set redirect URI to: `https://YOUR-APP.vercel.app/api/auth/callback?platform=meta`
   - **Instagram Basic Display** (if needed)
4. Under **App Settings > Basic**: copy **App ID** and **App Secret**
5. Required permissions (request in App Review):
   - `pages_manage_posts` — to publish on Facebook Pages
   - `pages_read_engagement` — to read page data
   - `instagram_basic` — to read Instagram profile
   - `instagram_content_publish` — to publish on Instagram
6. **Important:** Your Facebook Page must be linked to an Instagram Business Account for IG posting to work

### 5. Set Environment Variables

In Vercel Dashboard > Settings > Environment Variables, add:

| Variable | Value |
|----------|-------|
| `LINKEDIN_CLIENT_ID` | From LinkedIn Developer portal |
| `LINKEDIN_CLIENT_SECRET` | From LinkedIn Developer portal |
| `META_APP_ID` | From Meta/Facebook Developer portal |
| `META_APP_SECRET` | From Meta/Facebook Developer portal |
| `NEXT_PUBLIC_APP_URL` | `https://YOUR-APP.vercel.app` (no trailing slash) |
| `CRON_SECRET` | Any random string (generate with `openssl rand -hex 32`) |

> `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are auto-set by Vercel Storage.

### 6. Initialize Database

After setting env vars, run from your local machine:

```bash
npm install
npx prisma db push
```

Or trigger a redeploy on Vercel (the `postinstall` script runs `prisma generate`).

### 7. Connect Your Accounts

1. Visit your deployed app: `https://YOUR-APP.vercel.app`
2. Go to **Connections** page
3. Click **Connect** for each platform
4. Authorize through OAuth — you'll be redirected back with accounts connected

---

## How It Works

1. **You create a post** — Write content, upload media, pick platforms, set a schedule time
2. **Post is saved** to the database with status `SCHEDULED`
3. **Every 5 minutes**, Vercel Cron hits `/api/publish`
4. The cron job finds all posts where `scheduledAt <= now` and `status = SCHEDULED`
5. For each post, it publishes to each selected platform via their API
6. Post status updates to `PUBLISHED` or `FAILED` with details

---

## Project Structure

```
aviance-social/
├── prisma/
│   └── schema.prisma          # Database models
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/           # OAuth routes (LinkedIn, Meta, callback)
│   │   │   ├── connections/    # CRUD for platform connections
│   │   │   ├── posts/          # CRUD for posts + immediate publish
│   │   │   ├── publish/        # Cron endpoint for scheduled publishing
│   │   │   └── upload/         # Media upload to Vercel Blob
│   │   ├── connections/        # Connections management page
│   │   ├── schedule/           # Calendar schedule view
│   │   ├── globals.css         # Tailwind + dark theme styles
│   │   ├── layout.tsx          # Root layout with sidebar
│   │   └── page.tsx            # Dashboard (composer + queue)
│   ├── components/
│   │   ├── ConnectionCard.tsx  # Platform connection card
│   │   ├── DashboardClient.tsx # Dashboard client wrapper
│   │   ├── PostComposer.tsx    # Post creation form
│   │   ├── PostQueue.tsx       # Scheduled/published post list
│   │   └── Sidebar.tsx         # Navigation sidebar
│   └── lib/
│       ├── db.ts               # Prisma client singleton
│       └── platforms/
│           ├── facebook.ts     # Facebook Graph API integration
│           ├── instagram.ts    # Instagram Graph API integration
│           ├── linkedin.ts     # LinkedIn API integration
│           └── index.ts        # Unified publisher
├── .env.example
├── next.config.js
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vercel.json                 # Cron job configuration
```

---

## Local Development

```bash
# Install dependencies
npm install

# Copy env file and fill in your values
cp .env.example .env

# Push database schema
npx prisma db push

# Start dev server
npm run dev
```

Visit `http://localhost:3000`

---

## Platform Posting Requirements

| Platform | Text Only | Image | Video | Notes |
|----------|-----------|-------|-------|-------|
| LinkedIn | Yes | Yes | No (API limited) | Posts to personal profile |
| Facebook | Yes | Yes | No (use Page) | Posts to your Facebook Page |
| Instagram | No | Yes | No (container API) | Requires image. Posts to IG Business Account |

---

## License

Private — built for Aviance AI Automation Agency.
