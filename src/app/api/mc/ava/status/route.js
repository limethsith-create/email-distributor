/**
 * GET /api/mc/ava/status — Ava's brains (docs/HUB-API.md "Ava (AI helper)").
 * Owner and team members.
 *   → { brains: [{ id, name, ready, model, lastError, lastOkAt }], ready }
 * Never a key. `ready` = at least one brain can answer now.
 */

import { brainsStatus } from '@/lib/ava/brains';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const brains = await brainsStatus();
    return Response.json({ brains, ready: brains.some((b) => b.ready) });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
