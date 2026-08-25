import { getAllLeads } from '@/lib/leads-db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COLS = [
  'email', 'first_name', 'company_name', 'website', 'phone', 'linkedin',
  'industry', 'status', 'source', 'ai_score', 'send_count', 'sequence_day',
  'sent_at', 'opened_at', 'open_count', 'createdAt',
];

function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source');
  const status = searchParams.get('status');
  const industry = searchParams.get('industry');
  const namedOnlyRaw = (searchParams.get('namedOnly') || '').toLowerCase();
  const namedOnly = namedOnlyRaw === '1' || namedOnlyRaw === 'true' || namedOnlyRaw === 'yes' || (searchParams.has('namedOnly') && namedOnlyRaw === '');

  let leads = await getAllLeads();

  // Case-insensitive prefix match so ?status=sent catches sent-d0/sent-d3 and
  // ?source=apify catches every apify-* batch. Exact values still work.
  const pre = (v, q) => String(v || '').toLowerCase().startsWith(String(q).toLowerCase());
  if (source) leads = leads.filter(l => pre(l.source, source));
  if (status) leads = leads.filter(l => pre(l.status, status));
  if (industry) leads = leads.filter(l => (l.industry || '').toLowerCase().includes(industry.toLowerCase()));
  if (namedOnly) {
    const ROLE = /^(info|sales|support|admin|hello|contact|office|help|service|services|team|marketing|billing|accounts|accounting|careers|jobs|hr|general|reception|press|enquiries|inquiries|mail)@/i;
    leads = leads.filter(l => !ROLE.test(l.email || ''));
  }

  leads.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const rows = [COLS.join(',')];
  for (const l of leads) rows.push(COLS.map(c => esc(l[c])).join(','));
  const csv = '﻿' + rows.join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `aviance-leads-${source || status || 'all'}-${stamp}.csv`;

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
