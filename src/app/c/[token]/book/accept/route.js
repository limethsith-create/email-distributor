/**
 * /c/{token}/book/accept?m={meetingId} — the applicant's "Yes, that works"
 * for a time the owner suggested (docs/CALENDAR.md).
 *   GET  → the suggested time in their zone and ONE button (a form POST: mail
 *          link scanners open GET links by themselves and must never accept
 *          a meeting for someone).
 *   POST → accepted: confirmed, the confirmation + invite go to them, the
 *          owner is told. 409 (the time has gone) → pick another.
 * Public (the signed link token, purpose `book`); tries are rate-limited per link.
 */

import { readToken } from '@/lib/pagetokens';
import { getMeeting, acceptSuggestion, publicMeeting, zoneInfo, allowBookTry, CalendarError } from '@/lib/systems/calendar';
import { acceptPage, messagePage, HTML_HEADERS } from '@/lib/templates/bookpage';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const html = (body, status = 200) => new Response(body, { status, headers: HTML_HEADERS });

async function resolve(request, params) {
  const { token } = await params;
  const id = new URL(request.url).searchParams.get('m') || '';
  const t = await readToken(token, { purpose: 'book' }).catch(() => null);
  return { token, id, t };
}

const closed = (token) => messagePage('This suggestion is no longer open', 'Pick any time that suits you on the booking page.', { href: `/c/${encodeURIComponent(token)}/book`, text: 'Open the booking page' });

export async function GET(request, { params }) {
  const { token, id, t } = await resolve(request, params);
  if (!t) return html(messagePage('This link has expired', "Reply to my email and I'll send you a new one."), 404);
  const m = await getMeeting(id);
  if (!m || m.clientId !== t.clientId) return html(closed(token), 404);
  const tz = m.theirZone || 'America/New_York';
  if (m.status === 'confirmed') return html(acceptPage({ token, meeting: publicMeeting(m, tz), zoneName: zoneInfo(tz).name, done: true }));
  if (m.status !== 'requested' || !m.proposed) return html(closed(token));
  return html(acceptPage({ token, meeting: publicMeeting(m, tz), zoneName: zoneInfo(tz).name }));
}

export async function POST(request, { params }) {
  const { token, id, t } = await resolve(request, params);
  if (!t) return html(messagePage('This link has expired', "Reply to my email and I'll send you a new one."), 404);
  if (!(await allowBookTry(token))) return html(messagePage('Too many tries for now', 'Please wait a few minutes, or reply to my email.'), 429);
  try {
    const m = await acceptSuggestion(t.clientId, id);
    const tz = m.theirZone || 'America/New_York';
    return html(acceptPage({ token, meeting: publicMeeting(m, tz), zoneName: zoneInfo(tz).name, done: true }));
  } catch (err) {
    if (err instanceof CalendarError) {
      return html(messagePage(err.status === 409 ? 'That time has gone' : 'This suggestion is no longer open', err.message, { href: `/c/${encodeURIComponent(token)}/book`, text: 'Pick another time' }), err.status);
    }
    console.error('[book/accept] failed', t.clientId, err?.message);
    return html(messagePage('Something went wrong', 'Please try again in a minute, or reply to my email.'), 500);
  }
}
