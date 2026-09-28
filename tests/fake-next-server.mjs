// Test stand-in for 'next/server' in route handlers: `after` callbacks are
// collected (globalThis.__after) so a test can run them, as Vercel would
// after the response.
export function after(fn) {
  (globalThis.__after ||= []).push(fn);
}
// A Response, plus the middleware's NextResponse.next() ("let it through": marked x-middleware-next).
// Like Next, `next({ request: { headers } })` passes request headers on as x-middleware-request-*.
export class NextResponse extends Response {
  static next(init = {}) {
    const res = new Response(null, { headers: { 'x-middleware-next': '1' } });
    const h = init?.request?.headers;
    if (h) {
      const names = [];
      for (const [k, v] of new Headers(h).entries()) { names.push(k); res.headers.set(`x-middleware-request-${k}`, v); }
      res.headers.set('x-middleware-override-headers', names.join(','));
    }
    return res;
  }
  static json(body, init) { return Response.json(body, init); }
}
