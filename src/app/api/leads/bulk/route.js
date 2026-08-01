/**
 * Bulk Lead Upload Endpoint
 * Fast bulk insert of leads into Vercel KV.
 * Accepts JSON array of leads via POST.
 * Skips duplicates and suppressed emails.
 *
 * POST body: { leads: [{ email, company, industry, name, status? }] }
 */

import { kv } from '@vercel/kv';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const LEADS_KEY = 'leads';
const SUPPRESSION_KEY = 'suppression';
const STATS_KEY = 'stats';

export async function POST(request) {
  try {
    const { leads = [] } = await request.json();

    if (!leads.length) {
      return Response.json({ error: 'No leads provided' }, { status: 400 });
    }

    // Get existing leads and suppression list in bulk
    const [existingLeads, suppressionList] = await Promise.all([
      kv.hgetall(LEADS_KEY).catch(() => ({})),
      kv.smembers(SUPPRESSION_KEY).catch(() => []),
    ]);

    const existing = existingLeads || {};
    const suppressed = new Set(suppressionList || []);

    // Filter and prepare new leads
    const toInsert = {};
    let added = 0;
    let skipped = 0;
    let invalid = 0;

    for (const lead of leads) {
      const email = (lead.email || '').toLowerCase().trim();

      // Validate email
      if (!email || !email.includes('@')) {
        invalid++;
        continue;
      }

      // Skip suppressed
      if (suppressed.has(email)) {
        skipped++;
        continue;
      }

      // Skip existing
      if (existing[email]) {
        skipped++;
        continue;
      }

      // Skip if already in this batch
      if (toInsert[email]) {
        skipped++;
        continue;
      }

      toInsert[email] = {
        email,
        company: lead.company || lead.company_name || '',
        company_name: lead.company || lead.company_name || '',
        industry: lead.industry || 'business',
        name: lead.name || '',
        title: lead.title || '',
        city: lead.city || '',
        country: lead.country || '',
        status: lead.status || 'pending',
        send_count: 0,
        sequence_day: -1,
        source: lead.source || 'bulk-upload',
        createdAt: new Date().toISOString(),
        // pre-computed Scout enrichment (if provided)
        ...(lead.quality_score != null ? {
          quality_score: lead.quality_score,
          quality_reason: lead.quality_reason || '',
          quality_engine: lead.quality_engine || 'icp',
          verified_at: new Date().toISOString(),
        } : {}),
      };
      added++;
    }

    // Batch insert all at once
    if (added > 0) {
      await kv.hset(LEADS_KEY, toInsert);
      await kv.hincrby(STATS_KEY, 'totalScraped', added);
    }

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      added,
      skipped,
      invalid,
      total: leads.length,
    });
  } catch (error) {
    return Response.json({
      success: false,
      error: error.message,
    }, { status: 500 });
  }
}
