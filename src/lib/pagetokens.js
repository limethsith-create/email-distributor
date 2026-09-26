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

// ─── the hub's `links` (docs/HUB-API.md) ─────────────────────────────────────

/** The client links the hub shows: the onboarding page, the approval page, the decision page. */
export const LINK_PURPOSES = ['onboarding', 'approval', 'decision'];

/**
 * Remember the LAST link of a purpose the client was sent, on the trial hash
 * (`{purpose}Link`, `{purpose}LinkAt`). Only the token's hash is stored for
 * checking; the link itself was emailed to the client, so keeping it lets the
 * hub show "open their onboarding page" without minting another. Never throws.
 */
export async function rememberLink(clientId, purpose, url, { now = new Date() } = {}) {
  const p = String(purpose || '').split(':')[0];
  if (!clientId || !LINK_PURPOSES.includes(p) || !url) return false;
  try {
    await kv.hset(K.trial(clientId), { [`${p}Link`]: String(url), [`${p}LinkAt`]: now.toISOString() });
    return true;
  } catch { return false; }
}

/** The raw token inside a /c/{token}/… link, or null. */
const tokenIn = (url) => /\/c\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/.exec(String(url || ''))?.[1] || null;

/**
 * `links` for the trial detail: each remembered link while its token still
 * works (expired, replaced or used-up tokens drop out). `trial` = the trial
 * hash when the caller has it (saves a read).
 */
export async function currentLinks(clientId, trial = null) {
  const t = trial || (await kv.hgetall(K.trial(clientId)).catch(() => null)) || {};
  const out = {};
  for (const p of LINK_PURPOSES) {
    const url = t[`${p}Link`];
    const raw = tokenIn(url);
    if (!raw) continue;
    try { if (await readToken(raw, { purpose: p })) out[p] = String(url); } catch {}
  }
  return out;
}
