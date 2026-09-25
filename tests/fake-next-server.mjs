// Test stand-in for 'next/server' in route handlers: `after` callbacks are
// collected (globalThis.__after) so a test can run them, as Vercel would
// after the response.
export function after(fn) {
  (globalThis.__after ||= []).push(fn);
}
// A Response, plus the middleware's NextResponse.next() ("let it through": marked x-middleware-next).
export class NextResponse extends Response {
  static next() { return new Response(null, { headers: { 'x-middleware-next': '1' } }); }
}
