/**
 * Mission Control — a client's build: copy (variant A/B JSON the owner may
 * edit after a change request), approval state, Copy Checker ticks, Lead
 * Finder status, blocklist paste, readiness gate. Admin session (middleware).
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { getStoredSequence, buildSequence, saveEditedVariant, checkVariant, sampleLead } from '@/lib/systems/copy';
import { getApproval, resendAfterChange, sendApprovalLink } from '@/lib/systems/approval';
import { getState as lfState, listReady, dispatchLeadFinder } from '@/lib/systems/leadfinder';
import { addBlocklistInput } from '@/lib/systems/blocklist';
import { readinessGate } from '@/lib/systems/readiness';
import { getSanityRows } from '@/lib/systems/sanity';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const [profile, seq, approval, lf, list, rows] = await Promise.all([getProfile(id), getStoredSequence(id), getApproval(id), lfState(id), listReady(id), getSanityRows(id)]);
  const lead = await sampleLead(id);
  const maxWords = await cfg(id, 'COPY.maxWords');
  const checks = {};
  if (lead) for (const k of ['A', 'B']) if (seq[`variant${k}`]) checks[k] = checkVariant(seq[`variant${k}`], profile, lead, { maxWords }).map((r) => ({ touch: r.touch, ok: r.ok, failures: r.failures, subject: r.rendered?.subject, text: r.rendered?.text }));
  const gate = await readinessGate(id).catch((e) => ({ error: e.message }));
  const { tokenEnc, ...approvalPublic } = approval;
  const blocklistSize = await kv.scard(K.blocklist(id));
  return Response.json({ client: { id, name: client.name, state: client.state }, sequence: seq, approval: approvalPublic, checks, sampleLead: lead ? { first_name: lead.first_name, company: lead.company, city: lead.city } : null, leadfinder: lf, list, sanityRows: rows, gate, blocklistSize });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  if (!(await getClient(id))) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'save':
        return Response.json({ ok: true, ...(await saveEditedVariant(id, body.which, body.json)) });
      case 'rebuild':
        return Response.json(await buildSequence(id, { force: Boolean(body.force) }));
      case 'setActive': {
        if (!['A', 'B', 'both'].includes(body.active)) return Response.json({ error: 'active must be A, B or both' }, { status: 400 });
        await kv.hset(K.sequence(id), { active: body.active });
        await logEvent(id, 'mc', 'sequence_active', { active: body.active });
        return Response.json({ ok: true });
      }
      case 'sendLink':
        return Response.json(await sendApprovalLink(id));
      case 'resend':
        return Response.json(await resendAfterChange(id));
      case 'blocklist':
        return Response.json({ ok: true, ...(await addBlocklistInput(id, String(body.text || ''), { source: 'mission-control' })) });
      case 'dispatch':
        return Response.json(await dispatchLeadFinder(id, { mode: ['initial', 'refill', 'widen'].includes(body.mode) ? body.mode : 'refill', widen: body.mode === 'widen' }));
      default:
        return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
