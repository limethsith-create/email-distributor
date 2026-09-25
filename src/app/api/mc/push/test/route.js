/** POST /api/mc/push/test {endpoint?} — send a test notification (to one phone, or all). */
import { pushToOwner } from '@/lib/push';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const r = await pushToOwner({ title: 'Test alert from Aviance', body: 'Phone alerts work. Every machine alert will show up like this.', url: '/#alerts', tag: 'test', urgent: false }, { endpoint: body.endpoint || null });
  return Response.json({ ok: r.ok, sent: r.sent, failed: r.failed, ...(r.error ? { error: r.error } : {}) }, { status: r.ok ? 200 : (r.error === 'push not configured' ? 503 : 400) });
}
