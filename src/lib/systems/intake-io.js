/**
 * Stage A (intake) I/O seam. Every network, DNS, SMTP, IMAP and notification
 * call made by the intake systems goes through the mutable `io` object below,
 * so tests can replace one member with a stub and never touch the network.
 *
 * Also holds the small helpers the intake systems share: value parsing for
 * hashes (Upstash returns JSON as objects, the fake KV returns strings),
 * client-email sending that turns a render failure into a thrown error, the
 * owner sign-off, and US business-day arithmetic.
 */

import dnsp from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { alertOwner, notifyClient, sendOwnerEmail, sendTelegram } from '@/lib/notify';
import { fetchExt, fetchJson } from '@/lib/ext/http';
import { sendEmail, testConnection } from '@/lib/mailer';
import { cfg, isUsHoliday } from '@/lib/config';
import { addDays, isWeekday } from '@/lib/time';

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), { code: 'ETIMEOUT' })), ms); }),
  ]);
}

function imapClient(account) {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: true,
    // imapUser: a login name other than the address (iCloud: the part before the @).
    auth: { user: account.imapUser || account.email, pass: account.appPassword || account.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 10000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });
}

/** Login + confirm the spam folder exists. Never throws. */
async function imapLogin(account) {
  const client = imapClient(account);
  try {
    await client.connect();
    const list = await client.list();
    const spam = account.spamFolder || '[Gmail]/Spam';
    const spamFolderExists = list.some((f) => f.path === spam || (f.specialUse === '\\Junk'));
    return { ok: true, spamFolderExists };
  } catch (err) {
    return { ok: false, error: String(err?.responseText || err?.message || err).slice(0, 200), auth: Boolean(err?.authenticationFailed) };
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Look for a message whose subject contains `needle` in INBOX and the spam
 * folder. Returns { found, folder, headers } — headers is the raw header text.
 */
async function imapFindMessage(account, needle, since) {
  const client = imapClient(account);
  try {
    await client.connect();
    for (const folder of ['INBOX', account.spamFolder || '[Gmail]/Spam']) {
      let lock;
      try { lock = await client.getMailboxLock(folder); } catch { continue; }
      try {
        const uids = await client.search({ subject: needle, since: since ? new Date(since) : undefined }, { uid: true });
        if (uids && uids.length) {
          const msg = await client.fetchOne(String(uids[uids.length - 1]), { headers: true }, { uid: true });
          return { found: true, folder, headers: msg?.headers ? msg.headers.toString('utf8') : '' };
        }
      } finally {
        try { lock.release(); } catch {}
      }
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: String(err?.message || err).slice(0, 200) };
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Fetch recent messages with attachments from an IMAP inbox (DMARC collector).
 * Returns [{ uid, subject, attachments: [{ filename, content: Buffer }] }] for
 * UIDs above `afterUid`, at most `max`, plus the highest UID seen.
 */
async function imapFetchAttachments(account, { afterUid = 0, since, max = 25 } = {}) {
  const client = imapClient(account);
  const out = [];
  let maxUid = afterUid;
  let more = false;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = ((await client.search({ since: since ? new Date(since) : undefined }, { uid: true })) || []).filter((u) => u > afterUid).sort((a, b) => a - b);
      more = uids.length > max;
      for (const uid of uids.slice(0, max)) {
        const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
        const parts = [];
        (function walk(node) {
          if (!node) return;
          if (node.childNodes) node.childNodes.forEach(walk);
          const name = node.dispositionParameters?.filename || node.parameters?.name || '';
          if (/\.(xml|gz|zip)$/i.test(name) || /(zip|gzip|xml)/i.test(node.type || '')) parts.push({ part: node.part || '1', filename: name || node.type });
        })(msg.bodyStructure);
        const attachments = [];
        for (const p of parts.slice(0, 3)) {
          const { content } = await client.download(String(uid), p.part, { uid: true });
          const chunks = [];
          let size = 0;
          for await (const c of content) { size += c.length; if (size > 5 * 1024 * 1024) break; chunks.push(c); }
          attachments.push({ filename: p.filename, content: Buffer.concat(chunks) });
        }
        out.push({ uid, subject: msg.envelope?.subject || '', attachments });
        if (uid > maxUid) maxUid = uid;
      }
    } finally {
      lock.release();
    }
    return { ok: true, messages: out, maxUid, more };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200), messages: out, maxUid, more };
  } finally {
    try { await client.logout(); } catch {}
  }
}

export const io = {
  now: () => new Date(),
  alertOwner,
  notifyClient,
  sendOwnerEmail,
  sendTelegram,
  fetchExt,
  fetchJson,
  sendEmail,
  smtpVerify: (account) => testConnection(account.email, account.appPassword || account.password, account.smtp),
  imapLogin,
  imapFindMessage,
  imapFetchAttachments,
  // One bounded IMAP pass (systems/imap-scan.js) — the onboarding-call inbox check uses it.
  scanMailbox: async (account, opts) => (await import('@/lib/systems/imap-scan')).scanMailbox(account, opts),
  dns: {
    real: true, // the live resolver (tests swap the whole object; webintel refuses the real one in tests)
    resolveTxt: (name, ms = 4000) => withTimeout(dnsp.resolveTxt(name), ms, `TXT ${name}`),
    resolveMx: (name, ms = 4000) => withTimeout(dnsp.resolveMx(name), ms, `MX ${name}`),
    resolve4: (name, ms = 4000) => withTimeout(dnsp.resolve4(name), ms, `A ${name}`),
  },
};

// ── shared helpers ───────────────────────────────────────────────────────────

/** Array from a hash value that may be an array, a JSON string or a list. */
export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j; } catch {}
    return v.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** Object from a hash value that may be an object or a JSON string. */
export function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v) { try { const j = JSON.parse(v); if (j && typeof j === 'object') return j; } catch {} }
  return null;
}

export const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'y', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Only fetch user-supplied URLs (calendar links, websites) that point at a
 * public host: http(s), no credentials, no localhost / private / link-local
 * IP literals, no .local / .internal names.
 */
export function isPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost)$/.test(h)) return false;
  if (h.includes(':')) return false; // IPv6 literals
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  return true;
}

/** First word of a person's name. */
export const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * The owner's sign-off name (OWNER.signerName). Missing → config_missing
 * alert and an error, so nothing goes out unsigned (rule 4).
 */
export async function ownerName(clientId = null) {
  const name = await cfg(clientId, 'OWNER.signerName');
  if (name) return String(name);
  await io.alertOwner('config_missing', { clientId, scope: 'OWNER.signerName', vars: { key: 'OWNER.signerName' }, body: 'The owner signer name (OWNER.signerName) is not set in /mc/config. Client emails and the trial agreement need it.', did: 'Held the client email; it goes out on the next run once the name is set.' });
  throw new Error('OWNER.signerName is not set');
}

/**
 * Email a client through the Notifier. A render failure (missing slot) comes
 * back from notifyClient as {sent:false, error}; here it becomes a thrown
 * error so the caller leaves state unchanged. A dedupe hit is success.
 */
export async function sendClient(clientId, key, vars, opts = {}) {
  const res = await io.notifyClient(clientId, key, vars, opts);
  if (res && res.error) throw new Error(`${key}: ${res.error}`);
  return res || { sent: true };
}

// ── US business days (ET calendar) ───────────────────────────────────────────

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const weekdayOf = (dayKey) => WEEKDAY[new Date(`${dayKey}T12:00:00Z`).getUTCDay()];
export const isUsBusinessDay = (dayKey) => isWeekday(weekdayOf(dayKey)) && !isUsHoliday(dayKey);

/** The day itself if it is a US business day, else the next one. */
export function nextUsBusinessDay(dayKey) {
  let d = dayKey;
  for (let i = 0; i < 14 && !isUsBusinessDay(d); i++) d = addDays(d, 1);
  return d;
}

/** Business days from dayKey a (exclusive) to b (inclusive); 0 when b ≤ a. */
export function businessDaysBetween(a, b) {
  let n = 0;
  let d = a;
  for (let i = 0; i < 400 && d < b; i++) { d = addDays(d, 1); if (isUsBusinessDay(d)) n++; }
  return n;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LONG_WEEKDAY = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
/** '2026-10-12' → 'Monday 12 October' (or '12 October 2026' with { date: true }). */
export function formatDay(dayKey, { date = false } = {}) {
  if (!dayKey) return '';
  const [y, m, d] = dayKey.split('-').map(Number);
  return date ? `${d} ${MONTHS[m - 1]} ${y}` : `${LONG_WEEKDAY[weekdayOf(dayKey)]} ${d} ${MONTHS[m - 1]}`;
}
