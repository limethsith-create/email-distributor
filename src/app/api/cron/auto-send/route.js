/**
 * Autonomous Email Sender — Zero Claude Dependency
 *
 * FIXES applied:
 * - Persistent account rotation (KV counter, not resetting to 0)
 * - Lead claiming with atomic status check (no duplicate sends)
 * - Clean HTML body (strip plain-text sig before adding HTML sig)
 * - Concurrency lock to prevent overlapping triggers
 *
 * Trigger via n8n every hour with ?batch=1
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getEmailForSequenceDay, enhanceWithAI } from '@/lib/personalize';
import { maybeEnrichNames } from '@/lib/enrich-names';
import { checkAllReplies } from '@/lib/reply-checker';
import { logSentEmail } from '@/lib/leads-db';
import { verifyEmail } from '@/lib/email-verify';
import { getSmtpAccounts } from '@/lib/smtp-accounts';
import {
  isWithinSendingHours,
  computeNextSendDelayMs,
  computeEvenGapMs,
} from '@/lib/warmup';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Warmup ramp + 9am-8pm randomized scheduling now live in src/lib/warmup.js
const LEADS_KEY = 'leads';
const DAILY_SEND_KEY = 'daily_sends';
const LOCK_KEY = 'auto_send_lock';
const LOCK_TTL_SECONDS = 300; // 5 minute lock — matches maxDuration
const COMPANY_SENT_KEY = 'company_sent';

// ── GLOBAL ANTI-BURST PACING ──
// The hard guard that guarantees emails drip out across the day instead of
// firing in a burst. No two emails may go out closer than MIN_SEND_GAP_MS
// apart, no matter how often the heartbeat pings or how many follow-ups
// are due. Each successful send stamps `last_global_send`; every send path
// checks it first.
const LAST_GLOBAL_SEND_KEY = 'last_global_send';
const MIN_SEND_GAP_MS = 12 * 60 * 1000; // hard floor: never two emails within 12 min

// The gap is DYNAMIC and even: it's computed from how much of the workday is
// left divided by how many emails remain (see computeEvenGapMs). We pass that
// in as `gapMs`. It falls back to the 12-min floor when no gap is supplied.
async function tooSoonToSend(gapMs = MIN_SEND_GAP_MS) {
  try {
    const last = await kv.get(LAST_GLOBAL_SEND_KEY);
    if (!last) return false;
    return (Date.now() - new Date(last).getTime()) < gapMs;
  } catch {
    return false;
  }
}

async function recordGlobalSend() {
  try {
    await kv.set(LAST_GLOBAL_SEND_KEY, new Date().toISOString());
  } catch {}
}

function isGenericEmail(email) {
  const genericPrefixes = [
    'info@', 'contact@', 'sales@', 'admin@', 'support@', 'hello@',
    'reservations@', 'marketing@', 'hr@', 'careers@', 'jobs@',
    'billing@', 'accounts@', 'enquiries@', 'enquiry@', 'reception@',
    'office@', 'general@', 'noreply@', 'no-reply@', 'webmaster@',
  ];
  const genericDomains = ['ac.lk', 'edu.lk', 'gov.lk', 'mrt.ac.lk', 'cmb.ac.lk'];
  const lower = email.toLowerCase();
  if (genericPrefixes.some(p => lower.startsWith(p))) return true;
  if (genericDomains.some(d => lower.endsWith(d))) return true;
  return false;
}

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase().trim()
    .replace(/\s*(pvt\.?\s*ltd\.?|ltd\.?|plc|llc|inc\.?|private\s+limited|limited)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

async function isCompanyAlreadySent(companyName) {
  if (!companyName) return false;
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return false;
  try {
    return await kv.sismember(COMPANY_SENT_KEY, normalized);
  } catch { return false; }
}

async function markCompanySent(companyName) {
  if (!companyName) return;
  const normalized = normalizeCompanyName(companyName);
  if (normalized) {
    try { await kv.sadd(COMPANY_SENT_KEY, normalized); } catch {}
  }
}

// ============================================================
// Per-account randomized scheduling — removes Claude dependency
// Each account gets its own "next send time" stored in Redis.
// GitHub Actions pings every 30 min; this code decides who's ready.
// ============================================================
const ACCOUNT_SCHEDULE_KEY = 'account_next_send';

// ── Per-inbox physical ON/OFF switch (default OFF = no sending) ──
const INBOX_ENABLED_KEY = 'inbox_enabled';
// Daily cap per inbox once its switch is ON.
const SEND_CAP = 25;
// Optional per-inbox daily cap (<= SEND_CAP) so volume can be ramped gradually.
const INBOX_CAP_KEY = 'inbox_caps';
async function getInboxCap(email) {
  try {
    const v = await kv.hget(INBOX_CAP_KEY, (email || '').toLowerCase());
    if (v === null || v === undefined || v === '') return SEND_CAP;
    const n = parseInt(v);
    if (isNaN(n)) return SEND_CAP;
    return Math.max(0, Math.min(SEND_CAP, n));
  } catch {
    return SEND_CAP;
  }
}
// Only leads Scout has scored this high are ever sent.
const QUALITY_THRESHOLD = 8;
// Target-industry gate. Broadened to the full B2B target set — the lead list is
// already requalified to clean US targets, so the old narrow "USA -"/"marketing
// & advertising" test was silently blocking IT/MSP, agencies, SaaS, financial
// and other perfect-fit leads from ever sending.
function isUSALead(l) {
  const ind = (l.industry || '').trim();
  if (/^\s*usa\s*-/i.test(ind)) return true;
  return /(marketing|advert|agenc|consult|professional\s*service|technolog|software|saas|\bit\b|it\s*service|managed\s*service|\bmsp\b|finance|financial|fintech|\bb2b\b|logistic|revenue|growth|outbound|lead\s*gen)/i.test(ind);
}

async function getEnabledInboxes() {
  // Returns a Set of inbox emails that are switched ON. Fail-safe: on any
  // error we return an EMPTY set, so sending never happens by accident.
  try {
    const map = await kv.hgetall(INBOX_ENABLED_KEY);
    if (!map) return new Set();
    return new Set(Object.entries(map).filter(([, v]) => v === '1' || v === 1 || v === true).map(([k]) => k.toLowerCase()));
  } catch {
    return new Set();
  }
}

async function isAccountReady(accountEmail) {
  try {
    const nextSendTime = await kv.hget(ACCOUNT_SCHEDULE_KEY, accountEmail);
    if (!nextSendTime) return true; // First time — ready immediately
    return Date.now() >= new Date(nextSendTime).getTime();
  } catch {
    return true;
  }
}

async function scheduleNextSend(accountEmail, remainingToday = 1) {
  // Randomized spacing across the remaining 9am-8pm window (see lib/warmup.js).
  // Spreads the day's sends with heavy jitter so cadence looks human.
  const delayMs = computeNextSendDelayMs(remainingToday);
  const nextTime = new Date(Date.now() + delayMs);
  try {
    await kv.hset(ACCOUNT_SCHEDULE_KEY, { [accountEmail]: nextTime.toISOString() });
  } catch {}
}

async function getAccountScheduleStatus(accounts) {
  const status = [];
  for (const acc of accounts) {
    try {
      const nextTime = await kv.hget(ACCOUNT_SCHEDULE_KEY, acc.email);
      status.push({
        email: acc.email,
        nextSendAt: nextTime || 'ready now',
        ready: !nextTime || Date.now() >= new Date(nextTime).getTime(),
      });
    } catch {
      status.push({ email: acc.email, nextSendAt: 'unknown', ready: true });
    }
  }
  return status;
}

// Account loading delegated to shared smtp-accounts lib
const getAccounts = getSmtpAccounts;

function getTodayKey() {
  // US Eastern calendar day (DST-aware) — matches the US send window.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function randomDelay(min = 3000, max = 15000) {
  return min + Math.random() * (max - min);
}

async function getDailySendCount(accountEmail) {
  const key = `${accountEmail}:${getTodayKey()}`;
  try {
    const count = await kv.hget(DAILY_SEND_KEY, key);
    return parseInt(count || '0');
  } catch {
    return 0;
  }
}

async function incrementDailySend(accountEmail) {
  const key = `${accountEmail}:${getTodayKey()}`;
  await kv.hincrby(DAILY_SEND_KEY, key, 1);
}

// --- Follow-up daily cap -------------------------------------------------
// New (day-0) outreach is always sent first; follow-ups only run when a cycle
// had no fresh lead. This cap makes sure follow-ups can never eat more than a
// small slice of the day's volume, so a big fresh pool (e.g. new MSP leads)
// always gets the bulk of sends. Counted separately from per-inbox caps.
const FOLLOWUP_DAILY_CAP = 6;

async function getFollowupCountToday() {
  // Stored on the same daily_sends hash under a synthetic key that can never
  // collide with a real inbox email address.
  const key = `__followups__:${getTodayKey()}`;
  try {
    return parseInt((await kv.hget(DAILY_SEND_KEY, key)) || '0');
  } catch {
    return 0;
  }
}

async function incrementFollowupToday() {
  const key = `__followups__:${getTodayKey()}`;
  try { await kv.hincrby(DAILY_SEND_KEY, key, 1); } catch {}
}

// --- Reply check piggyback ----------------------------------------------
// vercel.json defines NO cron for /api/cron/check-replies, so on its own the
// reply scanner never runs (that's why the Replies tab stays at 0). The
// auto-send heartbeat IS pinged regularly, so we run the reply scan from here
// at most once per throttle window: it detects genuine lead replies (strict
// thread match), logs them to the Replies tab, updates lead status to
// "replied", and fires exactly one auto-reply per lead. Fully self-guarded so
// it can never break or delay a send beyond its own time.
const REPLY_CHECK_THROTTLE_MS = 40 * 60 * 1000; // ~40 min
const REPLY_CHECK_KEY = 'reply_check_last_run';

async function maybeRunReplyCheck() {
  try {
    const now = Date.now();
    const last = Number(await kv.get(REPLY_CHECK_KEY)) || 0;
    if (now - last < REPLY_CHECK_THROTTLE_MS) return;
    // Claim the slot before the (slow) IMAP scan so overlapping heartbeats
    // don't both run it. The scan itself is idempotent, so a rare overlap is
    // harmless anyway.
    await kv.set(REPLY_CHECK_KEY, now);
    await checkAllReplies();
  } catch {
    // Never let reply-checking break the send heartbeat.
  }
}

/**
 * Get the next account index using a persistent KV counter.
 * Each invocation increments and gets the next account in rotation.
 */
async function getNextAccountIndex(numAccounts) {
  try {
    const counter = await kv.hincrby('stats', 'rotationIndex', 1);
    return (counter - 1) % numAccounts; // -1 because hincrby returns AFTER increment
  } catch {
    return 0;
  }
}

/**
 * Acquire a simple distributed lock to prevent concurrent sends.
 * Returns true if lock acquired, false if another invocation is running.
 */
async function acquireLock() {
  try {
    // SET NX = only set if not exists, EX = expire after TTL
    const result = await kv.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock() {
  try {
    await kv.del(LOCK_KEY);
  } catch {}
}

/**
 * Claim a lead atomically — set status to "sending" so no other
 * concurrent request can pick it up. Returns true if claimed.
 */
async function claimLead(email) {
  try {
    const existing = await kv.hget(LEADS_KEY, email.toLowerCase());
    if (!existing) return false;
    const status = (existing.status || '').toLowerCase();
    // Only claim if still pending/new
    if (status !== 'pending' && status !== 'new') return false;
    // Mark as "sending" immediately
    await kv.hset(LEADS_KEY, {
      [email.toLowerCase()]: { ...existing, status: 'sending', updatedAt: new Date().toISOString() }
    });
    return true;
  } catch {
    return false;
  }
}

async function getUnsent(limit = 75) {
  try {
    const allLeads = await kv.hgetall(LEADS_KEY);
    if (!allLeads) return [];

    // Reaper: a lead stuck in 'sending' for >30 min means a previous run
    // died mid-send (timeout/crash). Flip it back to 'pending' so it can
    // be picked up again instead of being stranded forever.
    const STALE_MS = 30 * 60 * 1000;
    for (const lead of Object.values(allLeads)) {
      if ((lead.status || '').toLowerCase() === 'sending' && lead.email) {
        const ts = lead.updatedAt ? new Date(lead.updatedAt).getTime() : 0;
        if (!ts || Date.now() - ts > STALE_MS) {
          lead.status = 'pending';
          try { await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: { ...lead, status: 'pending', updatedAt: new Date().toISOString() } }); } catch {}
        }
      }
    }

    const unsent = Object.values(allLeads)
      .filter(lead => {
        const status = (lead.status || '').toLowerCase();
        const fresh = (status === 'pending' || status === 'new') && lead.email && !lead.account_used && !lead.sent_at;
        // Scout gate: only high-scored, US leads are eligible to send.
        const qualified = (Number(lead.quality_score) || 0) >= QUALITY_THRESHOLD;
        return fresh && qualified && isUSALead(lead);
      });

    // BEST CUSTOMERS FIRST: highest-rated leads get emailed before anyone else.
    // Random jitter only breaks ties within the same score, so order still
    // varies between runs without ever letting a lower-rated lead jump ahead.
    for (const l of unsent) l.__jitter = Math.random();
    unsent.sort((a, b) => {
      const diff = (Number(b.quality_score) || 0) - (Number(a.quality_score) || 0);
      return diff !== 0 ? diff : a.__jitter - b.__jitter;
    });
    for (const l of unsent) delete l.__jitter;

    return unsent.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get leads due for follow-up emails (Day 3 or Day 7)
 * - sent-d0 leads that were sent 3+ days ago → Day 3 follow-up
 * - sent-d3 leads that were sent 3+ days after d3 (6+ days total) → Day 7 follow-up
 * Excludes leads that have replied or bounced
 */
async function getFollowUpLeads(limit = 10) {
  try {
    const allLeads = await kv.hgetall(LEADS_KEY);
    if (!allLeads) return [];

    const now = Date.now();
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    const followUps = [];

    for (const lead of Object.values(allLeads)) {
      if (!lead.email || !lead.sent_at) continue;
      const status = (lead.status || '').toLowerCase();
      const sentAt = new Date(lead.sent_at).getTime();
      const daysSinceSent = now - sentAt;

      // Day 3 follow-up: sent-d0, 3+ days ago, not replied/bounced
      if (status === 'sent-d0' && daysSinceSent >= THREE_DAYS) {
        followUps.push({ ...lead, nextSequenceDay: 3 });
      }
      // Day 7 follow-up: sent-d3, 3+ days after d3 send
      else if (status === 'sent-d3') {
        const d3SentAt = lead.d3_sent_at ? new Date(lead.d3_sent_at).getTime() : sentAt + THREE_DAYS;
        if (now - d3SentAt >= THREE_DAYS) {
          followUps.push({ ...lead, nextSequenceDay: 7 });
        }
      }
    }

    // Shuffle and limit
    for (let i = followUps.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [followUps[i], followUps[j]] = [followUps[j], followUps[i]];
    }

    return followUps.slice(0, limit);
  } catch {
    return [];
  }
}

async function markFollowUpSent(email, sequenceDay, messageId) {
  try {
    const existing = await kv.hget(LEADS_KEY, email.toLowerCase());
    if (!existing) return;
    const updated = {
      ...existing,
      status: `sent-d${sequenceDay}`,
      sequence_day: sequenceDay,
      [`d${sequenceDay}_sent_at`]: new Date().toISOString(),
      [`d${sequenceDay}_message_id`]: messageId || null,
      send_count: (existing.send_count || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    // Mark as completed after Day 7
    if (sequenceDay === 7) {
      updated.status = 'sequence_complete';
    }
    await kv.hset(LEADS_KEY, { [email.toLowerCase()]: updated });
  } catch {}
}

async function markLeadAsSent(email, accountEmail, subject, messageId) {
  try {
    const existing = await kv.hget(LEADS_KEY, email.toLowerCase());
    const updated = {
      ...existing,
      email: email.toLowerCase(),
      status: 'sent-d0',
      account_used: accountEmail,
      sent_at: new Date().toISOString(),
      send_count: (existing?.send_count || 0) + 1,
      sequence_day: 0,
      original_subject: subject,
      original_message_id: messageId || null,
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(LEADS_KEY, { [email.toLowerCase()]: updated });
  } catch (err) {
    console.error('[auto-send] markLeadAsSent error:', err.message);
  }
}

/**
 * Strip the plain-text signature block from the email body.
 * The personalize templates include "Limethsith\nAviance..." in the body,
 * but we add a proper HTML signature separately, so remove it to avoid duplication.
 */
function stripPlainTextSignature(body) {
  // Remove lines starting from the standalone "Limethsith" line through the sig
  const lines = body.split('\n');
  let cutIndex = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === 'Limethsith') {
      cutIndex = i;
      break;
    }
  }
  // Remove trailing empty lines before the signature
  let end = cutIndex;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end).join('\n');
}

export async function GET(request) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    if (authHeader !== `Bearer ${cronSecret}` && tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Business hours check — only send 8 AM to 7 PM US Eastern
  if (!isWithinSendingHours()) {
    return Response.json({
      success: true,
      message: 'Outside sending hours (8 AM - 7 PM US Eastern)',
      timestamp: new Date().toISOString(),
      sent: 0,
    });
  }

  // Concurrency lock — prevent overlapping sends from multiple triggers
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    return Response.json({
      success: true,
      message: 'Another send is already in progress — skipping',
      timestamp: new Date().toISOString(),
      sent: 0,
    });
  }

  try {
    // Detect + handle any lead replies first (throttled). Populates the
    // Replies tab and sends the one-time auto-reply. Non-fatal.
    await maybeRunReplyCheck();

    // Name-enrichment bot (throttled, capped, no-op without GEMINI_API_KEY).
    // Finds owner first names for unsent leads so sends switch to named copy.
    await maybeEnrichNames();

    let accounts = getAccounts();
    if (!accounts.length) {
      await releaseLock();
      return Response.json({ error: 'No SMTP accounts configured' }, { status: 500 });
    }

    // ── PHYSICAL SWITCH GATE ──
    // Only inboxes whose toggle is switched ON may send. If none are on,
    // we stop here and send nothing. This is the master safety.
    const enabledInboxes = await getEnabledInboxes();
    accounts = accounts.filter((a) => enabledInboxes.has((a.email || '').toLowerCase()));
    if (!accounts.length) {
      await releaseLock();
      return Response.json({
        success: true,
        disabled: true,
        sent: 0,
        message: 'No inboxes are switched on — sending is off. Turn on an inbox toggle to start.',
        timestamp: new Date().toISOString(),
      });
    }

    const { searchParams: params } = new URL(request.url);
    const batchSize = parseInt(params.get('batch') || '0') || 0;

    // Check daily limits for each account
    const accountStatus = [];
    let totalRemaining = 0;

    for (const acc of accounts) {
      const sent = await getDailySendCount(acc.email);
      const cap = await getInboxCap(acc.email);
      const remaining = Math.max(0, cap - sent);
      accountStatus.push({ email: acc.email, sentToday: sent, remaining });
      totalRemaining += remaining;
    }

    if (totalRemaining === 0) {
      await releaseLock();
      return Response.json({
        success: true,
        message: 'Daily limit reached for all accounts',
        timestamp: new Date().toISOString(),
        sent: 0,
        accountStatus,
      });
    }

    // ── ANTI-BURST GATE (applies to every mode) ──
    // DYNAMIC EVEN SPACING: the gap between any two sends is the workday time
    // remaining divided by the emails remaining, so the day's emails land in
    // equal steps instead of a burst. e.g. 24 left over 8 h → ~20 min apart;
    // with two inboxes taking turns that's ~40 min per inbox.
    const evenGapMs = computeEvenGapMs(totalRemaining);
    if (await tooSoonToSend(evenGapMs)) {
      await releaseLock();
      return Response.json({
        success: true,
        paced: true,
        sent: 0,
        message: `Spacing sends evenly across the workday — ~${Math.round(evenGapMs / 60000)} min between emails right now.`,
        timestamp: new Date().toISOString(),
        accountStatus,
      });
    }

    // ============================================================
    // SCHEDULED MODE (default): ONE email per heartbeat
    // The heartbeat pings every ~10 min; each account also has its own
    // randomized timer, and the anti-burst gate above keeps every send
    // at least MIN_SEND_GAP_MS apart. Net effect: a steady drip.
    // ============================================================
    if (batchSize === 0) {
      const scheduleStatus = await getAccountScheduleStatus(accounts);

      // ── SELF-BALANCING INBOX SELECTION ──
      // Every eligible inbox (switch on, cap not hit) is a candidate. We sort
      // so the inbox that is FURTHEST BEHIND today (most remaining) goes first;
      // ties are broken at random. Because each send decrements that inbox's
      // remaining, the two inboxes automatically take turns — neither can race
      // ahead of the other, and both end the day at the same count. This is the
      // fix for "only one Gmail is sending": selection is by workload now, not
      // by fixed list order.
      const readyAccounts = [];
      for (let i = 0; i < accounts.length; i++) {
        if (accountStatus[i].remaining <= 0) continue;
        readyAccounts.push({ account: accounts[i], stat: accountStatus[i], __r: Math.random() });
      }
      readyAccounts.sort((a, b) => {
        const diff = b.stat.remaining - a.stat.remaining; // most-behind first
        return diff !== 0 ? diff : a.__r - b.__r;         // random tie-break
      });

      if (readyAccounts.length === 0) {
        await releaseLock();
        return Response.json({
          success: true,
          mode: 'scheduled',
          message: 'No accounts ready to send right now',
          timestamp: new Date().toISOString(),
          sent: 0,
          accountStatus,
          scheduleStatus,
        });
      }

      const unsent = await getUnsent(readyAccounts.length * 5);
      if (unsent.length === 0) {
        await releaseLock();
        return Response.json({
          success: true,
          mode: 'scheduled',
          message: 'No unsent leads available',
          timestamp: new Date().toISOString(),
          sent: 0,
          accountStatus,
          scheduleStatus,
        });
      }

      const results = { sent: 0, failed: 0, skipped: 0, details: [] };
      let leadIdx = 0;

      for (const { account, stat } of readyAccounts) {
        let sentFromThisAccount = false;

        while (leadIdx < unsent.length && !sentFromThisAccount) {
          const lead = unsent[leadIdx++];

          const claimed = await claimLead(lead.email);
          if (!claimed) { results.skipped++; continue; }

          if (isGenericEmail(lead.email)) {
            results.skipped++;
            try {
              const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
              if (existing) await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: { ...existing, status: 'skipped_generic', updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          const qualifiedLead = {
            ...lead,
            email: lead.email.toLowerCase().trim(),
            industry: lead.industry || 'business',
            company_name: lead.company || lead.company_name || null,
            city: lead.city || 'USA',
            first_name: lead.first_name || lead.name?.split(/[\s,]/)[0] || null,
          };

          if (!qualifiedLead.company_name || qualifiedLead.company_name === 'your business') {
            results.skipped++;
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_no_company', updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          const companyAlreadySent = await isCompanyAlreadySent(qualifiedLead.company_name);
          if (companyAlreadySent) {
            results.skipped++;
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_dedup', updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          // Email verification — MX + SMTP check before sending
          const verification = await verifyEmail(qualifiedLead.email);
          if (!verification.valid) {
            results.skipped++;
            results.details.push({ to: qualifiedLead.email, status: 'skipped', reason: `verification failed: ${verification.reason}` });
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_unverified', verify_reason: verification.reason, updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          const emailContent = await enhanceWithAI(qualifiedLead, getEmailForSequenceDay(qualifiedLead, 0));
          const bodyParts = emailContent.body.split('---');
          const rawBody = bodyParts[0];
                    const unsubNote = bodyParts[1] || "Not the right fit? Just reply STOP and I will not email you again.";
          const cleanBody = stripPlainTextSignature(rawBody);

          const htmlParagraphs = cleanBody
            .split(/\n\n+/)
            .filter(p => p.trim().length > 0)
            .map(p => {
              let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); escaped = escaped.replace(/aviance\.online/g, '<a href="https://www.aviance.online" style="color:#0a0a0a;">aviance.online</a>');
              return `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${escaped}</p>`;
            })
            .join('\n');

          const htmlSignature = `
          <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#555;">
                        Aviance — Guaranteed booked sales calls<br>
            <a href="https://www.aviance.online" style="color:#555;text-decoration:none;">aviance.online</a>
          </div>`;

          const htmlUnsubscribe = unsubNote
            ? `<p style="margin-top:24px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">${unsubNote.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
            : '';

          const htmlBody = htmlParagraphs + htmlSignature + htmlUnsubscribe;

          try {
            const sendResult = await sendEmail(account, {
              to: qualifiedLead.email,
              subject: emailContent.subject,
              html: htmlBody,
              text: emailContent.body,
            });

            if (sendResult.success) {
              results.sent++;
              stat.remaining--;
              stat.sentToday++;
              sentFromThisAccount = true;

              await incrementDailySend(account.email);
              await markLeadAsSent(qualifiedLead.email, account.email, emailContent.subject, sendResult.messageId);
              await markCompanySent(qualifiedLead.company_name);
              await scheduleNextSend(account.email, Math.max(1, stat.remaining));
              await recordGlobalSend();

              try {
                await logSentEmail({
                  to: qualifiedLead.email, from: account.email,
                  company: qualifiedLead.company_name, industry: qualifiedLead.industry,
                  subject: emailContent.subject, bodyPreview: emailContent.body.substring(0, 200),
                  status: 'sent', messageId: sendResult.messageId,
                  sequenceDay: 0, source: 'auto-send-scheduled',
                });
              } catch {}

              results.details.push({ to: qualifiedLead.email, from: account.email, company: qualifiedLead.company_name, status: 'sent' });
            } else {
              results.failed++;
              try {
                const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
                if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
              } catch {}
              results.details.push({ to: qualifiedLead.email, from: account.email, status: 'failed', error: sendResult.error });
            }
          } catch (err) {
            results.failed++;
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
            } catch {}
            results.details.push({ to: qualifiedLead.email, status: 'error', error: err.message });
          }

        }
        // ONE email per heartbeat: stop after the first successful send so
        // sends stay evenly spread through the day (never a burst).
        if (sentFromThisAccount) break;
      }

      // ============================================================
      // FOLLOW-UP SENDING: Day 3 / Day 7, on the SAME account.
      // Only if we didn't just send a fresh email this run and we're past
      // the spacing gap — and at most ONE follow-up per run.
      // ============================================================
      // New (day-0) sends always win: only consider follow-ups if no fresh
      // email went out this cycle, we're past the spacing gap, AND we haven't
      // hit the daily follow-up cap (keeps the bulk of volume on new outreach).
      const followupsToday = await getFollowupCountToday();
      const canFollowUp = results.sent === 0
        && followupsToday < FOLLOWUP_DAILY_CAP
        && !(await tooSoonToSend());
      const followUpLeads = canFollowUp ? await getFollowUpLeads(6) : [];
      let followUpsSent = 0;

      for (const fuLead of followUpLeads) {
        // Use the same account that sent the original
        const originalAccount = accounts.find(a => a.email === fuLead.account_used);
        if (!originalAccount) continue;

        // Check daily limit for this account
        const fuSent = await getDailySendCount(originalAccount.email);
        const fuCap = await getInboxCap(originalAccount.email);
        if (fuSent >= fuCap) continue;

        const qualifiedLead = {
          ...fuLead,
          email: fuLead.email.toLowerCase().trim(),
          industry: fuLead.industry || 'business',
          company_name: fuLead.company || fuLead.company_name || 'your company',
          city: fuLead.city || 'USA',
          first_name: fuLead.first_name || fuLead.name?.split(/[\s,]/)[0] || null,
        };

        const emailContent = getEmailForSequenceDay(qualifiedLead, fuLead.nextSequenceDay);
        const cleanBody = stripPlainTextSignature(emailContent.body);

        const htmlParagraphs = cleanBody
          .split(/\n\n+/)
          .filter(p => p.trim().length > 0)
          .map(p => {
            let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); escaped = escaped.replace(/aviance\.online/g, '<a href="https://www.aviance.online" style="color:#0a0a0a;">aviance.online</a>');
            return `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${escaped}</p>`;
          })
          .join('\n');

        const htmlSignature = `
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#555;">
                    Aviance — Guaranteed booked sales calls<br>
          <a href="https://www.aviance.online" style="color:#555;text-decoration:none;">aviance.online</a>
        </div>`;

        const htmlBody = htmlParagraphs + htmlSignature;

        // Build threading headers from the stored original messageId
        // For Day 3: reference the original (d0) messageId
        // For Day 7: reference the original + d3 messageId for full thread chain
        const threadingHeaders = {};
        const originalMsgId = fuLead.original_message_id;
        if (originalMsgId) {
          if (fuLead.nextSequenceDay === 3) {
            threadingHeaders.inReplyTo = originalMsgId;
            threadingHeaders.references = originalMsgId;
          } else if (fuLead.nextSequenceDay === 7) {
            const d3MsgId = fuLead.d3_message_id;
            threadingHeaders.inReplyTo = d3MsgId || originalMsgId;
            threadingHeaders.references = d3MsgId
              ? `${originalMsgId} ${d3MsgId}`
              : originalMsgId;
          }
        }

        try {
          const sendResult = await sendEmail(originalAccount, {
            to: qualifiedLead.email,
            subject: emailContent.subject,
            html: htmlBody,
            text: emailContent.body,
            ...threadingHeaders,
          });

          if (sendResult.success) {
            followUpsSent++;
            await incrementDailySend(originalAccount.email);
            await incrementFollowupToday();
            await markFollowUpSent(qualifiedLead.email, fuLead.nextSequenceDay, sendResult.messageId);
            try {
              await logSentEmail({
                to: qualifiedLead.email, from: originalAccount.email,
                company: qualifiedLead.company_name, industry: qualifiedLead.industry,
                subject: emailContent.subject, bodyPreview: emailContent.body.substring(0, 200),
                status: 'sent', messageId: sendResult.messageId,
                sequenceDay: fuLead.nextSequenceDay,
                source: `follow-up-d${fuLead.nextSequenceDay}`,
              });
            } catch {}
            results.details.push({ to: qualifiedLead.email, from: originalAccount.email, status: 'follow-up-sent', day: fuLead.nextSequenceDay });
            await recordGlobalSend();
            break; // one follow-up per run — keep sends spaced out
          }
        } catch {}
      }

      // NOTE: totalSent is already incremented by logSentEmail() — no hincrby here

      await releaseLock();
      return Response.json({
        success: true,
        mode: 'scheduled',
        timestamp: new Date().toISOString(),
        today: getTodayKey(),
        ...results,
        followUpsSent,
        accountStatus,
        scheduleStatus,
      });
    }

    // ============================================================
    // BATCH MODE: Original behavior when ?batch=N is specified
    // ============================================================
    const effectiveLimit = Math.min(batchSize, totalRemaining);
    const unsent = await getUnsent(effectiveLimit);

    if (unsent.length === 0) {
      await releaseLock();
      return Response.json({
        success: true,
        mode: 'batch',
        message: 'No unsent leads available',
        timestamp: new Date().toISOString(),
        sent: 0,
        accountStatus,
      });
    }

    const startAccountIdx = await getNextAccountIndex(accounts.length);
    let accountIndex = startAccountIdx;
    const results = { sent: 0, failed: 0, skipped: 0, details: [] };

    for (const lead of unsent) {
      // Anti-burst: even in batch mode, never send two emails within the gap.
      if (await tooSoonToSend()) break;
      const claimed = await claimLead(lead.email);
      if (!claimed) {
        results.skipped++;
        results.details.push({ to: lead.email, status: 'skipped', reason: 'already claimed or sent' });
        continue;
      }

      if (isGenericEmail(lead.email)) {
        results.skipped++;
        try {
          const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
          if (existing) await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: { ...existing, status: 'skipped_generic', updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      let found = false;
      let attempts = 0;
      while (attempts < accounts.length) {
        const accStat = accountStatus[accountIndex % accounts.length];
        if (accStat.remaining > 0) { found = true; break; }
        accountIndex++;
        attempts++;
      }
      if (!found) break;

      const accIdx = accountIndex % accounts.length;
      const account = accounts[accIdx];
      const accStat = accountStatus[accIdx];

      const qualifiedLead = {
        ...lead,
        email: lead.email.toLowerCase().trim(),
        industry: lead.industry || 'business',
        company_name: lead.company || lead.company_name || null,
        city: lead.city || 'USA',
        first_name: lead.first_name || lead.name?.split(/[\s,]/)[0] || null,
      };

      if (!qualifiedLead.company_name || qualifiedLead.company_name === 'your business') {
        results.skipped++;
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_no_company', updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      const companyAlreadySent = await isCompanyAlreadySent(qualifiedLead.company_name);
      if (companyAlreadySent) {
        results.skipped++;
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_dedup', updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      // Email verification — MX + SMTP check before sending
      const verification = await verifyEmail(qualifiedLead.email);
      if (!verification.valid) {
        results.skipped++;
        results.details.push({ to: qualifiedLead.email, status: 'skipped', reason: `verification failed: ${verification.reason}` });
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_unverified', verify_reason: verification.reason, updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      const emailContent = await enhanceWithAI(qualifiedLead, getEmailForSequenceDay(qualifiedLead, 0));
      const bodyParts = emailContent.body.split('---');
      const rawBody = bodyParts[0];
            const unsubNote = bodyParts[1] || "Not the right fit? Just reply STOP and I will not email you again.";
      const cleanBody = stripPlainTextSignature(rawBody);

      const htmlParagraphs = cleanBody
        .split(/\n\n+/)
        .filter(p => p.trim().length > 0)
        .map(p => {
          let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); escaped = escaped.replace(/aviance\.online/g, '<a href="https://www.aviance.online" style="color:#0a0a0a;">aviance.online</a>');
          return `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${escaped}</p>`;
        })
        .join('\n');

      const htmlSignature = `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#555;">
                Aviance — Guaranteed booked sales calls<br>
        <a href="https://www.aviance.online" style="color:#555;text-decoration:none;">aviance.online</a>
      </div>`;

      const htmlUnsubscribe = unsubNote
        ? `<p style="margin-top:24px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">${unsubNote.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
        : '';

      const htmlBody = htmlParagraphs + htmlSignature + htmlUnsubscribe;

      try {
        const sendResult = await sendEmail(account, {
          to: qualifiedLead.email,
          subject: emailContent.subject,
          html: htmlBody,
          text: emailContent.body,
        });

        if (sendResult.success) {
          results.sent++;
          accStat.remaining--;
          accStat.sentToday++;
          await incrementDailySend(account.email);
          await markLeadAsSent(qualifiedLead.email, account.email, emailContent.subject, sendResult.messageId);
          await markCompanySent(qualifiedLead.company_name);
          await recordGlobalSend();
          try {
            await logSentEmail({
              to: qualifiedLead.email, from: account.email,
              company: qualifiedLead.company_name, industry: qualifiedLead.industry,
              subject: emailContent.subject, bodyPreview: emailContent.body.substring(0, 200),
              status: 'sent', messageId: sendResult.messageId,
              sequenceDay: 0, source: 'auto-send-batch',
            });
          } catch {}
          results.details.push({ to: qualifiedLead.email, from: account.email, company: qualifiedLead.company_name, status: 'sent' });
        } else {
          results.failed++;
          try {
            const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
            if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
          } catch {}
          results.details.push({ to: qualifiedLead.email, from: account.email, status: 'failed', error: sendResult.error });
        }
      } catch (err) {
        results.failed++;
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
        } catch {}
        results.details.push({ to: qualifiedLead.email, status: 'error', error: err.message });
      }

      accountIndex++;
      if (results.sent + results.failed < unsent.length) {
        await new Promise(r => setTimeout(r, randomDelay()));
      }
    }

    // NOTE: totalSent is already incremented by logSentEmail() — no hincrby here

    await releaseLock();
    return Response.json({
      success: true,
      mode: 'batch',
      timestamp: new Date().toISOString(),
      today: getTodayKey(),
      accountUsed: accounts[startAccountIdx % accounts.length]?.email,
      ...results,
      accountStatus,
    });
  } catch (err) {
    await releaseLock();
    return Response.json({ error: err.message }, { status: 500 });
  }
}
