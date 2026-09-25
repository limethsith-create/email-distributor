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
    // Leads + Copy v2 (Stage C): risky / catch-all addresses are never sent in
    // sending days 1–7; from this sending day on they may be (null = never).
    allowRiskyAfterDay: null,
  },
  FRESH_MIN_SHARE: 0.4,
  FOLLOWUP_GRACE_DAYS: 7,
  BOUNCE: { max: 0.02 },
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
  // Leads + Copy v2 — verification waterfall (systems/verify.js). Free
  // allowances as published on 2026-09-25 (docs/research/v2-leads-copy.md);
  // daily ones first (they do not roll over), then monthly, then one-time
  // packs. A service with no key in the environment is skipped. null = no
  // limit of that kind (the service's own "out of credits" answer stops it).
  VERIFY: {
    order: ['quickemail', 'verifalia', 'reoon', 'mailboxvalidator', 'zerobounce', 'hunter', 'tomba', 'proofy'],
    services: {
      quickemail: { daily: 100, monthly: null },
      verifalia: { daily: 25, monthly: null },
      reoon: { daily: 20, monthly: 600 },
      mailboxvalidator: { daily: null, monthly: 300 },
      zerobounce: { daily: null, monthly: 100 },
      hunter: { daily: null, monthly: 100 },
      tomba: { daily: null, monthly: 50 },
      proofy: { daily: null, monthly: null },
      anymailfinder: { daily: null, monthly: null, total: 500 }, // catch-all resolver only (one-time credits)
    },
    catchallResolver: 'anymailfinder',
    perRun: 4,              // leads checked per run of the lead-verify job
    everyMin: 5,            // job cadence while leads wait
    timeoutMs: 15000,       // per API call
    catchallCacheDays: 30,  // a domain found catch-all is not re-checked for this long
    unknownRetryHours: 48,  // an "unknown" answer is retried once after this
    maxAttempts: 2,
    failAlertStreak: 3,     // errors in a row from one service → verify_failing
  },
  // Lead Grader (systems/grader.js): score ≥ A → A, ≥ B → B, else C.
  // findOvershoot: the Lead Finder collects need × this many contacts, because
  // some will fail verification or sit on catch-all domains (~30 % of B2B mail
  // servers are catch-all per Dropcontact — docs/research/v2-leads-copy.md).
  GRADE: { A: 70, B: 50, sendable: ['A', 'B'], sampleSize: 25, rollupEveryMin: 10, findOvershoot: 1.5 },
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
