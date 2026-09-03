/**
 * Bounce Detection Cron Endpoint
 *
 * Scans every sending inbox (INBOX + spam folder) over IMAP for delivery
 * status notifications, extracts the failed recipient from hard bounces and
 * marks the matching lead as bounced (status, suppression, company freed).
 *
 *  - Each account connects to ITS OWN IMAP server (smtp-accounts.js) — no
 *    global IMAP host guessing, so Gmail and Namecheap inboxes coexist.
 *  - The search runs SERVER-SIDE (SINCE + OR of mailer-daemon / postmaster /
 *    DSN subjects); only the small text part of a DSN is ever downloaded.
 *  - A per-account watermark (`bounce_last_check`) keeps each run to the
 *    last check minus a 12h overlap (7 days on the first run) and is only
 *    advanced after a fully successful scan, so nothing is ever lost.
 *  - Delays (4.x.x) are counted but never mark a lead; only leads that were
 *    actually emailed and have not replied / unsubscribed are marked.
 *  - Accounts run 3 at a time, each under a 30s deadline; every outcome is
 *    written to `inbox_health` and the handler never throws.
 *
 * Trigger:
 * - GET /api/cron/check-bounces?token=CRON_SECRET  (or Authorization: Bearer CRON_SECRET)
 * - n8n or external cron (every 1-2 hours)
 */

import { ImapFlow } from 'imapflow';
import { kv } from '@vercel/kv';
import { getSmtpAccounts, getOwnAddresses } from '@/lib/smtp-accounts';
import { getLeadsByEmail, markLeadBounced } from '@/lib/leads-db';
import { recordImapResult, updateInboxHealth } from '@/lib/inbox-health';
import {
  parseHeaders, classifyKind, dsnSeverity, extractBouncedAddress, bounceReason,
  htmlToText, findTextPart, readStream,
} from '@/lib/mail-utils';
import { getTodayKey } from '@/lib/metrics';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const LAST_CHECK_KEY = 'bounce_last_check'; // Hash: account -> ISO timestamp of the last successful scan
const BOUNCES_KEY = 'bounces';              // Hash: email -> { bounce details } (read by the daily log)
const DAILY_SEND_KEY = 'daily_sends';

const FIRST_SCAN_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 12 * 60 * 60 * 1000;
const MAX_PER_FOLDER = 400;
const MAX_BODY_BYTES = 16384;
const MAX_STATUS_BYTES = 4096;
const ACCOUNT_DEADLINE_MS = 30 * 1000;
const ACCOUNT_SOFT_BUDGET_MS = 24 * 1000; // stop downloading bodies past this, keep the watermark
const RUN_BUDGET_MS = 95 * 1000;          // accounts not started by then are skipped (maxDuration 120)
const CONCURRENCY = 3;

const FETCH_HEADERS = ['auto-submitted', 'return-path', 'content-type', 'x-failed-recipients'];

/** Server-side search: classic DSN senders and subjects. */
const BOUNCE_SEARCH_OR = [
  { from: 'mailer-daemon' },
  { from: 'postmaster' },
  { subject: 'undeliverable' },
  { subject: 'delivery status notification' },
  { subject: 'mail delivery' },
  { subject: 'failure notice' },
  { subject: 'returned mail' },
  { subject: 'delivery failure' },
];

// ─── Small helpers ────────────────────────────────────────────────────────────

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function errText(err) {
  if (!err) return 'unknown error';
  return `${err.code ? err.code + ': ' : ''}${err.message || String(err)}`.slice(0, 300);
}

/** Lead statuses that may still flip to bounced (never replied / unsubscribed / already bounced). */
function isBounceEligible(lead) {
  if (!lead) return false;
  const st = String(lead.status || '').toLowerCase();
  if (st === 'replied' || st === 'unsubscribed' || st === 'bounced') return false;
  if (lead.replied_at) return false;
  return st.startsWith('sent') || st === 'sending' || st === 'sequence_complete';
}

/** Our own inboxes and sending domains — a DSN "recipient" there is never a lead. */
function buildOwnFilter() {
  const own = getOwnAddresses();
  const domains = new Set();
  for (const e of own) {
    const d = String(e).split('@')[1];
    if (d) domains.add(d.toLowerCase());
  }
  return {
    own,
    isOurs(address) {
      const a = String(address || '').toLowerCase();
      if (!a) return true;
      if (own.has(a)) return true;
      const d = a.split('@')[1] || '';
      for (const od of domains) {
        if (d === od || d.endsWith('.' + od)) return true;
      }
      return false;
    },
  };
}

/** Since-date for this account: last successful check minus overlap, else 7 days back. */
function sinceFor(lastCheckIso, now) {
  const saved = lastCheckIso ? new Date(lastCheckIso).getTime() : NaN;
  if (!isNaN(saved) && saved > 0 && saved <= now) return new Date(saved - OVERLAP_MS);
  return new Date(now - FIRST_SCAN_MS);
}

/** Concurrency-limited Promise.allSettled. */
async function settleAll(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ─── IMAP scanning ────────────────────────────────────────────────────────────

/** Resolve INBOX + the spam folder for this server (special-use aware). */
async function resolveFolders(client, account) {
  const folders = ['INBOX'];
  let spam = null;
  try {
    const list = await client.list();
    const junk = list.find((f) => f.specialUse === '\\Junk');
    if (junk) spam = junk.path;
    else if (account.spamFolder && list.find((f) => f.path === account.spamFolder)) spam = account.spamFolder;
    else {
      const guess = list.find((f) => /^(\[gmail\]\/)?(spam|junk( e-?mail)?)$/i.test(String(f.path || '')));
      spam = guess ? guess.path : (account.spamFolder || null);
    }
  } catch {
    spam = account.spamFolder || null;
  }
  if (spam && spam !== 'INBOX' && !folders.includes(spam)) folders.push(spam);
  return folders;
}

/** Find a message/delivery-status node (RFC 3464 machine-readable part). */
function findDeliveryStatusPart(node) {
  if (!node) return null;
  if (node.childNodes && node.childNodes.length) {
    for (const c of node.childNodes) {
      const r = findDeliveryStatusPart(c);
      if (r) return r;
    }
    return null;
  }
  return String(node.type || '').toLowerCase() === 'message/delivery-status' && node.part ? node.part : null;
}

/** Download the (bounded) text of one DSN: human-readable text part + delivery-status part. */
async function fetchDsnText(client, meta) {
  let text = '';
  try {
    const part = findTextPart(meta.bodyStructure) || { part: 'TEXT', type: 'text/plain' };
    const { content } = await client.download(meta.uid, part.part, { uid: true, maxBytes: MAX_BODY_BYTES });
    text = await readStream(content, MAX_BODY_BYTES);
    if (part.type === 'text/html') text = htmlToText(text);
  } catch {
    text = '';
  }
  // The machine-readable status block is tiny and carries Final-Recipient / Status / Action.
  const statusPart = findDeliveryStatusPart(meta.bodyStructure);
  if (statusPart) {
    try {
      const { content } = await client.download(meta.uid, statusPart, { uid: true, maxBytes: MAX_STATUS_BYTES });
      const status = await readStream(content, MAX_STATUS_BYTES);
      if (status) text = `${text}\n${status}`;
    } catch {}
  }
  if (meta.failedRecipients) text = `X-Failed-Recipients: ${meta.failedRecipients}\n${text}`;
  return text;
}

/** Turn one fetched message into our metadata object (no body yet). */
function describeMessage(msg, folder) {
  const env = msg.envelope || {};
  const headers = parseHeaders(msg.headers);
  const fromEmail = String(env.from?.[0]?.address || '').toLowerCase();
  const subject = String(env.subject || '');
  const kind = classifyKind({
    headers,
    subject,
    from: fromEmail,
    contentType: String(msg.bodyStructure?.type || ''),
  });
  return {
    uid: msg.uid,
    folder,
    from: fromEmail,
    subject,
    date: safeIso(msg.internalDate) || safeIso(env.date) || new Date().toISOString(),
    messageId: env.messageId || null,
    kind,
    failedRecipients: headers['x-failed-recipients'] || null,
    bodyStructure: msg.bodyStructure || null,
  };
}

/**
 * Scan one account (client already created by the caller). Returns candidate
 * hard bounces — nothing is written to KV here so the deadline can cut the
 * IMAP work without leaving half-written records behind.
 */
async function scanAccount(client, account, ctx, started) {
  const result = {
    account: account.email,
    host: account.imap.host,
    ok: false,
    complete: true,
    folders: [],
    scanned: 0,
    candidates: 0,
    hard: [],
    delayed: 0,
    unknown: 0,
    unresolved: 0,
    error: null,
    ms: 0,
  };
  const since = sinceFor(ctx.lastCheck[account.email], ctx.now);
  result.since = since.toISOString();

  await client.connect();
  const folders = await resolveFolders(client, account);

  for (const folder of folders) {
    const folderResult = { folder, scanned: 0, dsn: 0, error: null };
    result.folders.push(folderResult);
    if (Date.now() - started > ACCOUNT_SOFT_BUDGET_MS) {
      folderResult.error = 'no_time';
      result.complete = false;
      continue;
    }
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch (err) {
      if (err && err.mailboxMissing) {
        folderResult.error = 'missing';
      } else {
        folderResult.error = errText(err);
        result.complete = false;
      }
      continue;
    }
    try {
      const pending = [];
      let capped = false;
      for await (const msg of client.fetch(
        { since, or: BOUNCE_SEARCH_OR },
        { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: FETCH_HEADERS },
        { uid: true }
      )) {
        // No IMAP commands inside this loop — collect, then download afterwards.
        if (folderResult.scanned >= MAX_PER_FOLDER) { capped = true; break; }
        folderResult.scanned++;
        result.scanned++;
        const meta = describeMessage(msg, folder);
        if (meta.kind !== 'dsn') continue;
        pending.push(meta);
      }
      if (capped) result.complete = false; // more than the cap: keep the watermark so the rest is seen next run
      folderResult.dsn = pending.length;
      result.candidates += pending.length;

      for (const meta of pending) {
        if (Date.now() - started > ACCOUNT_SOFT_BUDGET_MS) {
          result.complete = false;
          folderResult.error = folderResult.error || 'no_time';
          break;
        }
        const text = await fetchDsnText(client, meta);
        const severity = dsnSeverity(text, meta.subject);
        if (severity === 'delay') { result.delayed++; continue; }
        if (severity !== 'hard') { result.unknown++; continue; }
        const failed = extractBouncedAddress(text, ctx.ownFilter.own);
        if (!failed || ctx.ownFilter.isOurs(failed)) { result.unresolved++; continue; }
        result.hard.push({
          email: failed,
          reason: bounceReason(text),
          subject: meta.subject,
          date: meta.date,
          folder,
          uid: meta.uid,
          messageId: meta.messageId,
          account: account.email,
        });
      }
    } catch (err) {
      folderResult.error = errText(err);
      result.complete = false;
    } finally {
      try { lock.release(); } catch {}
    }
  }

  result.ok = true;
  return result;
}

/** Create the client, run the scan under the deadline, always tear the socket down. */
async function runAccount(account, ctx) {
  const started = Date.now();
  const budget = Math.max(1000, Math.min(ACCOUNT_DEADLINE_MS, ctx.hardDeadline - started));
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: true,
    auth: { user: account.email, pass: account.appPassword },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 25000,
  });
  let result;
  try {
    result = await withDeadline(scanAccount(client, account, ctx, started), budget, `IMAP ${account.email}`);
  } catch (err) {
    result = {
      account: account.email, host: account.imap.host, ok: false, complete: false, folders: [],
      scanned: 0, candidates: 0, hard: [], delayed: 0, unknown: 0, unresolved: 0, error: errText(err),
    };
  } finally {
    try { await withDeadline(client.logout(), 2000, 'logout'); } catch {}
    try { client.close(); } catch {}
  }
  result.ms = Date.now() - started;
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function checkAllBounces() {
  const started = Date.now();
  const now = started;
  const today = getTodayKey();
  const summary = {
    checked: 0,
    bounced: 0,
    delayed: 0,
    skipped: 0,
    candidates: 0,
    details: [],
    errors: [],
    perInbox: [],
    durationMs: 0,
    timestamp: new Date().toISOString(),
  };

  const accounts = getSmtpAccounts();
  if (!accounts.length) {
    summary.error = 'No SMTP accounts configured';
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // Watermarks + today's send counts (for the per-inbox bounce-rate alert), in parallel.
  let lastCheck = {};
  let sentToday = {};
  try {
    const sendKeys = accounts.map((a) => `${a.email}:${today}`);
    const [lc, st] = await Promise.all([
      kv.hgetall(LAST_CHECK_KEY).catch(() => ({})),
      kv.hmget(DAILY_SEND_KEY, ...sendKeys).catch(() => ({})),
    ]);
    lastCheck = lc && typeof lc === 'object' ? lc : {};
    for (const a of accounts) sentToday[a.email] = parseInt((st && st[`${a.email}:${today}`]) || '0', 10) || 0;
  } catch {}

  const ctx = {
    now,
    lastCheck,
    ownFilter: buildOwnFilter(),
    hardDeadline: started + RUN_BUDGET_MS,
  };

  // ── Scan (3 at a time, each under its own deadline) ──
  const settled = await settleAll(accounts, CONCURRENCY, async (account) => {
    if (Date.now() > ctx.hardDeadline - 3000) {
      return { account: account.email, host: account.imap.host, skipped: 'no_time', ok: false, complete: false, folders: [], scanned: 0, candidates: 0, hard: [], delayed: 0, unknown: 0, unresolved: 0, ms: 0 };
    }
    return runAccount(account, ctx);
  });

  const hardItems = [];
  const watermarks = {};
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const s = settled[i];
    const r = s.status === 'fulfilled' && s.value ? s.value : {
      account: account.email, host: account.imap.host, ok: false, complete: false, folders: [],
      scanned: 0, candidates: 0, hard: [], delayed: 0, unknown: 0, unresolved: 0, error: errText(s.reason), ms: 0,
    };
    if (r.skipped) {
      summary.skipped++;
      summary.perInbox.push({ account: account.email, host: r.host, ok: false, skipped: r.skipped });
      continue;
    }
    summary.checked++;
    summary.delayed += r.delayed || 0;
    summary.candidates += r.candidates || 0;
    const folderErrors = (r.folders || []).filter((f) => f.error && f.error !== 'missing');
    summary.perInbox.push({
      account: account.email,
      host: r.host,
      ok: r.ok,
      complete: Boolean(r.ok && r.complete),
      since: r.since || null,
      folders: r.folders,
      scanned: r.scanned,
      candidates: r.candidates,
      hard: r.hard.length,
      delayed: r.delayed,
      unknown: r.unknown,
      unresolved: r.unresolved,
      ms: r.ms,
      error: r.error || null,
    });
    if (r.error) summary.errors.push({ account: account.email, error: r.error });
    for (const f of folderErrors) summary.errors.push({ account: account.email, folder: f.folder, error: f.error });
    if (r.ok && r.complete) watermarks[account.email] = new Date(now).toISOString();
    for (const item of r.hard) hardItems.push(item);
    try {
      await recordImapResult(account.email, {
        ok: r.ok, error: r.error, ms: r.ms, newMessages: r.scanned, candidates: r.candidates,
        folders: (r.folders || []).map((f) => f.folder),
      });
    } catch {}
    console.log(`[bounce-scan] IMAP ${r.ok ? 'ok ' : 'ERR'} ${account.email} via ${r.host} — scanned=${r.scanned} dsn=${r.candidates} hard=${r.hard.length} delayed=${r.delayed} ms=${r.ms}${r.error ? ' :: ' + r.error : ''}`);
  }

  // ── Resolve hard bounces against leads (one batched lookup) ──
  const byEmail = new Map();
  for (const item of hardItems) if (!byEmail.has(item.email)) byEmail.set(item.email, item);
  const perAccountNew = {};
  if (byEmail.size) {
    let leads = {};
    try { leads = await getLeadsByEmail([...byEmail.keys()]); } catch { leads = {}; }
    for (const [email, item] of byEmail) {
      const lead = leads[email] || null;
      if (!lead) {
        summary.details.push({ email, action: 'no_lead', reason: item.reason, account: item.account });
        continue;
      }
      if (!isBounceEligible(lead)) {
        summary.details.push({ email, action: 'skipped', status: lead.status || null, reason: item.reason, account: item.account });
        continue;
      }
      try {
        const updated = await markLeadBounced(email, item.reason, { source: 'bounce-scan', account: item.account });
        if (!updated || updated.status !== 'bounced') {
          summary.details.push({ email, action: 'skipped', status: updated ? updated.status : null, reason: item.reason, account: item.account });
          continue;
        }
        summary.bounced++;
        perAccountNew[item.account] = (perAccountNew[item.account] || 0) + 1;
        summary.details.push({
          email,
          action: 'marked',
          reason: item.reason,
          account: item.account,
          company: lead.company || lead.company_name || null,
          statusBefore: lead.status || null,
          folder: item.folder,
          subject: item.subject,
          bouncedAt: item.date,
        });
        try {
          await kv.hset(BOUNCES_KEY, {
            [email]: { email, bouncedAt: item.date, reason: item.reason, account: item.account, subject: item.subject, source: 'bounce-scan' },
          });
        } catch {}
      } catch (err) {
        summary.errors.push({ email, error: `mark: ${errText(err)}` });
      }
    }
  }

  // ── Per-inbox bounce counters + alert (never auto-disables; the sender reads the flag) ──
  for (const account of accounts) {
    const n = perAccountNew[account.email] || 0;
    if (!n) continue;
    const sends = sentToday[account.email] || 0;
    const threshold = Math.max(3, Math.ceil(sends * 0.1));
    const at = new Date().toISOString();
    try {
      await updateInboxHealth(account.email, (h) => {
        const prev = h.bouncesTodayKey === today ? Number(h.bouncesToday) || 0 : 0;
        const bouncesToday = prev + n;
        const patch = {
          bouncesToday,
          bouncesTodayKey: today,
          bouncesTotal: (Number(h.bouncesTotal) || 0) + n,
          lastBounceAt: at,
        };
        if (bouncesToday > threshold) {
          patch.bounceAlert = true;
          patch.bounceAlertAt = h.bounceAlert && h.bounceAlertAt ? h.bounceAlertAt : at;
          patch.bounceAlertDetail = `${bouncesToday} bounces today vs ${sends} sends`;
        }
        return patch;
      });
    } catch {}
  }

  // ── Advance watermarks only for accounts that completed a full scan ──
  if (Object.keys(watermarks).length) {
    try { await kv.hset(LAST_CHECK_KEY, watermarks); } catch (err) { summary.errors.push({ error: `watermark: ${errText(err)}` }); }
  }

  summary.durationMs = Date.now() - started;
  console.log(`[bounce-scan] done checked=${summary.checked} skipped=${summary.skipped} candidates=${summary.candidates} bounced=${summary.bounced} delayed=${summary.delayed} errors=${summary.errors.length} ms=${summary.durationMs}`);
  return summary;
}

export async function GET(request) {
  // Auth check (same pattern as check-replies)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    const authHeader = request.headers.get('authorization');

    if (authHeader !== `Bearer ${cronSecret}` && tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await checkAllBounces();
    return Response.json({ success: true, ...result });
  } catch (err) {
    // Never throw out of the handler: report the failure with the same shape.
    return Response.json({
      success: false,
      error: errText(err),
      checked: 0,
      bounced: 0,
      delayed: 0,
      skipped: 0,
      details: [],
      errors: [{ error: errText(err) }],
      perInbox: [],
      durationMs: 0,
      timestamp: new Date().toISOString(),
    });
  }
}
