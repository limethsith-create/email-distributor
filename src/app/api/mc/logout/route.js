import { SESSION_COOKIE } from '@/lib/auth/session';

export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res;
}
