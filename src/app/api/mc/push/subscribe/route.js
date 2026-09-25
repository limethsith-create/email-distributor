/** POST /api/mc/push/subscribe {subscription, device} — remember this phone for alerts. */
import { savePushSub } from '@/lib/push';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const r = await savePushSub(body.subscription, body.device);
    await logEvent(null, 'push', 'subscribed', { device: String(body.device || '').slice(0, 80), count: r.count });
    return Response.json({ ok: true, ...r });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
