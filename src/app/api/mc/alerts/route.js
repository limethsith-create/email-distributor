import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAlertLog } from '@/lib/notify';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ alerts: await getAlertLog(300) });
}

/** POST {action:'ack', id} */
export async function POST(request) {
  const { action, id } = await request.json().catch(() => ({}));
  if (action !== 'ack' || !id) return Response.json({ error: 'expected {action:"ack", id}' }, { status: 400 });
  const list = await getAlertLog(1000);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return Response.json({ error: 'not found' }, { status: 404 });
  await kv.lset(K.alertLog(), i, { ...list[i], acknowledged: true, acknowledgedAt: new Date().toISOString() });
  return Response.json({ ok: true });
}
