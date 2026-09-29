/**
 * GET /api/mc/hub/[id]/threads/[threadId] — the whole conversation with one prospect, oldest first
 * (docs/HUB-API.md "Emails and conversations"). Owner and employees (read-only). 404 for an unknown thread.
 */

import { assertClientId } from '@/lib/db/keys';
import { threadFor } from '@/lib/systems/maillog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_request, { params }) {
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ error: 'bad client id' }, { status: 400 }); }
  try {
    const data = await threadFor(id, String(params.threadId || ''));
    if (!data) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
