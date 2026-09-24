/** GET /api/mc/hub/[id] — one trial in full for the Aviance Hub (docs/HUB-API.md). */

import { assertClientId } from '@/lib/db/keys';
import { hubClient } from '@/lib/systems/hubview';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req, { params }) {
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ error: 'bad client id' }, { status: 400 }); }
  try {
    const data = await hubClient(id);
    if (!data) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    console.error('[hub] client failed', id, err);
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
