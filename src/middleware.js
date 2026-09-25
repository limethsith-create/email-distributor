/**
 * Access control for every page and API route (SPEC §14.2, docs/HUB-API.md).
 *
 *  - public:  client pages and their APIs (signed tokens), unsubscribe,
 *             open tracking, webhooks (verify their own tokens), /api/apply,
 *             the login page.
 *  - machine: /api/cron/* and /api/admin/export|import accept
 *             `Authorization: Bearer CRON_SECRET` (header only: a ?token= in
 *             the address would land in logs) — or an admin session.
 *  - site:    /api/apply and /api/inquiry answer the public website (SITE_ORIGINS) cross-origin.
 *  - hub:     /api/mc/* also accepts `Authorization: Bearer <Supabase access
 *             token>` of an allowed hub admin, with CORS for the hub's origin.
 *  - admin:   everything else needs the ADMIN_SECRET session cookie.
 *
 * Missing secrets fail closed.
 */

import { NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession, cronAuthorized } from '@/lib/auth/session';
import { verifyHubToken, bearerOf, isAllowedOrigin, isSiteOrigin, corsHeaders } from '@/lib/auth/supabase';

const PUBLIC = [
  /^\/mc\/login$/, /^\/api\/mc\/login$/, /^\/api\/mc\/logout$/,
  /^\/api\/unsubscribe(\/|$)/, /^\/api\/track\//, /^\/api\/webhooks\//, /^\/api\/apply$/, /^\/api\/inquiry$/,
  /^\/api\/c\//, /^\/c\//, /^\/api\/logo$/, /^\/apply$/,
  // Lead Finder job: the route checks LEADFINDER_TOKEN itself.
  /^\/api\/clients\/[^/]+\/profile$/,
];
const MACHINE = [/^\/api\/cron\//, /^\/api\/admin\/(export|import)$/];
const HUB_API = /^\/api\/mc\//;

function withCors(res, origin) {
  if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
  return res;
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get('origin');
  const hubOrigin = HUB_API.test(pathname) && isAllowedOrigin(origin) ? String(origin).replace(/\/+$/, '') : null;

  // CORS preflight for the hub (before any auth: browsers send it without headers).
  if (request.method === 'OPTIONS' && HUB_API.test(pathname)) {
    return hubOrigin ? withCors(new NextResponse(null, { status: 204 }), hubOrigin) : new NextResponse(null, { status: 403 });
  }

  // The public website posts trial applications and plan inquiries cross-origin.
  if (pathname === '/api/apply' || pathname === '/api/inquiry') {
    const site = isSiteOrigin(origin) ? String(origin).replace(/\/+$/, '') : null;
    if (request.method === 'OPTIONS') return site ? withCors(new NextResponse(null, { status: 204 }), site) : new NextResponse(null, { status: 403 });
    return withCors(NextResponse.next(), site);
  }

  if (PUBLIC.some((re) => re.test(pathname))) return withCors(NextResponse.next(), hubOrigin);

  if (await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) return withCors(NextResponse.next(), hubOrigin);

  if (HUB_API.test(pathname)) {
    const token = bearerOf(request);
    if (token) {
      const v = await verifyHubToken(token);
      if (v.ok) {
        const res = NextResponse.next();
        res.headers.set('x-hub-user', v.email);
        return withCors(res, hubOrigin);
      }
      // The reason stays on the server (it would help an attacker); the hub only needs "sign in again".
      return withCors(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), hubOrigin);
    }
  }

  if (MACHINE.some((re) => re.test(pathname))) {
    if (cronAuthorized(request)) return NextResponse.next();
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (pathname.startsWith('/api/')) return withCors(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), hubOrigin);
  const login = new URL('/mc/login', request.url);
  login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
