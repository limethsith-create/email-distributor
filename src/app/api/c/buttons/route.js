/**
 * Client buttons (SPEC §8.8, §7.3): one signed token (`buttons`, 14 days)
 * behind three pages — "You emailed my customer", "Stop the trial", "I'm away".
 *   GET  ?t=                → { clientName, away }
 *   POST { t, action, ... } → action = customer | stop | away
 */

import { readToken } from '@/lib/pagetokens';
import { getClient, getProfile } from '@/lib/db/client';
import { handleButtons } from '@/lib/systems/clientwatch';
import { parseJson } from '@/lib/systems/stagec-common';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const tok = await readToken(new URL(request.url).searchParams.get('t'), { purpose: 'buttons' });
  if (!tok) return Response.json({ ok: false, error: 'This link has expired. Reply to any of our emails and we will act on it by hand.' }, { status: 404 });
  const [client, profile] = await Promise.all([getClient(tok.clientId), getProfile(tok.clientId)]);
  return Response.json({ ok: true, clientName: client?.name || null, away: parseJson(profile.awayRanges, []) || [] });
}

export async function POST(request) {
  const { status, body } = await handleButtons(await request.json().catch(() => ({})));
  return Response.json(body, { status });
}
