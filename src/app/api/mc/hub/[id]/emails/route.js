/**
 * GET /api/mc/hub/[id]/emails?limit=200&before=<ISO>&kind= — every email that went out for one client,
 * newest first (docs/HUB-API.md "Emails and conversations"). Owner and employees (read-only).
 */

import { assertClientId } from '@/lib/db/keys';
import { emailsFor } from '@/lib/systems/maillog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request, { params }) {
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ error: 'bad client id' }, { status: 400 }); }
  const q = new URL(request.url).searchParams;
  try {
    const data = await emailsFor(id, { limit: q.get('limit'), before: q.get('before'), kind: q.get('kind') });
    if (!data) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: err?.status || 500 });
  }
}
