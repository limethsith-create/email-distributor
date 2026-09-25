/**
 * GET /api/google/callback?code&state — where Google sends the owner back
 * after "Allow" (docs/REPLYBOT-MEET.md §3). Public (middleware PUBLIC): the
 * one-use `state` made by POST /api/mc/google {action:'connect'} is the check.
 * Always a 303 to the hub's Settings › Google Meet:
 *   …/#settings/google?connected=1, or ?error=<short code>
 *   (state | denied | google | no_code | not_set_up | exchange | google_down |
 *   calendar_permission | no_refresh_token | server). Nothing else is revealed.
 */

import { logEvent } from '@/lib/db/events';
import { handleCallback, hubUrl } from '@/lib/ext/google';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  let out;
  try {
    out = await handleCallback({ code: q.get('code'), state: q.get('state'), error: q.get('error') });
  } catch (err) {
    await logEvent(null, 'google', 'callback_failed', { error: String(err?.message || err).slice(0, 200) });
    out = { ok: false, error: 'server' };
  }
  const to = `${hubUrl()}/#settings/google?${out.ok ? 'connected=1' : `error=${encodeURIComponent(out.error)}`}`;
  return new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
