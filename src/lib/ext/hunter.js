/**
 * Hunter.io — free: 50 credits a month, API included; a verification costs
 * 0.5 credit (100 checks a month). One account per person (Hunter terms).
 * GET https://api.hunter.io/v2/email-verifier?email= with X-API-KEY →
 * data.status valid|invalid|accept_all|webmail|disposable|unknown; HTTP 202 =
 * still checking, 222 = SMTP error (docs/research/v2-leads-copy.md, checked
 * 2026-09-25).
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'hunter';
export const configured = () => Boolean(process.env.HUNTER_API_KEY);

export function mapHunter(data = {}) {
  const s = String(data.status || '').toLowerCase();
  if (s === 'valid') return { status: 'valid', raw: s };
  if (s === 'invalid' || s === 'disposable') return { status: 'invalid', raw: s };
  if (s === 'accept_all' || data.accept_all === true) return { status: 'catchall', raw: s || 'accept_all' };
  if (s === 'webmail') return { status: data.result === 'deliverable' ? 'valid' : 'risky', raw: s };
  return { status: 'unknown', raw: s || 'no status' };
}

export async function verify(email, { apiKey = process.env.HUNTER_API_KEY, timeoutMs = 15_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'HUNTER_API_KEY is not set', error: 'nokey' };
  try {
    const res = await fetchExt(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}`, { headers: { 'X-API-KEY': apiKey }, timeoutMs, retry: false });
    if (res.status === 202 || res.status === 222) return { status: 'unknown', raw: `http ${res.status}` };
    if (res.status === 401) return { status: 'unknown', raw: 'http 401', error: 'auth' };
    if (res.status === 403 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.data) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    return mapHunter(j.data);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
