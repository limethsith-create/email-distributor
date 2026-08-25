import { bulkUpsertLeads } from '@/lib/leads-db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ROLE = new Set(['info','sales','support','admin','hello','contact','office','help','service','services','team','marketing','billing','accounts','accounting','careers','jobs','hr','noreply','no-reply','donotreply','privacy','legal','abuse','webmaster','postmaster','mail','enquiries','inquiries','general','reception','newsletter','subscribe','unsubscribe','press']);

const JUNK_RE = /(sentry\.io|wixpress|godaddy|example\.(com|org)|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|schema\.org|u00|%20|@2x|sentry-|cloudflare|googlemail|yourdomain|domain\.com|email\.com|test@|demo@)/i;
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|protonmail|live|msn)\./i;

function companyFromDomain(domain) {
  const base = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function pickBestEmail(emails, domain) {
  const bare = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  const seen = new Set();
  const cleaned = [];
  for (const raw of emails || []) {
    const e = String(raw || '').toLowerCase().trim().replace(/^mailto:/, '');
    if (!e || seen.has(e)) continue;
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) continue;
    if (JUNK_RE.test(e)) continue;
    if (FREE_MAIL.test(e)) continue;
    const [local, host] = e.split('@');
    if (local.length > 40) continue;
    if (bare && !(host === bare || host.endsWith('.' + bare))) continue;
    seen.add(e);
    cleaned.push({ email: e, local, isRole: ROLE.has(local) });
  }
  if (!cleaned.length) return null;
  const named = cleaned.filter(c => !c.isRole);
  const pool = named.length ? named : cleaned;
  pool.sort((a, b) => a.local.length - b.local.length);
  return { email: pool[0].email, isRole: pool[0].isRole };
}

import { kv } from '@vercel/kv';

const LEADS_KEY = 'leads';

/**
 * Repair leads that were imported with a status/score the sender ignores.
 * getUnsent() only accepts pending|new|qualified AND requires an effective
 * score >= 8, so leads written as {status:'qualified', ai_score:6} were
 * stranded forever. Normalises them in place. Idempotent.
 */
async function repairStrandedLeads(sourcePrefix) {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  const patch = {};
  let scanned = 0, fixed = 0;

  for (const [email, lead] of Object.entries(all)) {
    if (!lead || typeof lead !== 'object') continue;
    const src = String(lead.source || '').toLowerCase();
    if (sourcePrefix && !src.startsWith(sourcePrefix.toLowerCase())) continue;
    scanned++;

    const status = String(lead.status || '').toLowerCase();
    const score = Number(lead.quality_score) || Number(lead.ai_score) || 0;
    // Only touch leads that have never been contacted.
    const untouched = !lead.sent_at && !lead.account_used && (!lead.send_count || lead.send_count === 0);
    const badStatus = status === 'qualified';
    const badScore = score < 8;
    if (!untouched || (!badStatus && !badScore)) continue;

    patch[email] = {
      ...lead,
      status: 'pending',
      quality_score: Math.max(score, 8),
      quality_engine: lead.quality_engine || 'import-repair',
      updatedAt: new Date().toISOString(),
    };
    fixed++;
  }

  const entries = Object.entries(patch);
  for (let i = 0; i < entries.length; i += 100) {
    await kv.hset(LEADS_KEY, Object.fromEntries(entries.slice(i, i + 100)));
  }
  return { scanned, fixed };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  // Maintenance mode: fix leads already in the DB that can never be sent.
  if (searchParams.get('repair') === '1') {
    try {
      const res = await repairStrandedLeads(searchParams.get('source') || '');
      return Response.json({ success: true, mode: 'repair', ...res });
    } catch (err) {
      return Response.json({ error: 'Repair failed: ' + err.message }, { status: 500 });
    }
  }

  const datasetId = searchParams.get('datasetId');
  const dryRun = searchParams.get('dryRun') === '1';
  const industry = searchParams.get('industry') || 'Managed IT Services';
  const source = searchParams.get('source') || 'apify-import';

  if (!datasetId) return Response.json({ error: 'Missing ?datasetId=' }, { status: 400 });

  const token = process.env.APIFY_TOKEN;
  const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};

  let items;
  try {
    const res = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&limit=5000`, { headers: authHeaders });
    if (!res.ok) {
      const body = await res.text();
      return Response.json({ error: `Apify returned ${res.status}`, detail: body.slice(0, 300) }, { status: 502 });
    }
    items = await res.json();
  } catch (err) {
    return Response.json({ error: 'Fetch failed: ' + err.message }, { status: 502 });
  }
  if (!Array.isArray(items)) return Response.json({ error: 'Unexpected dataset shape' }, { status: 502 });

  const byEmail = new Map();
  const stats = { rows: items.length, noEmail: 0, dupeInBatch: 0, candidates: 0, roleOnly: 0 };

  for (const row of items) {
    const domain = row.domain || row.url || '';
    const best = pickBestEmail(row.emails, domain);
    if (!best) { stats.noEmail++; continue; }
    if (byEmail.has(best.email)) { stats.dupeInBatch++; continue; }
    if (best.isRole) stats.roleOnly++;
    const linkedin = Array.isArray(row.linkedIns) && row.linkedIns.length ? row.linkedIns[0] : null;
    const phone = Array.isArray(row.phones) && row.phones.length ? row.phones[0] : null;
    byEmail.set(best.email, {
      email: best.email,
      company_name: companyFromDomain(domain),
      website: domain ? `https://${String(domain).replace(/^https?:\/\//, '')}` : null,
      industry, phone, linkedin, source,
      // MUST be a status getUnsent/claimLead accept, and MUST carry a score at
      // or above QUALITY_THRESHOLD (8) or the lead is silently never sent.
      status: 'pending',
      ai_score: best.isRole ? 8 : 9,
      quality_score: best.isRole ? 8 : 9,
      quality_reason: best.isRole ? 'Imported: role inbox on company domain' : 'Imported: named contact on company domain',
      quality_engine: 'import',
      qualified_at: new Date().toISOString(),
    });
  }

  const leads = [...byEmail.values()];
  stats.candidates = leads.length;
  if (dryRun) return Response.json({ success: true, dryRun: true, stats, sample: leads.slice(0, 10) });

  const result = await bulkUpsertLeads(leads);
  return Response.json({ success: true, stats, imported: result });
}
