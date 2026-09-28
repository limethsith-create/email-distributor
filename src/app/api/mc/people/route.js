/**
 * /api/mc/people — the owner's view of who uses the hub (docs/HUB-API.md
 * "Employees"). Admin only: the middleware keeps employees out, and a hub
 * token is checked again here.
 *   GET → { people: [{ uid, email, name, role, online, firstSeen, lastSignIn,
 *           lastSignOut, lastSeen, lastView, sessions, activeSecondsToday,
 *           activeSecondsTotal }], events: [{ at, uid, email, name, role, event, view }] }
 *   people: online first, then most recently seen; events: newest 300.
 */

import { verifyHubToken, bearerOf } from '@/lib/auth/supabase';
import { peopleView } from '@/lib/systems/presence';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const token = bearerOf(request);
  if (token) {
    const v = await verifyHubToken(token);
    if (!v.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (v.role !== 'admin') return Response.json({ error: 'Read-only: ask the owner to do this.' }, { status: 403 });
  }
  return Response.json(await peopleView());
}
