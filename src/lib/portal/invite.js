/** Portal invites: how many people a plan allows, and the invite email (shared by the owner's action and the client's own route). */
import { cfg } from '@/lib/config';

/** People allowed for a plan (starter 2, growth 4, scale 6; an unknown plan counts as starter). */
export async function seatsForPlan(plan) {
  const map = (await cfg(null, 'PORTAL.seats')) || {};
  const p = String(plan || '').toLowerCase();
  const n = Number(map[p] ?? map.starter ?? 2);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/**
 * Email a portal invite link (the hub made the token and the invite row itself; the database holds the real limit).
 * body = { email, link }. Returns a Response: { ok, sent, seats }.
 */
export async function sendPortalInvite(id, client, body) {
  const { isValidEmail, normalizeEmail } = await import('@/lib/metrics');
  const email = normalizeEmail(body?.email);
  if (!isValidEmail(email)) return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
  const { isAllowedOrigin } = await import('@/lib/auth/supabase');
  let link = null;
  try { const u = new URL(String(body?.link || '')); if (isAllowedOrigin(u.origin) && /^#join=[A-Za-z0-9_-]{16,200}$/.test(u.hash)) link = u.toString(); } catch {}
  if (!link) return Response.json({ error: 'That invite link does not look right. Make a new one and try again.' }, { status: 400 });
  const { ownerName } = await import('@/lib/systems/dshared');
  const sig = await ownerName(id, 'The portal invite email');
  if (!sig) return Response.json({ error: 'Set your signer name (OWNER.signerName) in Config first.' }, { status: 409 });
  const { notifyClient } = await import('@/lib/notify');
  const isContact = email === normalizeEmail(client.contactEmail);
  const minute = new Date().toISOString().slice(0, 16);
  const res = await notifyClient(id, 'portal_invite', { portalLink: link, ownerName: sig, ...(isContact ? {} : { firstName: 'there' }) }, { to: email, dedupe: `portal_invite:${email}:${minute}` });
  if (res?.error) return Response.json({ error: res.error }, { status: 500 });
  const { logEvent } = await import('@/lib/db/events');
  await logEvent(id, 'mc', 'portal_invited', { email });
  return Response.json({ ok: true, sent: res?.sent !== false, seats: await seatsForPlan(client.plan) });
}
