/**
 * /api/mc/cheapinboxes — the hub's Settings › Inboxes & domains
 * (docs/AUTO-BUY.md §1, the owner's steps in docs/CHEAPINBOXES-SETUP.md).
 * Admin cookie or hub token (middleware).
 *   GET → { status: 'not_set_up|connected|broken', account, hasPaymentMethod,
 *           webhook: 'registered|missing', unmatched: [{ domain, mailboxes, boughtAt }],
 *           keyFrom, checkedAt, lastSyncAt, problem, encKey }
 *   POST { action: 'saveKey', apiKey } → { ok, …status } (checks the key, reads
 *        whether a card is on file, registers the webhook; the first look at the
 *        account runs right after the answer)
 *        { action: 'test' } → { ok, …status, webhookRenewed }
 *        { action: 'forget' } → { ok, …status, webhookRemoved }
 *   → 400/409/502/503 { error } in plain words.
 * The API key and the webhook secret are never in any answer.
 */

import { after } from 'next/server';
import { logEvent } from '@/lib/db/events';
import { cheapInboxesStatus, saveKey, testKey, forgetKey, CheapInboxesError } from '@/lib/ext/cheapinboxes';
import { syncQuietly } from '@/lib/systems/autobuy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const fail = (err) => Response.json({ error: err.message }, { status: err.status || 502 });

export async function GET() {
  try {
    return Response.json(await cheapInboxesStatus());
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'saveKey': {
        const out = await saveKey({ apiKey: body.apiKey });
        // The first look at the account (what it already owns is not a new purchase) — after the answer.
        try { after(() => syncQuietly({ force: true, reason: 'key_saved', deadline: Date.now() + 45000 })); } catch { /* not inside a request (tests) */ }
        return Response.json({ ok: true, ...out });
      }
      case 'test': return Response.json(await testKey());
      case 'forget': return Response.json({ ok: true, ...(await forgetKey()) });
      default: return Response.json({ error: 'Unknown action — use saveKey, test or forget.' }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof CheapInboxesError) return fail(err);
    await logEvent(null, 'mc', 'cheapinboxes_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
