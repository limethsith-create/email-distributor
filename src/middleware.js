/**
 * Access control for every page and API route (SPEC §14.2, docs/HUB-API.md).
 *
 *  - public:  client pages and their APIs (signed tokens), unsubscribe,
 *             open tracking, webhooks (verify their own tokens), /api/inquiry,
 *             the login page, the Google sign-in return (/api/google/callback,
 *             checks its own one-use state).
 *  - machine: /api/cron/* and /api/admin/export|import accept
 *             `Authorization: Bearer CRON_SECRET` (header only: a ?token= in
 *             the address would land in logs) — or an admin session.
 *  - site:    /api/inquiry and GET /api/booking/availability (busy times only) answer the
 *             public website (SITE_ORIGINS) cross-origin.
 *  - hub:     /api/mc/* also accepts `Authorization: Bearer <Supabase access
 *             token>` of an allowed hub admin, with CORS for the hub's origin.
 *             An approved employee's token (profiles.role = 'employee') is
 *             read-only: GET/HEAD outside EMPLOYEE_DENY, plus POST
 *             /api/mc/presence, /api/mc/team (own status); anything else is 403. The verified email and
 *             role are passed on as `x-hub-user` / `x-hub-role` request headers
 *             (any the caller sent are dropped).
 *             A client's token (profiles.role = 'client') reaches ONLY GET /api/mc/portal/* (403 'Not allowed' for
 *             anything else, and for a `clientId` in the query that is not theirs); `x-hub-role: client` and
 *             `x-hub-client: {their client id}` are set by us (`x-hub-client` is dropped from every incoming request).
 *  - admin:   everything else needs the ADMIN_SECRET session cookie.
 *
 * Missing secrets fail closed.
 */

import { NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession, cronAuthorized, tickAuthorized } from '@/lib/auth/session';
import { verifyHubToken, bearerOf, isAllowedOrigin, isSiteOrigin, corsHeaders } from '@/lib/auth/supabase';

const PUBLIC = [
  /^\/mc\/login$/, /^\/api\/mc\/login$/, /^\/api\/mc\/logout$/,
  /^\/api\/unsubscribe(\/|$)/, /^\/api\/track\//, /^\/api\/webhooks\//, /^\/api\/inquiry$/, /^\/api\/booking\/availability$/,
  /^\/api\/c\//, /^\/c\//, /^\/api\/logo$/,
  // Lead Finder job: the route checks LEADFINDER_TOKEN itself.
  /^\/api\/clients\/[^/]+\/profile$/,
  // Google sends the owner back here after "Allow": the route checks its one-use `state` itself.
  /^\/api\/google\/callback$/,
];
// The public website's own calls (cross-origin from SITE_ORIGINS): bookings and the free/busy times.
const SITE_API = new Set(['/api/inquiry', '/api/booking/availability']);
const MACHINE = [/^\/api\/cron\//, /^\/api\/admin\/(export|import)$/];
const HUB_API = /^\/api\/mc\//;
// Owner-only screens: secrets, credentials, owner settings, warm-up controls (names kept closed by default even where no route exists).
export const EMPLOYEE_DENY = /^\/api\/mc\/(keys|config|setup|people|google|cheapinboxes|login|logout|test|push|warmup|archive|demo)(\/|$)/;
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
function passOn(request, { user = '', role = '', clientId = '' } = {}) {
  const headers = new Headers(request.headers);
  headers.delete('x-hub-user');
  headers.delete('x-hub-role');
  headers.delete('x-hub-client');
  if (user) headers.set('x-hub-user', user);
  if (role) headers.set('x-hub-role', role);
  if (clientId) headers.set('x-hub-client', clientId);
  const res = NextResponse.next({ request: { headers } });
  if (user) res.headers.set('x-hub-user', user);
  if (role) res.headers.set('x-hub-role', role);
  if (clientId) res.headers.set('x-hub-client', clientId);
  return res;
}

// A client's token (profiles.role = 'client') reaches only the portal's read-only views, for their own client.
const PORTAL_GET = /^\/api\/mc\/portal\/[^/]/;
const NOT_ALLOWED = 'Not allowed';
/** May a client (portal user) make this request? Only GET under /api/mc/portal/, and never for another client's id. */
export function clientMayAccess(method, pathname, searchParams, clientId) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  if (!PORTAL_GET.test(pathname) || /(^|\/)\.\.?(\/|$)/.test(pathname)) return false;
  const asked = searchParams?.getAll ? searchParams.getAll('clientId') : [];
  return asked.every((c) => c === clientId);
}

function withCors(res, origin) {
  if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
  return res;
}

/**
 * Why a ping to the tick was refused, without the secrets: each value's length and the first
 * 6 hex of its SHA-256, so the owner can see "the two keys differ" or "TICK_SECRET is not set".
 */
async function logTickRefusal(request) {
  try {
    const fp = async (s) => {
      if (!s) return null;
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(d)].slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const header = String(request.headers.get('authorization') || '').trim();
    const given = header.replace(/^Bearer\s+/i, '');
    const tick = String(process.env.TICK_SECRET || '').trim().replace(/^Bearer\s+/i, '');
    console.warn('[tick] refused', JSON.stringify({
      headerHasBearer: /^Bearer\s/i.test(header), givenLength: given.length, givenFp: await fp(given),
      tickSet: Boolean(process.env.TICK_SECRET), tickLength: tick.length, tickFp: await fp(tick),
    }));
  } catch { /* logging only */ }
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get('origin');
  const hubOrigin = HUB_API.test(pathname) && isAllowedOrigin(origin) ? String(origin).replace(/\/+$/, '') : null;

  // CORS preflight for the hub (before any auth: browsers send it without headers).
  if (request.method === 'OPTIONS' && HUB_API.test(pathname)) {
    return hubOrigin ? withCors(new NextResponse(null, { status: 204 }), hubOrigin) : new NextResponse(null, { status: 403 });
  }

  // The public website posts plan inquiries cross-origin.
  if (SITE_API.has(pathname)) {
    const site = isSiteOrigin(origin) ? String(origin).replace(/\/+$/, '') : null;
    if (request.method === 'OPTIONS') return site ? withCors(new NextResponse(null, { status: 204 }), site) : new NextResponse(null, { status: 403 });
    return withCors(NextResponse.next(), site);
  }

  if (PUBLIC.some((re) => re.test(pathname))) return withCors(NextResponse.next(), hubOrigin);

  if (await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return withCors(HUB_API.test(pathname) ? passOn(request, { role: 'admin' }) : NextResponse.next(), hubOrigin);
  }

  if (HUB_API.test(pathname)) {
    const token = bearerOf(request);
    if (token) {
      const v = await verifyHubToken(token);
      if (v.ok) {
        if (v.role === 'client') {
          // The client's id comes from the verified profile; the portal routes read x-hub-client, never the query.
          if (!v.clientId || !clientMayAccess(request.method, pathname, request.nextUrl.searchParams, v.clientId)) {
            return withCors(NextResponse.json({ error: NOT_ALLOWED }, { status: 403 }), hubOrigin);
          }
          return withCors(passOn(request, { user: v.email, role: 'client', clientId: v.clientId }), hubOrigin);
        }
        const role = v.role === 'employee' ? 'employee' : 'admin';
        if (role === 'employee' && !employeeMayAccess(request.method, pathname)) {
          return withCors(NextResponse.json({ error: READ_ONLY }, { status: 403 }), hubOrigin);
        }
            return withCors(passOn(request, { user: v.email, role }), hubOrigin);
      }
      // The reason stays on the server (it would help an attacker); the hub only needs "sign in again".
      return withCors(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), hubOrigin);
    }
  }

  if (MACHINE.some((re) => re.test(pathname))) {
    if (cronAuthorized(request) || (pathname === '/api/cron/tick' && tickAuthorized(request))) return NextResponse.next();
    if (pathname === '/api/cron/tick') await logTickRefusal(request);
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
