/**
 * Autonomous Email Sender — heartbeat endpoint (v3)
 *
 * An external heartbeat hits GET /api/cron/auto-send about once a minute.
 * Each hit sends AT MOST ONE email (a due follow-up or a fresh day-0 touch),
 * so volume is a steady drip across the US workday, never a burst.
 *
 * v3.1 — queue fairness + owner notifications:
 *  - FRESH MINIMUM per inbox (FRESH_MIN_SHARE of the cap is kept for day-0
 *    sends whenever fresh leads exist), so follow-ups can never starve new
 *    leads again. FOLLOW-UP EXPIRY retires touches more than
 *    FOLLOWUP_GRACE_DAYS past due instead of sending them weeks late.
 *  - OWNER EMAILS (lib/daily-report.js): a once-a-day "sending is OFF" alarm
 *    from 10 AM ET when no inbox is switched on, and an end-of-day report
 *    after 7 PM ET with per-inbox numbers, health, replies and tomorrow's queue.
 *
 * v3 — what changed and why:
 *  - PER-INBOX PACING. Every inbox keeps its own `nextSendAt` (KV `pacing`),
 *    computed after each send as (workday minutes left ÷ emails that inbox
 *    still has today) with ±15% jitter, clamped to 10–60 min. Adding an inbox
 *    now adds volume linearly (the old global 6-minute floor capped the whole
 *    system at ~110 emails/day no matter how many inboxes existed), the jitter
 *    is real (rolled once per send, not re-rolled every heartbeat), and the
 *    dashboard can show "next send at 10:42".
 *  - CHEAP IDLE PATH. Outside the window: 0 KV commands. Inside it, a paced
 *    heartbeat costs one HGETALL (`pacing`) before the lock is even taken —
 *    the full leads scan happens only on a heartbeat that will actually send.
 *  - FOLLOW-UPS FIXED. The global "6 follow-ups per day" cap and the random
 *    shuffle are gone: due follow-ups (day 3 = 3 days after day 0, day 7 =
 *    4 days after day 3) go oldest-first, only for inboxes that can send now,
 *    under the same pacing as fresh sends. They reuse the ORIGINAL subject
 *    ("Re: <original>") so Gmail threads the sequence, respect out-of-office
 *    holds, and never go to a suppressed address.
 *  - INBOX HEALTH. Every SMTP result is classified (auth / transient /
 *    recipient / content). Auth failures disable the inbox and are visible
 *    on the Inboxes API; 5xx recipient rejects mark the lead bounced instead
 *    of retrying it forever; a connection failure ends the inbox's turn
 *    instead of burning the whole lead pool; an inbox with 3 consecutive
 *    failures is skipped for 30 min.
 *  - DUPLICATE-PROOF BOOKKEEPING. The lead is claimed with SET NX, the lead
 *    record is written FIRST (with retries) after a successful send, counters
 *    go in one pipeline, and the lock is released with a compare-and-delete
 *    so an overrunning invocation can never delete a newer lock.
 *  - MORE INFORMATION. Each send records touch, campaign, subject variant,
 *    inbox, SMTP response, send time and ET hour; `daily_sends` carries
 *    per-touch / per-campaign / total breakdowns; every Message-ID is indexed
 *    so replies resolve without scanning the leads hash.
 *  - Reply scanning and name enrichment run AFTER the send and outside the
 *    lock (reply scan every 10 min in the window, every 20 min outside it, so
 *    replies are seen overnight too).
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getSequence, varsFor, renderTouch, sequenceReady, TemplateError } from '@/lib/systems/sequence';
import { getProfile } from '@/lib/db/client';
import { alertOwner } from '@/lib/notify';
import { checkAllReplies } from '@/lib/reply-checker';
import { logSentEmail, patchLead, markLeadBounced, indexMessageIds, getLeadsMap } from '@/lib/leads-db';
import { verifyEmail } from '@/lib/email-verify';
import { getSmtpAccounts, loadAccounts } from '@/lib/smtp-accounts';
import { isWithinSendingHours, minutesLeftInWindow } from '@/lib/warmup';
import { getInboxHealth, recordSendSuccess, recordSendFailure, updateInboxHealth, shouldSkipInbox } from '@/lib/inbox-health';
import { maybeSendDailyReport, maybeSendSwitchOffAlarm } from '@/lib/daily-report';
import {
  getTodayKey, etParts, campaignOf, normalizeCampaign, normalizeCompanyName, isRoleEmail,
  isSendable, leadScore, SEND_CAP, UNSENT_STATUSES,
} from '@/lib/metrics';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const LEADS_KEY = 'leads';
const DAILY_SEND_KEY = 'daily_sends';
const LOCK_KEY = 'auto_send_lock';
const LOCK_TTL_SECONDS = 120;
const COMPANY_SENT_KEY = 'company_sent';
const SUPPRESSION_KEY = 'suppression';
const PACING_KEY = 'pacing';
const INBOX_ENABLED_KEY = 'inbox_enabled';
const INBOX_CAP_KEY = 'inbox_caps';
const INBOX_CAMPAIGN_KEY = 'inbox_campaigns';
const REPLY_CHECK_KEY = 'reply_check_last_run';

// Pacing bounds (minutes between two sends from the SAME inbox).
const MIN_GAP_MIN = 10;
const MAX_GAP_MIN = 60;
// Two different inboxes never fire within this many seconds of each other.
const GLOBAL_SPACING_MS = 75 * 1000;
const LAST_GLOBAL_SEND_KEY = 'last_global_send';

// Sequence timing.
const D3_AFTER_MS = 3 * 24 * 60 * 60 * 1000;   // day 3 = 3 days after day 0
const D7_AFTER_MS = 4 * 24 * 60 * 60 * 1000;   // day 7 = 4 days after day 3
const D10_AFTER_MS = 3 * 24 * 60 * 60 * 1000;  // day 10 = 3 days after day 7 (SPEC SEQUENCE.gaps)
const STALE_CLAIM_MS = 30 * 60 * 1000;

// ─── Queue fairness (v3.1) ────────────────────────────────────────────────────
// Follow-ups still go first (a thread already opened is worth more than a cold
// one), but they can no longer eat the whole day. Two rules:
//
//  1) FRESH MINIMUM. Each inbox keeps at least FRESH_MIN_SHARE of its daily cap
//     for fresh day-0 emails whenever fresh leads exist for its campaign. With
//     a cap of 10 that is 4 fresh / up to 6 follow-ups; cap 20 → 8 / 12. Before
//     this, 478 old leads owed ~800 follow-ups and the 337 new leads would not
//     have received a single day-0 for about 40 days.
//
//  2) FOLLOW-UP EXPIRY. A follow-up that is more than FOLLOWUP_GRACE_DAYS past
//     its due date is retired (status `sequence_expired`) instead of sent: a
//     "just following up" three weeks after the opener reads as automation and
//     hurts the domain more than it helps. Expired leads stay in the CRM with
//     their history; they are simply not touched again.
const FRESH_MIN_SHARE = Math.min(0.9, Math.max(0, parseFloat(process.env.FRESH_MIN_SHARE || '0.4') || 0.4));
const FOLLOWUP_GRACE_MS = (parseInt(process.env.FOLLOWUP_GRACE_DAYS || '7', 10) || 7) * 24 * 60 * 60 * 1000;
const EXPIRE_PER_HEARTBEAT = 40;

// Reply-scan piggyback cadence.
const REPLY_CHECK_IN_WINDOW_MS = 10 * 60 * 1000;
const REPLY_CHECK_OFF_HOURS_MS = 20 * 60 * 1000;

// ─── Small helpers ────────────────────────────────────────────────────────────

const lower = (s) => String(s || '').trim().toLowerCase();

function jsonOk(body) {
  return Response.json({ success: true, timestamp: new Date().toISOString(), ...body });
}

async function withRetries(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 200 * (i + 1) * (i + 1))); }
  }
  throw lastErr;
}

function isAuthorized(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const authHeader = request.headers.get('authorization');
  const tokenParam = new URL(request.url).searchParams.get('token');
  return authHeader === `Bearer ${cronSecret}` || tokenParam === cronSecret;
}

// ─── Lock ─────────────────────────────────────────────────────────────────────

async function acquireLock(token) {
  try {
    const result = await kv.set(LOCK_KEY, token, { nx: true, ex: LOCK_TTL_SECONDS });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(token) {
  try {
    await kv.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      [LOCK_KEY],
      [token]
    );
  } catch {}
}

// ─── Inbox config ─────────────────────────────────────────────────────────────

async function loadInboxConfig() {
  const KV_ERROR = Symbol('kv-error');
  const [enabledMap, capMap, campaignMap, pacingMap, health] = await Promise.all([
    kv.hgetall(INBOX_ENABLED_KEY).catch(() => KV_ERROR),
    kv.hgetall(INBOX_CAP_KEY).catch(() => ({})),
    kv.hgetall(INBOX_CAMPAIGN_KEY).catch(() => ({})),
    kv.hgetall(PACING_KEY).catch(() => ({})),
    getInboxHealth(),
  ]);
  return {
    enabledMap: enabledMap && enabledMap !== KV_ERROR ? enabledMap : {},
    enabledUnavailable: enabledMap === KV_ERROR,
    capMap: capMap || {},
    campaignMap: campaignMap || {},
    pacingMap: pacingMap || {},
    health: health || {},
  };
}

function capFor(capMap, email) {
  const raw = capMap[lower(email)];
  if (raw === null || raw === undefined || raw === '') return SEND_CAP;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return SEND_CAP;
  return Math.max(0, Math.min(SEND_CAP, n));
}

function pacingFor(pacingMap, email) {
  let p = pacingMap[lower(email)];
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  return p && typeof p === 'object' ? p : null;
}

/** Per-inbox counters for today in ONE command. */
async function loadTodayCounts(accounts, today) {
  // Two fields per inbox: total sent today, and fresh (d0) sent today.
  const keys = [];
  for (const a of accounts) keys.push(`${a.email}:${today}`, `${a.email}:${today}:d0`);
  const counts = {};
  const fresh = {};
  try {
    // @vercel/kv (Upstash Redis) returns hmget as an OBJECT keyed by field
    // name — { "a@x:2026-09-11": 5, ... } — NOT a positional array. Read it by
    // field name. (A previous fix read it by index and always got 0, so the
    // cap was never enforced; `inboxes-control` reads it by field name and
    // reports the right numbers, which is the reference here.) The helper also
    // tolerates an array shape defensively.
    const res = (await kv.hmget(DAILY_SEND_KEY, ...keys)) || {};
    const read = (k) => {
      const v = Array.isArray(res) ? res[keys.indexOf(k)] : res[k];
      return parseInt(v ?? '0', 10) || 0;
    };
    for (const a of accounts) {
      counts[a.email] = read(`${a.email}:${today}`);
      fresh[a.email] = read(`${a.email}:${today}:d0`);
    }
  } catch {
    for (const a of accounts) { counts[a.email] = 0; fresh[a.email] = 0; }
  }
  return { counts, fresh };
}

/** Next-send time for an inbox after it just sent (or was just enabled). */
function computeNextSendAt(remainingAfter, now = new Date()) {
  const left = minutesLeftInWindow(now);
  if (left <= 0) return null;
  const base = left / Math.max(1, remainingAfter);
  const jitter = 0.85 + Math.random() * 0.3;
  const gapMin = Math.max(MIN_GAP_MIN, Math.min(MAX_GAP_MIN, base * jitter));
  return { at: new Date(now.getTime() + gapMin * 60 * 1000), gapMin: Math.round(gapMin * 10) / 10 };
}

// ─── Lead selection ───────────────────────────────────────────────────────────

/**
 * From one leads scan, derive both the fresh pool (per campaign, best score
 * first) and the due follow-ups (oldest due first), plus stuck claims.
 */
function partitionLeads(leadsMap, now) {
  const fresh = { 'free-leads': [], offer: [] };
  const followUps = [];
  const stuck = [];
  const expired = [];
  const nowMs = now.getTime();
  const pushDue = (lead, day, due) => {
    if (nowMs < due) return;
    if (nowMs - due > FOLLOWUP_GRACE_MS) expired.push({ lead, day, dueAt: due });
    else followUps.push({ lead, day, dueAt: due });
  };
  for (const lead of Object.values(leadsMap)) {
    if (!lead || !lead.email) continue;
    const status = lower(lead.status);

    if (status === 'sending') {
      const ts = lead.updatedAt ? new Date(lead.updatedAt).getTime() : 0;
      if (!ts || nowMs - ts > STALE_CLAIM_MS) stuck.push(lead);
      continue;
    }

    if (isSendable(lead)) {
      fresh[campaignOf(lead)].push(lead);
      continue;
    }

    if (!lead.sent_at) continue;
    const hold = lead.followup_hold_until ? new Date(lead.followup_hold_until).getTime() : 0;
    if (hold && hold > nowMs) continue;
    if (status === 'sent-d0') {
      pushDue(lead, 3, new Date(lead.sent_at).getTime() + D3_AFTER_MS);
    } else if (status === 'sent-d3') {
      const base = lead.d3_sent_at ? new Date(lead.d3_sent_at).getTime() : new Date(lead.sent_at).getTime() + D3_AFTER_MS;
      pushDue(lead, 7, base + D7_AFTER_MS);
    } else if (status === 'sent-d7') {
      const d7At = lead.d7_sent_at || lead.d7_skipped_at;
      const base = d7At ? new Date(d7At).getTime() : new Date(lead.sent_at).getTime() + D3_AFTER_MS + D7_AFTER_MS;
      pushDue(lead, 10, base + D10_AFTER_MS);
    }
  }
  for (const c of Object.keys(fresh)) {
    for (const l of fresh[c]) l.__jitter = Math.random();
    fresh[c].sort((a, b) => (leadScore(b) - leadScore(a)) || (a.__jitter - b.__jitter));
    for (const l of fresh[c]) delete l.__jitter;
  }
  followUps.sort((a, b) => a.dueAt - b.dueAt);
  return { fresh, followUps, stuck, expired };
}

/** Retire follow-ups that are too far past due (bounded per heartbeat). */
async function expireFollowUps(expired) {
  let n = 0;
  const at = new Date().toISOString();
  for (const { lead, day, dueAt } of expired.slice(0, EXPIRE_PER_HEARTBEAT)) {
    try {
      await patchLead(lead.email, {
        status: 'sequence_expired',
        expired_at: at,
        expired_touch: `d${day}`,
        expired_reason: `d${day} was due ${new Date(dueAt).toISOString().slice(0, 10)}, more than ${Math.round(FOLLOWUP_GRACE_MS / 864e5)} days ago`,
      });
      n++;
    } catch {}
  }
  return n;
}

/** Claim a lead atomically (SET NX marker + status flip). */
async function claimLead(email) {
  const key = lower(email);
  try {
    const got = await kv.set(`claim:${key}`, Date.now(), { nx: true, ex: 1800 });
    if (got !== 'OK') return false;
    const lead = await patchLead(key, (existing) => {
      const st = lower(existing.status);
      if (!UNSENT_STATUSES.has(st) || existing.sent_at) return null;
      return { status: 'sending', claimed_at: new Date().toISOString() };
    });
    if (!lead || lower(lead.status) !== 'sending') { await kv.del(`claim:${key}`).catch(() => {}); return false; }
    return true;
  } catch {
    return false;
  }
}

async function releaseClaim(email, status = 'pending', extra = {}) {
  const key = lower(email);
  try { await patchLead(key, { status, ...extra }); } catch {}
  try { await kv.del(`claim:${key}`); } catch {}
}

// ─── Email assembly ───────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a plain-text body as simple paragraph HTML that reads like a person
 *  wrote it (no tables, no newsletter chrome — that trips cold-outreach spam
 *  filters). Blank lines become paragraphs; aviance.online is linked. */
function textBodyHtml(body) {
  const paragraphs = String(body)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      let t = escapeHtml(p).replace(/\n/g, '<br>');
      t = t.replace(/(^|[^/.\w])(aviance\.online)/gi, '$1<a href="https://www.aviance.online" style="color:#141414;">aviance.online</a>');
      return `<p style="margin:0 0 14px 0;">${t}</p>`;
    })
    .join('\n');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#222222;max-width:560px;">${paragraphs}</div>`;
}

/**
 * Build subject/html/text/headers for one touch of one lead from the client's
 * sequence (Sequence T). Throws TemplateError when a slot has no value.
 *
 * Threading (SPEC §7.5 / trial doc): d3 replies in the d0 thread; d7 starts a
 * new thread with its own subject; d10 replies in the d7 thread (or the d0
 * thread when d7 was skipped).
 */
async function buildTouch(lead, day, ctx) {
  const touchName = `d${day}`;
  const vars = varsFor(lead, { profile: ctx.profile, account: ctx.account, ownerAddress: ctx.ownerAddress });
  const content = renderTouch(ctx.seq, touchName, vars);

  const reSubject = (s) => `Re: ${String(s).replace(/^\s*re:\s*/i, '').trim()}`;
  let subject = content.subject;
  const headers = {};
  if (content.thread === 'd0' || (content.thread === 'd7' && !lead.d7_message_id)) {
    subject = reSubject(lead.original_subject || subject || '');
    const refs = [lead.original_message_id, lead.d3_message_id].filter(Boolean);
    if (refs.length) { headers.inReplyTo = refs[refs.length - 1]; headers.references = refs; }
  } else if (content.thread === 'd7') {
    subject = reSubject(lead.d7_subject || '');
    headers.inReplyTo = lead.d7_message_id;
    headers.references = [lead.d7_message_id];
  }
  if (!subject) throw new TemplateError(`sequence:${touchName}`, ['subject']);

  const note = content.footer ? content.footer.split(/\n\s*\n/).pop().trim() : '';
  const bodyText = content.footer ? `${content.body}\n\n${content.footer.slice(0, content.footer.length - note.length).trim()}` : content.body;
  const htmlUnsubscribe = note ? `<p style="margin-top:24px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">${escapeHtml(note)}</p>` : '';
  const html = textBodyHtml(bodyText) + htmlUnsubscribe;

  return {
    lead: { ...lead, email: lower(lead.email), company_name: lead.company || lead.company_name || null },
    subject,
    html,
    text: content.text,
    headers,
    variant: `${ctx.seq.version ? `v${ctx.seq.version}-` : ''}${touchName}`,
    template: 'sequence-t',
    aiEnhanced: false,
    touch: touchName,
  };
}

// ─── Post-send bookkeeping ────────────────────────────────────────────────────

async function recordSend({ account, touch, day, lead, sendResult, today, startedAt }) {
  const now = new Date().toISOString();
  const campaign = campaignOf(lead);
  const et = etParts();

  // 1) The lead record first, with retries — this is the write that prevents
  //    a duplicate send if anything below fails.
  await withRetries(() => patchLead(lead.email, (existing) => {
    const base = {
      account_used: account.email,
      send_count: (Number(existing.send_count) || 0) + 1,
      last_touch_at: now,
      last_touch: touch.touch,
      updatedAt: now,
    };
    if (day === 0) {
      return {
        ...base,
        status: 'sent-d0',
        sent_at: now,
        sequence_day: 0,
        original_subject: touch.subject,
        original_message_id: sendResult.messageId || null,
        subject_variant: touch.variant,
        template_key: touch.template,
        ai_enhanced: touch.aiEnhanced,
        claimed_at: null,
      };
    }
    return {
      ...base,
      status: day === 10 ? 'sequence_complete' : `sent-d${day}`,
      sequence_day: day,
      [`d${day}_sent_at`]: now,
      [`d${day}_message_id`]: sendResult.messageId || null,
      [`d${day}_subject`]: touch.subject,
    };
  }));

  // 2) Counters + indexes in one pipeline.
  try {
    const p = kv.pipeline();
    p.hincrby(DAILY_SEND_KEY, `${account.email}:${today}`, 1);
    p.hincrby(DAILY_SEND_KEY, `${account.email}:${today}:${touch.touch}`, 1);
    p.hincrby(DAILY_SEND_KEY, `campaign:${campaign}:${today}`, 1);
    p.hincrby(DAILY_SEND_KEY, `__total__:${today}`, 1);
    if (day !== 0) p.hincrby(DAILY_SEND_KEY, `__followups__:${today}`, 1);
    p.set(LAST_GLOBAL_SEND_KEY, now);
    if (day === 0) {
      const company = normalizeCompanyName(lead.company_name || lead.company);
      if (company) p.sadd(COMPANY_SENT_KEY, company);
      p.del(`claim:${lead.email}`);
    }
    await p.exec();
  } catch (err) {
    console.error('[auto-send] counters failed:', err.message);
  }
  try { await indexMessageIds(lead.email, sendResult.messageId); } catch {}

  // 3) Log + health (best effort).
  try {
    await logSentEmail({
      to: lead.email, from: account.email,
      company: lead.company_name, industry: lead.industry,
      subject: touch.subject, bodyPreview: touch.text.substring(0, 200),
      status: 'sent', messageId: sendResult.messageId,
      sequenceDay: day, touch: touch.touch, campaign,
      source: day === 0 ? 'auto-send-scheduled' : `follow-up-d${day}`,
      subjectVariant: touch.variant, template: touch.template, aiEnhanced: touch.aiEnhanced,
      provider: account.provider, inboxDisplayName: account.displayName,
      smtpResponse: sendResult.response, messageSize: sendResult.messageSize,
      sendMs: sendResult.ms, attempts: sendResult.attempts,
      etHour: et.hour, etWeekday: et.weekday, tracked: sendResult.tracked,
      totalMs: Date.now() - startedAt,
    });
  } catch {}
  await recordSendSuccess(account.email, { ms: sendResult.ms, response: sendResult.response, messageId: sendResult.messageId });
}

/** Failure handling: classify, keep/bounce/skip the lead, record health. */
async function recordFailure({ account, touch, day, lead, sendResult, today }) {
  const kind = sendResult.kind || 'other';
  await recordSendFailure(account.email, sendResult);
  try {
    const p = kv.pipeline();
    p.hincrby(DAILY_SEND_KEY, `${account.email}:${today}:failed`, 1);
    p.hincrby(DAILY_SEND_KEY, `__failed__:${today}`, 1);
    await p.exec();
  } catch {}
  try {
    await logSentEmail({
      to: lead.email, from: account.email, company: lead.company_name, industry: lead.industry,
      subject: touch ? touch.subject : null, status: 'failed', sequenceDay: day, touch: touch ? touch.touch : null,
      campaign: campaignOf(lead), error: sendResult.error, errorKind: kind, errorCode: sendResult.code || sendResult.responseCode || null,
      smtpResponse: sendResult.response || null, sendMs: sendResult.ms, source: day === 0 ? 'auto-send-scheduled' : `follow-up-d${day}`,
    });
  } catch {}

  if (kind === 'recipient') {
    // The receiving server rejected the address: it's dead, stop retrying it.
    await markLeadBounced(lead.email, sendResult.response || sendResult.error, { source: 'smtp-reject', account: account.email });
    if (day === 0) { try { await kv.del(`claim:${lead.email}`); } catch {} }
    return 'bounced';
  }
  if (kind === 'content') {
    // Our message was refused (552/554) — a reputation signal, not a dead lead.
    if (day === 0) await releaseClaim(lead.email, 'skipped_rejected', { skip_reason: sendResult.response || sendResult.error });
    else await patchLead(lead.email, { last_error: sendResult.response || sendResult.error, last_error_at: new Date().toISOString() });
    return 'rejected';
  }
  if (kind === 'auth') {
    await updateInboxHealth(account.email, { disabledReason: `Login failed (${sendResult.responseCode || sendResult.code || 'EAUTH'}): check the app password`, disabledAt: new Date().toISOString() });
    try { await kv.hset(INBOX_ENABLED_KEY, { [account.email]: '0' }); } catch {}
  }
  // Transient / auth / other: the lead goes back to the pool.
  if (day === 0) await releaseClaim(lead.email, 'pending', { last_error: sendResult.error, last_error_at: new Date().toISOString() });
  else await patchLead(lead.email, { last_error: sendResult.error, last_error_at: new Date().toISOString() });
  return kind;
}

/** Send one touch; returns { ok, detail, stop } (stop = end this inbox's turn). */
async function sendTouch({ account, lead, day, today, startedAt, ctx }) {
  let touch;
  try {
    touch = await buildTouch(lead, day, { ...ctx, account });
  } catch (err) {
    const missing = err instanceof TemplateError ? err.missing.join(', ') : null;
    const reason = missing ? `copy slot missing: ${missing}` : `build: ${err.message}`;
    const at = new Date().toISOString();
    if (day === 0) {
      // No blank is ever sent (rule 4): the lead waits until its data is filled in.
      await releaseClaim(lead.email, missing ? 'skipped_copy' : 'pending', { last_error: reason, skip_reason: reason });
    } else if (missing) {
      // A follow-up that cannot be filled is skipped, and the sequence moves on.
      await patchLead(lead.email, day === 10
        ? { status: 'sequence_complete', d10_skipped_at: at, d10_skip_reason: reason }
        : { status: `sent-d${day}`, [`d${day}_skipped_at`]: at, [`d${day}_skip_reason`]: reason, sequence_day: day });
    } else {
      await patchLead(lead.email, { last_error: reason, last_error_at: at });
    }
    return { ok: false, stop: false, detail: { to: lead.email, status: 'skipped', touch: `d${day}`, error: reason } };
  }

  const sendResult = await sendEmail(account, {
    to: touch.lead.email,
    subject: touch.subject,
    html: touch.html,
    text: touch.text,
    touch: touch.touch,
    ...touch.headers,
  });

  if (sendResult.success) {
    await recordSend({ account, touch, day, lead: touch.lead, sendResult, today, startedAt });
    return {
      ok: true,
      stop: true,
      detail: {
        to: touch.lead.email, from: account.email, company: touch.lead.company_name, campaign: campaignOf(lead),
        status: day === 0 ? 'sent' : 'follow-up-sent', day, touch: touch.touch, subject: touch.subject,
        messageId: sendResult.messageId, ms: sendResult.ms, response: sendResult.response,
      },
    };
  }

  const outcome = await recordFailure({ account, touch, day, lead: touch.lead, sendResult, today });
  // Connection/auth problems belong to the inbox, not the lead: end its turn.
  const stop = outcome === 'auth' || outcome === 'transient' || outcome === 'other';
  return {
    ok: false,
    stop,
    detail: { to: touch.lead.email, from: account.email, status: 'failed', outcome, error: sendResult.error, code: sendResult.code || sendResult.responseCode || null },
  };
}

// ─── Reply check + enrichment piggybacks (outside the lock) ──────────────────

async function maybeRunReplyCheck(inWindow, deadlineMs) {
  try {
    const now = Date.now();
    const raw = await kv.get(REPLY_CHECK_KEY);
    const last = typeof raw === 'number' ? raw : Number(raw?.ts) || 0;
    const throttle = inWindow ? REPLY_CHECK_IN_WINDOW_MS : REPLY_CHECK_OFF_HOURS_MS;
    if (now - last < throttle) return { ran: false, nextInMs: throttle - (now - last) };
    const result = await checkAllReplies({ deadlineMs });
    if (result.skipped === 'locked') return { ran: false, skipped: 'locked' };
    return { ran: true, newReplies: result.matchedLeads, autoReplies: result.autoReplies.filter((a) => a.sent).length, bounces: result.bounces.length, errors: result.errors.length, ms: result.durationMs };
  } catch (err) {
    return { ran: false, error: err.message };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request) {
  const startedAt = Date.now();
  const deadlineMs = startedAt + (maxDuration - 20) * 1000;
  if (!isAuthorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  await loadAccounts();
  const params = new URL(request.url).searchParams;
  // The tick runs the reply scan as its own job; it calls this with skipReplies.
  const replyCheckFn = params.get('skipReplies') ? async () => ({ ran: false, skipped: 'handled by tick' }) : maybeRunReplyCheck;
  const inWindow = isWithinSendingHours();
  const today = getTodayKey();

  // ── Outside the window: no sending, but still look for replies (throttled). ──
  if (!inWindow) {
    const replyCheck = params.get('skipReplies') ? { ran: false } : await replyCheckFn(false, deadlineMs);
    // End-of-day report to the owner (once per send day, right after 7 PM ET).
    let report = { sent: false, reason: 'outside report slot' };
    const { weekday, hour } = etParts();
    if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && hour >= 19 && hour < 22) {
      const accountsAll = getSmtpAccounts();
      const cfg = await loadInboxConfig();
      report = await maybeSendDailyReport({ accountsAll, cfg, today });
    }
    return jsonOk({ sent: 0, message: 'Outside sending hours (8 AM - 7 PM US Eastern, Mon-Fri)', today, replyCheck, report });
  }

  // ── Cheap gates before the lock: inbox switches, caps, pacing. ──
  const accountsAll = getSmtpAccounts();
  if (!accountsAll.length) return Response.json({ error: 'No SMTP accounts configured' }, { status: 500 });

  // ── Never send a hole. ──
  // Sequence T needs the sender name and the postal address in every footer
  // (CAN-SPAM). If either is not filled in, hold sending and tell the owner
  // once a day; replies are still scanned.
  const profile = await getProfile('aviance');
  const ready = await sequenceReady('aviance', { profile, account: accountsAll[0] });
  if (!ready.ok) {
    await alertOwner('config_missing', {
      clientId: 'aviance',
      vars: { key: ready.missing.join(', ') },
      body: `Aviance outreach cannot send: the email footer needs ${ready.missing.join(' and ')}. Fill it in on the Aviance client page (postal address is legally required on every cold email).`,
      did: 'Sending is held. Replies are still being read.',
    }).catch(() => {});
    const replyCheck = await replyCheckFn(true, deadlineMs);
    return jsonOk({ sent: 0, blocked: 'copy_config_missing', missing: ready.missing, today, replyCheck });
  }
  const seqCtx = { seq: ready.seq, profile, ownerAddress: ready.ownerAddress };

  const cfg = await loadInboxConfig();
  if (cfg.enabledUnavailable) {
    return jsonOk({ sent: 0, kvError: true, message: 'Could not read inbox switches — sending paused for this heartbeat.', today });
  }
  const enabled = accountsAll.filter((a) => { const v = cfg.enabledMap[a.email]; return v === '1' || v === 1 || v === true; });
  if (!enabled.length) {
    // Sending is off, but prospects we already emailed still write back — and the
    // auto-reply bot only ever runs from here. Keep scanning.
    const replyCheck = await replyCheckFn(true, deadlineMs);
    // Tell the owner, once per day from 10 AM ET, that nothing is going out.
    const alarm = await maybeSendSwitchOffAlarm({ accountsAll, today });
    return jsonOk({ sent: 0, disabled: true, message: 'No inboxes are switched on — sending is off. Turn on an inbox toggle to start.', today, replyCheck, alarm });
  }

  const { counts, fresh: freshCounts } = await loadTodayCounts(enabled, today);
  const now = new Date();
  const accountStatus = enabled.map((a) => {
    const cap = capFor(cfg.capMap, a.email);
    const sentToday = counts[a.email] || 0;
    const freshToday = freshCounts[a.email] || 0;
    const freshMin = Math.min(cap, Math.ceil(cap * FRESH_MIN_SHARE));
    const pacing = pacingFor(cfg.pacingMap, a.email);
    const nextAt = pacing && pacing.nextSendAt ? new Date(pacing.nextSendAt).getTime() : 0;
    const health = cfg.health[a.email] || {};
    const skip = shouldSkipInbox(health, now.getTime());
    // Bounce circuit breaker: check-bounces raises `bounceAlert` when an inbox
    // bounces more than ~10% of what it sent today. Honour it — a bouncing
    // inbox that keeps sending is exactly how a domain's reputation dies. The
    // alert is scoped to today's counter, so it clears itself tomorrow, and
    // "clear health" on the Inboxes page clears it now.
    const bounceHold = Boolean(health.bounceAlert) && health.bouncesTodayKey === today
      ? `paused — ${health.bounceAlertDetail || 'bounce rate too high today'}`
      : null;
    return {
      email: a.email,
      campaign: normalizeCampaign(cfg.campaignMap[a.email]),
      sentToday,
      cap,
      remaining: Math.max(0, cap - sentToday),
      freshToday,
      followUpsToday: Math.max(0, sentToday - freshToday),
      // Follow-ups may use at most (cap − freshMin) slots while fresh leads exist.
      followUpBudget: Math.max(0, cap - freshMin),
      freshMin,
      nextSendAt: nextAt ? new Date(nextAt).toISOString() : null,
      ready: !nextAt || nextAt <= now.getTime(),
      skipped: skip.skip ? skip.reason : bounceHold,
      bounceHold,
      health: health.lastError && health.lastErrorAt > (health.lastSuccessAt || '') ? 'warning' : 'ok',
    };
  });
  const totalRemaining = accountStatus.reduce((n, s) => n + s.remaining, 0);
  if (totalRemaining === 0) {
    // Caps are hit early in the day; without this the bot would stop seeing
    // replies until the sending window closed.
    const replyCheck = await replyCheckFn(true, deadlineMs);
    return jsonOk({ sent: 0, message: 'Daily limit reached for all accounts', today, accountStatus, replyCheck });
  }
  const readyStatus = accountStatus.filter((s) => s.remaining > 0 && s.ready && !s.skipped);
  if (!readyStatus.length) {
    const soonest = accountStatus.filter((s) => s.remaining > 0 && !s.skipped).map((s) => s.nextSendAt).filter(Boolean).sort()[0] || null;
    const replyCheck = await replyCheckFn(true, deadlineMs);
    return jsonOk({ sent: 0, paced: true, message: soonest ? `Paced — next send at ${soonest}` : 'All eligible inboxes are cooling down', nextSendAt: soonest, today, accountStatus, replyCheck });
  }

  // Global spacing so two inboxes never fire in the same minute.
  try {
    const lastGlobal = await kv.get(LAST_GLOBAL_SEND_KEY);
    if (lastGlobal && Date.now() - new Date(lastGlobal).getTime() < GLOBAL_SPACING_MS) {
      return jsonOk({ sent: 0, paced: true, message: 'Spacing sends between inboxes', today, accountStatus });
    }
  } catch {}

  // ── Lock, then ONE leads scan, then at most one send. ──
  const lockToken = `${startedAt}-${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLock(lockToken))) {
    return jsonOk({ sent: 0, message: 'Another send is already in progress — skipping', today });
  }

  const results = { sent: 0, failed: 0, skipped: 0, bounced: 0, followUpsSent: 0, details: [] };
  let sentDetail = null;
  try {
    const leadsMap = await getLeadsMap();
    const { fresh, followUps, stuck, expired } = partitionLeads(leadsMap, now);

    // Reaper: claims that died mid-send go back to the pool.
    for (const lead of stuck.slice(0, 20)) {
      await releaseClaim(lead.email, 'pending', { reaped_at: new Date().toISOString() });
    }
    // Retire follow-ups that are too far past due (see FOLLOWUP_GRACE_MS).
    const expiredNow = expired.length ? await expireFollowUps(expired) : 0;

    // Most-behind inbox first (random tie-break) so inboxes take turns.
    const order = readyStatus
      .map((s) => ({ s, account: enabled.find((a) => a.email === s.email), r: Math.random() }))
      .sort((a, b) => (b.s.remaining - a.s.remaining) || (a.r - b.r));

    let suppressed = new Set();
    const candidateEmails = [
      ...followUps.slice(0, 60).map((f) => f.lead.email),
      ...fresh['free-leads'].slice(0, 40).map((l) => l.email),
      ...fresh.offer.slice(0, 40).map((l) => l.email),
    ].map(lower);
    if (candidateEmails.length) {
      try {
        const flags = await kv.smismember(SUPPRESSION_KEY, candidateEmails);
        suppressed = new Set(candidateEmails.filter((_, i) => flags[i] === 1 || flags[i] === true));
      } catch {}
    }

    const blockedFollowUps = { byDisabledInbox: 0, byCap: 0, byHold: 0, byFreshReserve: 0, suppressed: 0 };
    let usedInbox = null;

    // 1) FOLLOW-UPS FIRST (oldest due), on the thread's original inbox — but
    //    never past the inbox's follow-up budget while it still has fresh leads.
    for (const fu of followUps) {
      if (sentDetail) break;
      const email = lower(fu.lead.email);
      const inbox = lower(fu.lead.account_used);
      const status = accountStatus.find((s) => s.email === inbox);
      if (!status) { blockedFollowUps.byDisabledInbox++; continue; }
      if (status.remaining <= 0) { blockedFollowUps.byCap++; continue; }
      if (!status.ready || status.skipped) { blockedFollowUps.byHold++; continue; }
      if (status.followUpsToday >= status.followUpBudget && fresh[status.campaign].length > 0) { blockedFollowUps.byFreshReserve++; continue; }
      if (suppressed.has(email)) {
        blockedFollowUps.suppressed++;
        await patchLead(email, { status: 'unsubscribed', suppressed: true });
        continue;
      }
      const account = enabled.find((a) => a.email === inbox);
      const r = await sendTouch({ account, lead: fu.lead, day: fu.day, today, startedAt, ctx: seqCtx });
      results.details.push(r.detail);
      if (r.ok) { results.followUpsSent++; sentDetail = r.detail; usedInbox = account; }
      else { results.failed++; if (r.stop) { status.skipped = 'failed this heartbeat'; } }
      if (r.ok || r.stop) break;
    }

    // 2) FRESH DAY-0 on the most-behind ready inbox, its own campaign only.
    if (!sentDetail) {
      for (const { s, account } of order) {
        if (sentDetail || s.skipped) continue;
        const pool = fresh[s.campaign];
        let scanned = 0;
        for (const lead of pool) {
          if (scanned++ >= 40) break;
          const email = lower(lead.email);
          if (suppressed.has(email)) { results.skipped++; await patchLead(email, { status: 'unsubscribed', suppressed: true }); continue; }
          if (isRoleEmail(email)) { results.skipped++; await patchLead(email, { status: 'skipped_generic' }); continue; }
          const companyName = lead.company || lead.company_name || '';
          if (!companyName || companyName === 'your business') { results.skipped++; await patchLead(email, { status: 'skipped_no_company' }); continue; }
          const company = normalizeCompanyName(companyName);
          let dup = false;
          try { dup = company ? (await kv.sismember(COMPANY_SENT_KEY, company)) === 1 : false; } catch {}
          if (dup) { results.skipped++; await patchLead(email, { status: 'skipped_dedup' }); continue; }

          if (!(await claimLead(email))) { results.skipped++; continue; }

          const verification = await verifyEmail(email);
          if (!verification.valid) {
            results.skipped++;
            results.details.push({ to: email, status: 'skipped', reason: `verification failed: ${verification.reason}` });
            await releaseClaim(email, 'skipped_unverified', { verify_reason: verification.reason });
            continue;
          }

          const r = await sendTouch({ account, lead, day: 0, today, startedAt, ctx: seqCtx });
          results.details.push(r.detail);
          if (r.ok) { results.sent++; sentDetail = r.detail; usedInbox = account; break; }
          results.failed++;
          if (r.detail.outcome === 'bounced') results.bounced++;
          if (r.stop) { s.skipped = 'failed this heartbeat'; break; }
        }
      }
    }

    // 3) Pace the inbox that just sent.
    if (sentDetail && usedInbox) {
      const st = accountStatus.find((s) => s.email === usedInbox.email);
      const remainingAfter = Math.max(0, (st ? st.remaining : 1) - 1);
      const next = computeNextSendAt(remainingAfter, new Date());
      const pacing = {
        nextSendAt: next ? next.at.toISOString() : null,
        gapMin: next ? next.gapMin : null,
        lastSendAt: new Date().toISOString(),
        remaining: remainingAfter,
      };
      try { await kv.hset(PACING_KEY, { [usedInbox.email]: pacing }); } catch {}
      if (st) { st.sentToday++; st.remaining = remainingAfter; st.nextSendAt = pacing.nextSendAt; st.ready = false; }
    }

    results.blockedFollowUps = blockedFollowUps;
    results.pools = { followUpsDue: followUps.length, followUpsExpired: expired.length, expiredNow, freshFreeLeads: fresh['free-leads'].length, freshOffer: fresh.offer.length, stuckReaped: Math.min(stuck.length, 20) };
  } catch (err) {
    await releaseLock(lockToken);
    return Response.json({ error: err.message, timestamp: new Date().toISOString() }, { status: 500 });
  }
  await releaseLock(lockToken);

  // ── After the send, outside the lock: scan for replies. ──
  const replyCheck = await replyCheckFn(true, deadlineMs);

  return jsonOk({
    mode: 'scheduled',
    today,
    ...results,
    detail: sentDetail,
    accountStatus,
    replyCheck,
    durationMs: Date.now() - startedAt,
  });
}
