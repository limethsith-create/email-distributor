/**
 * One-click unsubscribe endpoint — the target of every outreach email's
 * `List-Unsubscribe` header (see lib/mailer) and of the "reply STOP" link.
 *
 *   GET  ?t=<token>   verify the signed token, suppress the address, show a
 *                     tiny confirmation page (200); a bad token is a 400.
 *   POST ?t=<token>   RFC 8058 one-click (body `List-Unsubscribe=One-Click`,
 *                     sent by the mail provider with no user interaction):
 *                     same suppression, answers { ok: true }.
 *
 * The token (lib/tokens) is an HMAC over the address, so only an address we
 * actually mailed can be suppressed. A bare `?email=` is honoured only when
 * it matches a valid token — an unsigned address is never suppressed.
 * Never throws.
 */

import { verifyUnsubscribeToken } from '@/lib/tokens';
import { addToSuppression } from '@/lib/leads-db';
import { normalizeEmail } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0', 'X-Robots-Tag': 'noindex' };

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(email) {
  const e = escapeHtml(email);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Unsubscribed</title>
<style>
  body { margin: 0; padding: 48px 20px; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; background: #fafaf8; }
  main { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e4e2dc; padding: 28px 30px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  p { margin: 0; color: #444; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: #f3f2ee; padding: 1px 5px; }
</style>
</head>
<body>
<main>
  <h1>You're unsubscribed.</h1>
  <p><code>${e}</code> will not be contacted again.</p>
</main>
</body>
</html>`;
}

/** Resolve the address to suppress from the request; null when unsigned/invalid. */
async function resolveEmail(request) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  let token = url.searchParams.get('t') || url.searchParams.get('token') || '';
  let requested = url.searchParams.get('email') || '';

  if (request.method === 'POST') {
    // RFC 8058 posts `List-Unsubscribe=One-Click` as a form body; some
    // providers also echo the token or address there.
    try {
      const ct = String(request.headers.get('content-type') || '').toLowerCase();
      const raw = await request.text();
      if (raw) {
        if (ct.includes('application/json')) {
          const body = JSON.parse(raw);
          token = token || body.t || body.token || '';
          requested = requested || body.email || '';
        } else {
          const form = new URLSearchParams(raw);
          token = token || form.get('t') || form.get('token') || '';
          requested = requested || form.get('email') || '';
        }
      }
    } catch {}
  }

  const email = verifyUnsubscribeToken(token);
  if (!email) return null;
  // An explicit ?email= must match the signed address; otherwise ignore it.
  if (requested && normalizeEmail(requested) !== email) return null;
  return email;
}

async function suppress(email) {
  try { await addToSuppression(email, 'one_click_unsubscribe'); return true; } catch { return false; }
}

export async function GET(request) {
  try {
    const email = await resolveEmail(request);
    if (!email) {
      return new Response('Invalid or expired unsubscribe link.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } });
    }
    const ok = await suppress(email);
    if (!ok) {
      return new Response('We could not process that right now. Please try again in a moment.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60', ...NO_STORE } });
    }
    return new Response(page(email), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } });
  } catch {
    return new Response('Invalid or expired unsubscribe link.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } });
  }
}

export async function POST(request) {
  try {
    const email = await resolveEmail(request);
    if (!email) return Response.json({ ok: false, error: 'invalid_token' }, { status: 400, headers: NO_STORE });
    const ok = await suppress(email);
    // A KV hiccup answers 503 so the mail provider retries the one-click POST.
    if (!ok) return Response.json({ ok: false, error: 'unavailable' }, { status: 503, headers: NO_STORE });
    return Response.json({ ok: true }, { status: 200, headers: NO_STORE });
  } catch {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 400, headers: NO_STORE });
  }
}
