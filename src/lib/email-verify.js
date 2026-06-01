/**
 * Email Verification Module
 *
 * MX Record Check — does the domain have mail servers?
 * Results are cached in Redis to avoid re-checking.
 *
 * NOTE: SMTP RCPT TO verification was removed because Vercel blocks
 * outbound port 25, causing 10-20s timeouts per lead for no benefit.
 */

import dns from 'dns';
import { kv } from '@vercel/kv';

const VERIFY_CACHE_KEY = 'email_verify'; // Hash: email -> { valid, reason, checkedAt }
const MX_CACHE_KEY = 'mx_verify'; // Hash: domain -> { hasMX, servers, checkedAt }
const CACHE_TTL_DAYS = 7; // Re-verify after 7 days

/**
 * Resolve MX records for a domain
 * Returns sorted array of mail servers or null if none found
 */
function resolveMX(domain) {
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        // Try A record as fallback (some domains handle mail without MX)
        dns.resolve4(domain, (err2, ips) => {
          if (err2 || !ips || ips.length === 0) {
            resolve(null);
          } else {
            // Domain has A record but no MX — might still accept mail
            resolve([{ exchange: domain, priority: 10 }]);
          }
        });
        return;
      }
      // Sort by priority (lowest first)
      addresses.sort((a, b) => a.priority - b.priority);
      resolve(addresses);
    });
  });
}

/**
 * Check MX records for a domain (with Redis cache)
 */
async function checkDomainMX(domain) {
  // Check cache first
  try {
    const cached = await kv.hget(MX_CACHE_KEY, domain);
    if (cached && cached.checkedAt) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
        return cached;
      }
    }
  } catch {}

  // Resolve MX
  const mxRecords = await resolveMX(domain);
  const result = {
    hasMX: !!mxRecords,
    servers: mxRecords ? mxRecords.slice(0, 3).map(r => r.exchange) : [],
    checkedAt: new Date().toISOString(),
  };

  // Cache result
  try {
    await kv.hset(MX_CACHE_KEY, { [domain]: result });
  } catch {}

  return result;
}

/**
 * MX-only email verification
 * Returns: { valid: boolean, reason: string, cached: boolean }
 */
export async function verifyEmail(email) {
  if (!email || !email.includes('@')) {
    return { valid: false, reason: 'invalid_format', cached: false };
  }

  const lower = email.toLowerCase().trim();
  const domain = lower.split('@')[1];

  // Check cache first
  try {
    const cached = await kv.hget(VERIFY_CACHE_KEY, lower);
    if (cached && cached.checkedAt) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
        return { ...cached, cached: true };
      }
    }
  } catch {}

  // MX check only (SMTP removed — port 25 blocked on Vercel)
  const mx = await checkDomainMX(domain);
  if (!mx.hasMX) {
    const result = { valid: false, reason: 'no_mx_records', checkedAt: new Date().toISOString() };
    try { await kv.hset(VERIFY_CACHE_KEY, { [lower]: result }); } catch {}
    return { ...result, cached: false };
  }

  const result = { valid: true, reason: 'mx_verified', checkedAt: new Date().toISOString() };
  try { await kv.hset(VERIFY_CACHE_KEY, { [lower]: result }); } catch {}
  return { ...result, cached: false };
}

/**
 * Quick MX-only check (faster, less accurate but catches dead domains)
 * Use this for bulk pre-filtering
 */
export async function quickVerifyDomain(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.toLowerCase().trim().split('@')[1];
  const mx = await checkDomainMX(domain);
  return mx.hasMX;
}
