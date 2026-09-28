/**
 * POST /api/inquiry — a paid-plan inquiry from the public website's "Book a
 * call" form (aviance.online). Public (CORS for SITE_ORIGINS in middleware),
 * guarded by a honeypot field and a per-IP hourly limit (IP stored hashed).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { sha256 } from '@/lib/crypto';
import { after } from 'next/server';
import { saveInquiry } from '@/lib/systems/inquiries';
import { researchToEnd } from '@/lib/systems/research';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const PER_HOUR = 10;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (body.company_url2) return Response.json({ ok: true }); // honeypot
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  try {
    const key = K.applyRateInquiry(sha256(ip).slice(0, 24), new Date().toISOString().slice(0, 13));
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 3700);
    if (n > PER_HOUR) return Response.json({ ok: false, error: 'Too many requests from this address. Please try again later.' }, { status: 429 });
  } catch {}
  const r = await saveInquiry(body, { source: 'website' });
  if (!r.ok) return Response.json({ ok: false, errors: r.errors }, { status: 400 });
  // A paid application: finish its research (and fit score) after the answer, like /api/apply.
  if (r.clientId) { try { after(() => researchToEnd(r.clientId, 52_000)); } catch { /* not inside a request (tests): the research job finishes it */ } }
  return Response.json({ ok: true, id: r.id || null });
}
