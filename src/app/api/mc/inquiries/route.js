/**
 * /api/mc/inquiries — the hub's Inquiries section (admin / hub token).
 *   GET                                   → { inquiries (newest first), counts }
 *   POST {action:'status', id, status, note?}   status: new (Booked) | held (Call done) | no_show | contacted (Following up) | agreement_sent (Agreement and invoice sent; the old 'proposal' is still accepted) | won | lost
 *        won  → they become a paying client and onboarding starts (the answer's inquiry.clientId); 400 when it cannot
 *        lost → the record held for the call closes; nothing is emailed
 *   POST {action:'note', id, text}
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
      case 'note': return Response.json({ ok: true, inquiry: await addInquiryNote(String(body.id), body.text) });
      default: return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
