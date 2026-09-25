/**
 * ZeroBounce — free: 100 checks a month (business-domain signup, refills
 * monthly); unknowns are not charged. GET
 * https://api.zerobounce.net/v2/validate?api_key=&email=&ip_address= →
 * status valid|invalid|catch-all|unknown|spamtrap|abuse|do_not_mail,
 * sub_status (docs/research/v2-leads-copy.md, checked 2026-09-25).
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'zerobounce';
export const configured = () => Boolean(process.env.ZEROBOUNCE_API_KEY);

export function mapZeroBounce(j = {}) {
  if (j.error) {
    const msg = String(j.error);
    return { status: 'unknown', raw: msg, error: /credit|ran out/i.test(msg) ? 'quota' : /key/i.test(msg) ? 'auth' : 'http' };
  }
  const s = String(j.status || '').toLowerCase();
  const sub = String(j.sub_status || '').toLowerCase();
  if (s === 'valid') return { status: 'valid', raw: sub || s };
  if (s === 'catch-all' || s === 'catchall') return { status: 'catchall', raw: sub || s };
  if (['invalid', 'spamtrap', 'abuse'].includes(s)) return { status: 'invalid', raw: sub || s };
  if (s === 'do_not_mail') return { status: /disposable|toxic|global_suppression/.test(sub) ? 'invalid' : 'risky', raw: sub || s };
  return { status: 'unknown', raw: sub || s || 'no status' };
}

export async function verify(email, { apiKey = process.env.ZEROBOUNCE_API_KEY, timeoutMs = 15_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'ZEROBOUNCE_API_KEY is not set', error: 'nokey' };
  try {
    const res = await fetchExt(`https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&ip_address=`, { timeoutMs, retry: false });
    const j = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) return { status: 'unknown', raw: `http ${res.status}`, error: 'auth' };
    if (res.status === 429) return { status: 'unknown', raw: 'http 429', error: 'quota' };
    if (!res.ok || !j) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    return mapZeroBounce(j);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
