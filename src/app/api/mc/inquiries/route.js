/**
 * /api/mc/inquiries — the hub's Inquiries section (admin / hub token).
 *   GET                                   → { inquiries (newest first), counts }
 *   POST {action:'paid', id}   the booking's invoice is paid: one "paid" alert, onboarding starts, the booking moves to Won
 *   POST {action:'status', id, status, note?}   status: new (Booked) | held (Call done) | no_show | contacted (Following up) | agreement_sent (Agreement and invoice sent) | won | lost
 *        agreement_sent → the yes: the agreement and the invoice are emailed now (inquiry.agreement / .invoice); 400 when they cannot go
 *        won  → (payment received) they become a paying client and onboarding starts (the answer's inquiry.clientId); 400 when it cannot
 *        lost → the record held for the call closes; nothing is emailed
 *   POST {action:'note', id, text}
 *   POST {action:'bookCheck', booking}  preview of a cold-call booking (nothing saved); see docs/HUB-API.md
 *   POST {action:'book', booking, force?}  save it through the website booking path; 409 {warnings} when it clashes / is outside call hours and no force
 */
import { after } from 'next/server';

import { listInquiries, setInquiryStatus, addInquiryNote } from '@/lib/systems/inquiries';
import { checkOnboardCallsQuietly } from '@/lib/systems/onboardcall';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  return Response.json(await listInquiries({ limit: 300 }));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'status': {
        const inquiry = await setInquiryStatus(String(body.id), String(body.status), body.note || '');
        // Won without the heartbeat: the onboarding-call check runs right after the answer (throttled, never throws).
        if (body.status === 'won') { try { after(() => checkOnboardCallsQuietly()); } catch { /* tests */ } }
        return Response.json({ ok: true, inquiry });
      }
      case 'paid': {
        const { bookingPaid } = await import('@/lib/systems/agreementsend');
        return Response.json({ ok: true, ...(await bookingPaid(String(body.id))) });
      }
      case 'note': return Response.json({ ok: true, inquiry: await addInquiryNote(String(body.id), body.text) });
      case 'bookCheck': {
        const { bookCheck } = await import('@/lib/systems/coldbook');
        const { _clean, ...preview } = await bookCheck(body.booking || {});
        return Response.json(preview);
      }
      case 'book': {
        const { bookCall } = await import('@/lib/systems/coldbook');
        const started = Date.now();
        const defer = (job) => after(async () => {
          const out = await job();
          if (out?.clientId) { const { researchToEnd } = await import('@/lib/systems/research'); await researchToEnd(out.clientId, Math.max(5_000, 25_000 - (Date.now() - started))); }
        });
        return Response.json(await bookCall(body.booking || {}, { force: body.force === true, defer }));
      }
      default: return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    if (err?.status === 409) return Response.json({ error: err.message, warnings: err.warnings || [] }, { status: 409 });
    return Response.json({ error: err.message }, { status: 400 });
  }
}
