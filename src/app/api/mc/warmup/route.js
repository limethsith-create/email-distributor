/**
 * Mission Control — warm-up circle (SPEC §10.1 /mc/warmup; the hub's
 * Settings › Warm-up, docs/WARMUP-HUB.md). Admin session (middleware).
 * GET: the plain `circle`, `helpers` and `providers` blocks, plus pool,
 * quotas, inbox rates, today's pairs, provider presets (with the one-time
 * setup steps), external network status.
 * POST {action: addHelper | testHelper | removeHelper | helperEnabled | retryMember}.
 * addHelper tests the SMTP + IMAP logins first and saves only when both work;
 * a failure is 400 with the plain reason. Passwords are encrypted on save and
 * never returned.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { poolStatus, addHelper, testHelper, removeHelper, retryMember, clearHelperMemo, HELPER } from '@/lib/systems/warmup';
import { hasEncKey } from '@/lib/crypto';

export const dynamic = 'force-dynamic';
// The login test may take up to ~20 s (SMTP, then IMAP).
export const maxDuration = 30;

export async function GET() {
  return Response.json({ ...(await poolStatus()), encKey: hasEncKey() });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  switch (body.action) {
    case 'addHelper': {
      const r = await addHelper({ email: body.email, password: body.password, provider: body.provider || null, displayName: body.displayName, imapUser: body.imapUser || null, force: Boolean(body.force) });
      if (!r.ok) return Response.json({ ok: false, error: r.error, ...(r.kind ? { kind: r.kind } : {}) }, { status: r.status || 400 });
      return Response.json({ ok: true, email: r.helper.email, provider: r.helper.provider, helper: r.helper });
    }
    case 'testHelper': {
      if (!body.email) return Response.json({ ok: false, error: 'email is required' }, { status: 400 });
      const r = await testHelper(body.email);
      if (!r.found) return Response.json({ ok: false, error: r.error }, { status: 404 });
      if (!r.ok) return Response.json({ ok: false, error: r.error, kind: r.kind, helper: r.helper }, { status: 400 });
      return Response.json({ ok: true, helper: r.helper });
    }
    case 'removeHelper':
      await removeHelper(body.email);
      return Response.json({ ok: true });
    case 'helperEnabled':
      clearHelperMemo();
      await kv.hset(K.warmupHelper(body.email), { enabled: body.enabled ? '1' : '0', ...(body.enabled ? { health: 'new' } : {}) });
      return Response.json({ ok: true });
    case 'retryMember': {
      if (!body.email) return Response.json({ error: 'email is required' }, { status: 400 });
      await retryMember(body.clientId || HELPER, body.email);
      return Response.json({ ok: true });
    }
    default:
      return Response.json({ error: 'unknown action' }, { status: 400 });
  }
}
