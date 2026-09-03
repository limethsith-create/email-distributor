/**
 * Inbox sending control — the physical ON/OFF switch + daily-limit per inbox,
 * plus everything the Inboxes page and the dashboard show about each inbox:
 * today's / 7d / 30d volume, pacing, connection health and the last reply scan.
 *
 * Sending is OFF by default. An inbox only sends when its switch here is ON.
 * The auto-sender reads this same KV key and refuses to send from any inbox
 * that isn't switched on. Each inbox also has a per-day send limit (default 25,
 * the hard max) that you can dial down to ramp volume gradually.
 *
 * GET  -> { inboxes[], cap, maxCap, today, totals, lastReplyCheck, sendingWindow }
 * POST -> { email, enabled | cap | campaign }
 *         { action: 'reset_counts' }
 *         { action: 'test', email }          SMTP login + IMAP login check
 *         { action: 'clear_health', email }  forget failures / alerts after a fix
 */

import { kv } from '@vercel/kv';
import { ImapFlow } from 'imapflow';
import { getSmtpAccounts, findSmtpAccount } from '@/lib/smtp-accounts';
import { getTodayKey, dayKeys, normalizeCampaign, SEND_CAP, CAMPAIGNS } from '@/lib/metrics';
import { describeHealth, updateInboxHealth, INBOX_HEALTH_KEY } from '@/lib/inbox-health';
import { getLastReplyCheck } from '@/lib/reply-checker';
import { testConnection } from '@/lib/mailer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const INBOX_ENABLED_KEY = 'inbox_enabled';
const INBOX_CAP_KEY = 'inbox_caps';
const INBOX_CAMPAIGN_KEY = 'inbox_campaigns'; // email -> 'free-leads' | 'offer'
const PACING_KEY = 'pacing';                  // email -> { nextSendAt, lastSendAt, gapMin, remaining }
const DAILY_SEND_KEY = 'daily_sends';

const TOUCH_SUFFIXES = ['', ':d0', ':d3', ':d7', ':autoreply', ':failed'];
const SENDING_WINDOW = '8:00 AM – 7:00 PM ET, Mon–Fri';
const VERIFY_DEADLINE_MS = 25 * 1000;

// Fallback list so the page still shows the two inboxes even before env is read
const FALLBACK_INBOXES = [
  { email: 'limethsith@getaviance.site', displayName: 'Limethsith Weerasinghe' },
  { email: 'limethsith.weerasinghe@getaviance.site', displayName: 'Limethsith Weerasinghe' },
];

function capFromMap(capMap, email) {
  const raw = capMap[(email || '').toLowerCase()];
  if (raw === null || raw === undefined || raw === '') return SEND_CAP;
  const n = parseInt(raw);
  if (isNaN(n)) return SEND_CAP;
  return Math.max(0, Math.min(SEND_CAP, n));
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
  }
  return {};
}

function toInt(value) {
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

function errText(err) {
  if (!err) return 'unknown error';
  return `${err.code ? err.code + ': ' : ''}${err.message || String(err)}`.slice(0, 300);
}

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Trim the reply-checker's last-run record to what the page shows. */
function trimLastReplyCheck(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    at: rec.at || (rec.ts ? new Date(rec.ts).toISOString() : null),
    durationMs: rec.durationMs ?? null,
    newReplies: toInt(rec.newReplies),
    autoReplies: toInt(rec.autoReplies),
    bounces: toInt(rec.bounces),
    errors: toInt(rec.errors),
    perInbox: (Array.isArray(rec.perInbox) ? rec.perInbox : []).map((p) => ({
      account: p.account || null,
      ok: Boolean(p.ok),
      newMessages: toInt(p.newMessages),
      candidates: toInt(p.candidates),
      ms: p.ms ?? null,
      error: p.error || null,
    })),
  };
}

export async function GET() {
  const accounts = getSmtpAccounts();
  const list = accounts.length ? accounts : FALLBACK_INBOXES;
  const today = getTodayKey();
  const days = dayKeys(30);

  // One HMGET for every inbox × the last 30 days × every counter.
  const sendKeys = [];
  for (const a of list) {
    const key = String(a.email || '').toLowerCase();
    for (const d of days) for (const s of TOUCH_SUFFIXES) sendKeys.push(`${key}:${d}${s}`);
  }

  let enabledMap = {};
  let capMap = {};
  let campaignMap = {};
  let pacingMap = {};
  let healthMap = {};
  let sends = {};
  let lastRun = null;
  try {
    const [en, cp, cm, pc, hl, sd, lr] = await Promise.all([
      kv.hgetall(INBOX_ENABLED_KEY).catch(() => ({})),
      kv.hgetall(INBOX_CAP_KEY).catch(() => ({})),
      kv.hgetall(INBOX_CAMPAIGN_KEY).catch(() => ({})),
      kv.hgetall(PACING_KEY).catch(() => ({})),
      kv.hgetall(INBOX_HEALTH_KEY).catch(() => ({})),
      sendKeys.length ? kv.hmget(DAILY_SEND_KEY, ...sendKeys).catch(() => ({})) : Promise.resolve({}),
      getLastReplyCheck().catch(() => null),
    ]);
    enabledMap = asObject(en);
    capMap = asObject(cp);
    campaignMap = asObject(cm);
    pacingMap = asObject(pc);
    healthMap = asObject(hl);
    sends = asObject(sd);
    lastRun = lr;
  } catch {}

  const num = (k) => toInt(sends[k] || 0);
  const totals = { sentToday: 0, sent7d: 0, sent30d: 0, autoRepliesToday: 0, failedToday: 0 };

  const inboxes = [];
  for (const a of list) {
    const key = (a.email || '').toLowerCase();
    const on = enabledMap[key] === '1' || enabledMap[key] === 1 || enabledMap[key] === true;
    const rawCampaign = String(campaignMap[key] || '').toLowerCase();
    const todayCounts = {
      total: num(`${key}:${today}`),
      d0: num(`${key}:${today}:d0`),
      d3: num(`${key}:${today}:d3`),
      d7: num(`${key}:${today}:d7`),
      autoreply: num(`${key}:${today}:autoreply`),
      failed: num(`${key}:${today}:failed`),
    };
    let sent7d = 0;
    let sent30d = 0;
    days.forEach((d, i) => {
      const n = num(`${key}:${d}`);
      sent30d += n;
      if (i < 7) sent7d += n;
    });
    const pacing = asObject(pacingMap[key]);
    const h = asObject(healthMap[key]);
    const health = describeHealth(h);

    totals.sentToday += todayCounts.total;
    totals.sent7d += sent7d;
    totals.sent30d += sent30d;
    totals.autoRepliesToday += todayCounts.autoreply;
    totals.failedToday += todayCounts.failed;

    inboxes.push({
      email: a.email,
      displayName: a.displayName || (a.email || '').split('@')[0],
      enabled: !!on,
      sentToday: todayCounts.total,
      cap: capFromMap(capMap, a.email),
      maxCap: SEND_CAP,
      campaign: rawCampaign === 'free-leads' ? 'free-leads' : 'offer',
      // additive
      provider: a.provider || null,
      smtpHost: a.smtp?.host || null,
      imapHost: a.imap?.host || null,
      today: todayCounts,
      sent7d,
      sent30d,
      nextSendAt: pacing.nextSendAt || null,
      lastSendAt: pacing.lastSendAt || h.lastSendAt || null,
      health,
      healthDetail: {
        lastSuccessAt: h.lastSuccessAt || null,
        lastError: h.lastError || null,
        lastErrorAt: h.lastErrorAt || null,
        consecutiveFailures: toInt(h.consecutiveFailures),
        imapLastOkAt: h.imapLastOkAt || null,
        imapLastError: h.imapLastError || null,
        bounceAlert: Boolean(h.bounceAlert),
        bouncesToday: h.bouncesTodayKey === today ? toInt(h.bouncesToday) : 0,
        sendsTotal: toInt(h.sendsTotal),
        failuresTotal: toInt(h.failuresTotal),
      },
    });
  }

  return Response.json({
    inboxes,
    cap: SEND_CAP,
    maxCap: SEND_CAP,
    today,
    totals,
    lastReplyCheck: trimLastReplyCheck(lastRun),
    sendingWindow: SENDING_WINDOW,
  });
}

/** IMAP login check (verifyOnly: connect, authenticate, logout). */
async function verifyImap(account) {
  const started = Date.now();
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: true,
    auth: { user: account.email, pass: account.appPassword },
    logger: false,
    verifyOnly: true,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
  try {
    await withDeadline(client.connect(), VERIFY_DEADLINE_MS, 'IMAP verify');
    try { await withDeadline(client.logout(), 2000, 'logout'); } catch {}
    return { ok: true, ms: Date.now() - started, error: null };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: errText(err) };
  } finally {
    try { client.close(); } catch {}
  }
}

/** SMTP login check via the shared mailer (login + EHLO, nothing sent). */
async function verifySmtp(account) {
  const started = Date.now();
  try {
    const r = await withDeadline(testConnection(account.email, account.appPassword, account), VERIFY_DEADLINE_MS, 'SMTP verify');
    return { ok: Boolean(r && r.success), ms: r?.ms ?? Date.now() - started, error: r && r.success ? null : (r?.error || 'unknown error') };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: errText(err) };
  }
}

/**
 * Reset today's per-inbox counters (total + per-touch + autoreply + failed) and
 * take the same amount off the day's aggregate counters so the dashboard's
 * totals stay consistent with the inboxes.
 */
async function resetTodayCounts(accounts, today) {
  const campaigns = {};
  try {
    const cm = asObject(await kv.hgetall(INBOX_CAMPAIGN_KEY));
    for (const a of accounts) campaigns[a.email] = normalizeCampaign(cm[a.email]);
  } catch {
    for (const a of accounts) campaigns[a.email] = 'offer';
  }

  const inboxKeys = [];
  for (const a of accounts) for (const s of TOUCH_SUFFIXES) inboxKeys.push(`${a.email}:${today}${s}`);
  const aggKeys = [`__total__:${today}`, `__followups__:${today}`, `__failed__:${today}`, ...CAMPAIGNS.map((c) => `campaign:${c}:${today}`)];

  let current = {};
  try { current = asObject(await kv.hmget(DAILY_SEND_KEY, ...inboxKeys, ...aggKeys)); } catch {}
  const cur = (k) => toInt(current[k] || 0);

  let totalDrop = 0;
  let followupDrop = 0;
  let failedDrop = 0;
  const campaignDrop = {};
  for (const a of accounts) {
    totalDrop += cur(`${a.email}:${today}`);
    followupDrop += cur(`${a.email}:${today}:d3`) + cur(`${a.email}:${today}:d7`);
    failedDrop += cur(`${a.email}:${today}:failed`);
    const c = campaigns[a.email];
    campaignDrop[c] = (campaignDrop[c] || 0) + cur(`${a.email}:${today}`);
  }

  const patch = {};
  for (const k of inboxKeys) patch[k] = 0;
  patch[`__total__:${today}`] = Math.max(0, cur(`__total__:${today}`) - totalDrop);
  patch[`__followups__:${today}`] = Math.max(0, cur(`__followups__:${today}`) - followupDrop);
  patch[`__failed__:${today}`] = Math.max(0, cur(`__failed__:${today}`) - failedDrop);
  for (const c of CAMPAIGNS) patch[`campaign:${c}:${today}`] = Math.max(0, cur(`campaign:${c}:${today}`) - (campaignDrop[c] || 0));

  await kv.hset(DAILY_SEND_KEY, patch);
}

export async function POST(request) {
  try {
    const body = await request.json();

    // Reset today's send counters to zero (fresh start) — configured accounts only.
    if (body.action === 'reset_counts') {
      const accounts = getSmtpAccounts();
      if (!accounts.length) return Response.json({ success: true, reset: [] });
      const today = getTodayKey();
      try {
        await resetTodayCounts(accounts, today);
      } catch {
        // Fall back to the plain per-inbox reset if the aggregate math could not run.
        for (const a of accounts) {
          try { await kv.hset(DAILY_SEND_KEY, { [`${a.email}:${today}`]: 0 }); } catch {}
        }
      }
      return Response.json({ success: true, reset: accounts.map((a) => a.email) });
    }

    const { email } = body;
    if (!email) return Response.json({ success: false, error: 'email required' }, { status: 400 });
    const key = String(email).trim().toLowerCase();

    // SMTP + IMAP login check for one inbox; the outcome is stored on its health record.
    if (body.action === 'test') {
      const account = findSmtpAccount(key);
      if (!account) return Response.json({ success: false, email: key, error: 'inbox is not configured (SMTP_ACCOUNT_n)' }, { status: 404 });
      const [smtp, imap] = await Promise.all([verifySmtp(account), verifyImap(account)]);
      try {
        const at = new Date().toISOString();
        await updateInboxHealth(key, {
          lastVerifyAt: at,
          smtpOk: smtp.ok,
          smtpMs: smtp.ms,
          smtpError: smtp.error,
          imapOk: imap.ok,
          imapMs: imap.ms,
          imapError: imap.error,
          // A successful login is a real IMAP OK signal: the inbox turns healthy now, not after the next scan.
          ...(imap.ok ? { imapLastOkAt: at, imapLastError: null, imapConsecutiveFailures: 0 } : {}),
        });
      } catch {}
      return Response.json({ success: smtp.ok && imap.ok, email: key, smtp, imap });
    }

    // Forget failures / alerts after the owner fixed the inbox (app password etc.).
    if (body.action === 'clear_health') {
      try {
        await updateInboxHealth(key, {
          consecutiveFailures: 0,
          disabledReason: null,
          disabledAt: null,
          bounceAlert: false,
          bounceAlertAt: null,
          bounceAlertDetail: null,
          lastError: null,
          lastErrorKind: null,
          lastErrorCode: null,
          imapLastError: null,
          imapConsecutiveFailures: 0,
          healthClearedAt: new Date().toISOString(),
        });
      } catch {}
      return Response.json({ success: true, email: key, cleared: true });
    }

    // Set the per-inbox daily limit (clamped 0..SEND_CAP).
    if (body.cap !== undefined) {
      let n = parseInt(body.cap);
      if (isNaN(n)) n = SEND_CAP;
      n = Math.max(0, Math.min(SEND_CAP, n));
      await kv.hset(INBOX_CAP_KEY, { [key]: String(n) });
      return Response.json({ success: true, email: key, cap: n });
    }

    // Assign this inbox to a campaign ('free-leads' or 'offer').
    if (body.campaign !== undefined) {
      const c = String(body.campaign || '').toLowerCase();
      if (!CAMPAIGNS.includes(c)) {
        return Response.json({ success: false, error: 'campaign must be free-leads or offer' }, { status: 400 });
      }
      await kv.hset(INBOX_CAMPAIGN_KEY, { [key]: c });
      return Response.json({ success: true, email: key, campaign: c });
    }

    // Flip the on/off switch. Switching ON also forgets an auto-disable so a
    // fixed inbox starts fresh instead of staying skipped by the sender.
    if (body.enabled !== undefined) {
      await kv.hset(INBOX_ENABLED_KEY, { [key]: body.enabled ? '1' : '0' });
      if (body.enabled) {
        try {
          await updateInboxHealth(key, (h) => (h && (h.disabledReason || Number(h.consecutiveFailures) > 0)
            ? { disabledReason: null, disabledAt: null, consecutiveFailures: 0 }
            : null));
        } catch {}
      }
      return Response.json({ success: true, email: key, enabled: !!body.enabled });
    }

    return Response.json({ success: false, error: 'nothing to update' }, { status: 400 });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
