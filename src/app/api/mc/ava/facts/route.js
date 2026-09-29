/**
 * /api/mc/ava/facts — the owner's "Business facts" note for Ava
 * (docs/HUB-API.md "Ava (AI helper)"). Everyone signed in reads it; only the owner writes it (403 for a team member).
 *   GET  → { text, updatedAt, by, maxBytes: 4096 }
 *   POST { text } → { ok, text, updatedAt, by }   (empty text clears it; over 4 KB → 400)
 */

import { getFacts, setFacts, FACTS_MAX_BYTES } from '@/lib/ava/facts';
import { whoIsAsking } from '@/lib/ava/who';

export const dynamic = 'force-dynamic';

const ownerOnly = () => Response.json({ error: 'Only the owner can change the business facts.' }, { status: 403 });

export async function GET() {
  try {
    return Response.json({ ...(await getFacts()), maxBytes: FACTS_MAX_BYTES });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  if (request.headers.get('x-hub-role') !== 'admin') return ownerOnly();
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || (body.text != null && typeof body.text !== 'string')) return Response.json({ error: 'Send { text }.' }, { status: 400 });
  try {
    const user = await whoIsAsking(request);
    return Response.json(await setFacts(body.text || '', user.name || 'owner'));
  } catch (err) {
    return Response.json({ error: err.message || 'That did not save.' }, { status: err.status || 500 });
  }
}
