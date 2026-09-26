/**
 * POST /api/webhooks/cheapinboxes — CheapInboxes' events (docs/AUTO-BUY.md §4).
 * Public (middleware lets /api/webhooks/* through); it checks the HMAC-SHA256
 * signature itself (the raw body, the stored secret, the common header forms).
 *
 * A delivery is only ever a wake-up: its body is never parsed, trusted or
 * stored. Signed or not, it can only start a re-sync — rate-limited per kind —
 * and the sync reads the truth from the CheapInboxes API. The answer is 200 at
 * once; the sync runs after it (after()).
 */

import { after } from 'next/server';
import { wakeFromWebhook, syncQuietly } from '@/lib/systems/autobuy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Deliveries larger than this are not even hashed (theirs are a few hundred bytes). */
const MAX_BYTES = 64 * 1024;

export async function POST(request) {
  let raw = '';
  try { raw = await request.text(); } catch {}
  let queued = false;
  let verified = false;
  try {
    ({ queued, verified } = await wakeFromWebhook(raw.length > MAX_BYTES ? '' : raw, request.headers));
  } catch { /* a failing check never turns into an error answer */ }
  if (queued) {
    try { after(() => syncQuietly({ force: true, reason: verified ? 'webhook' : 'webhook_unsigned', deadline: Date.now() + 45000 })); } catch { /* not inside a request (tests) */ }
  }
  return Response.json({ received: true });
}
