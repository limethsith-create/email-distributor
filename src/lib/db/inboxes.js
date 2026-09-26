/**
 * Trial inboxes stored in Redis (SPEC §3 inbox:{id}:{email}). Passwords are
 * encrypted at rest; `toAccount` turns a record into the connection object
 * mailer.js / reply-checker.js already understand.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { encrypt, decrypt } from '@/lib/crypto';
import { PROVIDERS } from '@/lib/smtp-providers';
import { logEvent } from '@/lib/db/events';

const norm = (s) => String(s || '').trim().toLowerCase();

/** A usable port number, else null. */
const portOf = (v) => { const p = parseInt(v, 10); return p > 0 && p < 65536 ? p : null; };
/** A plain host name (letters, digits, dots, dashes), else null — a provider's answer is never trusted blindly. */
const hostOf = (v) => { const h = String(v || '').trim().toLowerCase(); return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) ? h : null; };

/**
 * Add or replace an inbox. `password` (what SMTP/IMAP log in with — the app
 * password) and `loginPassword` (the account's own password, kept for the
 * owner; CheapInboxes inboxes) are plaintext here and never stored as such.
 * `smtpHost/smtpPort/imapHost/imapPort` override the provider's defaults when
 * the provider said where its servers are; `extra` adds plain fields (source).
 */
export async function saveInbox(clientId, { email, password, loginPassword, displayName, provider = 'google', dailyCap, enabled = false, smtpHost, smtpPort, imapHost, imapPort, extra = {} }) {
  assertClientId(clientId);
  const addr = norm(email);
  if (!addr.includes('@')) throw new Error('invalid inbox email');
  const cfg = PROVIDERS[provider] || PROVIDERS.google;
  const rec = {
    ...extra,
    email: addr,
    clientId,
    displayName: String(displayName || addr.split('@')[0]).trim(),
    provider,
    smtpHost: hostOf(smtpHost) || cfg.smtp.host,
    smtpPort: portOf(smtpPort) || cfg.smtp.port,
    imapHost: hostOf(imapHost) || cfg.imap.host,
    imapPort: portOf(imapPort) || cfg.imap.port,
    enabled: enabled ? '1' : '0',
    updatedAt: new Date().toISOString(),
  };
  if (password) rec.passwordEnc = encrypt(String(password).replace(/\s+/g, ''));
  if (loginPassword) rec.loginPasswordEnc = encrypt(String(loginPassword));
  if (dailyCap !== undefined) rec.dailyCap = String(dailyCap);
  await kv.hset(K.inbox(clientId, addr), rec);
  await kv.sadd(K.inboxes(clientId), addr);
  await logEvent(clientId, 'inboxes', 'inbox_saved', { email: addr, provider, passwordChanged: Boolean(password) });
  return rec;
}

export async function getInboxRecords(clientId) {
  assertClientId(clientId);
  const emails = (await kv.smembers(K.inboxes(clientId))) || [];
  if (!emails.length) return [];
  const p = kv.pipeline();
  for (const em of emails) p.hgetall(K.inbox(clientId, em));
  const rows = await p.exec();
  return rows.filter((r) => r && r.email);
}

/** A record as any API may show it: every encrypted field dropped, `hasPassword` instead. */
export function publicInbox(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) if (!/Enc$/.test(k)) out[k] = v;
  return { ...out, hasPassword: Boolean(rec?.passwordEnc) };
}

export async function patchInbox(clientId, email, fields) {
  await kv.hset(K.inbox(clientId, email), { ...fields, updatedAt: new Date().toISOString() });
}

export async function removeInbox(clientId, email) {
  await kv.srem(K.inboxes(clientId), norm(email));
  await kv.del(K.inbox(clientId, email));
  await logEvent(clientId, 'inboxes', 'inbox_removed', { email: norm(email) });
}

/** Record → account object (decrypts the password; null if it cannot). */
export function toAccount(rec) {
  let password = null;
  try { password = rec.passwordEnc ? decrypt(rec.passwordEnc) : null; } catch { password = null; }
  if (!password) return null;
  const cfg = PROVIDERS[rec.provider] || PROVIDERS.google;
  const smtpPort = parseInt(rec.smtpPort, 10) || cfg.smtp.port;
  return {
    email: rec.email,
    clientId: rec.clientId,
    appPassword: password,
    password,
    displayName: rec.displayName,
    provider: rec.provider,
    smtp: { host: rec.smtpHost || cfg.smtp.host, port: smtpPort, secure: smtpPort === 465 },
    imap: { host: rec.imapHost || cfg.imap.host, port: parseInt(rec.imapPort, 10) || cfg.imap.port },
    spamFolder: cfg.spamFolder,
    source: 'redis',
  };
}

/** Connection objects for a client's inboxes (enabledOnly = switched on). */
export async function getAccounts(clientId, { enabledOnly = false } = {}) {
  const recs = await getInboxRecords(clientId);
  return recs
    .filter((r) => !enabledOnly || r.enabled === '1' || r.enabled === 1 || r.enabled === true)
    .map((r) => ({ ...toAccount(r), record: r }))
    .filter((a) => a && a.email);
}
