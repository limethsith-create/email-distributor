/**
 * /api/mc/cleanup — remove test data (the owner only; never runs by itself).
 *   POST { action:'preview' }          → { ok, clients, bookings, keys, counts }   nothing is changed
 *   POST { action:'apply', ids:[ 'client:demo-x', 'booking:abc', 'keys:demo-bookkeeping' ] }
 *                                      → { ok, removed:[{kind,id,label,records}], skipped:[{kind,id,why}], counts }
 * Each item says why it matched. Apply only removes ids that are still clearly test records.
 */
import { previewCleanup, applyCleanup } from '@/lib/systems/cleanup';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request) {
  if (request.headers.get('x-hub-role') !== 'admin') {
    return Response.json({ error: 'Only the owner can remove test data.' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'preview') return Response.json(await previewCleanup());
    if (body.action === 'apply') {
      const r = await applyCleanup(body.ids);
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err) {
    console.error('[cleanup] failed', err?.message);
    return Response.json({ error: 'That did not go through. Try again.' }, { status: 500 });
  }
}
