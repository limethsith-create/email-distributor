/**
 * Admin session (SPEC §14.2). A stateless signed cookie: `<expiry>.<hmac>`,
 * HMAC-SHA256 under ADMIN_SECRET. Uses Web Crypto so the same code runs in
 * the edge middleware and in route handlers. No ADMIN_SECRET → nobody is
 * signed in (fail closed).
 */

export const SESSION_COOKIE = 'av_session';
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafe(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSession(secret = process.env.ADMIN_SECRET) {
  if (!secret) throw new Error('ADMIN_SECRET is not set');
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmacHex(secret, `session:${exp}`)}`;
}

export async function verifySession(value, secret = process.env.ADMIN_SECRET) {
  if (!secret || !value) return false;
  const [exp, sig] = String(value).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return timingSafe(sig, await hmacHex(secret, `session:${exp}`));
}

export function secretMatches(given, secret) {
  if (!secret || !given) return false;
  return timingSafe(String(given), String(secret));
}

/** Route-handler guard: true when the request carries a valid admin session. */
export async function isAdminRequest(request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySession(m ? decodeURIComponent(m[1]) : '');
}
