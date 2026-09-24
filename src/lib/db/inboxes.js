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

/** Add or replace an inbox. `password` is plaintext here and never stored as such. */
export async function saveInbox(clientId, { email, password, displayName, provider = 'google', dailyCap, enabled = false }) {
  assertClientId(clientId);
  const addr = norm(email);
  if (!addr.includes('@')) throw new Error('invalid inbox email');
  const cfg = PROVIDERS[provider] || PROVIDERS.google;
  const rec = {
    email: addr,
    clientId,
    displayName: String(displayName || addr.split('@')[0]).trim(),
    provider,
    smtpHost: cfg.smtp.host,
    smtpPort: cfg.smtp.port,
    imapHost: cfg.imap.host,
    imapPort: cfg.imap.port,
    enabled: enabled ? '1' : '0',
    updatedAt: new Date().toISOString(),
  };
  if (password) rec.passwordEnc = encrypt(String(password).replace(/\s+/g, ''));
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
