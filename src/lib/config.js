/**
 * Every threshold the trial machine uses (SPEC §12). Systems read values
 * through `cfg(clientId, 'DOTTED.KEY')`; nothing hard-codes a number.
 *
 * Resolution order: client override (client:{id}:config) → global override
 * (system:config, edited in /mc/config) → the default below. Overrides are
 * stored as JSON strings per dotted key.
 *
 * Two limits are legal/safety ceilings, not preferences, and are clamped here
 * whatever an override says (SPEC §14.8): 25 cold + 15 warm-up per inbox/day.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

export const HARD_COLD_CAP = 25;
export const HARD_WARMUP_CAP = 15;

export const DEFAULTS = {
  MAX_ACTIVE_TRIALS: 3,
  MIN_MARKET: 1000,
  FIT: { employeesMin: 5, employeesMax: 50, dealValueMin: 2000, slotsPerWeekMin: 5 },
  ONBOARD: { reminderDays: [2, 4], closeDay: 7 },
  PURCHASE: { reminderHours: [12, 48] },
  ALLOWED_TLDS: ['com', 'net', 'co'],
  BANNED_TLDS: ['xyz', 'shop', 'info', 'top', 'club', 'site', 'online'],
  WARMUP: {
    minPool: 8,
    quota: { '1-3': 3, '4-7': 8, '8-14': 15, '15+': 8 },
    replyRate: 0.40,
    readyRate: 0.90,
    readyConsecutiveDays: 2,
    lowRate: 0.80,
    maxSlideDays: 7,
    // Deliverability v2: the aviance client's own inboxes join the circle
    // (more members = better network); after Day 1 warm-up stays at about a
    // third of the inbox's cold cap (owner's report), never under the 15+ row.
    includeAviance: true,
    sendingShare: 0.33,
  },
  LIST: { need: 400, refillBelow: 50, startMin: 200, sanitySample: 20, maxFail: 2 },
  PLACES: { monthlyEnterprise: 1000 },
  REOON: { dailyFree: 20 },
  COPY: { maxWords: 80 },
  SEQUENCE: { gaps: [0, 3, 4, 3], compressedGaps: [0, 3, 2, 3] },
  APPROVAL: { reminderDays: [-5, -3], silenceHours: 48 },
  CANARY: { gate: 0.85, warn: 0.85, emergency: 0.70 },
  RAMP: { caps: { '1-2': 8, '3-4': 12, '5-6': 16, '7+': 25 } },
  COLD_CAP: 25,
  SEND: {
    windowLeadTz: ['09:00', '17:00'],
    windowInboxEt: ['08:00', '19:00'],
    smokeTestSends: 50,
    smokeTestBounceMax: 0.03,
    trackOpens: false,
  },
  FRESH_MIN_SHARE: 0.4,
  FOLLOWUP_GRACE_DAYS: 7,
  BOUNCE: { max: 0.02, pause: 0.015 }, // pause (halve caps) at 1.5 %, stop (emergency) over 2 % — owner's rule
  REPLIES: { usHoursMinutes: 5, offHoursMinutes: 20 },
  HOT: { nudgeHours: 4, holdingHours: 24 },
  BOOK: { farSlotDays: 5, reminders: [24, 1], tapReminderHours: 24 },
  NOSHOW: { attempts: 2, emails: 3, windowDays: 14, highRate: 0.30 },
  DISPUTE: { windowBusinessHours: 24, autoUpholdHours: 48 },
  NOTNOW: { defaultDays: 60, quarterDays: 90, maxMoves: 1 },
  CLIENT: { quietWarnDays: 2, pauseDays: 5, endDays: 14 },
  PACE: { days: [3, 7, 12, 15, 20, 25], replyMin: 0.01, positiveMin: 0.01, bookedMin: 0.0025 },
  EMERGENCY: { noReplyDays: 2, placementMin: 0.70, dmarcMin: 0.80, greenDays: 3 },
  TRIAL: { buildDays: 14, reportDay: 29, decisionDay: 30, ladderDays: [33, 37, 44], retireDay: 45, bonusHours: 24 },
  EXTENSION_CAP: 60,
  DELETE: { afterEndDays: 30 },
  WINBACK: { days: 90 },
  PLANS: {
    starter: { price: 2497, calls: 10, reach: 2000 },
    growth: { price: 3997, calls: 20, reach: 4000 },
    scale: { price: 8497, calls: 50, reach: 10000 },
    perCallAfter: 150,
    payPerShow: 250,
  },
  BONUS: { starter: [12, 10], growth: [22, 20], scale: [55, 50] },
  CAPACITY: { starterMax: 3, growthMax: 7 },
  WATCHDOG: { sendStallMin: 30, hcGraceMin: 15, jobFailStreak: 3 },
  USAGE: { warn: 0.80, stop: 0.95 },
  // "to set" values (SPEC §12): null means not set yet. Anything that needs one
  // refuses to run and alerts rather than inventing it (rule 4).
  OWNER: {
    usHours: ['09:00', '17:00'],
    signerName: null,
    address: null,
    email: null,
    telegramChatId: null,
  },
  PAYMENT: { paypalMe: null, wiseDetails: null },
  // ── Stage A additions ── (new defaults only inside this block)
  INTAKE: {
    // Lead-gen / outbound / SDR agencies are not trial clients (trial doc §2).
    agencyKeywords: ['lead gen', 'lead-gen', 'leadgen', 'lead generation', 'outbound agency', 'outbound sales agency',
      'sdr agency', 'sdr as a service', 'sdr-as-a-service', 'sales development agency', 'appointment setting',
      'appointment setters', 'cold email agency', 'cold outreach agency', 'demand generation agency'],
    applyPerHourPerIp: 5,
    applyClaimSeconds: 600,
  },
  QUEUE: { expectedExtraDays: 16 },
  MARKET: { queriesMin: 3, queriesMax: 5, maxPerQuery: 60, pageSize: 20, coverageFactor: 3, overpassFactor: 1, retryHours: 1 },
  PRICE: {
    candidatePatterns: ['{b}-team', 'get{b}', '{b}hq', 'try{b}', '{b}-co', '{b}mail', 'hello-{b}', '{b}-us'],
    backups: 2,
    inboxesPerTrial: 2,
    autoBuyMarginUsd: 2,
  },
  // v1 tables, kept for reference only: since Intake v2 the shopping list reads
  // REGISTRARS and INBOX_PROVIDER (below, in this block). pricescout.registrarQuotes
  // / inboxQuotes still accept these shapes.
  // Registrar first-year .com prices. Porkbun is read live from its public
  // pricing API (static value below is only the fallback, marked unconfirmed);
  // Cloudflare sells at cost. Source: Inbox Provider Research, 10 Sep 2026
  // ("a .com renews at $10.44 (Cloudflare) to $10.99 (Porkbun)"). null = unknown,
  // never guessed — the owner fills it in /mc/config.
  registrars: {
    porkbun: { name: 'Porkbun', live: true, prices: { com: 10.99, net: null, co: null }, seenAt: '2026-09-10' },
    cloudflare: { name: 'Cloudflare', live: false, prices: { com: 10.44, net: null, co: null }, seenAt: '2026-09-10' },
    spaceship: { name: 'Spaceship', live: false, prices: { com: null, net: null, co: null }, seenAt: null },
  },
  // Promo Hunter table, edited by the owner: {registrar, tld, code, firstYearPrice, expiresAt: 'YYYY-MM-DD'}.
  promos: [],
  // Inbox providers (Inbox Provider Research, prices verified 10 Sep 2026, USD per inbox per month).
  // allowsAppPasswords null = not stated by the vendor → filtered out.
  inboxProviders: [
    { id: 'premiuminboxes', name: 'Premium Inboxes', url: 'https://premiuminboxes.com/pricing-page', pricePerMonth: 3.5, minOrder: null, allowsAppPasswords: true, rank: 1, seenAt: '2026-09-10' },
    { id: 'inboxkit', name: 'InboxKit', url: 'https://www.inboxkit.com/pricing', pricePerMonth: 3.5, minOrder: null, allowsAppPasswords: true, rank: 2, seenAt: '2026-09-10' },
    { id: 'cheapinboxes', name: 'CheapInboxes', url: 'https://www.cheapinboxes.com/', pricePerMonth: 3.5, minOrder: null, allowsAppPasswords: true, rank: 3, seenAt: '2026-09-10' },
    { id: 'zapmail', name: 'Zapmail', url: 'https://zapmail.ai/', pricePerMonth: 3.9, minOrder: 10, allowsAppPasswords: true, rank: 4, seenAt: '2026-09-10' },
    { id: 'coldinfra', name: 'ColdInfra', url: 'https://www.coldinfra.com/pricing', pricePerMonth: 3.0, minOrder: 10, allowsAppPasswords: null, rank: 5, seenAt: '2026-09-10' },
    { id: 'hypertide', name: 'Hypertide (Google)', url: 'https://www.hypertide.io/', pricePerMonth: 3.3, minOrder: null, allowsAppPasswords: null, rank: 6, seenAt: '2026-09-10' },
  ],
  SETUP: {
    loopbackWaitMin: 3,
    spfInclude: '_spf.google.com',
    dkimSelector: 'google',
    googleMx: ['aspmx.l.google.com', 'smtp.google.com'],
    dnsbl: ['bl.spamcop.net', 'b.barracudacentral.org', 'dnsbl.sorbs.net', 'spam.dnsbl.sorbs.net'],
    dnsTimeoutMs: 4000,
  },
  AUTH: { dmarcWarn: 0.95, dmarcPause: 0.80, dmarcCollector: null, dmarcMaxMessages: 25, dmarcLookbackDays: 8 },
  BOOKTEST: {
    day: -4,
    firstSlotMaxBusinessDays: 5,
    minSlots7d: 10,
    lengthMin: 15,
    lengthMax: 30,
    hosts: ['calendly.com', 'cal.com', 'calendar.google.com', 'calendar.app.google', 'tidycal.com', 'zoho.com', 'zohobookings.com', 'bookings.zoho.com'],
  },
  // ── Intake v2: Applicant Research (systems/research.js) ──
  RESEARCH: {
    userAgent: 'AvianceBot/1.0 (+aviance.online/bot)',
    pageTimeoutMs: 10_000,        // per page
    maxBytes: 1_000_000,          // per page; the rest is not read
    pages: ['home', 'about', 'services', 'team', 'contact', 'locations'],
    inRequestMs: 12_000,          // how long POST /api/apply waits for research before alerting the owner without it
    maxServices: 12,
    maxLocations: 10,
    maxPhones: 5,
    maxEmails: 5,
    placesPageSize: 3,            // Enterprise-SKU call; one per applicant
    marketQueries: 2,             // "{customers} in {city}", "{customers} in {state}" — IDs-only (free)
    newSiteDays: 365,             // domain registered less than this many days ago → "very new site"
    prefill: true,                // fill empty onboarding fields from research (company name, address, cities, customers)
  },
  // ── Intake v2: Domains (systems/domains.js) ──
  DOMAINS: {
    prefixes: ['get', 'try', 'use', 'hey', 'join', 'with'],
    suffixes: ['hq', 'team', 'mail', 'co', 'app', 'labs', 'group', 'usa'],
    maxLabel: 15,                 // letters before the TLD
    offersMin: 5,
    offersMax: 8,
    rdapBase: 'https://rdap.org/domain/',
    rdapConcurrency: 2,
    rdapBackoffSec: 120,          // after a 429 from rdap.org
    rdapCacheHours: { free: 12, taken: 168 },
    livePriceMaxAgeDays: 40,      // a live price older than this falls back to the table
    // How much each pattern reads like a real company's second address (score points).
    affixWeights: { get: 8, try: 6, use: 4, hey: 2, join: 3, with: 2, hq: 7, team: 6, mail: -2, co: 5, app: 1, labs: 1, group: 5, usa: 3 },
    spamWords: ['free', 'cash', 'win', 'winner', 'deal', 'deals', 'promo', 'offer', 'sale', 'cheap', 'bonus', 'click', 'money', 'loan', 'crypto', 'casino', 'bet', 'gift', 'prize', 'discount', 'bulk', 'spam', 'leads', 'outreach', 'mailer', 'blast'],
    bigBrands: ['google', 'gmail', 'microsoft', 'outlook', 'office365', 'apple', 'icloud', 'amazon', 'facebook', 'instagram', 'whatsapp', 'paypal', 'netflix', 'yahoo', 'linkedin', 'twitter', 'tiktok', 'youtube', 'adobe', 'oracle', 'salesforce', 'hubspot', 'shopify', 'stripe', 'airbnb', 'walmart', 'costco', 'disney', 'mastercard', 'wellsfargo', 'citibank', 'verizon', 'tmobile', 'comcast', 'xfinity', 'cisco', 'samsung', 'tesla', 'fedex', 'docusign', 'dropbox', 'intuit', 'quickbooks', 'godaddy'],
    // Table prices older than this are listed as unconfirmed on the shopping list.
    // (Verisign's .com wholesale rises from $10.26 to $10.97 on 1 Nov 2026, so the
    // .com rows below go up by about $0.71 then — re-check and edit in /mc/config.)
    tableMaxAgeDays: 35,
  },
  // The five registrars compared on every shopping list (docs/research/v2-domains.md,
  // every price from the registrar's own page on 25 Sep 2026 unless `source` says
  // otherwise; USD incl. the $0.20 ICANN fee). Chosen: the five reputable
  // registrars with the lowest .com first-year + renewal. `promo` is shown, never
  // used for `best` (codes change without notice). Porkbun is refreshed live from
  // its keyless pricing API (job `registrar-prices`); the others are this table.
  // `search` pre-fills the name: {domain}. Every entry has the same keys (the
  // /mc/config editor checks each entry against the first one).
  REGISTRARS: [
    {
      id: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflare.com/products/registrar/',
      search: 'https://domains.cloudflare.com/?domain={domain}',
      prices: { com: { firstYear: 10.46, renewal: 10.46 }, net: { firstYear: 11.86, renewal: 11.86 }, co: { firstYear: 30.00, renewal: 30.00 } },
      promo: { com: null, net: null, co: null },
      whoisPrivacy: true, autoRenewOff: true, liveApi: null, checkedAt: '2026-09-25',
      source: '.com = wholesale $10.26 + $0.20 ICANN fee; .net/.co from cfdomainpricing.com (Cloudflare shows its list only when signed in)',
      why: 'Sells at cost, no mark-up at renewal. The domain must use Cloudflare DNS — fine for Google Workspace and for CheapInboxes.',
    },
    {
      id: 'spaceship', name: 'Spaceship', url: 'https://www.spaceship.com/domain-search/?tab=pricing',
      search: 'https://www.spaceship.com/domain-search/?query={domain}&tab=domains',
      prices: { com: { firstYear: 9.08, renewal: 10.18 }, net: { firstYear: 11.40, renewal: 11.40 }, co: { firstYear: 15.53, renewal: 31.05 } },
      promo: { com: { code: 'COM67', firstYear: 3.80, note: 'limited time, no end date shown' }, net: null, co: null },
      whoisPrivacy: true, autoRenewOff: true, liveApi: null, checkedAt: '2026-09-25',
      source: 'registrar pricing page',
      why: 'Lowest .com list price and renewal; free WHOIS privacy. Some reports of new accounts held for an ID check.',
    },
    {
      id: 'dynadot', name: 'Dynadot', url: 'https://www.dynadot.com/domain/prices',
      search: 'https://www.dynadot.com/domain/search?domain={domain}',
      prices: { com: { firstYear: 10.88, renewal: 10.88 }, net: { firstYear: 12.52, renewal: 12.52 }, co: { firstYear: 4.99, renewal: 31.20 } },
      promo: { com: { code: '899COM', firstYear: 8.99, note: 'limited quantity; help page dated 29 May 2026, not re-checked' }, net: null, co: null },
      whoisPrivacy: true, autoRenewOff: true, liveApi: null, checkedAt: '2026-09-25',
      source: 'registrar pricing page',
      why: 'Same price to renew, nothing added at checkout, free privacy; cheapest .co first year.',
    },
    {
      id: 'porkbun', name: 'Porkbun', url: 'https://porkbun.com/products/domains',
      search: 'https://porkbun.com/checkout/search?q={domain}',
      prices: { com: { firstYear: 11.08, renewal: 11.08 }, net: { firstYear: 12.52, renewal: 12.52 }, co: { firstYear: 15.76, renewal: 31.20 } },
      promo: { com: null, net: null, co: null },
      whoisPrivacy: true, autoRenewOff: true, liveApi: 'porkbun', checkedAt: '2026-09-25',
      source: 'keyless pricing API api.porkbun.com/api/json/v3/pricing/get',
      why: 'Same price to renew, strong reputation, and the only registrar with a keyless price API (refreshed live).',
    },
    {
      id: 'namecheap', name: 'Namecheap', url: 'https://www.namecheap.com/domains/',
      search: 'https://www.namecheap.com/domains/registration/results/?domain={domain}',
      prices: { com: { firstYear: 11.48, renewal: 18.68 }, net: { firstYear: 12.68, renewal: 18.78 }, co: { firstYear: 19.98, renewal: 45.48 } },
      promo: { com: { code: 'NEWCOM679', firstYear: 6.99, note: 'first order of a new customer only' }, net: null, co: null },
      whoisPrivacy: true, autoRenewOff: true, liveApi: null, checkedAt: '2026-09-25',
      source: 'registrar pricing page (.com sale price $11.28 + $0.20 ICANN fee)',
      why: 'Well-known and reliable; renewal is dear ($18.68) but auto-renew is off anyway.',
    },
  ],
  // Inboxes are bought at CheapInboxes only (owner's decision, 25 Sep 2026). Prices and
  // facts: cheapinboxes.com, /terms, /fulfillment, api.cheapinboxes.com/docs (checked
  // 25 Sep 2026, docs/research/v2-domains.md). The tier is set by the account's total
  // active mailboxes. The other providers stay in `inboxProviders` for reference only.
  INBOX_PROVIDER: {
    id: 'cheapinboxes', name: 'CheapInboxes', url: 'https://www.cheapinboxes.com/', orderUrl: 'https://app.cheapinboxes.com/add',
    // USD per inbox per month from `from` active mailboxes on the account upward.
    tiers: [{ from: 1, price: 3.50 }, { from: 100, price: 3.25 }, { from: 250, price: 3.00 }, { from: 1000, price: 2.80 }],
    count: 2,
    setupFee: 0,
    api: true,          // public REST API (70+ endpoints, key from the dashboard) — not used yet
    freeWarmup: false,  // they sell no warm-up; our Warm-up Engine warms the inboxes
    checkedAt: '2026-09-25',
    notes: 'Google Workspace Business Starter with admin access, month-to-month (card charged 5 days before renewal, cancel with 7 days\' notice), no setup fee. Public API: yes (not used yet). Warm-up: none included — our Warm-up Engine does it. App passwords appear in their API\'s credential output but the site does not promise them: ask support (WhatsApp) to confirm before the first order.',
    steps: [
      'Keep {domain} on Cloudflare DNS: bought at Cloudflare it already is; bought elsewhere, add it to your free Cloudflare account and switch the nameservers at the registrar. DNS stays in your hands for the setup checks.',
      'Sign in at https://app.cheapinboxes.com (first time: create the account and add a card).',
      'New order (https://app.cheapinboxes.com/add): import your own domain {domain} (free) and choose Google Workspace.',
      'DNS: pick the Cloudflare option and paste a Cloudflare API token limited to {domain} (Zone Read + DNS Edit). CheapInboxes adds MX, SPF, DKIM and DMARC. This choice cannot be changed later.',
      'Add {count} users: {users}. Skip the sequencer connection.',
      'If offered, forward the website {domain} to {mainDomain}.',
      'Pay {count} × {perInbox} = {monthly} a month (no setup fee).',
      'When the inboxes show Active (10 minutes to 48 hours), copy each app password (16 letters). None shown: sign in as the user, turn on 2-Step Verification and create one at https://myaccount.google.com/apppasswords.',
      'Paste {domain}, both inboxes and their app passwords below, tick "auto-renew is OFF" and save — the setup checks start at once.',
    ],
  },
  // ── end Stage A ──
  // ── Stage B additions ──
  BUILD: {
    // Warm-up Engine
    warmupHours: ['07:00', '22:00'],   // in the sending inbox's tz
    warmupPairsPerTick: 5,             // 5 pairs every 20 min = 225/day of capacity (Redis budget, integration.md)
    warmupEveryMin: 20,
    warmupFlagRate: 0.30,
    warmupReadEveryMin: 30,            // each pool mailbox is read at most this often
    warmupReadPerRun: 6,               // IMAP mailboxes per run (IMAP is slow; the run stops at the tick deadline)
    warmupReadRunEveryMin: 15,         // the warmup-read job's cadence
    warmupReadHours: ['06:00', '23:30'], // ET; warm-up mail only goes out 07:00–22:00 sender time
    warmupLookbackHours: 48,
    warmupReadyMinDays: 14,
    warmupHelperQuota: 8,              // helpers send like a 15+ day inbox
    warmupReceiveCap: 30,              // max warm-up mails one member receives per day
    warmupErrorAlert: 3,               // SMTP errors for one inbox in a day → alert
    // Canary
    canaryAt: '07:30',
    canaryHelpers: 10,
    canaryCheckAfterMin: 15,
    canarySendsPerRun: 4,
    canaryChecksPerRun: 2,
    canaryGiveUpMin: 180,
    canaryGateDay: -3,
    // Ramp Planner
    rampAt: '00:05',
    // Lead Finder
    refillAt: '02:00',
    refillMinHoursBetween: 20,
    refillNeed: 100,                   // contacts asked for by one refill run
    placesStopRatio: 0.80,             // Lead Finder stops at 80 % of the monthly Places budget
    repo: 'limethsith-create/email-distributor',
    // Approval page
    approvalLinkDay: -7,
    approvalMaxRounds: 2,
    // Readiness (warming → ready)
    readinessAt: '00:30',              // hourly from here (after the 23:45 warm-up check), so Day 1 can start at 09:00
    day1SendHour: '09:00',
  },
  // Deliverability v2 (docs/research/v2-deliverability.md)
  WARMUP_V2: {
    avianceAlone: false,               // keep the circle running for the aviance inboxes when no trial is warming (Redis cost)
    maxThreadDepth: 4,                 // replies in one warm-up thread before it ends
    deeperReplyShare: 0.6,             // later replies happen at replyRate × this
    quoteReplies: true,                // replies quote the mail they answer, like a mail client
    minFamilies: 3,                    // /mc/warmup warns when the circle has fewer mail-filter families
  },
  // An external warm-up network the owner runs by hand (none connects
  // automatically in 2026). name null = none. perDay = what it sends per trial
  // inbox per day; the circle sends that much less (the 15/day ceiling holds).
  EXTERNAL_WARMUP: { name: null, url: null, perDay: 0 },
  PLACEMENT: {
    // 'auto': mail-tester when MAILTESTER_USERNAME is set (the owner's account,
    // one-time credits, official JSON API) or mailTesterFree is on; else
    // dkimvalidator (free, no account). 'mail-tester' / 'dkimvalidator' force one.
    tool: 'auto',
    mailTesterFree: false,             // mail-tester's 3 free tests / 24 h with self-made ids — its FAQ puts JSON on paid plans, so off unless the owner accepts that
    gate: true,                        // Day 1 needs a passing spam test on every inbox
    minScore: 8,                       // mail-tester mark out of 10
    maxSpamAssassin: 2.0,              // dkimvalidator: SpamAssassin points (5 = spam); mail-tester's 8/10 ≈ 2 points off
    dailyLimit: { 'mail-tester': 3, dkimvalidator: 20 },   // tests per day, all clients together
    daysBeforeDay1: 3,                 // first test on Day −3 (the gate), retried daily until it passes
    everyDays: 7,                      // then Day 1 and every 7 days while sending
    at: '08:00',                       // ET, daily start
    checkAfterMin: 4,                  // wait before fetching the result
    giveUpMin: 120,                    // no result by then → failed test, retried next day
    maxAgeDays: 10,                    // an older result does not count for the gate
    sendsPerRun: 2,
    checksPerRun: 2,
  },
  BLACKLISTS: {
    // One shape per zone (so /mc/config can validate edits). Answer 127.0.0.X:
    // bitmask lists (listedBits/warnBits > 0) test X & bits; others use the
    // X ranges listedFrom–listedTo and warnFrom–warnTo (0–0 = none). `errors`
    // = X values meaning "refused". `test` must answer listed and `control`
    // must not, every run, or the zone gives no verdict (IP lists: reversed
    // labels, 2.0.0.127 = 127.0.0.2).
    // Domain (URI) lists: a hit here is "listed".
    domainZones: [
      { zone: 'multi.uribl.com', name: 'URIBL', listedBits: 2, warnBits: 12, listedFrom: 0, listedTo: 0, warnFrom: 0, warnTo: 0, errors: [1], test: 'test.uribl.com', control: 'example.com', warnOnly: false },
      { zone: 'multi.surbl.org', name: 'SURBL', listedBits: 216, warnBits: 0, listedFrom: 0, listedTo: 0, warnFrom: 0, warnTo: 0, errors: [1], test: 'test.surbl.org', control: 'example.com', warnOnly: false },
      { zone: 'dbl.nordspam.com', name: 'NordSpam DBL', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 2, warnFrom: 0, warnTo: 0, errors: [1], test: 'test', control: 'example.com', warnOnly: false },
    ],
    // IP lists, asked for the A record and MX IPs (not our sending IPs → warnings by default).
    ipZones: [
      { zone: 'bl.spamcop.net', name: 'SpamCop', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 99, warnFrom: 0, warnTo: 0, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: false },
      { zone: 'psbl.surriel.com', name: 'PSBL', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 99, warnFrom: 0, warnTo: 0, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: false },
      { zone: 'bl.mailspike.net', name: 'Mailspike', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 2, warnFrom: 10, warnTo: 12, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: false },
      { zone: 'bl.0spam.org', name: '0spam', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 99, warnFrom: 0, warnTo: 0, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: false },
      { zone: 'all.s5h.net', name: 's5h', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 99, warnFrom: 0, warnTo: 0, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: false },
      { zone: 'bl.nordspam.com', name: 'NordSpam', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 2, warnFrom: 0, warnTo: 0, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: false },
      { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT L1', listedBits: 0, warnBits: 0, listedFrom: 2, listedTo: 99, warnFrom: 0, warnTo: 0, errors: [1], test: '2.0.0.127', control: '1.0.0.127', warnOnly: true },
    ],
    ipAction: 'warn',                  // 'block' = an IP-list hit counts as listed
    timeoutMs: 4000,
    mxHosts: 2,
  },
  // ── end Stage B ──
  // ── Stage C additions ──
  PACING: { minGapMin: 10, maxGapMin: 60 },
  SMOKE: { rescanHours: 2 },
  OOO: { defaultHoldDays: 7 },
  COMPLIANCE: { alertBlocksPerDay: 3 },
  NOSHOW_EMAIL_DAYS: [0, 3, 7],
  EMERGENCY_C: { burnedCanary: 0.50, maxWindowDays: 7, verifyPerTick: 25 },
  LEARNING: { minSends: 20 },
  REPLIES_C: { maxMessagesPerRun: 30, firstScanDays: 7 },
  // ── end Stage C ──
  // ── Stage D additions ──
  REVIEW: { clutchUrl: null }, // "to set": review requests block + config_missing until filled
  FRIDAY: { maxWords: 120, personalUpdates: 4, trialWeeks: 4 },
  DIAGNOSIS: { bounceMax: 0.02, placementMin: 0.85, replyMin: 0.015, positiveMin: 0.01, bookedShareMin: 0.5 },
  TARGET: { promise: 1, target: 3 },
  INVOICE: { reminderDays: [3, 7] },
  PLAN_SHOPPING: { starter: { domains: 13, inboxes: 26 }, growth: null, scale: null },
  KPI: { bookedShare: 0.7, reviewShare: 0.7, paidShare: 0.3, maxExtensions: 1, hoursPerTrial: 9 },
  DIGEST: { morningAt: '08:00', mondayAt: '08:00' },
  DAYJOBS: { at: '09:00', stopRetireDays: 7 },
  TESTMODE: { clockScale: 24 },
  WINBACK_TEXT: { whatsNew: null }, // "to set": what's new since they left (Offboarding SOP [X])
  // ── end Stage D ──
  // US federal holidays, observed dates. Update once a year (one line per year).
  US_HOLIDAYS: [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03',
    '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05',
    '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24',
  ],
};

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function parse(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function clamp(key, value) {
  if (key === 'COLD_CAP') return Math.min(HARD_COLD_CAP, Math.max(0, Number(value) || 0));
  if (key === 'RAMP.caps' && value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = Math.min(HARD_COLD_CAP, Math.max(0, Number(v) || 0));
    return out;
  }
  if (key === 'WARMUP.quota' && value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = Math.min(HARD_WARMUP_CAP, Math.max(0, Number(v) || 0));
    return out;
  }
  return value;
}

/** Default value for a dotted key (no overrides). */
export function defaultOf(key) {
  return getPath(DEFAULTS, key);
}

// ── Tick-scoped config snapshot ─────────────────────────────────────────────
// Inside a tick (withConfigSnapshot) every cfg() reads one copy of the global
// override hash, loaded once, and a client's own override hash only when that
// client has one (listed in the global hash's `__clients` field). Outside a
// tick (pages, API routes) cfg() reads Redis as before. Upstash free tier is
// 500k commands/month; a per-call read cost ~2 commands per cfg() call.
const CLIENTS_FIELD = '__clients';
const snapshotStore = new AsyncLocalStorage();
// A warm serverless instance reuses the global override hash for up to
// CFG_MEMO_MS (default 60 s) across ticks; an edit in /mc/config applies
// within a minute. setOverride() on this instance clears it at once.
let globalMemo = null;
const memoMs = () => { const v = Number(process.env.CFG_MEMO_MS); return Number.isFinite(v) ? v : 60_000; };
export function clearConfigMemo() { globalMemo = null; }

export function withConfigSnapshot(fn) {
  return snapshotStore.run({ global: null, clients: new Map() }, fn);
}

async function snapshotValue(snap, clientId, key) {
  if (!snap.global) {
    if (globalMemo && globalMemo.exp > Date.now()) snap.global = globalMemo.value;
    else {
      try { snap.global = (await kv.hgetall(K.globalConfig())) || {}; } catch { snap.global = {}; }
      if (memoMs() > 0) globalMemo = { value: snap.global, exp: Date.now() + memoMs() };
    }
  }
  if (clientId) {
    let listed = [];
    try { listed = parse(snap.global[CLIENTS_FIELD]) || []; } catch {}
    if (Array.isArray(listed) && listed.includes(clientId)) {
      if (!snap.clients.has(clientId)) {
        let h = {};
        try { h = (await kv.hgetall(K.config(clientId))) || {}; } catch {}
        snap.clients.set(clientId, h);
      }
      const v = parse(snap.clients.get(clientId)[key]);
      if (v !== undefined) return v;
    }
  }
  return parse(snap.global[key]);
}

/**
 * Resolve one setting. `clientId` may be null for global-only lookups.
 * Never throws: a KV failure falls back to the default.
 */
export async function cfg(clientId, key) {
  let value;
  const snap = snapshotStore.getStore();
  try {
    if (snap) value = await snapshotValue(snap, clientId, key);
    else {
      if (clientId) value = parse(await kv.hget(K.config(clientId), key));
      if (value === undefined) value = parse(await kv.hget(K.globalConfig(), key));
    }
  } catch {
    value = undefined;
  }
  if (value === undefined) value = defaultOf(key);
  return clamp(key, value);
}

/** Every global override currently set (for /mc/config and drift reporting). */
export async function globalOverrides() {
  try {
    const raw = (await kv.hgetall(K.globalConfig())) || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (k !== CLIENTS_FIELD) out[k] = parse(v);
    return out;
  } catch {
    return {};
  }
}

/** Set (or with `value === undefined`, clear) an override. */
export async function setOverride(clientId, key, value) {
  if (defaultOf(key) === undefined) throw new Error(`unknown config key: ${key}`);
  clearConfigMemo();
  const hash = clientId ? K.config(clientId) : K.globalConfig();
  if (clientId) {
    // Keep the list of clients that have overrides (read by the tick snapshot).
    let listed = [];
    try { listed = parse(await kv.hget(K.globalConfig(), CLIENTS_FIELD)) || []; } catch {}
    if (!Array.isArray(listed)) listed = [];
    if (!listed.includes(clientId)) await kv.hset(K.globalConfig(), { [CLIENTS_FIELD]: JSON.stringify([...listed, clientId]) });
  }
  if (value === undefined) return kv.hdel(hash, key);
  return kv.hset(hash, { [key]: JSON.stringify(clamp(key, value)) });
}

export function isUsHoliday(dayKey) {
  return DEFAULTS.US_HOLIDAYS.includes(dayKey);
}
