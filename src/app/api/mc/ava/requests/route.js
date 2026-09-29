/**
 * /api/mc/ava/requests — change requests noted through Ava (docs/HUB-API.md "Ava (AI helper)").
 *   GET → { requests: [{ id, at, by, text, status: 'open'|'done', doneAt? }] }   newest first, at most 200
 *   POST { action: 'add', text }  → { ok, request }   any signed-in hub user
 *   POST { action: 'done', id }   → { ok, request }   the owner only (403 for a team member)
 */

import { listRequests, addRequest, markDone } from '@/lib/ava/requests';
import { whoIsAsking } from '@/lib/ava/who';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await listRequests());
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const user = await whoIsAsking(request);
  try {
    if (body.action === 'add') return Response.json(await addRequest(body.text, user.name || (user.role === 'admin' ? 'owner' : 'team member')));
    if (body.action === 'done') {
      if (user.role !== 'admin') return Response.json({ error: 'Only the owner can mark a request done.' }, { status: 403 });
      return Response.json(await markDone(body.id));
    }
    return Response.json({ error: "Unknown action — use 'add' or 'done'." }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message || 'That did not go through.' }, { status: err.status || 500 });
  }
}
