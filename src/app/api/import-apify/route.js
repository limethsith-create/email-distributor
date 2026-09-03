/**
 * Apify dataset import — pulls a scraped dataset (pages of 1000 rows), picks
 * the best contact email per company domain and inserts the leads at the send
 * threshold so the sender picks them up. GET and POST behave identically (an
 * external caller may use either). Requires the CRON_SECRET (Authorization:
 * Bearer <secret> or ?token=<secret>) whenever one is configured.
 *
 *   ?datasetId=<id> [&industry=..] [&source=..] [&dryRun=1]
 *   ?repair=1 [&source=<prefix>]   maintenance: un-strand imported leads
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { bulkUpsertLeads, newLeadRecord, getLeadsByEmail } from '@/lib/leads-db';
import { SEND_SCORE_THRESHOLD, isRoleEmail, isFreeMailDomain, isValidEmail, normalizeEmail } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LEADS_KEY = 'leads';
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

const JUNK_RE = /(sentry\.io|wixpress|godaddy|example\.(com|org)|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|schema\.org|u00|%20|@2x|sentry-|cloudflare|googlemail|yourdomain|domain\.com|email\.com|test@|demo@)/i;

// Public suffixes that take a second label ("acme.co.uk" → "acme").
const TWO_PART_TLD = /^(com|co|org|net|gov|edu|ac|ltd|plc|me|biz|info)\.[a-z]{2}$|^[a-z]{2}\.(com|co|org|net|gov|edu)$/i;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authorized(request, params) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return safeEqual(bearer, secret) || safeEqual(params.get('token') || '', secret);
}

function bareHost(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
}

/** Registrable label of a host: shop.acme.com → acme, acme.co.uk → acme. */
function registrableLabel(host) {
  const labels = bareHost(host).split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || '';
  const tail2 = labels.slice(-2).join('.');
  const drop = labels.length >= 3 && TWO_PART_TLD.test(tail2) ? 3 : 2;
  return labels[labels.length - drop] || labels[0];
}

function companyFromDomain(domain) {
  const base = registrableLabel(domain);
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function pickBestEmail(emails, domain) {
  const bare = bareHost(domain);
  const seen = new Set();
  const cleaned = [];
  for (const raw of emails || []) {
    const e = normalizeEmail(raw);
    if (!e || seen.has(e)) continue;
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) || !isValidEmail(e)) continue;
    if (JUNK_RE.test(e)) continue;
    if (isFreeMailDomain(e)) continue;
    const [local, host] = e.split('@');
    if (local.length > 40) continue;
    if (bare && !(host === bare || host.endsWith('.' + bare))) continue;
    seen.add(e);
    cleaned.push({ email: e, local, isRole: isRoleEmail(e) });
  }
  if (!cleaned.length) return null;
  const named = cleaned.filter((c) => !c.isRole);
  const pool = named.length ? named : cleaned;
  pool.sort((a, b) => a.local.length - b.local.length);
  return { email: pool[0].email, isRole: pool[0].isRole };
}

/**
 * Repair leads that were imported with a status/score the sender ignores.
 * getUnsent() only accepts pending|new|qualified AND requires an effective
 * score >= SEND_SCORE_THRESHOLD, so leads written as {status:'qualified',
 * ai_score:6} were stranded forever. Normalises them in place — each chunk is
 * re-read right before it is written. Idempotent.
 */
async function repairStrandedLeads(sourcePrefix) {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  const targets = [];
  let scanned = 0;

  for (const [email, lead] of Object.entries(all)) {
    if (!lead || typeof lead !== 'object') continue;
    const src = String(lead.source || '').toLowerCase();
    if (sourcePrefix && !src.startsWith(sourcePrefix.toLowerCase())) continue;
    scanned++;
    const status = String(lead.status || '').toLowerCase();
    const score = Number(lead.quality_score) || Number(lead.ai_score) || 0;
    // Only touch leads that have never been contacted.
    const untouched = !lead.sent_at && !lead.account_used && (!lead.send_count || lead.send_count === 0);
    if (untouched && (status === 'qualified' || score < SEND_SCORE_THRESHOLD)) targets.push(email);
  }

  let fixed = 0;
  for (let i = 0; i < targets.length; i += 100) {
    const part = targets.slice(i, i + 100);
    const fresh = await getLeadsByEmail(part);
    const updates = {};
    const now = new Date().toISOString();
    for (const email of part) {
      const lead = fresh[email];
      if (!lead || lead.sent_at || lead.account_used) continue;
      const score = Number(lead.quality_score) || Number(lead.ai_score) || 0;
      updates[email] = {
        ...lead,
        email,
        status: 'pending',
        quality_score: Math.max(score, SEND_SCORE_THRESHOLD),
        quality_engine: lead.quality_engine || 'import-repair',
        updatedAt: now,
      };
    }
    const keys = Object.keys(updates);
    if (keys.length) { await kv.hset(LEADS_KEY, updates); fixed += keys.length; }
  }
  return { scanned, fixed };
}

/** Pull the whole dataset, 1000 rows a page, up to MAX_PAGES pages. */
async function fetchDataset(datasetId, token) {
  const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};
  const items = [];
  let pages = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Apify returned ${res.status}`);
      err.apify = true;
      err.detail = body.slice(0, 300);
      throw err;
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) {
      const err = new Error('Unexpected dataset shape');
      err.shape = true;
      throw err;
    }
    pages++;
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return { items, pages };
}

async function handle(request, params) {
  if (!authorized(request, params)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Maintenance mode: fix leads already in the DB that can never be sent.
  if (params.get('repair') === '1') {
    try {
      const res = await repairStrandedLeads(params.get('source') || '');
      return Response.json({ success: true, mode: 'repair', ...res });
    } catch (err) {
      return Response.json({ error: 'Repair failed: ' + err.message }, { status: 500 });
    }
  }

  const datasetId = params.get('datasetId');
  const dryRun = params.get('dryRun') === '1';
  const industry = params.get('industry') || 'Managed IT Services';
  const source = params.get('source') || 'apify-import';

  if (!datasetId) return Response.json({ error: 'Missing ?datasetId=' }, { status: 400 });

  let items;
  let pages = 0;
  try {
    ({ items, pages } = await fetchDataset(datasetId, process.env.APIFY_TOKEN));
  } catch (err) {
    if (err && err.apify) return Response.json({ error: err.message, detail: err.detail || '' }, { status: 502 });
    if (err && err.shape) return Response.json({ error: 'Unexpected dataset shape' }, { status: 502 });
    return Response.json({ error: 'Fetch failed: ' + (err && err.message ? err.message : String(err)) }, { status: 502 });
  }

  const byEmail = new Map();
  const stats = { rows: items.length, pages, noEmail: 0, dupeInBatch: 0, candidates: 0, roleOnly: 0 };
  const now = new Date().toISOString();

  for (const row of items) {
    if (!row || typeof row !== 'object') { stats.noEmail++; continue; }
    const domain = row.domain || row.url || '';
    const best = pickBestEmail(row.emails, domain);
    if (!best) { stats.noEmail++; continue; }
    if (byEmail.has(best.email)) { stats.dupeInBatch++; continue; }
    if (best.isRole) stats.roleOnly++;
    const linkedin = Array.isArray(row.linkedIns) && row.linkedIns.length ? row.linkedIns[0] : null;
    const phone = Array.isArray(row.phones) && row.phones.length ? row.phones[0] : null;
    const host = bareHost(domain);
    // MUST be a status the sender accepts, and MUST carry a score at or above
    // SEND_SCORE_THRESHOLD or the lead is silently never sent.
    const score = best.isRole ? SEND_SCORE_THRESHOLD : SEND_SCORE_THRESHOLD + 1;
    byEmail.set(best.email, newLeadRecord({
      email: best.email,
      company_name: companyFromDomain(domain),
      website: host ? `https://${host}` : undefined,
      industry, phone, linkedin, source,
      status: 'pending',
      ai_score: score,
      quality_score: score,
      quality_reason: best.isRole ? 'Imported: role inbox on company domain' : 'Imported: named contact on company domain',
      quality_engine: 'import',
      qualified_at: now,
    }, 'apify'));
  }

  const leads = [...byEmail.values()];
  stats.candidates = leads.length;
  if (dryRun) return Response.json({ success: true, dryRun: true, stats, sample: leads.slice(0, 10) });

  const result = await bulkUpsertLeads(leads, { source: 'apify' });
  return Response.json({ success: true, stats, imported: result });
}

export async function GET(request) {
  return handle(request, new URL(request.url).searchParams);
}

/** Same behaviour as GET; parameters may come from the query or a JSON body. */
export async function POST(request) {
  const params = new URLSearchParams(new URL(request.url).searchParams);
  try {
    const body = await request.json();
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null && !params.has(k)) params.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      }
    }
  } catch {}
  return handle(request, params);
}
