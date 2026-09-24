/**
 * Approval page API (SPEC §7.6). Public (/api/c/*); every call carries the
 * signed page token in the POST body (never in the URL query).
 * op: load | approve {section} | change {section, text}
 */

import { loadApprovalPage, approveSection, requestChange } from '@/lib/systems/approval';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  switch (body.op) {
    case 'load': {
      const data = await loadApprovalPage(token);
      if (!data) return Response.json({ error: 'This link has expired or is not valid. Reply to our email and we will send a fresh one.' }, { status: 401 });
      return Response.json(data);
    }
    case 'approve': {
      const r = await approveSection(token, body.section);
      return Response.json(r, { status: r.status || 200 });
    }
    case 'change': {
      const r = await requestChange(token, body.section, body.text);
      return Response.json(r, { status: r.status || 200 });
    }
    default:
      return Response.json({ error: 'unknown op' }, { status: 400 });
  }
}
