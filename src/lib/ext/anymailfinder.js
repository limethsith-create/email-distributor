/**
 * Anymailfinder — 100 free credits once (card check, not charged); a verify
 * costs 0.2 credit (≈ 500 checks) and it resolves catch-all domains to
 * valid / risky / invalid. Used by the waterfall only for addresses on
 * catch-all domains, where the other verifiers can only say "catch-all".
 * POST https://api.anymailfinder.com/v5.1/verify-email {email},
 * header Authorization: <key> → email_status valid|risky|invalid
 * (docs/research/v2-leads-copy.md, checked 2026-09-25).
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'anymailfinder';
export const configured = () => Boolean(process.env.ANYMAILFINDER_API_KEY);

export function mapAnymailfinder(j = {}) {
  const s = String(j.email_status || j.status || '').toLowerCase();
  if (s === 'valid') return { status: 'valid', raw: s };
  if (s === 'invalid') return { status: 'invalid', raw: s };
  if (s === 'risky') return { status: 'catchall', raw: s }; // still unresolved: stays catch-all
  if (j.error || j.message) {
    const msg = String(j.error || j.message);
    return { status: 'unknown', raw: msg, error: /credit|balance|limit/i.test(msg) ? 'quota' : /key|auth/i.test(msg) ? 'auth' : 'http' };
  }
  return { status: 'unknown', raw: s || 'no status' };
}

export async function verify(email, { apiKey = process.env.ANYMAILFINDER_API_KEY, timeoutMs = 20_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'ANYMAILFINDER_API_KEY is not set', error: 'nokey' };
  try {
    const res = await fetchExt('https://api.anymailfinder.com/v5.1/verify-email', { method: 'POST', headers: { authorization: apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ email }), timeoutMs, retry: false });
    if (res.status === 401 || res.status === 403) return { status: 'unknown', raw: `http ${res.status}`, error: 'auth' };
    if (res.status === 402 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    const j = await res.json().catch(() => null);
    if (!j) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    return mapAnymailfinder(j);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
