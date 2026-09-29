/** GET /api/mc/hub — everything the Aviance Hub's Trials board needs (docs/HUB-API.md). */

import { hubBoard } from '@/lib/systems/hubview';
import { maybeAutoloadDemo } from '@/lib/systems/demo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  // The Test run loads itself the first time the hub opens in production (once; never after a Remove).
  await maybeAutoloadDemo();
  try {
    return Response.json(await hubBoard());
  } catch (err) {
    console.error('[hub] board failed', err);
    return Response.json({ machine: { ok: false }, error: String(err?.message || err) }, { status: 500 });
  }
}
