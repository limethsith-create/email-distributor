/** GET /api/mc/hub/[id]/growth?days=45 — daily history for the hub's growth charts (docs/HUB-API.md). */

import { assertClientId } from '@/lib/db/keys';
import { growthFor } from '@/lib/systems/growth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request, { params }) {
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ error: 'bad client id' }, { status: 400 }); }
  const days = new URL(request.url).searchParams.get('days');
  try {
    const data = await growthFor(id, { days });
    if (!data) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
