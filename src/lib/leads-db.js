/**
 * Lead Database — Vercel KV (Upstash Redis) for persistent storage.
 * All leads, sent emails, replies and stats persist across requests.
 *
 * Keys
 *   leads          Hash  email -> lead object
 *   sent_log       List  newest-first send log entries (capped)
 *   stats          Hash  running counters (informational; readers derive the
 *                        real numbers from lead records)
 *   suppression    Set   opted-out / bounced addresses, never mailed again
 *   replies_v3     Hash  leadEmail:messageId -> reply record
 *   company_sent   Set   normalised company names already contacted
 */

import { kv } from '@vercel/kv';
import {
  normalizeEmail, isValidEmail, normalizeCompanyName, campaignOf, isSendable,
  isReal, isSent, isTrackable, isOpened, isReplied, touchesOf, pct, mergeOpens,
  UNSENT_STATUSES,
} from '@/lib/metrics';

const LEADS_KEY = 'leads';
const SENT_LOG_KEY = 'sent_log';
const STATS_KEY = 'stats';
const SUPPRESSION_KEY = 'suppression';
const REPLIES_KEY = 'replies_v3';
const COMPANY_SENT_KEY = 'company_sent';
const OPENS_KEY = 'email_opens';

const SENT_LOG_MAX = 5000;
const CHUNK = 400;

function chunk(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Lead CRUD ───

export async function getAllLeads() {
  try {
    const leads = await kv.hgetall(LEADS_KEY);
    if (!leads) return [];
    return Object.values(leads).filter((l) => l && typeof l === 'object');
  } catch {
    return [];
  }
}

/** The raw email -> lead map (one command); callers that need both shapes use this. */
export async function getLeadsMap() {
  try {
    const map = await kv.hgetall(LEADS_KEY);
    if (!map) return {};
    for (const k of Object.keys(map)) {
      if (!map[k] || typeof map[k] !== 'object') delete map[k];
    }
    return map;
  } catch {
    return {};
  }
}

export async function getLead(email) {
  try {
    const lead = await kv.hget(LEADS_KEY, normalizeEmail(email));
    return lead && typeof lead === 'object' ? lead : null;
  } catch {
    return null;
  }
}

/** Fetch several leads in one round trip: returns { email: lead|null }. */
export async function getLeadsByEmail(emails) {
  const keys = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  const out = {};
  if (!keys.length) return out;
  for (const part of chunk(keys)) {
    try {
      const res = await kv.hmget(LEADS_KEY, ...part);
      for (const k of part) out[k] = (res && res[k] && typeof res[k] === 'object') ? res[k] : null;
    } catch {
      for (const k of part) out[k] = null;
    }
  }
  return out;
}

export async function upsertLead(lead) {
  const email = normalizeEmail(lead.email);
  const existing = await getLead(email);
  const updated = { ...existing, ...lead, email, updatedAt: new Date().toISOString() };
  await kv.hset(LEADS_KEY, { [email]: updated });
  return updated;
}

/**
 * Patch a lead: re-reads the record immediately before writing so a stale
 * snapshot from earlier in a run can never clobber fields another process
 * (pixel, reply scanner, sender) wrote in the meantime. `fields` may be an
 * object or a function(existing) -> object|null (null = skip the write).
 * Returns the stored record, or null when the lead does not exist.
 */
export async function patchLead(email, fields) {
  const key = normalizeEmail(email);
  if (!key) return null;
  const existing = await getLead(key);
  if (!existing) return null;
  const patch = typeof fields === 'function' ? fields(existing) : fields;
  if (!patch) return existing;
  const updated = { ...existing, ...patch, email: key, updatedAt: new Date().toISOString() };
  await kv.hset(LEADS_KEY, { [key]: updated });
  return updated;
}

/** Build one canonical lead record from any import shape. */
export function newLeadRecord(input, source = 'manual') {
  const email = normalizeEmail(input.email);
  const company = String(input.company_name || input.company || '').trim();
  const name = String(input.name || input.full_name || '').trim();
  const firstName = String(input.first_name || (name ? name.split(/[\s,]+/)[0] : '')).trim();
  const status = UNSENT_STATUSES.has(String(input.status || '').toLowerCase()) ? String(input.status || 'pending').toLowerCase() || 'pending' : 'pending';
  const record = {
    ...input,
    email,
    company_name: company || undefined,
    company: company || undefined,
    name: name || undefined,
    first_name: firstName || undefined,
    industry: String(input.industry || '').trim() || undefined,
    city: String(input.city || '').trim() || undefined,
    country: String(input.country || '').trim() || undefined,
    website: String(input.website || input.domain || '').trim() || undefined,
    campaign: String(input.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer',
    status,
    source: input.source || source,
    send_count: 0,
    sequence_day: -1,
    createdAt: input.createdAt || new Date().toISOString(),
  };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  return record;
}

/**
 * Insert many leads. Dedupes against the store and the suppression set with
 * two batched reads, then writes in pipelined chunks — O(1) round trips per
 * 400 leads instead of three commands per lead.
 */
export async function bulkUpsertLeads(leads, options = {}) {
  const source = options.source || 'manual';
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  const seen = new Set();
  const candidates = [];
  for (const raw of leads || []) {
    if (!raw || !isValidEmail(raw.email)) { invalid++; continue; }
    const email = normalizeEmail(raw.email);
    if (seen.has(email)) { skipped++; continue; }
    seen.add(email);
    candidates.push(newLeadRecord({ ...raw, email }, raw.source || source));
  }
  if (!candidates.length) return { added, skipped, invalid, total: added + skipped + invalid };

  const emails = candidates.map((c) => c.email);
  const existing = await getLeadsByEmail(emails);
  let suppressed = new Set();
  try {
    const flags = [];
    for (const part of chunk(emails)) {
      const res = await kv.smismember(SUPPRESSION_KEY, part);
      flags.push(...(res || []));
    }
    suppressed = new Set(emails.filter((_, i) => flags[i] === 1 || flags[i] === true));
  } catch {}

  const toInsert = candidates.filter((c) => {
    if (existing[c.email] || suppressed.has(c.email)) { skipped++; return false; }
    return true;
  });

  for (const part of chunk(toInsert)) {
    const obj = {};
    for (const rec of part) obj[rec.email] = rec;
    await kv.hset(LEADS_KEY, obj);
    added += part.length;
  }
  if (added) { try { await kv.hincrby(STATS_KEY, 'totalScraped', added); } catch {} }
  return { added, skipped, invalid, total: added + skipped + invalid };
}

// ─── Suppression / bounces ───

export async function isSuppressed(email) {
  try { return (await kv.sismember(SUPPRESSION_KEY, normalizeEmail(email))) === 1; } catch { return false; }
}

/**
 * Never email this address again. `options.status` = false keeps the lead's
 * current status (e.g. a "not interested" reply stays 'replied' but is still
 * suppressed from every future import and send).
 */
export async function addToSuppression(email, reason = 'unsubscribed', options = {}) {
  const emailLower = normalizeEmail(email);
  await kv.sadd(SUPPRESSION_KEY, emailLower);
  const existing = await getLead(emailLower);
  if (!existing) return null;
  return patchLead(emailLower, {
    ...(options.status === false ? {} : { status: 'unsubscribed' }),
    suppressed: true,
    suppressed_at: existing.suppressed_at || new Date().toISOString(),
    unsubscribed_at: existing.unsubscribed_at || new Date().toISOString(),
    unsubscribe_reason: reason,
  });
}

// ─── Message-ID index ───

const MSGID_INDEX_KEY = 'msgid_index'; // Hash: normalized Message-ID -> lead email

/**
 * Remember which lead every Message-ID we generate belongs to, so the reply
 * scanner can resolve In-Reply-To / References with one HMGET instead of a
 * full scan of the leads hash on every run.
 */
export async function indexMessageIds(leadEmail, ...messageIds) {
  const owner = normalizeEmail(leadEmail);
  const entries = {};
  for (const id of messageIds) {
    const n = String(id || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
    if (n && owner) entries[n] = owner;
  }
  if (!Object.keys(entries).length) return;
  try { await kv.hset(MSGID_INDEX_KEY, entries); } catch {}
}

/**
 * Mark a lead as bounced: status, reason, suppression, and free its company
 * for another contact (nobody there received the email).
 */
export async function markLeadBounced(email, reason, meta = {}) {
  const key = normalizeEmail(email);
  const lead = await getLead(key);
  if (!lead) return null;
  const st = String(lead.status || '');
  if (st === 'bounced') return lead;
  const updated = await patchLead(key, {
    status: 'bounced',
    bounced_at: new Date().toISOString(),
    bounce_reason: String(reason || 'undeliverable').slice(0, 200),
    bounce_source: meta.source || 'dsn',
    bounce_inbox: meta.account || lead.account_used || null,
    status_before_bounce: st,
  });
  const p = kv.pipeline();
  p.sadd(SUPPRESSION_KEY, key);
  const company = normalizeCompanyName(lead.company || lead.company_name);
  if (company) p.srem(COMPANY_SENT_KEY, company);
  p.hincrby(STATS_KEY, 'totalBounced', 1);
  try { await p.exec(); } catch {}
  return updated;
}

// ─── Sent email log ───

/** One log entry per attempt (success or failure) — a single pipelined write. */
export async function logSentEmail(entry) {
  const logEntry = { ...entry, timestamp: entry.timestamp || new Date().toISOString() };
  const p = kv.pipeline();
  p.lpush(SENT_LOG_KEY, logEntry);
  p.ltrim(SENT_LOG_KEY, 0, SENT_LOG_MAX - 1);
  p.hincrby(STATS_KEY, entry.status === 'sent' ? 'totalSent' : 'totalFailed', 1);
  await p.exec();
  return logEntry;
}

export async function getSentLog(limit = 100) {
  const n = Math.min(Math.max(1, parseInt(limit, 10) || 100), SENT_LOG_MAX);
  try {
    const log = await kv.lrange(SENT_LOG_KEY, 0, n - 1);
    return log || [];
  } catch {
    return [];
  }
}

// ─── Replies ───

export async function getAllReplies() {
  try {
    const replies = await kv.hgetall(REPLIES_KEY);
    if (!replies) return [];
    return Object.values(replies)
      .filter((r) => r && typeof r === 'object')
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch {
    return [];
  }
}

// ─── Stats ───

const EMPTY_STATS = {
  totalLeads: 0, new: 0, pending: 0, qualified: 0, sending: 0, sentD0: 0, sentD3: 0, completed: 0,
  replied: 0, humanReplied: 0, unsubscribed: 0, bounced: 0, skipped: 0, contacted: 0, emailsSent: 0,
  opened: 0, openRate: 0, replyRate: 0, totalSent: 0, totalFailed: 0, totalScraped: 0,
  totalOpens: 0, uniqueOpens: 0, byCampaign: {},
};

/**
 * Pipeline-wide stats. Counts are derived from lead records using the same
 * rules as the dashboard; the `stats` hash counters are reported as-is for
 * reference. Every key from the previous shape is preserved.
 */
export async function getStats() {
  try {
    const [allLeads, globalStats, opensMap] = await Promise.all([
      getAllLeads(),
      kv.hgetall(STATS_KEY).catch(() => ({})),
      kv.hgetall(OPENS_KEY).catch(() => ({})),
    ]);
    const g = globalStats || {};
    const count = (fn) => allLeads.filter(fn).length;
    const st = (l) => String(l.status || '').toLowerCase();
    const merged = allLeads.map((l) => ({ ...l, ...mergeOpens(l, opensMap || {}) }));
    const real = merged.filter(isReal);
    const sent = real.filter(isSent);
    const trackable = sent.filter(isTrackable);
    const opened = trackable.filter(isOpened);
    const replied = sent.filter(isReplied);
    const humanReplied = replied.filter((l) => !l.reply_kind || l.reply_kind === 'human');
    const byCampaign = {};
    for (const c of ['free-leads', 'offer']) {
      const s = sent.filter((l) => campaignOf(l) === c);
      const t = s.filter(isTrackable);
      const o = t.filter(isOpened);
      const r = s.filter(isReplied);
      byCampaign[c] = {
        total: merged.filter((l) => campaignOf(l) === c).length,
        contacted: s.length,
        emailsSent: s.reduce((n, l) => n + touchesOf(l).length, 0),
        opened: o.length,
        replied: r.length,
        openRate: pct(o.length, t.length),
        replyRate: pct(r.length, s.length),
      };
    }
    return {
      totalLeads: allLeads.length,
      new: count((l) => st(l) === 'new'),
      pending: count((l) => st(l) === 'pending' || st(l) === ''),
      qualified: count((l) => st(l) === 'qualified'),
      sending: count((l) => st(l) === 'sending'),
      sentD0: count((l) => st(l) === 'sent-d0'),
      sentD3: count((l) => st(l) === 'sent-d3'),
      completed: count((l) => st(l) === 'sequence_complete' || st(l) === 'sent-d7-complete'),
      replied: count((l) => st(l) === 'replied' || Boolean(l.replied_at)),
      humanReplied: humanReplied.length,
      unsubscribed: count((l) => st(l) === 'unsubscribed'),
      bounced: count((l) => st(l) === 'bounced'),
      skipped: count((l) => st(l).startsWith('skipped')),
      sendable: count(isSendable),
      contacted: sent.length,
      emailsSent: sent.reduce((n, l) => n + touchesOf(l).length, 0),
      opened: opened.length,
      untracked: sent.length - trackable.length,
      openRate: pct(opened.length, trackable.length),
      replyRate: pct(replied.length, sent.length),
      byCampaign,
      totalSent: parseInt(g.totalSent || 0, 10),
      totalFailed: parseInt(g.totalFailed || 0, 10),
      totalScraped: parseInt(g.totalScraped || 0, 10),
      totalReplied: parseInt(g.totalReplied || 0, 10),
      totalBounced: parseInt(g.totalBounced || 0, 10),
      totalOpens: parseInt(g.totalOpens || 0, 10),
      uniqueOpens: parseInt(g.uniqueOpens || 0, 10),
    };
  } catch (err) {
    return { ...EMPTY_STATS, error: true, message: err?.message || 'stats unavailable' };
  }
}
