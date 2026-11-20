/**
 * POST /api/mc/clients/new — the owner's "Add a paying client" (hub › Paying
 * clients): a client closed outside a website booking, straight to
 * onboarding (the one accepted_call email).
 * Body: { companyName, contactName, contactEmail, website, plan } —
 * plan = starter | growth | scale (starter when missing).
 */

import { addClient } from '@/lib/systems/gatekeeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const result = await addClient(body, { source: 'owner', plan: body.plan });
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  return Response.json(result);
}
