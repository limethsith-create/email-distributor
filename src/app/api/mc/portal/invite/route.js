/**
 * POST /api/mc/portal/invite { email, link } — a client emails an invite to one of their own people.
 * The middleware lets a client token reach exactly this POST; the client is always the one in x-hub-client (never the body).
 * The people limit is enforced by the database when the hub saves the invite; this only sends the email (and caps how many a day).
 */
import { kv } from '@vercel/kv';
import { getClient } from '@/lib/db/client';
import { sendPortalInvite } from '@/lib/portal/invite';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const PER_DAY = 20;

export async function POST(request) {
  const h = request.headers;
  const id = h.get('x-hub-client') || '';
  if (h.get('x-hub-role') !== 'client' || !id) return Response.json({ error: 'Not allowed' }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Something was missing. Try again.' }, { status: 400 }); }
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'Not found.' }, { status: 404 });
  try {
    const key = `portal:invites:${id}:${new Date().toISOString().slice(0, 10)}`;
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 90000);
    if (n > PER_DAY) return Response.json({ error: 'You have sent a lot of invites today. Try again tomorrow.' }, { status: 429 });
  } catch {}
  return sendPortalInvite(id, client, body);
}
