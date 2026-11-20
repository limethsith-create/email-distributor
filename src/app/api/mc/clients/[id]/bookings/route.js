/**
 * Bookings for Mission Control (SPEC §8.5 disputes). Admin session required
 * (middleware).
 *   GET                                   → { bookings, pacelog, hot }
 *   POST { bookingId, action: 'uphold' | 'overturn' }  → owner decision on a dispute
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { getBookings } from '@/lib/systems/bookings';
import { resolveDispute } from '@/lib/systems/scorekeeper';
import { getPaceLog } from '@/lib/systems/pace';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  if (!(await getClient(id))) return Response.json({ error: 'not found' }, { status: 404 });
  const [bookings, pacelog, hot] = await Promise.all([getBookings(id), getPaceLog(id, 50), kv.hgetall(K.hot(id))]);
  const list = Object.values(bookings).sort((a, b) => String(b.scheduledAt || '').localeCompare(String(a.scheduledAt || '')));
  return Response.json({ bookings: list, pacelog, hot: Object.values(hot || {}) });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  if (!(await getClient(id))) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  if (!['uphold', 'overturn'].includes(body.action) || !body.bookingId) return Response.json({ error: 'expected {bookingId, action: "uphold"|"overturn"}' }, { status: 400 });
  const res = await resolveDispute(id, String(body.bookingId), body.action, { by: 'owner' });
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  await logEvent(id, 'mc', 'dispute_decided', { bookingId: body.bookingId, action: body.action });
  return Response.json({ ok: true, booking: res.booking });
}
