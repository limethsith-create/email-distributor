import { getAlertLog, ackMatching } from '@/lib/notify';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ alerts: await getAlertLog(300) });
}

/**
 * POST {action:'ack', id} — or {action:'ack', ids: [...]} (the hub's to-do for
 * several alerts of one kind acknowledges them together). Each alert is
 * re-read at its place before it is written, so a new alert arriving at the
 * same moment is never overwritten.
 */
export async function POST(request) {
  const { action, id, ids } = await request.json().catch(() => ({}));
  const want = new Set([...(Array.isArray(ids) ? ids : []), ...(id ? [id] : [])].map(String));
  if (action !== 'ack' || !want.size) return Response.json({ error: 'expected {action:"ack", id} or {action:"ack", ids:[...]}' }, { status: 400 });
  const list = await getAlertLog(1000);
  if (!list.some((a) => want.has(String(a.id)))) return Response.json({ error: 'not found' }, { status: 404 });
  const acknowledged = await ackMatching((a) => want.has(String(a.id)), { by: 'owner' });
  return Response.json({ ok: true, acknowledged });
}
