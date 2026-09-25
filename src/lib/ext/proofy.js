/**
 * Proofy — no free credits, but a one-time pack that never expires ($5 for
 * 5,000 checks for new users; allowed by SPEC §1 rule 2 as a one-time
 * credit). GET https://apis.proofy.io/v1/verify/single?email=&api_key= →
 * status valid|invalid|risky|unknown, deliverability.catchAll
 * (docs/research/v2-leads-copy.md, checked 2026-09-25). Last in the waterfall:
 * it only spends when every free allowance is used up.
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'proofy';
export const configured = () => Boolean(process.env.PROOFY_API_KEY);

export function mapProofy(j = {}) {
  if (j.error || j.message && !j.status) {
    const msg = String(j.error || j.message);
    return { status: 'unknown', raw: msg, error: /credit|balance|limit/i.test(msg) ? 'quota' : /key|auth/i.test(msg) ? 'auth' : 'http' };
  }
  const s = String(j.status || j.result || '').toLowerCase();
  const catchAll = j.deliverability?.catchAll === true || j.catchAll === true;
  if (s === 'invalid') return { status: 'invalid', raw: s };
  if (catchAll) return { status: 'catchall', raw: 'catchAll' };
  if (s === 'valid') return { status: 'valid', raw: s };
  if (s === 'risky') return { status: 'risky', raw: s };
  return { status: 'unknown', raw: s || 'no status' };
}

export async function verify(email, { apiKey = process.env.PROOFY_API_KEY, timeoutMs = 15_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'PROOFY_API_KEY is not set', error: 'nokey' };
  try {
    const res = await fetchExt(`https://apis.proofy.io/v1/verify/single?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(apiKey)}`, { timeoutMs, retry: false });
    if (res.status === 401 || res.status === 403) return { status: 'unknown', raw: `http ${res.status}`, error: 'auth' };
    if (res.status === 402 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    return mapProofy(j);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
