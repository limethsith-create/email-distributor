/**
 * Mission Control — warm-up circle (SPEC §10.1 /mc/warmup). Admin session
 * (middleware). GET: pool, quotas, inbox rates, today's pairs, helper health,
 * provider presets (with the one-time setup steps), external network status.
 * POST {action: addHelper | removeHelper | helperEnabled | retryMember}.
 * Passwords are encrypted on save and never returned.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { poolStatus, saveHelper, removeHelper, retryMember, clearHelperMemo, HELPER } from '@/lib/systems/warmup';
import { PROVIDERS, providerForAddress } from '@/lib/smtp-providers';
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
      const provider = body.provider || providerForAddress(body.email) || 'google';
      const preset = PROVIDERS[provider];
      if (!preset) return Response.json({ error: `unknown provider "${provider}"` }, { status: 400 });
      // Free accounts that cannot log in with a password (Outlook.com: OAuth2
      // only since Sep 2024; Zoho / mail.com free: no IMAP) would only fail.
      if (!preset.helper && !body.force) return Response.json({ error: preset.helperNote || `${preset.label || provider} cannot be a free helper.` }, { status: 400 });
      const rec = await saveHelper({ email: body.email, password: body.password, displayName: body.displayName, provider, imapUser: body.imapUser || null });
      return Response.json({ ok: true, email: rec.email, provider: rec.provider });
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
