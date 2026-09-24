/**
 * Lead Finder results (SPEC §7.2 step 7). Called by the GitHub Actions job
 * with `Authorization: Bearer LEADFINDER_TOKEN`. Public in middleware
 * (/api/webhooks/*) — this route verifies the token itself.
 * body.type: hosts | batch | done | failed (see src/lib/systems/leadfinder.js)
 */

import { secretMatches } from '@/lib/auth/session';
import { handleWebhook } from '@/lib/systems/leadfinder';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request) {
  const secret = process.env.LEADFINDER_TOKEN;
  if (!secretMatches(request.headers.get('authorization') || '', secret ? `Bearer ${secret}` : '')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return Response.json({ error: 'bad json' }, { status: 400 });
  try {
    const { status, json } = await handleWebhook(body);
    return Response.json(json, { status });
  } catch (err) {
    await logEvent(body.clientId && /^[a-z0-9_-]+$/.test(body.clientId) ? body.clientId : null, 'leadfinder', 'webhook_error', { type: body.type, error: err.message });
    const { alertOwner } = await import('@/lib/notify');
    await alertOwner('leadfinder_failed', { scope: `webhook:${body.clientId}`, vars: { clientId: String(body.clientId || 'unknown') }, body: `The Lead Finder webhook failed on a "${body.type}" post: ${err.message}`, did: 'The batch was not stored; the job sees an error for this post.' });
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
