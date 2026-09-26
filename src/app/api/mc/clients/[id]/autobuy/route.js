/**
 * /api/mc/clients/[id]/autobuy — one trial's CheapInboxes purchase
 * (docs/AUTO-BUY.md §3). Admin cookie or hub token (middleware).
 *   GET → { ok, autobuy }
 *   POST { action: 'recheck' }        look for the purchase now (and remake a shopping list over an hour old)
 *        { action: 'link', domain }   this domain (in the CheapInboxes account) is this trial's
 *        { action: 'unlink' }         undo a wrong link — only before any inbox was connected
 *        { action: 'pick', domain }   buy this alternative instead (updates the shopping list)
 *   → { ok: true, autobuy, sync? } · { ok: false, error, autobuy } with 400/404/409.
 * The machine never places an order: every action only reads the account or
 * changes what the machine itself keeps.
 */

import { assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { autobuyAction, autobuyFor, AutobuyError } from '@/lib/systems/autobuy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const current = (id) => autobuyFor(id).catch(() => null);

export async function GET(_req, { params }) {
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ ok: false, error: 'bad client id' }, { status: 400 }); }
  const autobuy = await current(id);
  return Response.json({ ok: true, autobuy });
}

export async function POST(request, { params }) {
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ ok: false, error: 'bad client id', autobuy: null }, { status: 400 }); }
  const body = await request.json().catch(() => ({}));
  try {
    return Response.json(await autobuyAction(id, body));
  } catch (err) {
    if (err instanceof AutobuyError) return Response.json({ ok: false, error: err.message, autobuy: await current(id) }, { status: err.status || 400 });
    await logEvent(id, 'mc', 'autobuy_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ ok: false, error: String(err?.message || err), autobuy: await current(id) }, { status: err?.status && err.status < 600 ? err.status : 500 });
  }
}
