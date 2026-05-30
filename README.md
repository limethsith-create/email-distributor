# MailDistro - Multi-Gmail Email Distribution System

A Next.js web app that lets you connect multiple Gmail accounts and distribute emails across them using round-robin. Built for Vercel deployment.

## Features

- **Multi-Account Support** — Connect as many Gmail accounts as you want
- **Round-Robin Distribution** — Emails are evenly split across your accounts
- **Template Variables** — Use `{{name}}`, `{{company}}`, etc. for personalization
- **CSV Upload** — Upload a CSV file with recipients and data columns
- **Real-Time Progress** — Watch emails being sent with live status updates
- **Campaign History** — Track all past campaigns with per-email results
- **Rate Limiting** — Configurable delay between emails to avoid Gmail limits

## Quick Start

### 1. Prerequisites

Each Gmail account needs an **App Password**:
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable **2-Step Verification**
3. Go to [App Passwords](https://myaccount.google.com/apppasswords)
4. Create a new App Password for "Mail"
5. Save the 16-character password

### 2. Local Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 3. Deploy to Vercel

#### Option A: One-Click Deploy
1. Push this folder to a GitHub repository
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your GitHub repository
4. Click **Deploy**

#### Option B: Vercel CLI
```bash
npm install -g vercel
vercel
```

### 4. Environment Variables (Optional)

Set these in your Vercel dashboard under Settings > Environment Variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ENCRYPTION_KEY` | Key for encrypting stored credentials | (optional) |
| `MAX_EMAILS_PER_ACCOUNT` | Daily limit per account | 450 |

## Usage

### Connect Accounts
1. Go to **Accounts** page
2. Click **Add Account**
3. Enter your Gmail and App Password
4. Click **Test Connection** to verify
5. Click **Add Account**

### Send Campaign
1. Go to **Compose** page
2. Select which accounts to send from
3. Add recipients (manual, paste, or CSV upload)
4. Write your subject and body using `{{variables}}`
5. Set delay between emails
6. Click **Send**

### CSV Format

Your CSV file must have an `email` column. Other columns become template variables:

```csv
email,name,company,role
john@example.com,John Smith,Acme Corp,CEO
jane@example.com,Jane Doe,Tech Inc,CTO
```

Then use `{{name}}`, `{{company}}`, `{{role}}` in your email template.

## Gmail Limits

- **Free Gmail**: ~500 emails/day per account
- **Google Workspace**: ~2,000 emails/day per account
- Use multiple accounts to scale beyond these limits
- Set appropriate delay (2-5 seconds) between sends

## Tech Stack

- **Next.js 14** (App Router)
- **Tailwind CSS** (Styling)
- **Nodemailer** (Gmail SMTP)
- **Vercel** (Hosting)

## Project Structure

```
src/
├── app/
│   ├── page.js          # Dashboard
│   ├── accounts/        # Gmail account management
│   ├── compose/         # Email composition & sending
│   ├── history/         # Campaign history
│   └── api/
│       ├── send/        # Email sending endpoint (SSE)
│       └── test-connection/  # Connection testing
└── lib/
    ├── mailer.js        # Nodemailer Gmail transport
    └── distributor.js   # Round-robin & template engine
```
