/** GET /api/mc/push/key — the VAPID public key the hub subscribes with. */
import { vapid } from '@/lib/push';

export const dynamic = 'force-dynamic';

export async function GET() {
  const v = vapid();
  if (!v) return Response.json({ error: 'Phone alerts are not set up on the machine yet (no VAPID keys).' }, { status: 503 });
  return Response.json({ publicKey: v.publicKey });
}
