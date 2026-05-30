# Aviance Email Outreach System — Comprehensive Audit Report

**Date:** 2026-05-28
**System:** Next.js on Vercel + Gmail SMTP (5 accounts, 15/day each)
**Total Emails Analyzed:** ~90 sent emails
**Verdict:** System has critical issues across lead quality, deliverability, personalization, and compliance. Without fixes, estimated inbox placement is under 30% and reply rate under 0.5%.

---

## Section 1: Current Problems — Severity Ratings

### CRITICAL Severity

| # | Problem | Impact |
|---|---------|--------|
| P1 | **"Your business" fallback in company name** | Emails say "I came across your business" when company name is missing. This is the single biggest spam signal — it screams mass-generated outreach. Gmail AI classifiers will flag this instantly. Recipients delete on sight. |
| P2 | **Sending from brand-new Gmail accounts with no reputation** | All 5 accounts (aviancesystems@, avianceops@, avianceauto@, avianceflow@, aviancedev@gmail.com) are new accounts with zero sending history. Gmail throttles new accounts aggressively. Sending 15 cold emails/day from a fresh account will get you flagged within 48-72 hours. Google's February 2024 bulk sender policy makes this even worse. |
| P3 | **No CAN-SPAM compliant unsubscribe mechanism** | The emails include "reply unsubscribe" but there is no automated processing, no one-click unsubscribe URL, and no physical mailing address. This violates CAN-SPAM (US), GDPR (if any EU contacts), and Gmail's 2024 bulk sender requirements. Penalty: up to $50,120 per email under CAN-SPAM. |
| P4 | **Duplicate company sends — multiple people at same company** | MAS Holdings got 4-5 emails, Dialog Axiata got 4, Sampath Bank got 3, etc. When multiple employees at the same company all receive the same templated cold email, they compare notes, flag it as spam, and your domain reputation tanks. |

### HIGH Severity

| # | Problem | Impact |
|---|---------|--------|
| P5 | **Wrong person names attached to emails** | nishantha@bernardbotejue.com gets "Hi Edmund" — the name and email are mismatched. This destroys credibility instantly. The recipient knows you have no idea who they are. |
| P6 | **Sending to generic/role-based addresses** | info@, contact@, sales@, reservations@ addresses have 5-10x lower deliverability than personal addresses. ISPs know these catch-alls are cold email targets and filter aggressively. |
| P7 | **Generic industry="business" label** | Many leads have industry set to "business" which makes the email say "A lot of business companies I talk to..." — this is meaningless and makes the email feel like untargeted spam. |
| P8 | **Identical email structure across all sends** | Every single email follows the exact same paragraph structure. Gmail's content similarity detection flags this. When 75+ emails with near-identical text flow through Gmail's servers from the same accounts, it triggers bulk sender classification. |

### MEDIUM Severity

| # | Problem | Impact |
|---|---------|--------|
| P9 | **Weak, templated subject lines** | "Quick idea for [company]", "Quick question about your business", "Thought for [company]" — these are classic cold email subject line patterns that Gmail's spam filter has been trained on for years. Average open rate for these: 8-12% vs 25-35% for well-crafted subjects. |
| P10 | **Tracking pixel from custom domain** | The tracking pixel loads from email-distributor.vercel.app — a shared Vercel subdomain. ESP filters flag tracking pixels from non-reputable domains. This alone can push emails to promotions/spam tab. |
| P11 | **University and irrelevant email addresses in lead list** | manjitha.15@cse.mrt.ac.lk is a university email at Moratuwa University. Emailing students/academics with B2B cold outreach is wasteful and can generate spam complaints. |
| P12 | **No email verification before sending** | The system does not verify that email addresses actually exist (no SMTP verification, no bounce prediction). Sending to non-existent addresses increases bounce rate, which destroys sender reputation. |

### LOW Severity

| # | Problem | Impact |
|---|---------|--------|
| P13 | **Scraper produces low-quality leads** | The scraper does basic regex matching on directory pages, often mismatching company names with emails. The lead enrichment is minimal. |
| P14 | **No A/B testing analytics** | Subject line variants are randomly selected but results are not tracked per variant, making it impossible to optimize. |
| P15 | **Gemini AI enhancement is unreliable** | The AI enhancement via Gemini has a 10-second timeout and silently falls back to the template — no logging of how often this happens or whether AI-enhanced emails perform better. |

---

## Section 2: Why Emails Are Bouncing

### 2.1 DNS/SPF/DKIM Alignment Issues

When you send from aviancesystems@gmail.com, the email passes through Gmail's SMTP servers. Here is how authentication works:

- **SPF:** Gmail's SPF record covers smtp.gmail.com, so SPF passes. However, the MAIL FROM envelope domain is gmail.com, not a custom domain. This means you are sharing reputation with every other Gmail user.
- **DKIM:** Gmail signs outgoing mail with its own DKIM key (d=gmail.com). This passes DKIM. But again, you share the gmail.com domain reputation.
- **DMARC:** gmail.com has a DMARC policy. Your emails align because both SPF and DKIM use gmail.com. However, Gmail can and does throttle individual accounts within its ecosystem.

**The real problem:** You have no custom domain. You cannot build independent sender reputation. Every spam complaint against your gmail.com accounts drags down your individual account standing within Gmail's internal scoring system.

### 2.2 Email Address Validity

Your scraper collects emails via regex from directory websites. Common failures:
- Outdated directory listings with deactivated email addresses
- Typos in scraped data (encoding issues, malformed addresses)
- Generic addresses (info@) that have been abandoned or have full mailboxes
- The scraper fallback `guessEmails()` generates info@, contact@, hello@, admin@ — these are guesses, not verified addresses

**Bounce rate impact:** Industry average bounce rate should be under 2%. With unverified scraped emails, you are likely at 8-15%+. Anything over 5% bounce rate causes Gmail to start throttling your account.

### 2.3 Sending to Generic Addresses

Role-based addresses (info@, sales@, contact@, reservations@, admin@) have specific problems:
- Many companies route these to shared inboxes that nobody monitors
- Some ISPs automatically filter cold email to role-based addresses
- Bounce rates for role-based addresses are 2-3x higher than personal addresses
- Even when delivered, open rates are 60-70% lower than personal addresses

### 2.4 Sender Reputation Issues

New Gmail accounts have a "neutral" reputation that quickly turns negative when:
- You send more than 5-10 emails/day in the first 2 weeks
- Bounce rate exceeds 2%
- Spam complaint rate exceeds 0.1% (1 in 1,000)
- Recipients do not open or engage with your emails
- Multiple recipients mark your email as spam

With 5 new accounts sending 15 emails/day each (75 total), you likely triggered Gmail's anti-abuse systems within the first few days.

---

## Section 3: Why Open Rates Are Low

### 3.1 Subject Line Analysis

Your current subject lines and their problems:

| Subject Line | Problem |
|---|---|
| "Quick idea for [company]" | Classic cold email spam pattern. Gmail has trained on millions of these. |
| "Quick question about your business" | Uses "your business" fallback = clearly mass email. |
| "Thought for [company]" | Vague, gives no reason to open. |
| "Following up — [company]" | Following up on what? Recipient never received initial email (it went to spam). |
| "Last note — [company]" | "Last note" from a stranger has zero urgency or interest value. |

**What works in 2025-2026:** Subject lines that reference a specific, observable fact about the recipient's company. Examples: referencing a recent hire, a product launch, a website observation, or a specific operational detail. The subject line must make the recipient think "how do they know that?" — not "another sales email."

### 3.2 Sender Name and Reputation

Your sender names are configured as the email prefix (aviancesystems, avianceops, etc.) unless a display name is set. Problems:
- These look like bot accounts, not real people
- The display name should be a real person's name (e.g., "Limethsith from Aviance")
- Gmail users see sender name first — if it looks corporate/automated, they skip it

### 3.3 Gmail Tab Placement

Gmail automatically sorts incoming mail into Primary, Promotions, Social, and Updates tabs. Your emails are likely landing in Promotions or Spam because:

1. **HTML formatting:** Your wrapper adds HTML structure (DOCTYPE, body tags, div wrappers) — Gmail sees this as marketing email
2. **Tracking pixel:** The 1x1 pixel image is a known email marketing pattern that Gmail's classifiers detect
3. **List-Unsubscribe header:** While required for compliance, this header explicitly tells Gmail "this is a bulk/marketing email" which triggers Promotions tab placement
4. **Identical content patterns:** Sending nearly identical content from the same IP range signals automated bulk sending
5. **No prior relationship:** Gmail heavily favors emails from people the recipient has emailed before

---

## Section 4: Why Reply Rates Are Low

### 4.1 Email Content Analysis

The email body has several problems that kill reply rates:

**Problem: Generic opener**
> "I came across [company] while looking into [industry] businesses in Sri Lanka"

This line is in every single email. It adds zero value. The recipient knows you did not "come across" their company — you scraped their email from a directory. This opener has been used in billions of cold emails and recipients recognize it instantly.

**Problem: No specific observation**
The email never references anything specific about the recipient's company — no mention of their website, products, recent news, team size, or any detail that proves you actually researched them.

**Problem: Vague social proof**
> "A manufacturer told us their production delays dropped significantly"

"Significantly" is meaningless. "A manufacturer" is unverifiable. This reads as fabricated. Effective social proof needs specificity: company name (with permission), specific metric, timeframe.

**Problem: Weak CTA**
> "Would a quick 15-minute call make sense?"

This asks for a significant time commitment from a stranger. The first email should have a much lower-friction CTA — asking a yes/no question, offering a specific deliverable, or requesting a reply rather than a meeting.

### 4.2 Personalization Gaps

The personalization system has three major gaps:

1. **Company name missing:** Falls back to "your business" — an immediate credibility killer
2. **First name missing or wrong:** Either no greeting name (just "Hi,") or wrong name (the Edmund/nishantha mismatch)
3. **Industry too generic:** "business" as an industry makes the entire pain point section irrelevant

True personalization would include: the recipient's actual role, something specific about their company (from their website or LinkedIn), and a pain point tied to their specific situation rather than a generic industry template.

### 4.3 CTA Weakness

The CTA progression across the 3-email sequence:
- Day 0: "Would a quick 15-minute call make sense?" — Too much commitment
- Day 3: "I can send over a quick 1-page breakdown" — Better, but still vague
- Day 7: "If you ever want to explore..." — Passive, no urgency

Effective CTAs for cold email:
- Ask a specific question that can be answered in one sentence
- Offer something concrete and immediately useful (not a call)
- Give a binary choice ("Would X or Y be more relevant?")

### 4.4 Trust Signals Missing

The email lacks trust signals that Sri Lankan business leaders look for:
- No company website that looks professional (aviance.online needs to be solid)
- No LinkedIn profile link
- No specific Sri Lankan client references (anonymized references have zero weight)
- No case study or portfolio link
- No indication of team size or legitimacy

---

## Section 5: Recommended Fixes — Priority Order

### Fix 1: Stop Sending Immediately and Warm Up Accounts

**What:** Pause all outbound email for 2-4 weeks. During this time, warm up each Gmail account.
**Why:** Your accounts likely have damaged reputation. Continuing to send will make it worse. Warming rebuilds reputation gradually.
**How:**
1. Stop the auto-send cron job
2. Sign up for an email warm-up service (Instantly.ai warmup, Lemwarm, or Warmbox)
3. Each service sends and receives emails between real inboxes, opening them and marking them as important
4. Start with 2-3 warm-up emails/day per account, increase by 2-3 per day over 3-4 weeks
5. After 3-4 weeks, start sending cold emails at 3-5/day per account, scaling up by 2/day per week

**Expected impact:** Inbox placement should improve from ~30% to 70-85%
**Implementation difficulty:** Easy — just pause sending and sign up for a service ($30-50/month per account)

### Fix 2: Get a Custom Domain and Set Up Proper Email Authentication

**What:** Buy a custom domain (e.g., aviance.email or outreach-aviance.com) and set up Google Workspace
**Why:** Gmail.com accounts cannot build independent sender reputation. A custom domain with proper DNS records is table stakes for cold email in 2025.
**How:**
1. Buy 2-3 domains ($10-12/year each) — use them for outreach only, not your main domain
2. Set up Google Workspace ($6/user/month) on each domain
3. Configure DNS records:
   - SPF: `v=spf1 include:_spf.google.com ~all`
   - DKIM: Generate in Google Workspace Admin > Gmail > Authenticate email
   - DMARC: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
4. Create 2-3 email accounts per domain (e.g., limethsith@aviance.email, team@aviance.email)
5. Warm up each account for 3-4 weeks before sending

**Expected impact:** Deliverability improvement of 30-50%. Custom domains with proper DNS authentication have significantly higher inbox placement.
**Implementation difficulty:** Medium — requires domain purchase, DNS configuration, and Google Workspace setup

### Fix 3: Fix Lead Data Quality — Eliminate "Your Business" Fallback

**What:** Never send an email where company_name falls back to "your business". Skip the lead entirely.
**Why:** This single issue probably accounts for 20-30% of your spam classifications. It is the most obvious indicator of mass-generated email.
**How:**
In `src/app/api/cron/auto-send/route.js`, change:
```javascript
// BEFORE (line 304):
company_name: lead.company || lead.company_name || 'your business',

// AFTER:
company_name: lead.company || lead.company_name || null,
```
Then add a check before sending:
```javascript
if (!qualifiedLead.company_name || qualifiedLead.company_name === 'your business') {
  results.skipped++;
  results.details.push({ to: lead.email, status: 'skipped', reason: 'missing company name' });
  // Revert status
  await kv.hset(LEADS_KEY, {
    [lead.email.toLowerCase()]: { ...lead, status: 'skipped', updatedAt: new Date().toISOString() }
  });
  continue;
}
```

**Expected impact:** Immediate improvement in email quality. Smaller send volume but drastically higher quality.
**Implementation difficulty:** Easy — 10 minutes of code changes

### Fix 4: Implement Company-Level Deduplication

**What:** Only send to ONE person per company. Track companies already contacted.
**Why:** Sending to 4-5 people at MAS Holdings or Dialog Axiata is aggressive and will generate spam complaints.
**How:**
Add a company deduplication layer:
```javascript
// In leads-db.js, add:
const COMPANY_SENT_KEY = 'company_sent'; // Set of normalized company names

export async function isCompanyAlreadySent(companyName) {
  if (!companyName) return false;
  const normalized = companyName.toLowerCase().trim()
    .replace(/\s*(pvt\.?\s*ltd\.?|ltd\.?|plc|llc|inc\.?)\s*$/i, '')
    .replace(/\s+/g, ' ');
  return await kv.sismember(COMPANY_SENT_KEY, normalized);
}

export async function markCompanySent(companyName) {
  if (!companyName) return;
  const normalized = companyName.toLowerCase().trim()
    .replace(/\s*(pvt\.?\s*ltd\.?|ltd\.?|plc|llc|inc\.?)\s*$/i, '')
    .replace(/\s+/g, ' ');
  await kv.sadd(COMPANY_SENT_KEY, normalized);
}
```
Then check before sending:
```javascript
const alreadySent = await isCompanyAlreadySent(qualifiedLead.company_name);
if (alreadySent) {
  results.skipped++;
  continue;
}
// After successful send:
await markCompanySent(qualifiedLead.company_name);
```

**Expected impact:** Eliminates duplicate company contacts. Reduces spam complaints by 30-50%.
**Implementation difficulty:** Easy — add a Redis set, check before send

### Fix 5: Add Email Verification Before Sending

**What:** Verify each email address exists before attempting to send.
**Why:** Every bounce damages your sender reputation. Verifying upfront prevents this.
**How:**
Options (choose one):
1. **API-based verification** (recommended): Use ZeroBounce, NeverBounce, or Hunter.io API. Cost: $0.003-0.008 per verification. For 200 leads, that is $0.60-1.60.
2. **Free SMTP verification**: Do an SMTP handshake check (RCPT TO) without actually sending. This is free but some servers block it.
3. **Bulk verification services**: Upload your entire lead list to a verification service. Most offer 100 free verifications.

Add verification during the scrape/qualify pipeline:
```javascript
// In qualify.js, add after basic email validation:
async function verifyEmailExists(email) {
  try {
    const response = await fetch(
      `https://api.zerobounce.net/v2/validate?api_key=${process.env.ZEROBOUNCE_API_KEY}&email=${email}`
    );
    const data = await response.json();
    return data.status === 'valid';
  } catch {
    return true; // Default to valid if API fails
  }
}
```

**Expected impact:** Reduces bounce rate from 8-15% to under 2%
**Implementation difficulty:** Easy — API integration, $1-2 per batch

### Fix 6: Filter Out Role-Based and Generic Email Addresses

**What:** Expand the SKIP_EMAIL_PATTERNS list and add it to the auto-send pipeline.
**Why:** info@, contact@, sales@, etc. have terrible deliverability and reply rates.
**How:**
Update `qualify.js` SKIP_EMAIL_PATTERNS:
```javascript
const SKIP_EMAIL_PATTERNS = [
  'noreply@', 'no-reply@', 'donotreply@',
  'postmaster@', 'mailer@', 'bounce@',
  'spam@', 'abuse@', 'security@',
  'webmaster@', 'hostmaster@', 'root@',
  'info@', 'contact@', 'sales@',
  'admin@', 'support@', 'hello@',
  'reservations@', 'marketing@', 'hr@',
  'careers@', 'jobs@', 'billing@',
  'accounts@', 'enquiries@', 'enquiry@',
  'reception@', 'office@', 'general@',
];
```

Also skip academic domains:
```javascript
const SKIP_DOMAINS = [
  ...existing,
  'ac.lk', 'edu.lk', 'gov.lk',
  'mrt.ac.lk', 'cmb.ac.lk', 'sjp.ac.lk',
  'pdn.ac.lk', 'ruh.ac.lk', 'jfn.ac.lk',
];
```

**Expected impact:** Higher quality sends, better engagement metrics
**Implementation difficulty:** Easy — config change

### Fix 7: Rewrite Email Templates (See Section 6)

**What:** Replace the current templated emails with shorter, more personalized variants.
**Why:** The current templates are too long, too formulaic, and trigger spam filters.
**Expected impact:** Open rates from 8-12% to 25-35%, reply rates from 0.5% to 3-5%
**Implementation difficulty:** Medium — requires template rewrite and testing

### Fix 8: Remove Tracking Pixel or Use a Proper Domain

**What:** Either remove the tracking pixel entirely or serve it from a dedicated, warmed-up domain.
**Why:** Tracking pixels from vercel.app subdomains are a spam signal.
**How:**
Option A (recommended for now): Remove the tracking pixel entirely. Focus on reply rate as your primary metric instead of open rate.
Option B: Set up a custom tracking domain (e.g., track.aviance.online) with proper SSL and DNS.

In `auto-send/route.js`, remove the tracking pixel line:
```javascript
// Remove this line:
const trackingPixel = `<img src="https://email-distributor.vercel.app/api/track/open?id=...`;
```

**Expected impact:** Small improvement in inbox placement
**Implementation difficulty:** Easy — remove one line of code

### Fix 9: Implement Proper Subject Line Rotation and Variation

**What:** Create fundamentally different subject line structures (not just swapping company names).
**Why:** Gmail detects patterns across emails from the same sender. If 75 emails all use "Thought for [X]" pattern, it flags the pattern.
**How:**
Create 10-15 genuinely different subject line templates with different structures:
```javascript
const SUBJECT_POOLS = [
  // Question-based
  (lead) => `${lead.first_name}, quick question about ${lead.industry}`,
  // Observation-based
  (lead) => `Noticed something about ${lead.company_name}'s workflow`,
  // Direct value prop
  (lead) => `Saving ${lead.industry} teams 10+ hours/week`,
  // Mutual connection pattern
  (lead) => `${lead.city} ${lead.industry} — thought of you`,
  // Curiosity-based
  (lead) => `${lead.company_name} and automation`,
];
```

Also add subject line uniqueness enforcement — do not send the same subject pattern more than 10 times per day across all accounts.

**Expected impact:** 5-10% improvement in open rates
**Implementation difficulty:** Medium

### Fix 10: Add Physical Address and Proper Unsubscribe

**What:** Add a physical business address to the email footer. Implement one-click unsubscribe via a URL.
**Why:** CAN-SPAM requires it. Gmail's 2024 bulk sender policy requires it. Without it, you risk legal issues and deliverability penalties.
**How:**
1. Add a physical address (even a registered virtual office address) to the email signature
2. Build an unsubscribe endpoint:
```javascript
// /api/unsubscribe/route.js
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const email = Buffer.from(searchParams.get('id') || '', 'base64').toString();
  if (email) {
    await addToSuppression(email);
  }
  return new Response('<html><body><h1>You have been unsubscribed.</h1></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
}
```
3. Update the List-Unsubscribe header:
```javascript
'List-Unsubscribe': `<https://yourdomain.com/api/unsubscribe?id=${Buffer.from(email).toString('base64')}>, <mailto:unsubscribe@yourdomain.com>`,
```

**Expected impact:** Legal compliance + small deliverability improvement
**Implementation difficulty:** Medium

---

## Section 6: Email Template Rewrites

### Template A: Short and Direct (3-4 sentences)

```
Subject: [first_name] — [specific observation about company]

Hi [first_name],

I saw that [company_name] [specific observation — e.g., "handles logistics across Southern Province" or "recently expanded your hotel operations"]. Companies in [industry] at your stage typically lose 10-15 hours/week to manual [specific task — dispatch coordination / document processing / appointment scheduling].

We build automation for [industry] companies in Sri Lanka — [one specific result, e.g., "one logistics firm cut their dispatch coordination time by 12 hours/week"].

Worth a quick look? I can send a 2-minute video showing how it would work for [company_name].

Limethsith
Aviance | aviance.online
071 870 2702
[physical address line]
Unsubscribe: [link]
```

**Why this works:**
- 67 words in the body (current template is 120+)
- References a specific observation (not "I came across your business")
- Includes a concrete number ("10-15 hours/week", "12 hours/week")
- CTA is low-friction (a 2-minute video, not a 15-minute call)
- No generic fallbacks possible — if data is missing, the email does not send

### Template B: Value-First with Specific Example

```
Subject: How [similar company] saved [X] hours/week on [task]

Hi [first_name],

A [industry] company similar to [company_name] was spending [X] hours/week on [specific pain point — e.g., "manually coordinating delivery drivers via WhatsApp"]. We automated their [specific workflow] and they got that time back within 3 weeks.

I put together a quick breakdown of how this could work for [company_name] based on what I saw on your site. Want me to send it over?

Limethsith
Aviance | aviance.online
071 870 2702
[physical address line]
Unsubscribe: [link]
```

**Why this works:**
- Leads with value/proof, not with "I came across your company"
- Specific and concrete (hours, timeframe, workflow name)
- CTA asks permission to send something useful, not for their time
- 72 words — scannable in under 15 seconds

### Template C: Question-Based Opener

```
Subject: Quick question, [first_name]

Hi [first_name],

How is [company_name] currently handling [specific operational task — e.g., "supplier follow-ups" / "patient appointment reminders" / "guest check-in coordination"]?

I ask because we have been working with [industry] companies in Sri Lanka on automating exactly that, and the results have been solid — [specific metric].

If it is something you have thought about, I am happy to share what we have seen work. If not, no worries at all.

Limethsith
Aviance | aviance.online
071 870 2702
[physical address line]
Unsubscribe: [link]
```

**Why this works:**
- Opens with a genuine question (triggers the "reply" instinct)
- Demonstrates knowledge of their operations without being presumptuous
- Very low-pressure CTA
- Short (68 words)
- "If not, no worries at all" reduces psychological resistance

### Important Notes on All Templates:

1. **Plain text only** — Do not use HTML formatting in cold emails. Send as plain text. This looks like a personal email, not a marketing blast.
2. **No tracking pixel** — Rely on reply rate as the metric, not open rate.
3. **Every variable must be filled** — If any variable (first_name, company_name, industry observation) is missing, do not send the email.
4. **Rotate templates** — Use each template for roughly 1/3 of sends. Track which template gets the most replies.

---

## Section 7: Lead Quality Improvements

### 7.1 Cleaning the Existing Lead List

Run the following cleanup immediately on all leads in KV:

1. **Remove leads with no company name** — Any lead where company_name is empty, null, or "your business"
2. **Remove role-based emails** — info@, contact@, sales@, admin@, support@, hello@, reservations@, enquiries@, office@, general@, reception@, marketing@, hr@, careers@, jobs@, billing@, accounts@
3. **Remove academic emails** — Any email containing .ac.lk, .edu, university domains
4. **Remove government emails** — Any email containing .gov.lk
5. **Verify remaining emails** — Run through ZeroBounce or NeverBounce ($1-2 for the batch)
6. **Deduplicate by company** — Keep only the highest-quality contact per company (prefer personal email with real name over generic)
7. **Fix name mismatches** — Cross-reference the name field with the email local part. If they do not match, clear the name field rather than using the wrong name.

### 7.2 What Data Points Matter

For each lead, you need at minimum:

| Field | Required? | Why |
|---|---|---|
| email | Required | Must be personal (not role-based), verified |
| first_name | Required | Without it, greeting is "Hi," which is impersonal |
| company_name | Required | Without it, the email is generic spam |
| industry | Required | Must be specific (not "business") |
| company_size | Strongly recommended | Determines relevance of your offer |
| job_title | Strongly recommended | Lets you tailor the pain point to their role |
| city | Recommended | Local reference builds trust |
| website | Recommended | Lets you make specific observations |
| linkedin_url | Nice to have | Lets you find accurate name/title |
| recent_news | Nice to have | Best personalization signal |

### 7.3 Avoiding Duplicate Company Sends

**Immediate fix:**
Add a company_sent Set in Redis (see Fix 4 above). Before sending to any lead, check if that company has already been contacted.

**Better approach:**
Implement "account-based" outreach:
1. Group leads by company (normalize names: remove "Pvt Ltd", "PLC", etc.)
2. For each company, select the BEST contact (decision-maker title > manager > generic)
3. Only send to that one person
4. If no reply after full sequence (Day 0 + Day 3 + Day 7), move to the next contact at that company after a 30-day cooling period

**Company name normalization function:**
```javascript
function normalizeCompanyName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s*(pvt\.?\s*ltd\.?|ltd\.?|plc|llc|inc\.?|co\.?\s*ltd\.?|private\s+limited|limited)\s*$/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

### 7.4 Better Lead Sources

The current scraper is pulling from yp.lk and bizdir.lk which yield low-quality data. Better sources for Sri Lankan B2B leads:

1. **LinkedIn Sales Navigator** — $79.99/month, but gives you verified contacts with titles, company size, and industry. This is the gold standard.
2. **Apollo.io** — Free tier gives 50 leads/month with email finding. Paid tier is $49/month for unlimited.
3. **Colombo Stock Exchange listed companies** — Public company directories with management contact info.
4. **Ceylon Chamber of Commerce** directory — Premium but high-quality B2B contacts.
5. **Industry-specific directories** — e.g., SLASSCOM for tech companies, Hotel Association of Sri Lanka for hospitality.
6. **Google Maps + Hunter.io** — Use Google Maps to find businesses, then Hunter.io to find the right person's email at that company.

---

## Section 8: Technical Fixes Needed

### 8.1 Code Changes for Deduplication

**File:** `src/app/api/cron/auto-send/route.js`

Add company-level dedup before the send loop:

```javascript
// At the top of the GET handler, after getting unsent leads:
const companySet = new Set();
const deduped = [];
for (const lead of unsent) {
  const companyKey = normalizeCompanyName(lead.company || lead.company_name);
  if (!companyKey || companySet.has(companyKey)) continue;

  // Also check if company was already sent to (from KV)
  const alreadySent = await kv.sismember('company_sent', companyKey);
  if (alreadySent) continue;

  companySet.add(companyKey);
  deduped.push(lead);
}
// Use deduped instead of unsent in the send loop
```

**File:** `src/lib/qualify.js`

Add name-email validation:
```javascript
function validateNameEmailMatch(name, email) {
  if (!name || !email) return false;
  const localPart = email.split('@')[0].toLowerCase();
  const firstName = name.split(/[\s,]/)[0].toLowerCase();
  // Check if name appears anywhere in the email local part
  return localPart.includes(firstName.substring(0, 4));
}
```

### 8.2 Subject Line Rotation System

Replace the current simple random selection with a tracked rotation:

```javascript
// In personalize.js, add:
const SUBJECT_STRUCTURES = [
  // Each structure is fundamentally different
  { type: 'question', generate: (lead) => `${lead.first_name}, quick question` },
  { type: 'observation', generate: (lead) => `Noticed something at ${lead.company_name}` },
  { type: 'value', generate: (lead) => `Saving ${lead.industry} teams time — ${lead.company_name}` },
  { type: 'direct', generate: (lead) => `${lead.company_name} + automation` },
  { type: 'local', generate: (lead) => `${lead.city} ${lead.industry} idea` },
];

// Track usage per day to ensure even distribution
async function getNextSubjectStructure(lead) {
  const todayKey = `subject_usage:${new Date().toISOString().split('T')[0]}`;
  const usage = await kv.hgetall(todayKey) || {};

  // Find least-used structure
  let minUsage = Infinity;
  let selected = SUBJECT_STRUCTURES[0];
  for (const structure of SUBJECT_STRUCTURES) {
    const count = parseInt(usage[structure.type] || '0');
    if (count < minUsage) {
      minUsage = count;
      selected = structure;
    }
  }

  await kv.hincrby(todayKey, selected.type, 1);
  await kv.expire(todayKey, 86400 * 2); // expire after 2 days
  return selected.generate(lead);
}
```

### 8.3 Send Timing Optimization

Current behavior: Random 3-15 second delay between sends, triggered by n8n hourly.

**Problems:**
- Sends can cluster within a short window (if n8n triggers frequently)
- No time-of-day optimization
- No day-of-week optimization

**Recommended schedule for Sri Lanka B2B:**
- **Best days:** Tuesday, Wednesday, Thursday (avoid Monday morning catch-up and Friday wind-down)
- **Best times:** 9:00-11:00 AM and 2:00-4:00 PM Sri Lanka Time (IST, UTC+5:30)
- **Avoid:** Before 8 AM, after 6 PM, weekends, Sri Lankan public holidays
- **Spacing:** Minimum 10-15 minutes between sends from the same account
- **Daily limit per account:** Start at 5/day, increase by 2/day per week, cap at 25/day (not 30)

Implementation:
```javascript
function isSendingWindow() {
  const now = new Date();
  // Convert to Sri Lanka time (UTC+5:30)
  const sriLankaOffset = 5.5 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const slMinutes = (utcMinutes + sriLankaOffset) % (24 * 60);
  const slHour = Math.floor(slMinutes / 60);
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat

  // Skip weekends
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  // Morning window: 9-11 AM
  if (slHour >= 9 && slHour < 11) return true;
  // Afternoon window: 14-16 (2-4 PM)
  if (slHour >= 14 && slHour < 16) return true;

  return false;
}
```

### 8.4 Warm-Up Schedule for New Accounts

Follow this exact ramp-up schedule for each account:

| Week | Warm-Up Emails/Day | Cold Emails/Day | Total/Day |
|---|---|---|---|
| Week 1-2 | 10-15 (via warm-up service) | 0 | 10-15 |
| Week 3 | 10-15 | 3 | 13-18 |
| Week 4 | 10-15 | 5 | 15-20 |
| Week 5 | 10 | 8 | 18 |
| Week 6 | 10 | 10 | 20 |
| Week 7 | 5 | 15 | 20 |
| Week 8+ | 5 (maintenance) | 20-25 | 25-30 |

**Key rules during warm-up:**
1. Continue warm-up indefinitely (at maintenance level) — do not stop once cold sending starts
2. Reply to all warm-up emails (the warm-up service handles this automatically)
3. If bounce rate exceeds 3% on any day, stop cold sending from that account for 48 hours
4. If any account gets a spam complaint, stop cold sending from that account for 1 week
5. Monitor Google Postmaster Tools for each domain (once you move to custom domains)

**Warm-up service recommendations:**
- **Instantly.ai** — $30/month per account, includes warm-up + sending platform
- **Lemwarm** — $29/month, standalone warm-up
- **Warmbox.ai** — $15/month per inbox, standalone warm-up
- **Mailreach** — $25/month per account

### 8.5 Additional Technical Recommendations

**Switch to plain text email:**
In `mailer.js`, send plain text only (no HTML wrapping):
```javascript
// Remove the wrapInHtmlTemplate function
// Send with text only, no html field:
const info = await transporter.sendMail({
  from: `"${senderName}" <${account.email}>`,
  to: mailOptions.to,
  subject: mailOptions.subject,
  text: mailOptions.text,  // Plain text only
  // Do NOT include 'html' field
  replyTo: mailOptions.replyTo || account.email,
  messageId,
  envelope: { from: account.email, to: mailOptions.to },
});
```

Plain text emails have 15-25% higher deliverability for cold outreach because they mimic real personal emails. HTML emails trigger Gmail's "promotions" tab classification.

**Add reply detection to auto-suppress:**
Currently, `reply-checker.js` exists but ensure it runs before each send batch to suppress leads who have already replied.

**Implement send rate tracking per account:**
Add monitoring to detect when an account is being throttled:
```javascript
// Track consecutive failures per account
async function trackAccountHealth(accountEmail, success) {
  const key = `account_health:${accountEmail}`;
  if (success) {
    await kv.hset(key, { consecutiveFailures: 0, lastSuccess: Date.now() });
  } else {
    const failures = await kv.hincrby(key, 'consecutiveFailures', 1);
    if (failures >= 3) {
      // Account likely throttled — pause for 24 hours
      await kv.hset(key, { pausedUntil: Date.now() + 86400000 });
    }
  }
}
```

---

## Summary: Implementation Roadmap

### Phase 1: Immediate (This Week) — Stop the Bleeding
1. Pause all cold sending
2. Remove "your business" fallback — skip leads without company names
3. Remove tracking pixel
4. Filter out role-based and generic emails
5. Add company-level deduplication
6. Clean existing lead list

### Phase 2: Foundation (Weeks 1-4) — Build Proper Infrastructure
1. Buy custom domain(s) and set up Google Workspace
2. Configure SPF, DKIM, DMARC
3. Sign up for email warm-up service
4. Begin warm-up on all accounts
5. Build proper unsubscribe endpoint with one-click URL
6. Add email verification API integration
7. Rewrite email templates (use Section 6 templates)

### Phase 3: Relaunch (Weeks 4-6) — Start Sending Again
1. Begin cold sending at 3-5 emails/day per account
2. Send only to verified, personal email addresses with complete data
3. Use plain text emails only
4. Implement send timing optimization (business hours, weekdays)
5. Track results per template, per subject line, per industry

### Phase 4: Optimize (Weeks 6+) — Scale What Works
1. Analyze reply rates by template, subject line, industry
2. Double down on what works, cut what does not
3. Gradually increase send volume (add 2/day per account per week)
4. Add new lead sources (LinkedIn, Apollo, industry directories)
5. Build a proper CRM integration for lead tracking

---

**Bottom line:** The current system is sending low-quality, poorly personalized, template-identical emails from new Gmail accounts to unverified addresses — this is the recipe for spam folder placement. The fixes above, implemented in order, will transform this from a spam cannon into a legitimate outreach system. The most impactful single change is stopping sends, warming up accounts, and only resuming with verified leads and properly personalized emails.
