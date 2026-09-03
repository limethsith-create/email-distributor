/**
 * Bulk Lead Upload Endpoint
 * Fast bulk insert of leads into Vercel KV.
 * Accepts JSON array of leads via POST.
 * Skips duplicates and suppressed emails.
 *
 * POST body: { leads: [{ email, company, industry, name, status? }] }
 * Response:  { success, added, skipped, invalid, total, duplicatesInFile, sendable }
 */

import { kv } from '@vercel/kv';
import { bulkUpsertLeads, newLeadRecord, getLeadsByEmail } from '@/lib/leads-db';
import { isValidEmail, normalizeEmail, isSendable, UNSENT_STATUSES } from '@/lib/metrics';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SUPPRESSION_KEY = 'suppression';

/** Which of these records are new inserts (not stored, not suppressed)? */
async function newInserts(records) {
  const emails = [...new Set(records.map((r) => r.email))];
  if (!emails.length) return [];
  const existing = await getLeadsByEmail(emails);
  const suppressed = new Set();
  for (let i = 0; i < emails.length; i += 400) {
    const part = emails.slice(i, i + 400);
    try {
      const flags = (await kv.smismember(SUPPRESSION_KEY, part)) || [];
      part.forEach((e, j) => { if (flags[j] === 1 || flags[j] === true) suppressed.add(e); });
    } catch {}
  }
  return records.filter((r) => !existing[r.email] && !suppressed.has(r.email));
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const leads = Array.isArray(body?.leads) ? body.leads : [];

    if (!leads.length) {
      return Response.json({ error: 'No leads provided' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const seen = new Set();
    const records = [];
    let invalid = 0;
    let duplicatesInFile = 0;

    for (const row of leads) {
      if (!row || typeof row !== 'object' || !isValidEmail(row.email)) { invalid++; continue; }
      const email = normalizeEmail(row.email);
      if (seen.has(email)) { duplicatesInFile++; continue; }
      seen.add(email);

      // An upload can only ever create a not-yet-sent lead.
      const st = String(row.status || '').toLowerCase();
      const status = UNSENT_STATUSES.has(st) && st ? st : 'pending';

      records.push(newLeadRecord({
        ...row,
        email,
        status,
        industry: row.industry || 'business',
        // pre-computed Scout enrichment (if provided)
        ...(row.quality_score != null ? {
          quality_score: row.quality_score,
          quality_reason: row.quality_reason || '',
          quality_engine: row.quality_engine || 'icp',
          verified_at: row.verified_at || now,
        } : {}),
      }, 'upload'));
    }

    // How many of the new rows the sender will actually pick up.
    const inserts = records.length ? await newInserts(records) : [];
    const sendable = inserts.filter(isSendable).length;

    // Dedupes against the store + suppression set and writes in pipelined
    // chunks — no full hgetall of the leads hash.
    const result = records.length
      ? await bulkUpsertLeads(records, { source: 'upload' })
      : { added: 0, skipped: 0, invalid: 0, total: 0 };

    return Response.json({
      success: true,
      timestamp: now,
      added: result.added,
      skipped: result.skipped + duplicatesInFile,
      invalid: invalid + result.invalid,
      total: leads.length,
      duplicatesInFile,
      sendable,
    });
  } catch (error) {
    return Response.json({
      success: false,
      error: error.message,
    }, { status: 500 });
  }
}
