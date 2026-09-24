/** GET /api/mc/hub — everything the Aviance Hub's Trials board needs (docs/HUB-API.md). */

import { hubBoard } from '@/lib/systems/hubview';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    return Response.json(await hubBoard());
  } catch (err) {
    console.error('[hub] board failed', err);
    return Response.json({ machine: { ok: false }, error: String(err?.message || err) }, { status: 500 });
  }
}
