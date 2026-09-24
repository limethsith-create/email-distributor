/**
 * Secrets at rest (SPEC §14.1): inbox passwords are AES-256-GCM encrypted
 * under ENC_KEY (32 bytes, base64). Output is `v1.<iv>.<tag>.<ciphertext>`,
 * each part base64url. Nothing here ever logs a plaintext.
 */

import crypto from 'crypto';

function key() {
  const raw = process.env.ENC_KEY || '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENC_KEY must be 32 bytes, base64-encoded');
  return buf;
}

export function hasEncKey() {
  try { key(); return true; } catch { return false; }
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('not an encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** 32-byte random token (hex) and its SHA-256 (what gets stored). */
export function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Constant-time string compare. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
