/**
 * Reoon Email Verifier (SPEC §13): single verify, power mode. Free tier is
 * 20 checks/day; the caller checks the daily budget first. Maps the answer to
 * { valid: true|false|null, status, raw } — null = unknown (never a guess).
 */

import { fetchJson } from '@/lib/ext/http';

export async function reoonVerify(email, { apiKey = process.env.REOON_API_KEY } = {}) {
  if (!apiKey) return { valid: null, status: 'unknown', raw: 'REOON_API_KEY is not set' };
  try {
    const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`;
    const r = await fetchJson(url, { service: 'reoon', usageField: 'checks', timeoutMs: 30_000, retry: false });
    if (!r.ok || !r.json) return { valid: null, status: 'unknown', raw: `http ${r.status}` };
    const j = r.json;
    const s = String(j.status || '').toLowerCase();
    if (s === 'safe' || s === 'valid') return { valid: true, status: 'valid', raw: s };
    if (s === 'catch_all' || s === 'catchall' || j.is_catch_all === true) return { valid: true, status: 'catchall', raw: s };
    if (['invalid', 'disabled', 'disposable', 'spamtrap'].includes(s)) return { valid: false, status: 'invalid', raw: s };
    if (s === 'role_account' && j.is_deliverable) return { valid: true, status: 'valid', raw: s };
    return { valid: null, status: 'unknown', raw: s };
  } catch (err) {
    return { valid: null, status: 'unknown', raw: err.message };
  }
}
