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
  // ── end Stage A ──

  // ── Stage B additions (build) ──
  // ── end Stage B ──

  // ── Stage C additions (run) ──
  // ── end Stage C ──

  // ── Stage D additions (report, close, Mission Control) ──
  // ── end Stage D ──
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
