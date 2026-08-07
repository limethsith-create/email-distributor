/**
 * Leads Cleanup Endpoint
 * Reversibly removes leads from the active dashboard by ARCHIVING them to a
 * separate KV hash ('removed_leads') and deleting them from the main 'leads'
 * hash. Nothing is permanently erased — a 'restore' action moves them back.
 *
 * Safeguard: never removes a lead that has been sent, replied, or completed.
 *
 * POST { action:'remove', statuses:['skipped_dedup'], dryRun?:true }
 * POST { action:'remove', emails:['a@b.com', ...] }
 * POST { action:'restore', emails?:[...] }   // omit emails to restore all
 * GET                                          // count of archived leads
 */

import { kv } from '@vercel/kv';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const LEADS_KEY = 'leads';
const ARCHIVE_KEY = 'removed_leads';

function isProtected(lead) {
  if (!lead) return false;
  const st = String(lead.status || '');
  return Boolean(
    lead.account_used ||
    lead.sent_at ||
    lead.replied_at ||
    st.startsWith('sent') ||
    st === 'replied' ||
    st === 'sequence_complete'
  );
}

async function chunkedHdel(key, fields) {
  for (let i = 0; i < fields.length; i += 100) {
    await kv.hdel(key, ...fields.slice(i, i + 100));
  }
}

async function chunkedHset(key, obj) {
  const entries = Object.entries(obj);
  for (let i = 0; i < entries.length; i += 100) {
    const slice = Object.fromEntries(entries.slice(i, i + 100));
    if (Object.keys(slice).length) await kv.hset(key, slice);
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const action = body.action || 'remove';

  if (action === 'promote') {
    // Bump quality_score for all leads matching a source (or explicit emails).
    // Used to mark a hand-curated, verified list as send-ready.
    const all = (await kv.hgetall(LEADS_KEY)) || {};
    const score = Number(body.score);
    const source = body.source || null;
    const emailSet = (body.emails && body.emails.length)
      ? new Set(body.emails.map((e) => String(e).toLowerCase()))
      : null;
    if (!(score >= 1 && score <= 10)) {
      return Response.json({ error: 'score must be 1-10' }, { status: 400 });
    }
    const updates = {};
    for (const [email, lead] of Object.entries(all)) {
      if (!lead) continue;
      if (isProtected(lead)) continue; // never touch sent/replied leads
      const match = emailSet ? emailSet.has(String(email).toLowerCase()) : (source && lead.source === source);
      if (!match) continue;
      updates[email] = {
        ...lead,
        quality_score: score,
        quality_reason: body.reason || lead.quality_reason || 'Hand-curated, verified list.',
        quality_engine: 'curated-verified',
        verified_at: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const keys = Object.keys(updates);
    if (body.dryRun) return Response.json({ dryRun: true, wouldPromote: keys.length, score, source });
    if (keys.length) await chunkedHset(LEADS_KEY, updates);
    return Response.json({ promoted: keys.length, score, source });
  }

  if (action === 'restore') {
    const arch = (await kv.hgetall(ARCHIVE_KEY)) || {};
    const emails = (body.emails && body.emails.length)
      ? body.emails.map((e) => String(e).toLowerCase())
      : Object.keys(arch);
    const toRestore = {};
    for (const e of emails) if (arch[e]) toRestore[e] = arch[e];
    const keys = Object.keys(toRestore);
    if (keys.length) {
      await chunkedHset(LEADS_KEY, toRestore);
      await chunkedHdel(ARCHIVE_KEY, keys);
    }
    return Response.json({ restored: keys.length });
  }

  // action === 'remove'
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  const statuses = body.statuses || (body.status ? [body.status] : ['skipped_dedup']);
  const emailSet = (body.emails && body.emails.length)
    ? new Set(body.emails.map((e) => String(e).toLowerCase()))
    : null;

  const toRemove = {};
  let protectedSkipped = 0;
  for (const [email, lead] of Object.entries(all)) {
    const st = (lead && lead.status) || '';
    const match = emailSet ? emailSet.has(String(email).toLowerCase()) : statuses.includes(st);
    if (!match) continue;
    if (isProtected(lead)) { protectedSkipped++; continue; }
    toRemove[email] = lead;
  }
  const emails = Object.keys(toRemove);

  if (body.dryRun) {
    return Response.json({ dryRun: true, wouldRemove: emails.length, protectedSkipped, statuses });
  }

  if (emails.length) {
    await chunkedHset(ARCHIVE_KEY, toRemove);
    await chunkedHdel(LEADS_KEY, emails);
  }
  return Response.json({ removed: emails.length, protectedSkipped, archivedTo: ARCHIVE_KEY });
}

export async function GET() {
  const arch = (await kv.hgetall(ARCHIVE_KEY)) || {};
  return Response.json({ archived: Object.keys(arch).length });
}
