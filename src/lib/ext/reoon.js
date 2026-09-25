/**
 * Reoon Email Verifier (SPEC §13): single verify, power mode (quick mode does
 * not check the mailbox). Free: 20 checks a day (up to 600 a month) + 100 on
 * signup; one-time packs never expire. API: GET
 * https://emailverifier.reoon.com/api/v1/verify?email=&key=&mode=power
 * (docs/research/v2-leads-copy.md, checked 2026-09-25). Unknown results are
 * not charged by Reoon.
 *
 * `reoonVerify` keeps the v1 shape { valid: true|false|null, status, raw }
 * (null = unknown, never a guess); `verify` is the waterfall adapter
 * ({ status: valid|invalid|catchall|risky|unknown, raw, error? }).
 */

import { fetchJson } from '@/lib/ext/http';

export const SERVICE = 'reoon';
export const configured = () => Boolean(process.env.REOON_API_KEY);

export function mapReoon(j = {}) {
  const s = String(j.status || '').toLowerCase();
  if (s === 'error' || j.error) {
    const msg = String(j.reason || j.message || j.error || 'error');
    return { status: 'unknown', raw: msg, error: /credit|balance|limit|quota/i.test(msg) ? 'quota' : /key|auth/i.test(msg) ? 'auth' : 'http' };
  }
  if (s === 'safe' || s === 'valid') return { status: 'valid', raw: s };
  if (s === 'catch_all' || s === 'catchall' || j.is_catch_all === true) return { status: 'catchall', raw: s };
  if (['invalid', 'disabled', 'disposable', 'spamtrap'].includes(s)) return { status: 'invalid', raw: s };
  if (s === 'role_account') return { status: j.is_deliverable || j.is_safe_to_send ? 'valid' : 'risky', raw: s };
  if (s === 'inbox_full') return { status: 'risky', raw: s };
  return { status: 'unknown', raw: s || 'no status' };
}

export async function verify(email, { apiKey = process.env.REOON_API_KEY, timeoutMs = 30_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'REOON_API_KEY is not set', error: 'nokey' };
  try {
    const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`;
    const r = await fetchJson(url, { service: 'reoon', usageField: 'checks', timeoutMs, retry: false });
    if (r.status === 401 || r.status === 403) return { status: 'unknown', raw: `http ${r.status}`, error: 'auth' };
    if (r.status === 402 || r.status === 429) return { status: 'unknown', raw: `http ${r.status}`, error: 'quota' };
    if (!r.ok || !r.json) return { status: 'unknown', raw: `http ${r.status}`, error: 'http' };
    return mapReoon(r.json);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}

/** v1 shape, kept for callers that want { valid }. */
export async function reoonVerify(email, opts = {}) {
  const r = await verify(email, opts);
  const valid = r.status === 'valid' || r.status === 'catchall' ? true : r.status === 'invalid' ? false : null;
  return { valid, status: r.status, raw: r.raw };
}
