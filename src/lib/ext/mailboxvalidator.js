/**
 * MailboxValidator — free API plan: 300 checks a month (auto-renewing); does
 * not validate Yahoo addresses. GET
 * https://api.mailboxvalidator.com/v2/validation/single?key=&email= →
 * status (true/false), is_catchall, is_disposable, is_role, is_smtp,
 * is_verified, credits_available (docs/research/v2-leads-copy.md, checked
 * 2026-09-25).
 */

import { fetchExt } from '@/lib/ext/http';

export const SERVICE = 'mailboxvalidator';
export const configured = () => Boolean(process.env.MAILBOXVALIDATOR_API_KEY);
const yes = (v) => v === true || String(v).toLowerCase() === 'true';
const no = (v) => v === false || String(v).toLowerCase() === 'false';

/** The service cannot check these domains (skip it for them). */
export const unsupported = (email) => /@(yahoo|ymail|rocketmail)\./i.test(String(email || ''));

export function mapMailboxValidator(j = {}) {
  if (j.error) {
    const msg = String(j.error.error_message || j.error.message || j.error || 'error');
    return { status: 'unknown', raw: msg, error: /credit|limit|quota|insufficient/i.test(msg) ? 'quota' : /key|auth/i.test(msg) ? 'auth' : 'http' };
  }
  if (yes(j.is_disposable)) return { status: 'invalid', raw: 'disposable' };
  if (yes(j.status)) return yes(j.is_catchall) ? { status: 'catchall', raw: 'catchall' } : { status: 'valid', raw: 'status true' };
  if (no(j.is_smtp) || no(j.is_verified)) return yes(j.is_catchall) ? { status: 'catchall', raw: 'catchall' } : { status: 'invalid', raw: 'not verified' };
  return { status: 'unknown', raw: 'no verdict' };
}

export async function verify(email, { apiKey = process.env.MAILBOXVALIDATOR_API_KEY, timeoutMs = 15_000 } = {}) {
  if (!apiKey) return { status: 'unknown', raw: 'MAILBOXVALIDATOR_API_KEY is not set', error: 'nokey' };
  if (unsupported(email)) return { status: 'unknown', raw: 'Yahoo not supported', error: 'skip' };
  try {
    const res = await fetchExt(`https://api.mailboxvalidator.com/v2/validation/single?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`, { timeoutMs, retry: false });
    const j = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) return { status: 'unknown', raw: `http ${res.status}`, error: 'auth' };
    if (res.status === 402 || res.status === 429) return { status: 'unknown', raw: `http ${res.status}`, error: 'quota' };
    if (!j) return { status: 'unknown', raw: `http ${res.status}`, error: 'http' };
    return mapMailboxValidator(j);
  } catch (err) {
    return { status: 'unknown', raw: err.message, error: 'timeout' };
  }
}
