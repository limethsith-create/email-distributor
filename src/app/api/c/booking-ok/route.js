/**
 * POST /api/c/booking-ok — the client's "It worked" tap from the booking
 * test email (SPEC §6.7). Public (signed token in the body). A POST, not a
 * GET, so mail scanners that pre-open links cannot tap it.
 */

import { confirmBookingOk } from '@/lib/systems/bookingtest';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const r = await confirmBookingOk(body.token || request.headers.get('x-page-token'));
  return Response.json(r, { status: r.ok ? 200 : 401 });
}
