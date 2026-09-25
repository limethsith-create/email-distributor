/** POST /api/mc/push/unsubscribe {endpoint} — stop alerts to this phone. */
import { removePushSub } from '@/lib/push';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!body.endpoint) return Response.json({ error: 'endpoint is required' }, { status: 400 });
  await removePushSub(body.endpoint);
  await logEvent(null, 'push', 'unsubscribed', {});
  return Response.json({ ok: true });
}
