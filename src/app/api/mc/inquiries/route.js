/**
 * /api/mc/inquiries — the hub's Inquiries section (admin / hub token).
 *   GET                                   → { inquiries (newest first), counts }
 *   POST {action:'status', id, status, note?}   status: new | contacted | won | lost
 *   POST {action:'note', id, text}
 *   POST {action:'toTrial', id}           → runs the Gatekeeper pre-approved (onboarding link or queue)
 */

import { listInquiries, setInquiryStatus, addInquiryNote, inquiryToTrial } from '@/lib/systems/inquiries';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  return Response.json(await listInquiries({ limit: 300 }));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'status': return Response.json({ ok: true, inquiry: await setInquiryStatus(String(body.id), String(body.status), body.note || '') });
      case 'note': return Response.json({ ok: true, inquiry: await addInquiryNote(String(body.id), body.text) });
      case 'toTrial': {
        const r = await inquiryToTrial(String(body.id));
        return Response.json(r, { status: r.ok ? 200 : 400 });
      }
      default: return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
