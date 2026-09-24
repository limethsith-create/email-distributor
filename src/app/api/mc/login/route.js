import { makeSession, secretMatches, SESSION_COOKIE, SESSION_DAYS } from '@/lib/auth/session';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return Response.json({ error: 'ADMIN_SECRET is not set on the server yet.' }, { status: 503 });
  let password = '';
  try { password = String((await request.json()).password || ''); } catch {}
  // Small fixed delay blunts password guessing.
  await new Promise((r) => setTimeout(r, 400));
  if (!secretMatches(password, secret)) {
    await logEvent(null, 'auth', 'login_failed', { ip: request.headers.get('x-forwarded-for') || null });
    return Response.json({ error: 'Wrong password' }, { status: 401 });
  }
  const res = Response.json({ ok: true });
  res.headers.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(await makeSession(secret))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  return res;
}
