/**
 * /api/mc/clients/[id]/onboard-call — the owner's onboarding-call buttons in
 * the hub (docs/ONBOARD-CALL.md §4–5). Admin / hub token (middleware).
 *   GET                                  → { onboardCall }   (null when no acceptance email went)
 *   POST { action: 'reply', text }       plain text, ≤ 2 000 characters, same inbox, same thread
 *        { action: 'markBooked', when }  ISO date-time of the call
 *        { action: 'markHeld' } · { action: 'markNoShow' }
 *        { action: 'resend' }            the acceptance email again
 *        { action: 'stopReminders' }
 *   → { ok, onboardCall } · 400/409 { error } in plain words
 */

import { assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { onboardCallAction, onboardCallFor, OnboardCallError } from '@/lib/systems/onboardcall';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function idOf(params) {
  try { return assertClientId(params.id); } catch { return null; }
}

export async function GET(_req, { params }) {
  const id = idOf(params);
  if (!id) return Response.json({ error: 'bad client id' }, { status: 400 });
  return Response.json({ onboardCall: await onboardCallFor(id) });
}

export async function POST(request, { params }) {
  const id = idOf(params);
  if (!id) return Response.json({ error: 'bad client id' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  try {
    return Response.json(await onboardCallAction(id, body));
  } catch (err) {
    if (err instanceof OnboardCallError) return Response.json({ error: err.message }, { status: err.status });
    await logEvent(id, 'mc', 'onboard_call_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
