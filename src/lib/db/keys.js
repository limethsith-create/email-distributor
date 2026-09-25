/**
 * Every Redis key the trial machine uses (SPEC §3). Nothing else in the app
 * may build a key string by hand: import from here, pass clientId first.
 *
 * clientId is a short slug (`acme-plumbing`). The owner's own outreach is
 * `aviance`; `_test` is Test Mode; `_helper` marks warm-up helper accounts.
 * The one deliberately global key a client can touch is `suppression:global`
 * (a STOP applies to every client).
 */

const SLUG_RE = /^(_test|_helper|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/;

export function assertClientId(id) {
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    throw new Error(`invalid clientId: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Turn a company name or domain into a clientId slug. */
export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.[a-z.]+(\/.*)?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

const e = (email) => String(email || '').trim().toLowerCase();
const c = (id) => `client:${assertClientId(id)}`;

export const K = {
  // ── Clients ──
  clients: () => 'clients',
  client: (id) => c(id),
  profile: (id) => `${c(id)}:profile`,
  trial: (id) => `${c(id)}:trial`,
  domain: (id) => `${c(id)}:domain`,
  config: (id) => `${c(id)}:config`,
  inboxes: (id) => `${c(id)}:inboxes`,
  inbox: (id, email) => `inbox:${assertClientId(id)}:${e(email)}`,
  shopping: (id) => `${c(id)}:shopping`,

  // ── Leads, replies, bookings ──
  leads: (id) => `${c(id)}:leads`,
  leadIndex: (id, status) => `${c(id)}:leads:index:${status}`,
  leadClaim: (id, email) => `lead:${assertClientId(id)}:${e(email)}:claim`,
  blocklist: (id) => `${c(id)}:blocklist`,
  replies: (id) => `${c(id)}:replies`,
  bookings: (id) => `${c(id)}:bookings`,

  // ── Counters and reports ──
  countersDay: (id, day) => `${c(id)}:counters:${day}`,
  countersTotal: (id) => `${c(id)}:counters:total`,
  sequence: (id) => `${c(id)}:sequence`,
  events: (id) => `${c(id)}:events`,
  promises: (id) => `${c(id)}:promises`,
  report: (id, name) => `${c(id)}:report:${name}`,
  token: (id, purpose) => `${c(id)}:token:${purpose}`,
  pacing: (id) => `pacing:${assertClientId(id)}`,

  // ── Global ──
  suppression: () => 'suppression:global',
  warmupPool: () => 'warmup:pool',
  warmupHelper: (email) => `warmup:helper:${e(email)}`,
  warmupPair: (day) => `warmup:pair:${day}`,
  usage: (service, month) => `usage:${service}:${month}`,
  heartbeat: () => 'system:heartbeat',
  alertsDay: (day) => `system:alerts:${day}`,
  alertLog: () => 'system:alerts:log',
  errors: (job, day) => `system:errors:${job}:${day}`,
  errorStreak: (job, scope) => `system:errstreak:${job}:${scope}`,
  globalConfig: () => 'system:config',
  eventsGlobal: () => 'events:global',
  learning: (niche) => `learning:${niche}`,
  queueTrial: () => 'queue:trial',
  jobClaim: (job, scope, period) => `jobs:claim:${job}:${scope}:${period}`,
  jobLast: (job, scope) => `jobs:last:${job}:${scope}`,
  session: (sid) => `session:${sid}`,
  migrations: () => 'system:migrations',

  // ── Stage A additions (intake) ── add new key builders only inside this block
  application: (id) => `${c(id)}:application`,
  market: (id) => `${c(id)}:market`,
  dmarcDays: (id) => `${c(id)}:dmarc`,
  mainDomainIndex: () => 'intake:maindomains',
  applyClaim: (domain) => `intake:applyclaim:${String(domain || '').toLowerCase()}`,
  applyRate: (ipHash, hour) => `intake:applyrate:${hour}:${ipHash}`,
  priceCache: () => 'intake:pricecache',
  promoFlags: () => 'intake:promoflags',
  dmarcSeen: () => 'intake:dmarc:seen',
  dmarcState: () => 'intake:dmarc:state',
  onceClaim: (what, id, key) => `intake:once:${what}:${assertClientId(id)}:${key}`,
  /** Applicant research (hash): status, at, summary, website/business/market/flags (JSON) + crawl progress. */
  research: (id) => `${c(id)}:research`,
  /** Registrar prices refreshed from keyless public APIs (hash): `{registrarId}` → {tld: {firstYear, renewal, confirmedAt}}. */
  registrarPrices: () => 'intake:registrarprices',
  /** RDAP availability cache (hash): domain → {available: true|false, at}. */
  rdapCache: () => 'intake:rdapcache',
  /** RDAP politeness: set (with EX) after a 429 so nobody asks again until it expires. */
  rdapBackoff: () => 'intake:rdapbackoff',
  // ── end Stage A ──

  // ── Stage B additions (build) ──
  /** Warm-up landings/sends per inbox (sender) per day: {sent, inbox, spam, rescued, replied, errors}. */
  warmupStats: (email, day) => `warmup:stats:${e(email)}:${day}`,
  warmupDayStats: (day) => `warmup:daystats:${day}`, // {email|sent, email|received} roll-up (integration)
  /** Message-ids of warm-up / canary mails already handled on a day (set). */
  warmupDone: (day) => `warmup:done:${day}`,
  /** Last warm-up IMAP read per pool member (hash member → ISO). */
  warmupReadAt: () => 'warmup:readat',
  /** Canary run for one client on one ET day (hash). */
  canary: (id, day) => `${c(id)}:canary:${day}`,
  /** Lead Finder state for one client (hash). */
  leadfinder: (id) => `${c(id)}:leadfinder`,
  /** The 20 sanity rows shown on the approval page (string, JSON). */
  sanityRows: (id) => `${c(id)}:sanity`,
  /** Approval page state (hash). */
  approval: (id) => `${c(id)}:approval`,
  /** Cross-client fairness: host → clientId for one niche + month (hash). */
  leadHosts: (niche, month) => `leadhosts:${String(niche || 'general').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}:${month}`,
  // Deliverability v2
  /** Warm-up pool at a glance, written by every warm-up send run (hash): pool, helpers, providers (JSON), todayPairs, at. */
  warmupSummary: () => 'warmup:summary',
  /** Placement results (list, newest first, capped 30): {at, day, tool: seed|mail-tester, inbox, score, inboxRate, detail[], reportUrl}. */
  placement: (id) => `${c(id)}:placement`,
  /** One day's spam-test run for a client (hash): phase, pending tests, results. */
  placementRun: (id, day) => `${c(id)}:placementrun:${day}`,
  /** Tests used today on a rate-limited tool, all clients together (string counter, INCR). */
  placementQuota: (tool, day) => `placement:quota:${String(tool || 'tool').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}:${day}`,
  // ── end Stage B ──

  // ── Stage C additions (run) ──
  /** Pace Check log (list, newest first): {at, day, test, fix, detail} — read by the Friday update. */
  pacelog: (id) => `${c(id)}:pacelog`,
  /** Settings the Pace Checks switched on (hash): compressed, earlySend, softInterested, narrowSlice, exclude. */
  pace: (id) => `${c(id)}:pace`,
  /** Sender / reply / booking run state (hash): smoke test, IMAP cursors, bounce-scan flags. */
  sendState: (id) => `${c(id)}:sendstate`,
  /** IMAP UID watermarks (hash): `{purpose}|{inbox}|{folder}` → {uidValidity, lastUid}. */
  imapState: (id) => `${c(id)}:imapstate`,
  /** Message-ID index (hash): normalised Message-ID → lead email (every mail we sent a prospect). */
  msgIndex: (id) => `${c(id)}:msgindex`,
  /** Per-inbox sends on one ET day (hash): `{inbox}`, `{inbox}:{touch}`, `{inbox}:bounces`. */
  inboxSends: (id, day) => `${c(id)}:inboxsends:${day}`,
  /** Hosts that already got a first touch (set) — companiesContacted. */
  sentHosts: (id) => `${c(id)}:senthosts`,
  /** Hot leads handed to the client (hash): replyId → {leadEmail, sentAt, nudgedAt, holdingAt, answeredAt, …}. */
  hot: (id) => `${c(id)}:hot`,
  /** Compliance Guard blocks on one ET day (string counter). */
  complianceDay: (id, day) => `${c(id)}:compliance:${day}`,
  /** Emergency Runner state (hash). */
  emergency: (id) => `${c(id)}:emergency`,
  /** Per-client learning counters (hash, flat fields) used by the Pace Checks. */
  learnStats: (id) => `${c(id)}:learnstats`,
  /** Learning Library raw counters per niche (hash, flat fields; aggregate only, survives deletion). */
  learningRaw: (niche) => `learning:${niche}:raw`,
  // Leads + Copy v2
  /** Lead quality rollup (hash): data (JSON, HUB-API `leadQuality` + sendableUnsent), builtAt. */
  leadQuality: (id) => `${c(id)}:leadquality`,
  /** Verification queue (sorted set): email, score = −(grade score) so the best leads are checked first. */
  verifyQueue: (id) => `${c(id)}:verifyq`,
  /** Domain facts from the verifiers (hash, global — technical facts, no personal data): host → {catchall, by, at}. */
  verifyDomains: () => 'verify:domains',
  // ── end Stage C ──

  // ── Stage D additions (report, close, Mission Control) ──
  reports: (id) => `${c(id)}:reports`, // set of report names rendered (friday:{date}, day20, day29, final, market, handover)
  invoice: (id) => `${c(id)}:invoice`, // Invoice Maker: month-one invoice
  paceLogRead: (id) => `${c(id)}:pacelog`, // Stage C's Pace Check log (list of {at, day, test, fix}); read-only here
  trialLedger: () => 'system:trials:ledger', // clientId -> outcome snapshot (no personal data); survives deletion for KPIs
  testSkipPings: () => 'system:test:skippings', // legacy: now system:heartbeat.skipPingsUntil
  pushSubs: () => 'push:subs', // owner's phones/browsers for Web Push alerts (endpoint hash → subscription)
  inquiries: () => 'inquiries', // plan inquiries from the website (id → record)
  inquiryOrder: () => 'inquiries:order', // ids, newest first
  applyRateInquiry: (ipHash, hour) => `inquiry:rate:${hour}:${ipHash}`,
  // ── end Stage D ──

  // ── Google Meet (docs/REPLYBOT-MEET.md §3) ──
  /**
   * The owner's Google connection (hash): clientIdEnc, clientSecretEnc, refreshTokenEnc
   * (ENC_KEY-encrypted, never returned by any API), account, scope, connectedAt, brokenAt,
   * brokenReason, updatedAt.
   */
  google: () => 'google:oauth',
  /** The current Google access token (string, encrypted, EX until about a minute before it expires). */
  googleAccess: () => 'google:access',
  /** A consent-screen `state` waiting for its callback (string, EX 10 min, one use; key = the state's SHA-256). */
  googleState: (hash) => `google:state:${hash}`,
  // ── end Google Meet ──

  // ── Onboarding call (docs/ONBOARD-CALL.md) ──
  /**
   * The acceptance email and the call it asks for (hash): sentAt, lastSentAt, subject,
   * fromInbox, messageIds (JSON, every Message-ID in the conversation), dueBy, openedAt,
   * firstReplyAt, lastReplyAt, lastOwnerReplyAt, bookedFor, bookedAt, bookedBy, bookingUid,
   * heldAt, noShowAt, stoppedAt, cancelledAt, remindersSent, overdueAt, tomorrowSentFor,
   * and from the Calendar: meetingId, requestedFor, requestedAt, firstRequestAt, proposedFor, theirZone.
   * The status is worked out from these times, never stored.
   */
  onboardCall: (id) => `${c(id)}:onboardcall`,
  /** The onboarding-call conversation (list, oldest first): {id, dir, at, from, to, subject, text, kind}. */
  onboardThread: (id) => `${c(id)}:onboardthread`,
  /** Last onboarding-call check (string ISO, with EX): one check per ONBOARDCALL.checkEveryMinutes across the job, the hub and Approve. */
  onboardCheck: () => 'onboardcall:checkedat',
  /** IMAP watermarks of the ONBOARDCALL inbox (hash): `{inbox}|{folder}` → {uidValidity, lastUid}. */
  onboardImap: () => 'onboardcall:imapstate',
  // ── end onboarding call ──

  // ── Calendar (docs/CALENDAR.md) ──
  /** Every meeting (hash): id → meeting JSON (times in UTC ISO). */
  meetings: () => 'meetings',
  /** Meetings by start time (sorted set): score = start ms, member = meeting id. */
  meetingsByStart: () => 'meetings:byStart',
  /** One writer at a time (string, NX + EX): a slot can never be given twice. */
  calendarLock: () => 'meetings:lock',
  /** Booking-page tries per link per hour (string counter, INCR + EX). */
  bookRate: (tokenHash, hour) => `meetings:rate:${hour}:${tokenHash}`,
  // ── end calendar ──
};

/**
 * Keys the pre-trial single-client engine still reads for clientId `aviance`.
 * The per-client Sender (SPEC §8.1, Phase 5) moves these under client:aviance:*;
 * until then they are the aviance client's live data and are listed here so
 * nothing else spells them out.
 */
export const LEGACY = {
  leads: 'leads',
  suppression: 'suppression',
  replies: 'replies_v3',
  sentLog: 'sent_log',
  stats: 'stats',
  dailySends: 'daily_sends',
  pacing: 'pacing',
  inboxEnabled: 'inbox_enabled',
  inboxCaps: 'inbox_caps',
  inboxHealth: 'inbox_health',
  lastGlobalSend: 'last_global_send',
};

/** Prefixes that belong to one client — what Wrap-up deletes (SPEC §3). */
export function clientKeyPatterns(id) {
  assertClientId(id);
  return [`client:${id}:*`, `inbox:${id}:*`, `pacing:${id}`, `lead:${id}:*`];
}
