/**
 * POST /api/cron/research?client={id}&hop={n} — carry an applicant's research
 * on in a fresh function (machine route: Authorization: Bearer CRON_SECRET,
 * checked in middleware). The research of one applicant can take longer than
 * one function may run (a big site, slow public records), so each run hands
 * the rest to the next one (systems/research.js researchToEnd → continueLater),
 * a few hops at most. The per-minute research job still picks up anything left.
 */

import { after } from 'next/server';
import { assertClientId } from '@/lib/db/keys';
import { researchToEnd } from '@/lib/systems/research';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  let id;
  try { id = assertClientId(searchParams.get('client')); } catch { return Response.json({ error: 'bad client id' }, { status: 400 }); }
  const hop = Math.max(0, Math.min(10, Number(searchParams.get('hop')) || 0));
  after(() => researchToEnd(id, 52_000, { hop }));
  return Response.json({ ok: true, continuing: id, hop }, { status: 202 });
}
