/**
 * Who is asking Ava. The middleware verified the request and set
 * `x-hub-role` (admin | employee) and `x-hub-user` (email; none for the
 * owner's Mission Control cookie) — any the caller sent were dropped. Money
 * needs `admin` exactly; anything else counts as a team member (fails closed).
 * The first name comes from the verified hub token (cached), else the
 * owner's signer name in config, else nothing.
 */

import { verifyHubToken, bearerOf } from '@/lib/auth/supabase';
import { cfg } from '@/lib/config';

const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';

export async function whoIsAsking(request) {
  const role = request.headers.get('x-hub-role') === 'admin' ? 'admin' : 'employee';
  const email = request.headers.get('x-hub-user') || '';
  let name = '';
  let uid = '';
  const token = bearerOf(request);
  if (token) {
    const v = await verifyHubToken(token).catch(() => null);
    if (v?.ok) { name = first(v.name); uid = v.sub || ''; }
  }
  if (!name && role === 'admin') name = first((await cfg(null, 'OWNER').catch(() => null))?.signerName);
  return { id: uid || email || role, name, role };
}
