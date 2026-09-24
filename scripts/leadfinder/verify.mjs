// Lead Finder — address checks (SPEC §7.2 steps 4–5): syntax → MX → Reoon.
import { Resolver } from 'node:dns/promises';

const resolver = new Resolver({ timeout: 4000, tries: 2 });
const mxCache = new Map();

export const syntaxOk = (e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(e || ''));

/** 'mx' | 'none' | 'timeout' for a domain (cached per run). */
export async function mxStatus(domain, { resolveMx = (d) => resolver.resolveMx(d) } = {}) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let status;
  try {
    const recs = (await resolveMx(domain)) || [];
    status = recs.some((r) => r && r.exchange && r.exchange !== '.') ? 'mx' : 'none';
  } catch (err) {
    status = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err?.code) ? 'none' : 'timeout';
  }
  if (status !== 'timeout') mxCache.set(domain, status);
  return status;
}

/**
 * Reoon single verify (power mode). Maps to 'valid' | 'invalid' | 'catchall' | 'unknown'.
 * https://emailverifier.reoon.com/api/v1/verify?email=…&key=…&mode=power
 */
export async function reoonVerify(email, { apiKey, fetchImpl = fetch } = {}) {
  try {
    const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { status: 'unknown', raw: `http ${res.status}` };
    const j = await res.json();
    const s = String(j.status || '').toLowerCase();
    if (s === 'safe' || s === 'valid') return { status: 'valid', raw: s };
    if (s === 'catch_all' || s === 'catchall' || j.is_catch_all === true) return { status: 'catchall', raw: s };
    if (['invalid', 'disabled', 'disposable', 'spamtrap'].includes(s)) return { status: 'invalid', raw: s };
    if (s === 'role_account' && j.is_deliverable) return { status: 'valid', raw: s };
    return { status: 'unknown', raw: s };
  } catch (err) {
    return { status: 'unknown', raw: err.message };
  }
}

/**
 * A shared Reoon budget for the run (free daily credits handed over by the
 * app). `take()` returns false when none are left.
 */
export function reoonBudget(n) {
  let left = Math.max(0, Number(n) || 0);
  let used = 0;
  return {
    take() { if (left <= 0) return false; left--; used++; return true; },
    get used() { return used; },
    get left() { return left; },
  };
}
