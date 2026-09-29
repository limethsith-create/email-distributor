/**
 * GET /api/mc/ava/warm — get Ava ready before the first question
 * (docs/HUB-API.md "Ava (AI helper)"). Owner and team members. The hub calls
 * it when the Ava panel opens. Cheap: loads the guide's search index, the
 * Business facts and every brain's model list (cached 6 h); no AI call.
 *   → { ok: true, ready, brains: [{ id, model, quick, source }], guide, search, ms }
 * Never a key.
 */

import { warmAva } from '@/lib/ava/warm';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET() {
  try {
    return Response.json(await warmAva(), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
