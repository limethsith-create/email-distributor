/**
 * POST /api/apply — public trial application (SPEC §6.1). Accepts JSON or a
 * form post with the application answers; runs the Gatekeeper and answers
 * with a plain status the applicant can read. Every public application —
 * the website's nine questions or the Gatekeeper's own shape — is held for
 * the owner's review (systems/webapply.js): nothing public decides by itself,
 * so no onboarding link or email goes out before the owner presses Approve. The site
 * calls this cross-origin (CORS in middleware). Public; guarded
 * by a honeypot field and a per-IP hourly limit (IP stored hashed only).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { sha256 } from '@/lib/crypto';
import { submitWebsiteApplication, submitFormApplication } from '@/lib/systems/webapply';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MESSAGES = {
  onboarding: "You're in. Check your inbox for a link to one page — your details and the agreement.",
  queued: "You fit — every trial slot is taken right now, so you're in the queue. Check your inbox for your place and date.",
  declined: 'Thank you for applying. We have emailed you our answer and the reason.',
  manual: 'Thank you — your application is saved and we will answer you by email within one business day.',
  received: 'Thank you — we already have your application and will answer by email.',
  review: 'Application in. A person reads every one and answers within one business day.',
};

/** The public site's form (aviance.online/trial.html) sends its own nine questions. */
const isWebsiteForm = (b) => b.source === 'website' || (b.sell !== undefined && b.email !== undefined && b.companyName === undefined);

async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return request.json().catch(() => ({}));
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  const out = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : '';
  return out;
}

export async function POST(request) {
  const body = await readBody(request);
  if (body.company_url2) return Response.json({ ok: true, message: MESSAGES.received }); // honeypot

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
  const hour = new Date().toISOString().slice(0, 13);
  try {
    const key = K.applyRate(sha256(ip).slice(0, 24), hour);
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 3700);
    if (n > (await cfg(null, 'INTAKE.applyPerHourPerIp'))) return Response.json({ ok: false, error: 'Too many applications from this address. Please try again later.' }, { status: 429 });
  } catch {}

  const result = isWebsiteForm(body) ? await submitWebsiteApplication(body) : await submitFormApplication(body);
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  return Response.json({ ok: true, outcome: result.outcome, message: MESSAGES[result.outcome] || MESSAGES.manual });
}
