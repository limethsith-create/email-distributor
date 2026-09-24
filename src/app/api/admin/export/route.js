import { exportAll } from '@/lib/systems/backup';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const snap = await exportAll();
  await logEvent(null, 'watchdog', 'backup_exported', { count: snap.count });
  return new Response(JSON.stringify(snap), { headers: { 'content-type': 'application/json' } });
}
