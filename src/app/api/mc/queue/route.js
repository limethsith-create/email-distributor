/**
 * /api/mc/queue — waiting trial applicants (SPEC §10.1 /mc/queue, admin).
 * GET: the queue in order with expected dates and the active-trial count.
 * POST { action: 'promote', clientId } → onboarding now (even over the cap);
 * POST { action: 'decline', clientId, reason } → decline_fit with that reason.
 */

import { assertClientId } from '@/lib/db/keys';
import { listQueue, promoteFromQueue, declineQueued } from '@/lib/systems/gatekeeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  return Response.json(await listQueue());
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const id = assertClientId(body.clientId);
    if (body.action === 'promote') return Response.json({ ok: true, ...(await promoteFromQueue({ clientId: id })) });
    if (body.action === 'decline') return Response.json({ ok: true, ...(await declineQueued(id, body.reason)) });
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 400 });
  }
}
