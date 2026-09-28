/**
 * Access control for every page and API route (SPEC §14.2, docs/HUB-API.md).
 *
 *  - public:  client pages and their APIs (signed tokens), unsubscribe,
 *             open tracking, webhooks (verify their own tokens), /api/apply,
 *             the login page, the Google sign-in return (/api/google/callback,
 *             checks its own one-use state).
 *  - machine: /api/cron/* and /api/admin/export|import accept
 *             `Authorization: Bearer CRON_SECRET` (header only: a ?token= in
 *             the address would land in logs) — or an admin session.
 *  - site:    /api/apply and /api/inquiry answer the public website (SITE_ORIGINS) cross-origin.
 *  - hub:     /api/mc/* also accepts `Authorization: Bearer <Supabase access
 *             token>` of an allowed hub admin, with CORS for the hub's origin.
 *             An approved employee's token (profiles.role = 'employee') is
 *             read-only: GET/HEAD outside EMPLOYEE_DENY, plus POST
 *             /api/mc/presence; anything else is 403. The verified email and
 *             role are passed on as `x-hub-user` / `x-hub-role` request headers
 *             (any the caller sent are dropped).
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
  // Google sends the owner back here after "Allow": the route checks its one-use `state` itself.
  /^\/api\/google\/callback$/,
];
const MACHINE = [/^\/api\/cron\//, /^\/api\/admin\/(export|import)$/];
const HUB_API = /^\/api\/mc\//;
// Owner-only screens: secrets, credentials, owner settings, test mode, the activity log, the outreach archive, the test run.
export const EMPLOYEE_DENY = /^\/api\/mc\/(keys|config|setup|people|google|cheapinboxes|login|logout|test|push|warmup|archive|demo)(\/|$)/;
// The hub's Test run clients (systems/demo.js) are look-only: no button on them may send or change anything.
const DEMO_CLIENT_WRITE = /^\/api\/mc\/clients\/(demo-harbor-dental|demo-summit-roofing)(\/|$)/;
export const DEMO_READ_ONLY = 'This is a test-run client: nothing can be sent or changed for it. Remove the test run to clear it.';
/** A write on a Test run client (anything but GET / HEAD / OPTIONS under /api/mc/clients/{demo id}). */
export function demoWriteBlocked(method, pathname) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase()) && DEMO_CLIENT_WRITE.test(pathname);
}
const EMPLOYEE_POST = /^\/api\/mc\/(presence|team)\/?$/;   // team: only their own status (the route checks)
const READ_ONLY = 'Read-only: ask the owner to do this.';

/** Is this request something an employee (read-only hub user) may do? */
export function employeeMayAccess(method, pathname) {
  const m = String(method || '').toUpperCase();
  if (m === 'POST') return EMPLOYEE_POST.test(pathname);
  if (m !== 'GET' && m !== 'HEAD') return false;
  return !EMPLOYEE_DENY.test(pathname);
}

/** Let the request through with the hub identity headers set (never the caller's own). */
function passOn(request, { user = '', role = '' } = {}) {
  const headers = new Headers(request.headers);
  headers.delete('x-hub-user');
  headers.delete('x-hub-role');
  if (user) headers.set('x-hub-user', user);
  if (role) headers.set('x-hub-role', role);
  const res = NextResponse.next({ request: { headers } });
  if (user) res.headers.set('x-hub-user', user);
  if (role) res.headers.set('x-hub-role', role);
  return res;
}

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

  if (await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) {
    if (demoWriteBlocked(request.method, pathname)) return withCors(NextResponse.json({ error: DEMO_READ_ONLY }, { status: 409 }), hubOrigin);
    return withCors(HUB_API.test(pathname) ? passOn(request, { role: 'admin' }) : NextResponse.next(), hubOrigin);
  }

  if (HUB_API.test(pathname)) {
    const token = bearerOf(request);
    if (token) {
      const v = await verifyHubToken(token);
      if (v.ok) {
        const role = v.role === 'employee' ? 'employee' : 'admin';
        if (role === 'employee' && !employeeMayAccess(request.method, pathname)) {
          return withCors(NextResponse.json({ error: READ_ONLY }, { status: 403 }), hubOrigin);
        }
        if (demoWriteBlocked(request.method, pathname)) return withCors(NextResponse.json({ error: DEMO_READ_ONLY }, { status: 409 }), hubOrigin);
        return withCors(passOn(request, { user: v.email, role }), hubOrigin);
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
