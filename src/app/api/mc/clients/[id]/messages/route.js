/**
 * /api/mc/clients/[id]/messages — the client's one conversation and the
 * owner's buttons on it (docs/REPLYBOT-MEET.md §1). Admin / hub token
 * (middleware protects /api/mc/*).
 *   GET                              → { conversation }
 *   POST { action: 'reply', text }   plain text, ≤ 2 000 characters, from the ONBOARDCALL inbox,
 *                                    threaded (In-Reply-To / References) — any client, not only onboarding
 *        { action: 'botOff' }        the reply bot stops answering THIS client
 *        { action: 'botOn' }         … and starts again
 *   → { ok, conversation } · 400/404/409 { error } in plain words
 * The onboarding card's `reply` (/api/mc/clients/{id}/onboard-call) stays as an alias.
 */

import { assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { conversationFor, messagesAction, MessagesError } from '@/lib/systems/conversation';
import { OnboardCallError } from '@/lib/systems/onboardcall';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function idOf(params) {
  try { return assertClientId(params.id); } catch { return null; }
}

export async function GET(_req, { params }) {
  const id = idOf(await params);
  if (!id) return Response.json({ error: 'bad client id' }, { status: 400 });
  const conversation = await conversationFor(id);
  if (!conversation) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ conversation });
}

export async function POST(request, { params }) {
  const id = idOf(await params);
  if (!id) return Response.json({ error: 'bad client id' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  try {
    return Response.json(await messagesAction(id, body));
  } catch (err) {
    if (err instanceof MessagesError || err instanceof OnboardCallError) return Response.json({ error: err.message }, { status: err.status });
    await logEvent(id, 'mc', 'messages_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
