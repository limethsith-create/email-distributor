/**
 * Report renderer (SPEC §9.2): the Market Report, sent in the handover pack.
 *
 * `renderReport('market', clientId)` refuses to render when a counter the
 * report needs is missing (rule 4): the rendered record gets a
 * `blockedReason`, the owner gets `report_blocked`, and nothing is shown as 0.
 * Rendered reports are stored in client:{id}:report:{name}.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getProfile, getTrial } from '@/lib/db/client';
import { requireCounters, getDay } from '@/lib/db/counters';
import { getLeads } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { addDays, dayKeyIn, ET } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { getReplies, getBookings, getPaceLog, pct, csv, esc, markReportRendered } from '@/lib/systems/dshared';

export const REPORT_FIELDS = {
  market: ['sent', 'bounces', 'replies', 'positive'],
};

const POSITIVE_KINDS = new Set(['interested', 'question']);
const OPEN_KINDS = new Set(['interested', 'question', 'unclear']);

function placementOf(client) {
  const v = Number(client?.canaryPlacement);
  if (client?.canaryPlacement == null || client.canaryPlacement === '' || !Number.isFinite(v)) return null;
  return v > 1 ? v / 100 : v;
}

function variantStats(leads, repliedEmails) {
  const out = {};
  for (const l of leads) {
    const v = l.sequenceVariant;
    if (!v || !l.sent_at) continue;
    out[v] = out[v] || { variant: v, sent: 0, replied: 0 };
    out[v].sent++;
    if (repliedEmails.has(String(l.email).toLowerCase())) out[v].replied++;
  }
  return Object.values(out).map((s) => ({ ...s, rate: s.sent ? s.replied / s.sent : 0 })).sort((a, b) => a.variant.localeCompare(b.variant));
}

function countBy(rows, field) {
  const m = {};
  for (const r of rows) { const k = r[field] || 'unknown'; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}


/** Everything the reports read, gathered once. */
export async function gatherData(clientId, now = new Date()) {
  const [client, profile, trial, replies, bookings, paceLog, leads] = await Promise.all([
    getClient(clientId), getProfile(clientId), getTrial(clientId), getReplies(clientId), getBookings(clientId), getPaceLog(clientId), getLeads(clientId),
  ]);
  const leadByEmail = new Map(leads.map((l) => [String(l.email).toLowerCase(), l]));
  const realReplies = replies.filter((r) => r.kind !== 'bounce').map((r) => ({ ...r, lead: leadByEmail.get(String(r.leadEmail || '').toLowerCase()) || null }));
  const repliedEmails = new Set(realReplies.filter((r) => r.kind !== 'ooo').map((r) => String(r.leadEmail || '').toLowerCase()));
  const bookedEmails = new Set(bookings.map((b) => String(b.leadEmail || '').toLowerCase()).filter(Boolean));
  const open = realReplies.filter((r) => OPEN_KINDS.has(r.kind) && !bookedEmails.has(String(r.leadEmail || '').toLowerCase()));
  const notNows = realReplies.filter((r) => r.kind === 'notnow').map((r) => ({ ...r, date: r.notnowDate || r.lead?.notnowDate || null }));
  return { client: client || { id: clientId }, profile, trial, replies: realReplies, bookings, paceLog, leads, open, notNows, variants: variantStats(leads, repliedEmails), now };
}

async function sendsPerDay(clientId, trial, now) {
  if (!trial.day1Date) return null;
  const today = dayKeyIn(ET, now);
  let day = trial.day1Date;
  let days = 0;
  let total = 0;
  for (let i = 0; i < 120 && day <= today; i++, day = addDays(day, 1)) {
    const row = await getDay(clientId, day);
    if (Number(row.sent) > 0) { days++; total += Number(row.sent); }
  }
  return days ? Math.round(total / days) : null;
}

const nextStep = (kind) => (kind === 'interested' ? 'Book it: two slots were offered — follow up by reply or phone'
  : kind === 'question' ? 'Answer their question'
  : 'Your call — read the reply');

// ── Market Report ─────────────────────────────────────────────────────────────

export function marketReport(data, totals, extra = {}) {
  const { client, replies, open, notNows, variants } = data;
  const name = client.name || client.id;
  const byKind = countBy(replies, 'kind');
  const leadsOfReplies = replies.map((r) => r.lead || {});
  const byTitle = countBy(leadsOfReplies, 'title');
  const bySize = countBy(leadsOfReplies, 'sizeBand');
  const byCity = countBy(leadsOfReplies, 'city');
  const placement = extra.placement;

  const table = (head, rows) => `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr>${head.map((h) => `<th align="left">${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} — Market Report</title></head>
<body style="font-family:Arial,sans-serif;max-width:900px;margin:24px auto;line-height:1.5">
<h1>${esc(name)} — Market Report</h1>
<p>What ${replies.length} people on your list said when asked directly. Every reply is tagged by kind; the snippet is their own words.</p>
<h2>Every reply</h2>
${table(['Date', 'Kind', 'Company', 'Title', 'City', 'What they said'], replies.map((r) => [String(r.receivedAt || '').slice(0, 10), r.kind, r.lead?.company || '', r.lead?.title || '', r.lead?.city || '', r.snippet || '']))}
<h2>Replies by kind</h2>${table(['Kind', 'Count'], byKind)}
<h2>Who answered — by title</h2>${table(['Title', 'Replies'], byTitle)}
<h2>By company size</h2>${table(['Size band', 'Replies'], bySize)}
<h2>By city</h2>${table(['City', 'Replies'], byCity)}
<h2>Open conversations (${open.length})</h2>
${table(['Company', 'Contact', 'Kind', 'Next step'], open.map((r) => [r.lead?.company || '', r.leadEmail || '', r.kind, nextStep(r.kind)]))}
<h2>Not now — and when to come back</h2>
${table(['Company', 'Contact', 'Come back on'], notNows.map((r) => [r.lead?.company || '', r.leadEmail || '', r.date ? String(r.date).slice(0, 10) : 'no date given']))}
<h2>The copy and what it did</h2>
${table(['Variant', 'Sent', 'Replied', 'Reply rate'], variants.map((v) => [v.variant, v.sent, v.replied, pct(v.replied, v.sent)]))}
<h2>Infrastructure proof</h2>
${table(['Measure', 'Value'], [['Emails sent', totals.sent], ['Bounce rate', pct(totals.bounces, totals.sent)], ['Inbox placement (canary)', placement == null ? 'not measured' : `${Math.round(placement * 100)}%`], ['Sends per sending day', extra.sendsPerDay == null ? 'not measured' : extra.sendsPerDay]])}
</body></html>`;

  const rows = replies.map((r) => ({
    receivedAt: r.receivedAt || '', kind: r.kind, email: r.leadEmail || '', name: r.lead?.name || r.lead?.first_name || '', company: r.lead?.company || '',
    title: r.lead?.title || '', city: r.lead?.city || '', sizeBand: r.lead?.sizeBand || '', snippet: r.snippet || '',
    notnowDate: r.kind === 'notnow' ? (r.notnowDate || r.lead?.notnowDate || '') : '',
    open: OPEN_KINDS.has(r.kind) && open.includes(r) ? 'yes' : '',
  }));
  const text = csv(rows, ['receivedAt', 'kind', 'email', 'name', 'company', 'title', 'city', 'sizeBand', 'snippet', 'notnowDate', 'open']);
  return { html, csv: text, counts: { byKind, byTitle, bySize, byCity }, openCount: open.length };
}

// ── What produced it / what didn't ────────────────────────────────────────────



// ── Storage + blocking ────────────────────────────────────────────────────────

async function store(clientId, name, rec) {
  const now = new Date().toISOString();
  await kv.hset(K.report(clientId, name), { renderedAt: now, html: rec.html || '', text: rec.text || '', blockedReason: rec.blockedReason || '' });
  await markReportRendered(clientId, name);
}

async function block(clientId, name, missing) {
  const blockedReason = `missing counter(s): ${missing.join(', ')}`;
  await store(clientId, name, { blockedReason });
  await logEvent(clientId, 'reports', 'report_blocked', { name, missing });
  await alertOwner('report_blocked', {
    clientId,
    scope: `${clientId}:${name}`,
    vars: { report: name, clientId },
    body: `The ${name} report for ${clientId} cannot be rendered: ${blockedReason}. Reports never show a missing number as 0.`,
    did: 'Nothing was sent to the client. The report retries on the next run once the counters exist.',
  });
  return { ok: false, name, blockedReason, missing };
}

/**
 * Render a report. Returns { ok, name, text, html, attachments, zero, rec,
 * blockedReason }. Never sends anything itself.
 * opts: { now }
 */
export async function renderReport(name, clientId, opts = {}) {
  if (!(name in REPORT_FIELDS)) throw new Error(`unknown report ${name}`);
  const need = REPORT_FIELDS[name];
  const gate = await requireCounters(clientId, need);
  if (!gate.ok) return block(clientId, name, gate.missing);
  const totals = gate.values;
  const client = await getClient(clientId);
  const now = opts.now || clientNow(client, new Date());
  const data = await gatherData(clientId, now);
  const placement = placementOf(data.client);

  if (name === 'market') {
    const m = marketReport(data, totals, { placement, sendsPerDay: await sendsPerDay(clientId, data.trial, now) });
    await store(clientId, 'market', { html: m.html, text: m.csv });
    return { ok: true, name, html: m.html, text: m.csv, market: m };
  }

  throw new Error(`unknown report ${name}`);
}

export async function getRenderedReports(clientId) {
  let names = [];
  try { names = (await kv.smembers(K.reports(clientId))) || []; } catch {}
  const out = [];
  for (const n of names.sort()) {
    const r = (await kv.hgetall(K.report(clientId, n))) || {};
    out.push({ name: n, renderedAt: r.renderedAt || null, blockedReason: r.blockedReason || '' });
  }
  return out;
}
