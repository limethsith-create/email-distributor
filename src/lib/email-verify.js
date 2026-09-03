/**
 * Email Verification Module
 *
 * MX Record Check — does the domain have mail servers?
 * Verdicts are cached per domain in Redis (7 days) so one lookup covers every
 * lead at that company.
 *
 * NOTE: SMTP RCPT TO verification was removed because Vercel blocks
 * outbound port 25, causing 10-20s timeouts per lead for no benefit.
 * The A-record fallback is gone too: a B2B domain that serves a website but
 * publishes no MX is a bounce, not a mailbox.
 */

import { Resolver } from 'dns/promises';
import { kv } from '@vercel/kv';

const MX_CACHE_KEY = 'mx_verify'; // Hash: domain -> { hasMX, servers, checkedAt }
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Re-verify after 7 days
const DNS_TIMEOUT_MS = 4000;

const resolver = new Resolver({ timeout: 3000, tries: 2 });

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve the domain's mail servers.
 * Returns { status: 'mx' | 'none' | 'timeout', servers }.
 *   'none'    — no MX, an explicit null MX ("." / empty exchange), or NXDOMAIN
 *   'timeout' — the resolver did not answer in time (transient)
 */
async function resolveMX(domain) {
  try {
    const records = await withTimeout(resolver.resolveMx(domain), DNS_TIMEOUT_MS);
    const usable = (records || []).filter((r) => r && r.exchange && r.exchange !== '.');
    if (!usable.length) return { status: 'none', servers: [] };
    usable.sort((a, b) => a.priority - b.priority);
    return { status: 'mx', servers: usable.slice(0, 3).map((r) => r.exchange) };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      return { status: 'none', servers: [] };
    }
    // ETIMEOUT / ESERVFAIL / ECONNREFUSED / anything else: the resolver, not
    // the domain — treated like a timeout (transient, never cached).
    return { status: 'timeout', servers: [] };
  }
}

/**
 * Check MX records for a domain (with Redis cache).
 * Returns { hasMX, servers, checkedAt, cached, timedOut }.
 */
async function checkDomainMX(domain) {
  try {
    const cached = await kv.hget(MX_CACHE_KEY, domain);
    if (cached && typeof cached === 'object' && cached.checkedAt) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age >= 0 && age < CACHE_TTL_MS) {
        return { hasMX: !!cached.hasMX, servers: cached.servers || [], checkedAt: cached.checkedAt, cached: true, timedOut: false };
      }
    }
  } catch {}

  const mx = await resolveMX(domain);
  if (mx.status === 'timeout') {
    // Transient: do not cache, do not strand the lead.
    return { hasMX: true, servers: [], checkedAt: new Date().toISOString(), cached: false, timedOut: true };
  }

  const result = {
    hasMX: mx.status === 'mx',
    servers: mx.servers,
    checkedAt: new Date().toISOString(),
  };
  try { await kv.hset(MX_CACHE_KEY, { [domain]: result }); } catch {}
  return { ...result, cached: false, timedOut: false };
}

/**
 * MX-only email verification.
 * Returns { valid, reason: 'invalid_format' | 'no_mx' | 'mx_verified' | 'dns_timeout', cached, servers }.
 * A DNS timeout fails open (valid: true) and is never cached.
 */
export async function verifyEmail(email) {
  const lower = String(email || '').toLowerCase().trim();
  const at = lower.indexOf('@');
  const domain = at > 0 ? lower.slice(at + 1) : '';
  if (!domain || !domain.includes('.') || /\s/.test(lower) || lower.indexOf('@', at + 1) !== -1) {
    return { valid: false, reason: 'invalid_format', cached: false, servers: [] };
  }

  const mx = await checkDomainMX(domain);
  if (mx.timedOut) return { valid: true, reason: 'dns_timeout', cached: false, servers: [] };
  if (!mx.hasMX) return { valid: false, reason: 'no_mx', cached: mx.cached, servers: [] };
  return { valid: true, reason: 'mx_verified', cached: mx.cached, servers: mx.servers };
}

/**
 * Quick MX-only check (faster, less accurate but catches dead domains)
 * Use this for bulk pre-filtering. A DNS timeout counts as deliverable.
 */
export async function quickVerifyDomain(email) {
  const lower = String(email || '').toLowerCase().trim();
  const domain = lower.split('@')[1];
  if (!domain) return false;
  const mx = await checkDomainMX(domain);
  return mx.timedOut || mx.hasMX;
}
