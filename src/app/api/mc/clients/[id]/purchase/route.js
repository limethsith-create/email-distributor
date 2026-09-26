/**
 * /api/mc/clients/[id]/purchase — the owner's purchase page API (SPEC §6.5).
 * GET: the shopping list + current setup checks + inbox list (no passwords).
 * POST: { domain, registrar?, price?, autoRenewOff: true, inboxes: [{email,
 * password, displayName}] } → encrypted inboxes, state setup_check, Setup
 * Checker runs immediately.
 */

import { assertClientId } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { getInboxRecords, publicInbox } from '@/lib/db/inboxes';
import { hasEncKey } from '@/lib/crypto';
import { getShopping } from '@/lib/systems/pricescout';
import { setupSummary } from '@/lib/systems/setupcheck';
import { submitPurchase } from '@/lib/systems/purchase';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const [shopping, setup, inboxes] = await Promise.all([getShopping(id), setupSummary(id), getInboxRecords(id)]);
  return Response.json({
    client: { id, name: client.name, state: client.state, mainDomain: client.mainDomain },
    shopping,
    setup,
    inboxes: inboxes.map(publicInbox),
    encKey: hasEncKey(),
  });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  const body = await request.json().catch(() => ({}));
  const r = await submitPurchase(id, body, { deadline: Date.now() + 20000 });
  if (!r.ok) return Response.json(r, { status: r.status || 400 });
  return Response.json(r);
}
