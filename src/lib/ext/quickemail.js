/**
 * QuickEmailVerification — free: 100 checks a day, API included (work-email
 * signup). GET https://api.quickemailverification.com/v1/verify?email=&apikey=
 * → result valid|invalid|unknown, accept_all, disposable, role, safe_to_send;
 * remaining credits in the X-QEV-Remaining-Credits header
 * (docs/research/v2-leads-copy.md, checked 2026-09-25).
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'quickemail';
export const configured = () => Boolean(process.env.QUICKEMAILVERIFICATION_API_KEY);
const yes = (v) => v === true || String(v).toLowerCase() === 'true';

export function mapQuickEmail(j = {}) {
  if (j.success !== undefined && !yes(j.success)) {
    const msg = String(j.message || 'error');
    return { status: 'unknown', raw: msg, error: /credit|limit|quota/i.test(msg) ? 'quota' : /key|auth/i.test(msg) ? 'auth' : 'http' };
  }
  const result = String(j.result || '').toLowerCase();
  if (yes(j.disposable)) return { status: 'invalid', raw: 'disposable' };
  if (result === 'invalid') return { status: 'invalid', raw: String(j.reason || result) };
  if (yes(j.accept_all)) return { status: 'catchall', raw: 'accept_all' };
  if (result === 'valid') return { status: yes(j.safe_to_send) || j.safe_to_send === undefined ? 'valid' : 'risky', raw: String(j.reason || result) };
  return { status: 'unknown', raw: String(j.reason || result || 'no result') };
}

export async function verify(email, { apiKey = process.env.QUICKEMAILVERIFICATION_API_KEY, timeoutMs = 15_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'QUICKEMAILVERIFICATION_API_KEY is not set', error: 'nokey' };
  try {
    const res = await fetchExt(`https://api.quickemailverification.com/v1/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(apiKey)}`, { timeoutMs, retry: false });
    const left = Number(res.headers?.get?.('x-qev-remaining-credits'));
    const j = await res.json().catch(() => null);
    if (res.status === 401) return { status: 'unknown', raw: 'http 401', error: 'auth' };
    if (res.status === 402 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    if (!res.ok || !j) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    const out = mapQuickEmail(j);
    if (Number.isFinite(left)) out.remaining = left;
    return out;
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
