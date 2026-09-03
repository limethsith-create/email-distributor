/**
 * CSV export of the leads hash. Dumps PII, nothing in the UI calls it — so it
 * requires the CRON_SECRET (Authorization: Bearer <secret> or ?token=<secret>)
 * whenever one is configured.
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { getAllLeads } from '@/lib/leads-db';
import { mergeOpens, isRoleEmail } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COLS = [
  'email', 'first_name', 'company_name', 'website', 'phone', 'linkedin',
  'industry', 'status', 'source', 'ai_score', 'send_count', 'sequence_day',
  'sent_at', 'opened_at', 'open_count', 'createdAt',
  // additive columns
  'campaign', 'name', 'title', 'country', 'city', 'account_used',
  'd3_sent_at', 'd7_sent_at', 'replied_at', 'reply_kind', 'reply_intent',
  'quality_score', 'quality_reason', 'bounced_at', 'bounce_reason',
];

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authorized(request, searchParams) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return safeEqual(bearer, secret) || safeEqual(searchParams.get('token') || '', secret);
}

function esc(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula injection: a cell starting with = + - @ or a control char would be
  // evaluated by Excel / Sheets; a leading quote keeps it plain text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  if (!authorized(request, searchParams)) {
    return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const source = searchParams.get('source');
  const status = searchParams.get('status');
  const industry = searchParams.get('industry');
  const namedOnlyRaw = (searchParams.get('namedOnly') || '').toLowerCase();
  const namedOnly = namedOnlyRaw === '1' || namedOnlyRaw === 'true' || namedOnlyRaw === 'yes' || (searchParams.has('namedOnly') && namedOnlyRaw === '');

  const [allLeads, opensRaw] = await Promise.all([
    getAllLeads(),
    kv.hgetall('email_opens').catch(() => ({})),
  ]);
  const opensMap = opensRaw && typeof opensRaw === 'object' ? opensRaw : {};
  let leads = allLeads;

  // Case-insensitive prefix match so ?status=sent catches sent-d0/sent-d3 and
  // ?source=apify catches every apify-* batch. Exact values still work.
  const pre = (v, q) => String(v || '').toLowerCase().startsWith(String(q).toLowerCase());
  if (source) leads = leads.filter(l => pre(l.source, source));
  if (status) leads = leads.filter(l => pre(l.status, status));
  if (industry) leads = leads.filter(l => (l.industry || '').toLowerCase().includes(industry.toLowerCase()));
  if (namedOnly) {
    const ROLE = /^(info|sales|support|admin|hello|contact|office|help|service|services|team|marketing|billing|accounts|accounting|careers|jobs|hr|general|reception|press|enquiries|inquiries|mail)@/i;
    leads = leads.filter(l => !ROLE.test(l.email || '') && !isRoleEmail(l.email || ''));
  }

  const keyed = leads.map((l) => ({ l, k: Date.parse(l.createdAt || '') || 0 }));
  keyed.sort((a, b) => b.k - a.k);
  leads = keyed.map((x) => x.l);

  const rows = [COLS.join(',')];
  for (const l of leads) {
    const o = mergeOpens(l, opensMap);
    const row = {
      ...l,
      campaign: String(l.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer',
      opened_at: o.opened_at,
      open_count: o.open_count,
    };
    rows.push(COLS.map(c => esc(row[c])).join(','));
  }
  const csv = '﻿' + rows.join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `aviance-leads-${source || status || 'all'}-${stamp}.csv`.replace(/[^A-Za-z0-9._-]/g, '_');

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      'X-Lead-Count': String(leads.length),
    },
  });
}
