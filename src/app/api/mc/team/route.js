/**
 * /api/mc/team — the hub's Team tab (docs/HUB-API.md "Team").
 *   GET → { team: [{ uid, name, email, role, online, lastSeen, lastView, activeSecondsToday, status: {text, at}|null,
 *           clients: [{ id, name, state, plan }] }], owners: { clientId: [uid] } }   (owner and team members)
 *   POST { action: 'status', text }              → their own "working on" line (owner and team members)
 *   POST { action: 'assign', clientId, uids: [] } → who looks after a client (the owner only)
 * Identity always comes from the verified token (the owner's Mission Control cookie counts as the owner).
 */

import { verifyHubToken, bearerOf } from '@/lib/auth/supabase';
import { teamView, setStatus, assignClient } from '@/lib/systems/team';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await teamView());
  } catch (err) {
    console.error('[team] view failed', err?.message);
    return Response.json({ error: 'The team did not load. Try again.' }, { status: 500 });
  }
}

export async function POST(request) {
  const token = bearerOf(request);
  const v = token ? await verifyHubToken(token) : null;
  const role = v?.ok ? v.role : request.headers.get('x-hub-role') === 'admin' ? 'admin' : null;
  if (!role) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'status') {
      if (!v?.ok || !v.sub) return Response.json({ error: 'Sign in to the hub to set your status.' }, { status: 401 });
      return Response.json(await setStatus(v.sub, body.text));
    }
    if (body.action === 'assign') {
      if (role !== 'admin') return Response.json({ error: 'Only the owner can choose who looks after a client.' }, { status: 403 });
      return Response.json(await assignClient(body.clientId, body.uids));
    }
    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message || 'That did not go through.' }, { status: 400 });
  }
}
