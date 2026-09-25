// Lead Finder — the free, local address checks (SPEC §7.2 steps 4–5, Leads
// v2): syntax → disposable domain → MX. The paid-per-credit API verifiers
// (Reoon, Hunter, …) run in the app's verification waterfall
// (src/lib/systems/verify.js), which owns the keys and the daily / monthly
// free budgets; every lead this job posts is `verifyStatus: pending` until
// that waterfall has checked it. SMTP "handshake" checks are not attempted:
// GitHub-hosted runners and Vercel cannot open outbound port 25, and Google
// Workspace / Microsoft 365 answer them unreliably anyway.
import { Resolver } from 'node:dns/promises';
import { syntaxOk as syntaxRule, isDisposable } from '../../src/lib/leadquality/rules.mjs';

const resolver = new Resolver({ timeout: 4000, tries: 2 });
const mxCache = new Map();

export const syntaxOk = syntaxRule;
export { isDisposable };

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

export function clearMxCache() { mxCache.clear(); }

/**
 * Local verdict for one address: 'invalid' (bad syntax, disposable, no mail
 * server) or 'pending' (passes; the app's API waterfall decides).
 */
export async function localCheck(email, { resolveMx } = {}) {
  if (!syntaxOk(email)) return { status: 'invalid', reason: 'syntax' };
  if (isDisposable(email)) return { status: 'invalid', reason: 'disposable' };
  const mx = await mxStatus(String(email).split('@')[1], resolveMx ? { resolveMx } : {});
  if (mx === 'none') return { status: 'invalid', reason: 'no_mx' };
  return { status: 'pending', mx };
}
