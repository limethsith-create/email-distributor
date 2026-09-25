/**
 * POST /api/c/book — the applicant asks for a time (docs/CALENDAR.md).
 * Public (the signed link token, purpose `book`, in the body or the
 * `x-page-token` header). Body { token, start, note?, tz? } as JSON, or the
 * booking page's own form post.
 *   JSON → { ok, meeting } · 409 { ok:false, error } when the slot was just
 *          taken · 400 bad input · 401 bad link · 429 too many tries.
 *   form → 303 back to /c/{token}/book with ?flash=sent|taken|pick|limit|error.
 * Tries (asks + accepts) are limited per link per hour (BOOK_TRIES_PER_HOUR).
 */

import { readToken } from '@/lib/pagetokens';
import { requestMeeting, publicMeeting, pickZone, allowBookTry, CalendarError } from '@/lib/systems/calendar';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return { form: false, body: await request.json().catch(() => ({})) };
  const fd = await request.formData().catch(() => null);
  const body = {};
  if (fd) for (const [k, v] of fd.entries()) body[k] = typeof v === 'string' ? v : '';
  return { form: true, body };
}

export async function POST(request) {
  const { form, body } = await readBody(request);
  const token = String(body.token || request.headers.get('x-page-token') || '');
  const zone = pickZone(body.tz);
  const back = (flash) => new Response(null, {
    status: 303,
    headers: { Location: new URL(`/c/${encodeURIComponent(token)}/book?flash=${flash}${zone ? `&tz=${encodeURIComponent(zone)}` : ''}`, request.url).toString(), 'Cache-Control': 'no-store' },
  });
  const t = await readToken(token, { purpose: 'book' }).catch(() => null);
  if (!t) return Response.json({ ok: false, error: 'This link has expired or is not valid. Reply to my email and I will send a new one.' }, { status: 401 });
  if (!(await allowBookTry(token))) return form ? back('limit') : Response.json({ ok: false, error: 'Too many tries for now — please wait a few minutes.' }, { status: 429 });
  try {
    const m = await requestMeeting(t.clientId, { start: body.start, note: body.note, zone });
    return form ? back('sent') : Response.json({ ok: true, meeting: publicMeeting(m, m.theirZone || zone || 'America/New_York') });
  } catch (err) {
    if (err instanceof CalendarError) {
      if (form) return back(err.status === 409 ? 'taken' : err.status === 400 ? 'pick' : 'error');
      return Response.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('[book] request failed', t.clientId, err?.message);
    return form ? back('error') : Response.json({ ok: false, error: 'Something went wrong — please try again in a minute.' }, { status: 500 });
  }
}
