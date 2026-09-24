/**
 * Stage C holds for Mission Control. Admin session required (middleware).
 *   GET                                 → { legalHoldAt, emergency, smoke, pace, clientButtons? }
 *   POST { action: 'clearLegalHold' }   → owner clears a legal hold (SPEC §8.3)
 *   POST { action: 'clearSendHold' }   → owner clears an Auth Guard hold on a converted client
 *   POST { action: 'clientButtons' }    → mint the client-button links (customer / stop / away)
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { clientButtonLinks } from '@/lib/systems/clientwatch';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const [emergency, run, pace] = await Promise.all([kv.hgetall(K.emergency(id)), kv.hgetall(K.sendState(id)), kv.hgetall(K.pace(id))]);
  return Response.json({ legalHoldAt: client.legalHoldAt || null, sendHold: client.sendHold || null, emergencyActive: client.emergencyActive || '0', emergencyHalved: client.emergencyHalved || '0', emergency: emergency || {}, run: run || {}, pace: pace || {} });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  if (!(await getClient(id))) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  if (body.action === 'clearLegalHold') {
    await kv.hset(K.client(id), { legalHoldAt: '', legalHoldClearedAt: new Date().toISOString() });
    await logEvent(id, 'mc', 'legal_hold_cleared', {});
    return Response.json({ ok: true });
  }
  if (body.action === 'clearSendHold') {
    await kv.hset(K.client(id), { sendHold: '', sendHoldClearedAt: new Date().toISOString() });
    await logEvent(id, 'mc', 'send_hold_cleared', {});
    return Response.json({ ok: true });
  }
  if (body.action === 'clientButtons') return Response.json({ ok: true, links: await clientButtonLinks(id) });
  return Response.json({ error: 'unknown action' }, { status: 400 });
}
