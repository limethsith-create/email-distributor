/**
 * GET /c/{token}/book — the applicant's booking page (docs/CALENDAR.md).
 * Public (the signed link token, purpose `book`). Plain server-rendered HTML
 * (templates/bookpage.js): their own time zone first with a switcher
 * (?tz=), the open times of the next CALENDAR.daysAhead days, a note box and
 * one button that posts to /api/c/book. Their current request or booking is
 * shown instead, with "Ask for a different time" (?change=1).
 * ?flash=sent|taken|limit|gone|error|pick shows one line after a post.
 */

import { readToken } from '@/lib/pagetokens';
import { bookingPageData } from '@/lib/systems/calendar';
import { bookingPage, messagePage, HTML_HEADERS } from '@/lib/templates/bookpage';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { token } = await params;
  const url = new URL(request.url);
  const t = await readToken(token, { purpose: 'book' }).catch(() => null);
  if (!t) return new Response(messagePage('This link has expired', "Reply to my email and I'll send you a new one."), { status: 404, headers: HTML_HEADERS });
  try {
    const data = await bookingPageData(t.clientId, { tz: url.searchParams.get('tz') });
    const html = bookingPage(data, { token, flash: url.searchParams.get('flash'), change: url.searchParams.get('change') === '1' });
    return new Response(html, { headers: HTML_HEADERS });
  } catch (err) {
    console.error('[book] page failed', t.clientId, err?.message);
    return new Response(messagePage('Something went wrong', 'Please try again in a minute, or reply to my email.'), { status: 500, headers: HTML_HEADERS });
  }
}
