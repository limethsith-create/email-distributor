/**
 * /api/mc/calendar — the hub's Calendar tab (docs/CALENDAR.md, docs/HUB-API.md).
 * Admin cookie or hub token (middleware).
 *   GET ?from=ISO&to=ISO[&all=1] → { meetings, requests, settings, free }
 *   POST { action: 'confirm', id } · { action: 'decline', id, reason }
 *        { action: 'suggest', id, start } · { action: 'move', id, start }
 *        { action: 'held', id } · { action: 'noShow', id } · { action: 'cancel', id, reason }
 *        { action: 'add', clientId|null, title, start, minutes, kind? }
 *        { action: 'block', start, minutes } · { action: 'unblock', id }
 *   → { ok, meeting } · 400/404/409 { error } in plain words · 502 when the
 *     email to them could not go (nothing changed).
 */

import { logEvent } from '@/lib/db/events';
import { calendarView, calendarAction, CalendarError } from '@/lib/systems/calendar';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const url = new URL(request.url);
  try {
    return Response.json(await calendarView({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), all: url.searchParams.get('all') === '1' }));
  } catch (err) {
    if (err instanceof CalendarError) return Response.json({ error: err.message }, { status: err.status });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    return Response.json(await calendarAction(body));
  } catch (err) {
    if (err instanceof CalendarError) return Response.json({ error: err.message }, { status: err.status });
    await logEvent(null, 'mc', 'calendar_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
