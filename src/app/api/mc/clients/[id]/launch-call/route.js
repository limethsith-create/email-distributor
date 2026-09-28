/**
 * /api/mc/clients/[id]/launch-call — the owner's launch-call buttons in the
 * hub (docs/LAUNCH-CALL.md §5). Admin / hub token (middleware).
 *   GET                                  → { launchCall }   (null until the invite went)
 *   POST { action: 'reply', text }       plain text, ≤ 2 000 characters, same inbox, same thread
 *        { action: 'markBooked', when }  ISO date-time of the call
 *        { action: 'markHeld' } · { action: 'markNoShow' }
 *        { action: 'resend' }            the invite again · { action: 'stopReminders' }
 *        { action: 'approvedOnCall' }    every section approved (approvalMode 'call'), the call held
 *        { action: 'skip' }              only once they approved on the page
 *   → { ok, launchCall } · 400/409 { error } in plain words
 */

import { assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { OnboardCallError } from '@/lib/systems/onboardcall';
import { launchCallAction, launchCallFor } from '@/lib/systems/launchcall';
import { demoRefusal } from '@/lib/systems/demo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function idOf(params) {
  try { return assertClientId(params.id); } catch { return null; }
}

export async function GET(_req, { params }) {
  const id = idOf(params);
  if (!id) return Response.json({ error: 'bad client id' }, { status: 400 });
  return Response.json({ launchCall: await launchCallFor(id) });
}

export async function POST(request, { params }) {
  const refused = demoRefusal((await params)?.id);
  if (refused) return refused;
  const id = idOf(params);
  if (!id) return Response.json({ error: 'bad client id' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  try {
    return Response.json(await launchCallAction(id, body));
  } catch (err) {
    if (err instanceof OnboardCallError) return Response.json({ error: err.message }, { status: err.status });
    await logEvent(id, 'mc', 'launch_call_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
