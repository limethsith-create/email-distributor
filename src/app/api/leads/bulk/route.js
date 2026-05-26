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

    const [existingLeads, suppressionList] = await Promise.all([
      kv.hgetall(LEADS_KEY).catch(() => ({})),
      kv.smembers(SUPPRESSION_KEY).catch(() => []),
    ]);

    const existing = existingLeads || {};
    const suppressed = new Set(suppressionList || []);

    const toInsert = {};
    let added = 0;
    let skipped = 0;
    let invalid = 0;

    for (const lead of leads) {
      const email = (lead.email || '').toLowerCase().trim();

      if (!email || !email.includes('@')) {
        invalid++;
        continue;
      }

      if (suppressed.has(email)) {
        skipped++;
        continue;
      }

      if (existing[email]) {
        skipped++;
        continue;
      }

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
        status: lead.status || 'pending',
        send_count: 0,
        sequence_day: -1,
        source: 'bulk-upload',
        createdAt: new Date().toISOString(),
      };
      added++;
    }

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
