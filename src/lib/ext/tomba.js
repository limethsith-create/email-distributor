/**
 * Tomba.io — free tier: 25 searches + 50 verifications a month per Tomba's
 * own blog (the pricing page and API page disagree — see
 * docs/research/v2-leads-copy.md, checked 2026-09-25). GET
 * https://api.tomba.io/v1/email-verifier?email= with X-Tomba-Key +
 * X-Tomba-Secret → data.email.result (deliverable …), status, accept_all.
 * The full list of values is not published, so anything unrecognised is
 * `unknown` (never a guess).
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'tomba';
export const configured = () => Boolean(process.env.TOMBA_API_KEY && process.env.TOMBA_API_SECRET);

export function mapTomba(data = {}) {
  const e = data.email || data;
  const result = String(e.result || '').toLowerCase();
  const status = String(e.status || '').toLowerCase();
  if (e.disposable === true) return { status: 'invalid', raw: 'disposable' };
  if (result === 'undeliverable' || status === 'invalid') return { status: 'invalid', raw: result || status };
  if (e.accept_all === true) return { status: 'catchall', raw: 'accept_all' };
  if (result === 'deliverable' && (status === 'valid' || !status)) return { status: 'valid', raw: result };
  if (result === 'risky') return { status: 'risky', raw: result };
  return { status: 'unknown', raw: result || status || 'no result' };
}

export async function verify(email, { key = process.env.TOMBA_API_KEY, secret = process.env.TOMBA_API_SECRET, timeoutMs = 15_000 } = {}) {
  if (!key || !secret) return { status: 'unknown', raw: 'TOMBA_API_KEY / TOMBA_API_SECRET are not set', error: 'nokey' };
  try {
    const res = await fetchExt(`https://api.tomba.io/v1/email-verifier?email=${encodeURIComponent(email)}`, { headers: { 'X-Tomba-Key': key, 'X-Tomba-Secret': secret }, timeoutMs, retry: false });
    if (res.status === 401 || res.status === 403) return { status: 'unknown', raw: `http ${res.status}`, error: 'auth' };
    if (res.status === 402 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.data) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    return mapTomba(j.data);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
