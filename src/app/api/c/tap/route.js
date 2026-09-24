/**
 * Call tap API (SPEC §8.4/§8.5). Public; authorised by the signed tap token
 * (`tap:{bookingId}`, 24 h). GET shows the booking, POST records the tap.
 */

import { readToken } from '@/lib/pagetokens';
import { getLead } from '@/lib/db/leads';
import { getBookings } from '@/lib/systems/bookings';
import { applyTap, DISPUTE_REASONS, TAP_ACTIONS } from '@/lib/systems/scorekeeper';
import { formatWhen } from '@/lib/systems/stagec-common';

export const dynamic = 'force-dynamic';

async function resolve(t) {
  const tok = await readToken(t, { purpose: 'tap' });
  if (!tok || !tok.data?.bookingId) return null;
  const booking = (await getBookings(tok.clientId))[tok.data.bookingId];
  return booking ? { ...tok, booking } : null;
}

export async function GET(request) {
  const t = new URL(request.url).searchParams.get('t');
  const r = await resolve(t);
  if (!r) return Response.json({ ok: false, error: 'This link has expired. Reply to the email and I will record it by hand.' }, { status: 404 });
  const b = r.booking;
  const lead = b.leadEmail ? await getLead(r.clientId, b.leadEmail) : null;
  return Response.json({
    ok: true,
    booking: {
      name: lead?.name || lead?.first_name || b.attendeeName || b.attendeeEmail || 'the prospect',
      company: lead?.company || null,
      when: formatWhen(b.scheduledAt, lead?.tz) || null,
      status: b.status,
      tapped: Boolean(b.attendedTapAt || b.disputedAt || ['noshow', 'wrongfit', 'closed_noshow'].includes(b.status)),
      manualMatch: Boolean(b.manualMatch),
    },
    actions: TAP_ACTIONS,
    reasons: DISPUTE_REASONS,
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const r = await resolve(body.t);
  if (!r) return Response.json({ ok: false, error: 'This link has expired.' }, { status: 404 });
  const res = await applyTap(r.clientId, r.booking.id, String(body.action || ''), { reason: body.reason || null, note: body.note ? String(body.note).slice(0, 1000) : null });
  if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 400 });
  return Response.json({ ok: true, status: res.booking?.status || null });
}
