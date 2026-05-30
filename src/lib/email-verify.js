/**
 * Email Verification Module
 *
 * Two-level verification before sending:
 * 1. MX Record Check — does the domain have mail servers?
 * 2. SMTP RCPT TO Check — does the mailbox actually exist?
 *
 * Results are cached in Redis to avoid re-checking.
 */

import dns from 'dns';
import net from 'net';
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
 * SMTP verification — connect to mail server, check if recipient exists
 * Uses RCPT TO command to verify without sending any email
 *
 * Returns: 'valid' | 'invalid' | 'catch_all' | 'timeout' | 'error'
 */
function smtpVerify(mxHost, recipientEmail, senderDomain = 'aviance.online') {
  return new Promise((resolve) => {
    const timeout = 10000; // 10 second timeout
    let resolved = false;
    let response = '';
    let step = 0; // 0=connect, 1=EHLO, 2=MAIL FROM, 3=RCPT TO

    const socket = net.createConnection({ host: mxHost, port: 25, timeout });

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.on('timeout', () => done('timeout'));
    socket.on('error', () => done('error'));

    socket.on('data', (data) => {
      response += data.toString();
      const lines = response.split('\r\n');
      const lastComplete = lines[lines.length - 2] || '';

      // Check for multi-line response completion (line starts with "XXX " not "XXX-")
      const code = parseInt(lastComplete.substring(0, 3));
      if (isNaN(code)) return;

      // Only proceed when we get a complete response (not continuation)
      if (lastComplete[3] === '-') return;

      response = ''; // Reset for next response

      switch (step) {
        case 0: // Connected, got banner
          if (code >= 200 && code < 400) {
            step = 1;
            socket.write(`EHLO ${senderDomain}\r\n`);
          } else {
            done('error');
          }
          break;

        case 1: // Got EHLO response
          if (code >= 200 && code < 400) {
            step = 2;
            socket.write(`MAIL FROM:<verify@${senderDomain}>\r\n`);
          } else {
            done('error');
          }
          break;

        case 2: // Got MAIL FROM response
          if (code >= 200 && code < 400) {
            step = 3;
            socket.write(`RCPT TO:<${recipientEmail}>\r\n`);
          } else {
            done('error');
          }
          break;

        case 3: // Got RCPT TO response — this is the answer
          socket.write('QUIT\r\n');
          if (code === 250 || code === 251) {
            done('valid');
          } else if (code === 550 || code === 551 || code === 552 || code === 553 || code === 554) {
            // 550 = mailbox not found, 551 = user not local, etc.
            done('invalid');
          } else if (code === 450 || code === 451 || code === 452) {
            // Temporary failure — treat as unknown, don't block
            done('unknown');
          } else {
            done('unknown');
          }
          break;
      }
    });

    socket.on('close', () => {
      if (!resolved) done('error');
    });
  });
}

/**
 * Full email verification — MX check + SMTP verification
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

  // Step 1: MX check
  const mx = await checkDomainMX(domain);
  if (!mx.hasMX) {
    const result = { valid: false, reason: 'no_mx_records', checkedAt: new Date().toISOString() };
    try { await kv.hset(VERIFY_CACHE_KEY, { [lower]: result }); } catch {}
    return { ...result, cached: false };
  }

  // Step 2: SMTP verification (try first 2 MX servers)
  let smtpResult = 'error';
  for (const server of mx.servers.slice(0, 2)) {
    try {
      smtpResult = await smtpVerify(server, lower);
      if (smtpResult !== 'error' && smtpResult !== 'timeout') break;
    } catch {
      continue;
    }
  }

  let result;
  switch (smtpResult) {
    case 'valid':
      result = { valid: true, reason: 'smtp_verified', checkedAt: new Date().toISOString() };
      break;
    case 'invalid':
      result = { valid: false, reason: 'mailbox_not_found', checkedAt: new Date().toISOString() };
      break;
    case 'catch_all':
      // Risky but might work — allow sending with a flag
      result = { valid: true, reason: 'catch_all_domain', checkedAt: new Date().toISOString() };
      break;
    case 'timeout':
    case 'error':
    case 'unknown':
    default:
      // Can't verify — allow sending (MX exists, so domain is valid)
      // Don't block sends just because SMTP verification was inconclusive
      result = { valid: true, reason: 'mx_valid_smtp_inconclusive', checkedAt: new Date().toISOString() };
      break;
  }

  // Cache result
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
