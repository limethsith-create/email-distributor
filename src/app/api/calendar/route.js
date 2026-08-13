/**
 * Calendar API — discovery-call availability + bookings.
 *
 * GET  → { availability, upcoming, openSlots, tz }
 * POST → actions: save_availability | add_booking | confirm | cancel
 */

import {
  US_TZ, SL_TZ,
  getAvailability, saveAvailability,
  getBookings, setBooking, updateBookingStatus, removeBooking,
  computeOpenSlots, labelInstant, fmtTime, zonedWallToUtc,
} from '@/lib/calendar';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Show an ET wall-clock window (["09:00","15:30"]) in both zones, using today
// as the reference date for the Sri Lanka equivalent.
function labelWindow(win) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const parts = win.map((hhmm) => {
    const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
    // Reference instant: that ET time, today-ish.
    const inst = zonedWallToUtc(y, now.getUTCMonth() + 1, now.getUTCDate(), h, m, US_TZ);
    return { us: fmtTime(inst, US_TZ), sl: fmtTime(inst, SL_TZ) };
  });
  return {
    us: `${parts[0].us} – ${parts[1].us}`,
    sl: `${parts[0].sl} – ${parts[1].sl}`,
    raw: win,
  };
}

export async function GET() {
  try {
    const [availability, bookings] = await Promise.all([getAvailability(), getBookings()]);

    const windowsLabelled = {};
    for (let d = 0; d <= 6; d++) {
      windowsLabelled[d] = (availability.windows?.[d] || []).map(labelWindow);
    }

    const now = Date.now();
    const upcoming = Object.values(bookings || {})
      .filter((b) => b && b.start && new Date(b.start).getTime() > now - 60 * 60 * 1000)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((b) => ({
        ...b,
        ...labelInstant(new Date(b.start)),
      }));

    const openSlots = computeOpenSlots(availability, bookings, { days: 14, limit: 40 });

    return Response.json({
      success: true,
      tz: { us: US_TZ, sl: SL_TZ },
      availability: { slotMinutes: availability.slotMinutes, windows: availability.windows, windowsLabelled },
      upcoming,
      openSlots,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (action === 'save_availability') {
      const saved = await saveAvailability({
        slotMinutes: body.slotMinutes,
        windows: body.windows || {},
      });
      return Response.json({ success: true, availability: saved });
    }

    if (action === 'add_booking') {
      // Book a specific open slot (iso required) with the prospect's details.
      let iso = body.iso;
      if (!iso && body.date && body.time) {
        const [y, m, d] = body.date.split('-').map((n) => parseInt(n, 10));
        const [hh, mm] = body.time.split(':').map((n) => parseInt(n, 10));
        iso = zonedWallToUtc(y, m, d, hh, mm, US_TZ).toISOString();
      }
      if (!iso) return Response.json({ success: false, error: 'iso or date+time required' }, { status: 400 });
      const entry = await setBooking(iso, {
        prospectEmail: body.prospectEmail,
        leadEmail: body.leadEmail || body.prospectEmail,
        company: body.company,
        status: body.status === 'proposed' ? 'proposed' : 'confirmed',
        note: body.note,
      });
      return Response.json({ success: true, booking: { ...entry, ...labelInstant(new Date(iso)) } });
    }

    if (action === 'confirm') {
      if (!body.iso) return Response.json({ success: false, error: 'iso required' }, { status: 400 });
      const entry = await updateBookingStatus(body.iso, 'confirmed');
      if (!entry) return Response.json({ success: false, error: 'not found' }, { status: 404 });
      return Response.json({ success: true, booking: entry });
    }

    if (action === 'cancel') {
      if (!body.iso) return Response.json({ success: false, error: 'iso required' }, { status: 400 });
      await removeBooking(body.iso);
      return Response.json({ success: true, cancelled: body.iso });
    }

    return Response.json({ success: false, error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
