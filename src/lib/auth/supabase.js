/**
 * Hub sign-in for the machine (docs/HUB-API.md). The Aviance Hub's users sign
 * in through Supabase; the hub sends its access token as
 * `Authorization: Bearer <jwt>` and this module verifies it:
 *
 *   - ES256 signature against the project's public keys
 *     (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached for an hour), or
 *     HS256 under SUPABASE_JWT_SECRET when a project still uses a shared secret;
 *   - not expired, issued by this project (`iss`), audience `authenticated`;
 *   - the token's email is one of HUB_ADMIN_EMAILS (default the owner) → role
 *     `admin`; otherwise the user's own `profiles` row (read through Supabase
 *     REST with the user's token, so Row Level Security applies) must say
 *     `approved = true` and `role = 'employee'` → role `employee` (read-only,
 *     see the middleware). Lookups are cached in memory for about a minute.
 *
 * Web Crypto + fetch only, so it runs in the edge middleware too.
 * Nothing here trusts the token before the signature check.
 */

const DEFAULT_SUPABASE_URL = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const DEFAULT_ADMINS = 'limethsith@gmail.com';
const DEFAULT_ANON_KEY = 'sb_publishable_WV4FANV2hNsmbzK3DbiLFg_9bjiB8Z1';
const JWKS_TTL_MS = 60 * 60 * 1000;
const PROFILE_TTL_MS = 60 * 1000;

const profileCache = new Map(); // sub → { at, profile|null }

let jwksCache = { at: 0, keys: [] };

export function supabaseUrl() {
  return (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
}

export function supabaseAnonKey() {
  return process.env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
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

/** Test hook: forget cached profile lookups. */
export function __resetProfileCache() {
  profileCache.clear();
}

/**
 * The signed-in user's own `profiles` row, or null (none / not readable).
 * Answers (found or not) from a 2xx are cached PROFILE_TTL_MS; a network failure is not
 * cached and throws, so the caller fails closed for this request only.
 */
async function lookupProfile(sub, token, now) {
  const hit = profileCache.get(sub);
  if (hit && now - hit.at < PROFILE_TTL_MS) return hit.profile;
  const url = `${supabaseUrl()}/rest/v1/profiles?id=eq.${encodeURIComponent(sub)}&select=id,name,email,role,approved`;
  const res = await fetch(url, { headers: { apikey: supabaseAnonKey(), Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (res.status >= 500) throw new Error(`profiles ${res.status}`);
  if (!res.ok) return null; // 401/403/4xx: not readable with this token — not cached
  const rows = await res.json().catch(() => []);
  const profile = (Array.isArray(rows) ? rows.find((r) => r && String(r.id) === String(sub)) : null) || null;
  if (profileCache.size > 500) profileCache.clear();
  profileCache.set(sub, { at: now, profile });
  return profile;
}

/**
 * Verify a Supabase access token.
 * @returns {Promise<{ok: boolean, email?: string, sub?: string, role?: 'admin'|'employee', name?: string, error?: string}>}
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
    if (!email) return { ok: false, error: 'not an admin' };
    const metaName = String(payload.user_metadata?.name || payload.user_metadata?.full_name || '').slice(0, 80);
    if (allowedAdmins().has(email)) return { ok: true, email, sub: payload.sub, role: 'admin', name: metaName };
    // Not an admin: an approved employee may still read.
    if (!payload.sub) return { ok: false, error: 'not an admin' };
    let profile;
    try {
      profile = await lookupProfile(String(payload.sub), String(token), now);
    } catch (err) {
      return { ok: false, error: `profile lookup failed: ${err?.message || err}` };
    }
    if (!profile) return { ok: false, error: 'not an admin' };
    if (profile.approved !== true || profile.role !== 'employee') return { ok: false, error: 'not an approved employee' };
    return { ok: true, email, sub: payload.sub, role: 'employee', name: String(profile.name || metaName || '').slice(0, 80) };
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

/** The public website's origins, allowed to POST /api/apply. */
export function isSiteOrigin(origin) {
  if (!origin) return false;
  const o = String(origin).replace(/\/+$/, '');
  const raw = process.env.SITE_ORIGINS || 'https://www.aviance.online,https://aviance.online';
  if (raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).includes(o)) return true;
  return process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, accept',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
