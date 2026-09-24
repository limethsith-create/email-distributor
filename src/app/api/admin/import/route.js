import { importAll } from '@/lib/systems/backup';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST a snapshot from /api/admin/export with ?confirm=restore. */
export async function POST(request) {
  if (new URL(request.url).searchParams.get('confirm') !== 'restore') {
    return Response.json({ error: 'add ?confirm=restore — this overwrites every key in the snapshot' }, { status: 400 });
  }
  const snapshot = await request.json();
  const result = await importAll(snapshot);
  await logEvent(null, 'watchdog', 'backup_imported', { ...result, exportedAt: snapshot?.exportedAt || null });
  return Response.json({ ok: true, ...result });
}
