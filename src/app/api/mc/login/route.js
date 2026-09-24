/**
 * Admin sign-in (SPEC §14.2, docs/HUB-API.md). Three ways in:
 *   - JSON {password}                → the Mission Control login page
 *   - JSON {hubToken}                → a hub session used from JavaScript
 *   - form hubToken=&next=/mc/...    → single sign-on from the Aviance Hub:
 *                                      verifies the Supabase token, sets the
 *                                      admin cookie and redirects to `next`
 * Every path signs the cookie with ADMIN_SECRET, so it must be set.
 */

import { makeSession, secretMatches, SESSION_COOKIE, SESSION_DAYS } from '@/lib/auth/session';
import { verifyHubToken } from '@/lib/auth/supabase';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';

function cookie(session) {
  return `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function safeNext(next) {
  const n = String(next || '/mc');
  return n.startsWith('/') && !n.startsWith('//') && !/[\r\n]/.test(n) ? n : '/mc';
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

  // Hub single sign-on.
  if (body.hubToken) {
    const v = await verifyHubToken(String(body.hubToken));
    if (!v.ok) {
      await logEvent(null, 'auth', 'hub_login_failed', { error: v.error });
      return isForm ? new Response(`Sign-in from the hub failed: ${v.error}`, { status: 401 }) : Response.json({ error: `Unauthorized: ${v.error}` }, { status: 401 });
    }
    await logEvent(null, 'auth', 'hub_login', { email: v.email });
    const session = await makeSession(secret);
    if (isForm) {
      return new Response(null, { status: 303, headers: { Location: safeNext(body.next), 'Set-Cookie': cookie(session) } });
    }
    const res = Response.json({ ok: true, email: v.email });
    res.headers.append('Set-Cookie', cookie(session));
    return res;
  }

  // Password login (Mission Control page).
  const password = String(body.password || '');
  await new Promise((r) => setTimeout(r, 400)); // blunts password guessing
  if (!secretMatches(password, secret)) {
    await logEvent(null, 'auth', 'login_failed', { ip: request.headers.get('x-forwarded-for') || null });
    return Response.json({ error: 'Wrong password' }, { status: 401 });
  }
  const res = Response.json({ ok: true });
  res.headers.append('Set-Cookie', cookie(await makeSession(secret)));
  return res;
}
