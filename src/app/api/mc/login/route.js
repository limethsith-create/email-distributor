/**
 * Admin sign-in (SPEC §14.2, docs/HUB-API.md). Three ways in:
 *   - JSON {password}                → the Mission Control login page
 *   - JSON {hubToken}                → a hub session used from JavaScript
 *   - form hubToken=&next=/mc/...    → single sign-on from the Aviance Hub:
 *                                      verifies the Supabase token, sets the
 *                                      admin cookie and redirects to `next`
 * Every path signs the cookie with ADMIN_SECRET, so it must be set. Failed
 * sign-ins are limited per IP (LOGIN_FAILS_PER_HOUR, counted in KV); a hub
 * sign-in lasts HUB_SESSION_HOURS, a password sign-in SESSION_DAYS.
 */

import { kv } from '@vercel/kv';
import { makeSession, secretMatches, safeNext, SESSION_COOKIE, SESSION_DAYS, HUB_SESSION_HOURS } from '@/lib/auth/session';
import { sha256 } from '@/lib/crypto';
import { verifyHubToken } from '@/lib/auth/supabase';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';

const LOGIN_FAILS_PER_HOUR = 10;

function cookie(session, hours = SESSION_DAYS * 24) {
  return `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(hours * 3600)}`;
}


const failKey = (request) => {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
  return `auth:fails:${sha256(ip).slice(0, 24)}:${new Date().toISOString().slice(0, 13)}`;
};
async function tooManyFails(request) {
  try { return Number(await kv.get(failKey(request))) >= LOGIN_FAILS_PER_HOUR; } catch { return false; }
}
async function countFail(request) {
  try { const k = failKey(request); const n = await kv.incr(k); if (n === 1) await kv.expire(k, 3700); } catch {}
}

export async function POST(request) {
  const secret = process.env.ADMIN_SECRET;
  const ct = request.headers.get('content-type') || '';
  const isForm = ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');
  let body = {};
  try {
    if (isForm) body = Object.fromEntries((await request.formData()).entries());
    else body = await request.json();
  } catch {}

  if (!secret) {
    const msg = 'ADMIN_SECRET is not set on the server yet.';
    return isForm ? new Response(msg, { status: 503 }) : Response.json({ error: msg }, { status: 503 });
  }

  if (await tooManyFails(request)) {
    const msg = 'Too many failed sign-ins from this connection. Try again in an hour.';
    return isForm ? new Response(msg, { status: 429 }) : Response.json({ error: msg }, { status: 429 });
  }

  // Hub single sign-on.
  if (body.hubToken) {
    const v = await verifyHubToken(String(body.hubToken));
    if (!v.ok) {
      await countFail(request);
      await logEvent(null, 'auth', 'hub_login_failed', { error: v.error });
      return isForm ? new Response('Sign-in from the hub failed. Sign in to the hub again and retry.', { status: 401 }) : Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await logEvent(null, 'auth', 'hub_login', { email: v.email });
    const session = await makeSession(secret, { hours: HUB_SESSION_HOURS });
    if (isForm) {
      return new Response(null, { status: 303, headers: { Location: safeNext(body.next), 'Set-Cookie': cookie(session, HUB_SESSION_HOURS) } });
    }
    const res = Response.json({ ok: true, email: v.email });
    res.headers.append('Set-Cookie', cookie(session, HUB_SESSION_HOURS));
    return res;
  }

  // Password login (Mission Control page).
  const password = String(body.password || '');
  await new Promise((r) => setTimeout(r, 400)); // blunts password guessing
  if (!secretMatches(password, secret)) {
    await countFail(request);
    await logEvent(null, 'auth', 'login_failed', { ip: request.headers.get('x-forwarded-for') || null });
    return Response.json({ error: 'Wrong password' }, { status: 401 });
  }
  const res = Response.json({ ok: true });
  res.headers.append('Set-Cookie', cookie(await makeSession(secret)));
  return res;
}
