/**
 * Verifalia — free: 25 credits a day (reset at midnight GMT, one free account
 * per organisation), API included. POST
 * https://api.verifalia.com/v2.7/email-validations?waitTime=… with
 * {"entries":[{"inputData": email}]}, HTTP Basic (user + password, or a
 * browser-app key). 200 = done; 202 = still running → poll
 * /email-validations/{id} once. Entry: classification Deliverable |
 * Undeliverable | Risky | Unknown, status (ServerIsCatchAll, …)
 * (docs/research/v2-leads-copy.md, checked 2026-09-25). The login: env wins,
 * else the one pasted in the hub (lib/secrets.js).
 */

import { fetchExt } from '@/lib/ext/http';
import { secretOf } from '@/lib/secrets';

export const SERVICE = 'verifalia';
const BASE = 'https://api.verifalia.com/v2.7';
export const configured = async (snap = null) => Boolean((await secretOf('VERIFALIA_USERNAME', snap)) && (await secretOf('VERIFALIA_PASSWORD', snap)));

export function mapVerifalia(entry = {}) {
  const c = String(entry.classification || '').toLowerCase();
  const s = String(entry.status || '');
  if (/catchall/i.test(s)) return { status: 'catchall', raw: s };
  if (c === 'deliverable') return { status: 'valid', raw: s || c };
  if (c === 'undeliverable') return { status: 'invalid', raw: s || c };
  if (c === 'risky') return { status: 'risky', raw: s || c };
  return { status: 'unknown', raw: s || c || 'no classification' };
}

const entryOf = (j) => (j?.entries?.data || j?.entries || [])[0] || null;

export async function verify(email, { user = undefined, pass = undefined, timeoutMs = 15_000, waitMs = 8000 } = {}) {
  user = user ?? await secretOf('VERIFALIA_USERNAME');
  pass = pass ?? await secretOf('VERIFALIA_PASSWORD');
  if (!user || !pass) return { status: 'unknown', raw: 'VERIFALIA_USERNAME / VERIFALIA_PASSWORD are not set', error: 'nokey' };
  const headers = { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' };
  try {
    let res = await fetchExt(`${BASE}/email-validations?waitTime=${waitMs}`, { method: 'POST', headers, body: JSON.stringify({ entries: [{ inputData: email }] }), timeoutMs, retry: false });
    if (res.status === 401 || res.status === 403) return { status: 'unknown', raw: `http ${res.status}`, error: 'auth' };
    if (res.status === 402 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    let j = await res.json().catch(() => null);
    if (res.status === 202 && j?.overview?.id) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetchExt(`${BASE}/email-validations/${encodeURIComponent(j.overview.id)}?waitTime=${waitMs}`, { headers, timeoutMs, retry: false });
      j = await res.json().catch(() => null);
      if (res.status === 202) return { status: 'unknown', raw: 'job still running', error: 'http' };
    }
    if (!res.ok || !j) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    const e = entryOf(j);
    return e ? mapVerifalia(e) : { status: 'unknown', raw: 'no entry', error: 'http' };
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
