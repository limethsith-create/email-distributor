/**
 * Access control for every page and API route (SPEC §14.2).
 *
 *  - public:  client pages and their APIs (signed tokens), unsubscribe,
 *             open tracking, webhooks (verify their own tokens), /api/apply,
 *             the login page.
 *  - machine: /api/cron/* and /api/admin/export|import accept
 *             `Authorization: Bearer CRON_SECRET` (or `?token=` for the old
 *             pingers) — or an admin session.
 *  - admin:   everything else needs the ADMIN_SECRET session cookie.
 *
 * Missing secrets fail closed.
 */

import { NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession, secretMatches } from '@/lib/auth/session';

const PUBLIC = [
  /^\/mc\/login$/, /^\/api\/mc\/login$/, /^\/api\/mc\/logout$/,
  /^\/api\/unsubscribe(\/|$)/, /^\/api\/track\//, /^\/api\/webhooks\//, /^\/api\/apply$/,
  /^\/api\/c\//, /^\/c\//, /^\/api\/logo$/, /^\/apply$/,
];
const MACHINE = [/^\/api\/cron\//, /^\/api\/admin\/(export|import)$/];

export async function middleware(request) {
  const { pathname, searchParams } = request.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  if (await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (MACHINE.some((re) => re.test(pathname))) {
    const secret = process.env.CRON_SECRET;
    const header = request.headers.get('authorization') || '';
    if (secretMatches(header, secret ? `Bearer ${secret}` : '') || secretMatches(searchParams.get('token'), secret)) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const login = new URL('/mc/login', request.url);
  login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
