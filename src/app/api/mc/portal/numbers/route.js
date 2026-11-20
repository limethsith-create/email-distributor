/**
 * GET /api/mc/portal/numbers?clientId=… — a client's numbers (docs: CONTRACT.md "Numbers").
 * A client profile (x-hub-role: client, set by the middleware) gets its own client from x-hub-client and the query is
 * ignored; staff pass ?clientId=.
 */
import { buildNumbers } from '@/lib/portal/numbers';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const h = request.headers;
  let clientId;
  if (h.get('x-hub-role') === 'client') {
    clientId = h.get('x-hub-client') || '';
    if (!clientId) return Response.json({ ok: false, error: 'This account is not linked to a business yet.' }, { status: 403 });
  } else {
    clientId = new URL(request.url).searchParams.get('clientId') || '';
    if (!clientId) return Response.json({ ok: false, error: 'clientId is required' }, { status: 400 });
  }
  try {
    const out = await buildNumbers(clientId);
    if (!out) return Response.json({ ok: false, error: 'Not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    return Response.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (/client id|invalid/i.test(err?.message || '')) return Response.json({ ok: false, error: 'Not found.' }, { status: 404 });
    console.error('[portal] numbers failed', err);
    return Response.json({ ok: false, error: 'Something went wrong loading the numbers. Please try again.' }, { status: 500 });
  }
}
