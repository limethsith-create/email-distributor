/**
 * GET /api/c/book/slots?token=&tz= — the open times for the booking page
 * (docs/CALENDAR.md), public with the signed link token (purpose `book`).
 *   → { zone, slots: [ { start: ISO, label: 'Tue 30 Sep · 2:00 pm' } ], existing: meeting|null, closed }
 */

import { readToken } from '@/lib/pagetokens';
import { bookingPageData } from '@/lib/systems/calendar';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-page-token') || '';
  const t = await readToken(token, { purpose: 'book' }).catch(() => null);
  if (!t) return Response.json({ error: 'This link has expired or is not valid.' }, { status: 401 });
  const d = await bookingPageData(t.clientId, { tz: url.searchParams.get('tz') });
  return Response.json({ zone: d.zone, slots: d.slots, existing: d.existing, closed: d.closed }, { headers: { 'Cache-Control': 'no-store' } });
}
