/**
 * Mission Control — warm-up circle (SPEC §10.1 /mc/warmup). Admin session
 * (middleware). GET: pool, quotas, inbox rates, today's pairs, helper health.
 * POST {action: addHelper | removeHelper | helperEnabled}.
 * Passwords are encrypted on save and never returned.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { poolStatus, saveHelper, removeHelper } from '@/lib/systems/warmup';
import { hasEncKey } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ...(await poolStatus()), encKey: hasEncKey() });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  switch (body.action) {
    case 'addHelper': {
      if (!hasEncKey()) return Response.json({ error: 'ENC_KEY is not set on the server, so passwords cannot be stored safely yet.' }, { status: 503 });
      if (!body.email || !body.password) return Response.json({ error: 'email and app password are required' }, { status: 400 });
      const rec = await saveHelper({ email: body.email, password: body.password, displayName: body.displayName, provider: body.provider || 'google' });
      return Response.json({ ok: true, email: rec.email });
    }
    case 'removeHelper':
      await removeHelper(body.email);
      return Response.json({ ok: true });
    case 'helperEnabled':
      await kv.hset(K.warmupHelper(body.email), { enabled: body.enabled ? '1' : '0', ...(body.enabled ? { health: 'new' } : {}) });
      return Response.json({ ok: true });
    default:
      return Response.json({ error: 'unknown action' }, { status: 400 });
  }
}
