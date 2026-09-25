// Test stand-in for 'next/server' in route handlers: `after` callbacks are
// collected (globalThis.__after) so a test can run them, as Vercel would
// after the response.
export function after(fn) {
  (globalThis.__after ||= []).push(fn);
}
export const NextResponse = Response;
