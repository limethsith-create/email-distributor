/**
 * POST /api/mc/clients/new — Mission Control "New client" (SPEC §6.1): the
 * owner creates a trial record pre-approved (fit rules skipped). The
 * one-trial-per-company rule, the 3-trial cap and "no new trials while an
 * extension runs" still apply unless `override: true` is sent.
 * Body: { companyName, contactName, contactEmail, website, override?, plan? }.
 * With `plan` = starter|growth|scale it is a paying client (hub › Paying clients): the paid
 * onboarding email, no trial cap or one-trial rule (gatekeeper.js decide).
 */

import { applyForTrial, isPaidPlan } from '@/lib/systems/gatekeeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const result = await applyForTrial(body, { preApproved: true, override: body.override === true, source: 'owner', plan: isPaidPlan(body.plan) ? String(body.plan).toLowerCase() : 'trial' });
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  return Response.json(result);
}
