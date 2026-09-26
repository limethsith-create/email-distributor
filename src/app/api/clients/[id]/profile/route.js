/**
 * GET /api/clients/{id}/profile — what the Lead Finder job needs (SPEC §7.2):
 * search profile, blocklist hosts/names, excluded pattern, Places/Reoon budgets,
 * and — for the job only — the service keys from the store (`keys`, docs/KEYS.md).
 * Machine route: `Authorization: Bearer LEADFINDER_TOKEN`, verified here. An
 * admin session may read the payload too, without the keys.
 * NOTE: middleware must let this path through (see the Stage B report) —
 * otherwise it answers 401 before reaching this handler.
 */

import { assertClientId } from '@/lib/db/keys';
import { secretMatches, isAdminRequest } from '@/lib/auth/session';
import { profilePayload } from '@/lib/systems/leadfinder';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const secret = process.env.LEADFINDER_TOKEN;
  const okToken = secretMatches(request.headers.get('authorization') || '', secret ? `Bearer ${secret}` : '');
  if (!okToken && !(await isAdminRequest(request))) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let id;
  try { id = assertClientId(params.id); } catch { return Response.json({ error: 'bad client id' }, { status: 400 }); }
  const payload = await profilePayload(id, new Date(), { keys: okToken });
  if (!payload) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(payload);
}
