/**
 * Open-tracking pixel endpoint
 *
 * Each outgoing email embeds an invisible 1x1 image pointing here with a token
 * that identifies the recipient (base64url of their lowercased email — keeps the
 * raw address out of the URL). When the recipient's mail client loads the image,
 * this route records the open against:
 *   - the lead record        (opened_at / last_opened_at / open_count)
 *   - the 'email_opens' hash  (feeds the Daily Activity log)
 *   - stats.totalOpens        (running counter)
 *
 * It ALWAYS returns the transparent pixel, even on error, so a mail client never
 * sees a broken image. Cache headers are set so proxies re-fetch on later opens.
 */

import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LEADS_KEY = 'leads';
const OPENS_KEY = 'email_opens';

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function pixelResponse() {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.length),
      // Never let a proxy cache the pixel, so repeat opens still register.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

function decodeToken(t) {
  if (!t) return null;
  try {
    const email = Buffer.from(String(t), 'base64url').toString('utf8').trim().toLowerCase();
    // basic sanity: must look like an email
    if (email && email.includes('@') && email.length < 200) return email;
  } catch {
    /* ignore */
  }
  return null;
}

async function recordOpen(email) {
  const now = new Date().toISOString();

  // 1) Update the lead record (first-open sets opened_at; every hit bumps count)
  let leadWasFirstOpen = false;
  try {
    const lead = await kv.hget(LEADS_KEY, email);
    if (lead && typeof lead === 'object') {
      leadWasFirstOpen = !lead.opened_at;
      const updated = {
        ...lead,
        opened_at: lead.opened_at || now,
        last_opened_at: now,
        open_count: (Number(lead.open_count) || 0) + 1,
      };
      await kv.hset(LEADS_KEY, { [email]: updated });
    }
  } catch {
    /* ignore lead write errors */
  }

  // 2) Update the email_opens store (keyed by email) that Daily Activity reads
  try {
    const existing = await kv.hget(OPENS_KEY, email);
    const rec = existing && typeof existing === 'object'
      ? {
          email,
          count: (Number(existing.count) || 0) + 1,
          openedAt: existing.openedAt || now,
          lastOpenedAt: now,
        }
      : { email, count: 1, openedAt: now, lastOpenedAt: now };
    await kv.hset(OPENS_KEY, { [email]: rec });
  } catch {
    /* ignore */
  }

  // 3) Running counters. totalOpens = every open event; uniqueOpens = distinct leads.
  try {
    await kv.hincrby('stats', 'totalOpens', 1);
    if (leadWasFirstOpen) await kv.hincrby('stats', 'uniqueOpens', 1);
  } catch {
    /* ignore */
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const email = decodeToken(url.searchParams.get('t'));
    if (email) {
      // Fire-and-forget style, but await so serverless doesn't kill it early.
      await recordOpen(email);
    }
  } catch {
    /* never block the pixel on an error */
  }
  return pixelResponse();
}
