import { migrateAviance } from '@/lib/systems/migrate';
import { alertOwner } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/** POST {action:'migrate'} | {action:'test-alert'} */
export async function POST(request) {
  const { action } = await request.json().catch(() => ({}));
  if (action === 'migrate') return Response.json({ ok: true, done: await migrateAviance() });
  if (action === 'test-alert') {
    const r = await alertOwner('test', { body: 'This is a test alert from Mission Control. If you can read this, owner alerts work.', did: 'Nothing — it is a test.', force: true });
    return Response.json({ ok: r.sent, channels: r.channels });
  }
  return Response.json({ error: 'unknown action' }, { status: 400 });
}
