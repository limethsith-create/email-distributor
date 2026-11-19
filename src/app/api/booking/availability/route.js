/**
 * GET /api/booking/availability?from=&to=&days= — what the public website's "Book a call" page needs to
 * offer only free times inside the owner's call hours (systems/calendar.js publicAvailability):
 *   → { ok, zone, days, hours: ['09:00','17:00'], closed: ['YYYY-MM-DD'], busy: [{ start, end }], from, to, generatedAt }
 * Times only (no names, emails or titles). Public and read-only; CORS for SITE_ORIGINS in middleware.
 * Cached briefly: a time booked a few seconds ago is still refused by POST /api/inquiry.
 */

import { publicAvailability, CalendarError } from '@/lib/systems/calendar';

export const dynamic = 'force-dynamic';

const CACHE = 'public, max-age=15, s-maxage=15, stale-while-revalidate=30';

export async function GET(request) {
  const url = new URL(request.url);
  try {
    const a = await publicAvailability({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), days: url.searchParams.get('days') });
    return Response.json({ ok: true, ...a }, { headers: { 'Cache-Control': CACHE } });
  } catch (err) {
    const status = err instanceof CalendarError ? err.status : 500;
    return Response.json({ ok: false, error: err instanceof CalendarError ? err.message : 'Could not read the calendar.' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
