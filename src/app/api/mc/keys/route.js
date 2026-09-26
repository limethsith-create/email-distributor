/**
 * /api/mc/keys — the hub's Settings › Keys (docs/KEYS.md, docs/HUB-API.md
 * "Keys"). Admin cookie or hub token (middleware).
 *   GET → { keys: [ { name, label, short, optional, secret, fields, set, from: 'env|hub|null',
 *                     savedAt, testedAt, ok, problem, detail, url, free, steps, note } ], encKey }
 *   POST { action: 'save', name, value } (Verifalia: { name: 'VERIFALIA', username, password })
 *        → { saved: true, …status } (the key was checked with the service first)
 *        { action: 'test', name } → { tested: true, …status } (ok / problem = the outcome)
 *        { action: 'forget', name } → { forgotten: true, …status }
 *   → 400/409/503 { error } in plain words (400 also when the service refused the key — nothing saved).
 * A key's value is never in any answer (GITHUB_REPO is a plain setting and is shown).
 */

import { logEvent } from '@/lib/db/events';
import { keysView, saveKey, testKey, forgetKey, KeysError } from '@/lib/systems/keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const fail = (err) => Response.json({ error: err.message }, { status: err.status || 502 });

export async function GET() {
  try {
    return Response.json(await keysView());
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'save': return Response.json({ saved: true, ...(await saveKey({ name: body.name, value: body.value, username: body.username, password: body.password })) });
      case 'test': return Response.json({ tested: true, ...(await testKey({ name: body.name })) });
      case 'forget': return Response.json({ forgotten: true, ...(await forgetKey({ name: body.name })) });
      default: return Response.json({ error: 'Unknown action — use save, test or forget.' }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof KeysError) return fail(err);
    await logEvent(null, 'mc', 'keys_action_failed', { action: body.action, name: String(body.name || '').slice(0, 40), error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
