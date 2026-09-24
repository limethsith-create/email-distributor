/**
 * Signed client page tokens (SPEC §14.3). 32 random bytes, only the SHA-256
 * is stored, one purpose per token, TTL 14 days (onboarding/approval) or 24 h
 * (tap buttons, decision). One-shot tokens are deleted when used.
 *
 * Stored at client:{id}:token:{purpose} = { hash, data, oneShot } and a
 * reverse lookup tokenidx:{hash} = { clientId, purpose } so a URL only needs
 * the raw token: /c/{token}/...
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { newToken, sha256 } from '@/lib/crypto';

export const TTL = { long: 14 * 86400, short: 24 * 3600 };

export async function mintToken(clientId, purpose, { ttl = TTL.long, oneShot = false, data = null } = {}) {
  const { token, hash } = newToken();
  const rec = { hash, clientId, purpose, oneShot, data, createdAt: new Date().toISOString() };
  const p = kv.pipeline();
  p.set(K.token(clientId, purpose), rec, { ex: ttl });
  p.set(`tokenidx:${hash}`, { clientId, purpose }, { ex: ttl });
  await p.exec();
  return token;
}

/** Resolve a raw token → { clientId, purpose, data } or null. `consume` deletes one-shot tokens. */
export async function readToken(raw, { purpose = null, consume = false } = {}) {
  if (!raw || String(raw).length < 20) return null;
  const hash = sha256(raw);
  const idx = await kv.get(`tokenidx:${hash}`);
  if (!idx) return null;
  if (purpose && idx.purpose !== purpose && !String(idx.purpose).startsWith(`${purpose}:`)) return null;
  const rec = await kv.get(K.token(idx.clientId, idx.purpose));
  if (!rec || rec.hash !== hash) return null;
  if (consume && rec.oneShot) await kv.del(K.token(idx.clientId, idx.purpose), `tokenidx:${hash}`);
  return { clientId: idx.clientId, purpose: idx.purpose, data: rec.data || null };
}

export function pageUrl(token, path = '') {
  const base = (process.env.PUBLIC_BASE_URL || 'https://email-distributor.vercel.app').replace(/\/+$/, '');
  return `${base}/c/${token}${path ? `/${path.replace(/^\/+/, '')}` : ''}`;
}
