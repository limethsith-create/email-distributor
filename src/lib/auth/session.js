/**
 * Admin session (SPEC §14.2). A stateless signed cookie: `<expiry>.<hmac>`,
 * HMAC-SHA256 under ADMIN_SECRET. Uses Web Crypto so the same code runs in
 * the edge middleware and in route handlers. No ADMIN_SECRET → nobody is
 * signed in (fail closed).
 */

export const SESSION_COOKIE = 'av_session';
export const SESSION_DAYS = 14;
/** A hub sign-in (single sign-on from aviance.store) lasts a working day, not weeks. */
export const HUB_SESSION_HOURS = 12;

/**
 * The signing key: ADMIN_SECRET plus SESSION_SECRET when set. Changing
 * SESSION_SECRET in Vercel signs every device out at once (the password
 * stays the same).
 */
const signingKey = (secret) => `${secret}|${process.env.SESSION_SECRET || ''}`;

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

export async function makeSession(secret = process.env.ADMIN_SECRET, { hours = SESSION_DAYS * 24 } = {}) {
  if (!secret) throw new Error('ADMIN_SECRET is not set');
  const exp = Date.now() + hours * 3600e3;
  return `${exp}.${await hmacHex(signingKey(secret), `session:${exp}`)}`;
}

export async function verifySession(value, secret = process.env.ADMIN_SECRET) {
  if (!secret || !value) return false;
  const [exp, sig] = String(value).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  // A cookie can never outlive the longest session, whatever its expiry says.
  if (Number(exp) > Date.now() + SESSION_DAYS * 864e5 + 60e3) return false;
  return timingSafe(sig, await hmacHex(signingKey(secret), `session:${exp}`));
}

export function secretMatches(given, secret) {
  if (!secret || !given) return false;
  return timingSafe(String(given), String(secret));
}

/**
 * Machine routes (cron, backups): `Authorization: Bearer CRON_SECRET` only —
 * never a ?token= in the address (addresses end up in logs). No secret set →
 * nobody gets in.
 */
export function cronAuthorized(request, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const header = String(request.headers.get('authorization') || '');
  return secretMatches(header, `Bearer ${secret}`);
}

/** Where to go after sign-in: only a Mission Control page on this site ("//evil.com" and "/\\evil.com" are other sites to a browser). */
export function safeNext(next) {
  const n = String(next || '/mc');
  return /^\/mc(?:[/?#]|$)/.test(n) && !/[\\\r\n\t]/.test(n) ? n : '/mc';
}

/** Route-handler guard: true when the request carries a valid admin session. */
export async function isAdminRequest(request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySession(m ? decodeURIComponent(m[1]) : '');
}
