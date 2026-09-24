/**
 * Hub sign-in for the machine (docs/HUB-API.md). The Aviance Hub's users sign
 * in through Supabase; the hub sends its access token as
 * `Authorization: Bearer <jwt>` and this module verifies it:
 *
 *   - ES256 signature against the project's public keys
 *     (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached for an hour), or
 *     HS256 under SUPABASE_JWT_SECRET when a project still uses a shared secret;
 *   - not expired, issued by this project (`iss`), audience `authenticated`;
 *   - the token's email is one of HUB_ADMIN_EMAILS (default the owner).
 *
 * Web Crypto + fetch only, so it runs in the edge middleware too.
 * Nothing here trusts the token before the signature check.
 */

const DEFAULT_SUPABASE_URL = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const DEFAULT_ADMINS = 'limethsith@gmail.com';
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = { at: 0, keys: [] };

export function supabaseUrl() {
  return (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
}

export function allowedAdmins() {
  return new Set(String(process.env.HUB_ADMIN_EMAILS || DEFAULT_ADMINS).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

async function fetchJwks({ force = false } = {}) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`${supabaseUrl()}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = await res.json();
  jwksCache = { at: Date.now(), keys: Array.isArray(body?.keys) ? body.keys : [] };
  return jwksCache.keys;
}

/** Test hook: preload the JWKS so no network call happens. */
export function __setJwks(keys) {
  jwksCache = { at: Date.now(), keys };
}

async function verifyEs256(signingInput, signature, header) {
  let keys = await fetchJwks();
  let jwk = keys.find((k) => (!header.kid || k.kid === header.kid) && k.kty === 'EC');
  if (!jwk && header.kid) {
    // Key rotation: refresh once before giving up.
    keys = await fetchJwks({ force: true });
    jwk = keys.find((k) => k.kid === header.kid && k.kty === 'EC');
  }
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(signingInput));
}

async function verifyHs256(signingInput, signature) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(signingInput));
}

/**
 * Verify a Supabase access token.
 * @returns {Promise<{ok: boolean, email?: string, sub?: string, error?: string}>}
 */
export async function verifyHubToken(token, { now = Date.now() } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, error: 'malformed token' };
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = b64urlToBytes(parts[2]);

    let valid = false;
    if (header.alg === 'ES256') valid = await verifyEs256(signingInput, signature, header);
    else if (header.alg === 'HS256') valid = await verifyHs256(signingInput, signature);
    else return { ok: false, error: `unsupported alg ${header.alg}` };
    if (!valid) return { ok: false, error: 'bad signature' };

    if (!payload.exp || payload.exp * 1000 <= now) return { ok: false, error: 'token expired' };
    if (payload.iss !== `${supabaseUrl()}/auth/v1`) return { ok: false, error: 'wrong issuer' };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes('authenticated')) return { ok: false, error: 'wrong audience' };
    const email = String(payload.email || '').toLowerCase();
    if (!email || !allowedAdmins().has(email)) return { ok: false, error: 'not an admin' };
    return { ok: true, email, sub: payload.sub };
  } catch (err) {
    return { ok: false, error: `verify failed: ${err?.message || err}` };
  }
}

/** Bearer token from a Request's Authorization header, or ''. */
export function bearerOf(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/** Origins the hub may call the API from (CORS). */
export function allowedOrigins() {
  const raw = process.env.HUB_ORIGINS || 'https://aviance.store,https://aviance-hub.vercel.app';
  return new Set(raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
}

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  const o = String(origin).replace(/\/+$/, '');
  if (allowedOrigins().has(o)) return true;
  // Local development of the hub (file:// pages send "null"; a local server sends localhost).
  if (process.env.NODE_ENV !== 'production' && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || o === 'null')) return true;
  return false;
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
