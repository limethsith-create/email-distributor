/** The shared view's data routes (/api/c/emails, /threads, /thread): the token check and the answers they share. */

import { sharedClientId, overLimit } from '@/lib/systems/clientdash';

export const NOT_FOUND = 'This link has expired or is not valid. Reply to our last email and we will send a new one.';

/** Run `fn(clientId, params)` for a valid dashboard token; 404 / 429 / 500 otherwise. */
export async function withSharedClient(request, fn) {
  const params = new URL(request.url).searchParams;
  const token = params.get('token') || '';
  try {
    if (overLimit(token)) return Response.json({ ok: false, error: 'Too many requests — wait a minute and refresh.' }, { status: 429 });
    const id = await sharedClientId(token);
    if (!id) return Response.json({ ok: false, error: NOT_FOUND }, { status: 404 });
    const out = await fn(id, params);
    if (!out) return Response.json({ ok: false, error: 'Not found.' }, { status: 404 });
    return Response.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err?.status === 400) return Response.json({ ok: false, error: err.message }, { status: 400 });
    console.error('[dashboard] data failed', err);
    return Response.json({ ok: false, error: 'Something went wrong loading this page. Please try again in a minute.' }, { status: 500 });
  }
}
