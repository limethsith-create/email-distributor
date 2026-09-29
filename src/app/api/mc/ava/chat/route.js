/**
 * POST /api/mc/ava/chat — ask Ava (docs/HUB-API.md "Ava (AI helper)").
 * Owner and team members (middleware lets team members POST here).
 *   body { messages: [{ role: 'user'|'assistant', content }], page: { view, clientId, tab } }
 *   → 200 { reply, actions: [...], brain, tried: [{ brain, ok, ms, error }] }
 *   → 503 { error, needsKeys: true } no AI key yet · 429 { error } too many questions
 *   → 502 { error, tried } no brain answered · 400 { error } bad body
 */

import { avaChat, AvaError } from '@/lib/ava/chat';
import { whoIsAsking } from '@/lib/ava/who';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return Response.json({ error: 'Send { messages, page }.' }, { status: 400 });
  try {
    const user = await whoIsAsking(request);
    return Response.json(await avaChat(body, user));
  } catch (err) {
    if (err instanceof AvaError) return Response.json({ error: err.message, ...err.extra }, { status: err.status });
    console.error('[ava] chat failed', err?.message);
    return Response.json({ error: 'Ava ran into a problem — try again.' }, { status: 500 });
  }
}
