/**
 * /api/mc/presence — the hub reports sign-ins, sign-outs, a heartbeat and the
 * screens people open (docs/HUB-API.md "Employees"). Any hub user, admin or
 * employee, with their Supabase token (middleware); identity comes from the
 * verified token, never from the body.
 *   POST { event: 'signin'|'signout'|'active'|'view', view?: string (≤ 60), name?: string }
 *     → { ok: true } · 400 { error } · 401 { error: 'Unauthorized' }
 */

import { verifyHubToken, bearerOf } from '@/lib/auth/supabase';
import { recordPresence } from '@/lib/systems/presence';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const token = bearerOf(request);
  if (!token) return Response.json({ error: 'Presence needs the hub sign-in token.' }, { status: 401 });
  const v = await verifyHubToken(token);
  if (!v.ok || !v.sub) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    const r = await recordPresence({ uid: v.sub, email: v.email, role: v.role, name: v.name }, body);
    if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[presence] write failed', err?.message);
    return Response.json({ error: 'Could not record that just now.' }, { status: 503 });
  }
}
