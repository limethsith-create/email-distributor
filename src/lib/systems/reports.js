/**
 * Report renderer + Plan Recommender (SPEC §9.2, §9.3).
 *
 * Everything goes through `renderReport(name, clientId)`. It refuses to
 * render when a counter the report needs is missing (rule 4): the rendered
 * record gets a `blockedReason`, the owner gets `report_blocked`, and nothing
 * is shown as 0.
 *
 * Names: day20 (disposition sheet), day29 (Trial Report, normal or zero-call),
 * final (the report at the end of an extension), market (Market Report).
 * Rendered reports are stored in client:{id}:report:{name}.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, getTrial } from '@/lib/db/client';
import { requireCounters, getDay } from '@/lib/db/counters';
import { getLeads } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { fill } from '@/lib/templates/render';
import { REPORT_LINES, REPORT_ZERO_LINES } from '@/lib/templates/client/stage-d';
import { addDays, dayKeyIn, ET } from '@/lib/time';
import { mintToken, pageUrl } from '@/lib/pagetokens';
import { clientNow } from '@/lib/testclock';
import { getReplies, getBookings, getPaceLog, pct, money, csv, esc, fmtDay, PLAN_NAMES, markReportRendered, parseRec, cfgTree } from '@/lib/systems/dshared';

export const REPORT_FIELDS = {
  day29: ['sent', 'bounces', 'replies', 'positive', 'booked', 'held', 'qualified', 'noshows', 'companiesContacted'],
  final: ['sent', 'bounces', 'replies', 'positive', 'booked', 'held', 'qualified', 'noshows', 'companiesContacted'],
  market: ['sent', 'bounces', 'replies', 'positive'],
  day20: [],
};

const POSITIVE_KINDS = new Set(['interested', 'question']);
const OPEN_KINDS = new Set(['interested', 'question', 'unclear']);

// ── Plan Recommender (SPEC §9.3) ──────────────────────────────────────────────

function perCall(plan) {
  return money(Math.round(plan.price / plan.calls));
}

/**
 * Exactly the §9.3 rule. Inputs are stored numbers only.
 * @returns {{plan: string|null, kind: string, rate: number|null, rateText: string, text: string, short: string, projections: object}}
 */
export function recommendPlan({ qualified, positive, companies, capacityPerWeek, kickoffDate, extensionUsed = false, plans, capacity = { starterMax: 3, growthMax: 7 } }) {
  const q = Number(qualified);
  const pos = Number(positive);
  const c = Number(companies);
  const rate = c > 0 ? q / c : null;
  const rateText = rate == null ? 'n/a' : `${(rate * 100).toFixed(2)}%`;
  const projections = {
    starter: rate == null ? null : Math.floor(rate * plans.starter.reach),
    growth: rate == null ? null : Math.floor(rate * plans.growth.reach),
  };
  const arithmetic = rate == null ? '' : [
    `${q} qualified call${q === 1 ? '' : 's'} from ${c.toLocaleString('en-US')} companies is ${rateText}. That’s your rate, in your market, with your offer — not a benchmark.`,
    `Starter contacts at least ${plans.starter.reach.toLocaleString('en-US')} companies a month. At your rate that’s about ${projections.starter} calls; we guarantee ${plans.starter.calls}. Growth contacts ${plans.growth.reach.toLocaleString('en-US')} — about ${projections.growth} at your rate, and we guarantee ${plans.growth.calls}.`,
  ].join(' ');

  const line = (key) => `${PLAN_NAMES[key]} — ${money(plans[key].price)} a month for ${plans[key].calls} guaranteed calls, ${perCall(plans[key])} a call`;

  if (q >= 3) {
    const cap = Number(capacityPerWeek);
    if (!Number.isFinite(cap) || cap <= 0) {
      return { plan: 'starter', kind: 'capacity_unknown', rate, rateText, projections, short: line('starter'),
        text: `${arithmetic} You didn’t give us a capacity number, so the recommendation is the smallest plan that fits the rate: ${line('starter')}.` };
    }
    const plan = cap <= capacity.starterMax ? 'starter' : cap <= capacity.growthMax ? 'growth' : 'scale';
    const when = kickoffDate ? `on ${kickoffDate}` : 'during onboarding';
    return { plan, kind: 'capacity', rate, rateText, projections, short: line(plan),
      text: `${arithmetic} You told us ${when} you can take ${cap} calls a week. That’s ${PLAN_NAMES[plan]} — ${money(plans[plan].price)}, and it works out at ${perCall(plans[plan])} a call.` };
  }
  if (q >= 1) {
    return { plan: 'starter', kind: 'thin', rate, rateText, projections, short: line('starter'),
      text: `${arithmetic} With ${q} qualified call${q === 1 ? '' : 's'} so far, the recommendation is Starter, and only Starter — ${money(plans.starter.price)} for ${plans.starter.calls} calls — to prove the rate holds at volume before going bigger.` };
  }
  if (pos > 0) {
    return { plan: 'starter', kind: 'pay_per_show', rate, rateText, projections, short: line('starter'),
      text: `${pos} positive repl${pos === 1 ? 'y' : 'ies'} from ${c.toLocaleString('en-US')} companies is ${pct(pos, c)} — demand exists; the booking step is the problem. Recommendation: Starter — ${money(plans.starter.price)} for ${plans.starter.calls} guaranteed calls. The other honest option: pay per show, ${money(plans.payPerShow)} for every qualified call that actually attends, billed weekly.` };
  }
  if (!extensionUsed) {
    return { plan: null, kind: 'extension', rate, rateText, projections, short: 'no plan yet — the free extension',
      text: 'No positive replies, so no plan: the free extension is the recommendation. We keep sending at our cost and change the campaign, not the deal.' };
  }
  return { plan: null, kind: 'winback', rate, rateText, projections, short: 'no plan — change the offer or the market first',
    text: `No positive replies from ${c.toLocaleString('en-US')} companies, so no plan. If nobody wanted it at this volume, more volume won’t change that. The honest next step is to change the offer or the market before outbound can work; we’ll check back in 90 days.` };
}

export async function plansConfig(clientId) {
  return { plans: await cfgTree(clientId, 'PLANS'), capacity: await cfgTree(clientId, 'CAPACITY') };
}

// ── Diagnosis for zero-call reports (Section 7, "The four questions") ─────────

export function diagnose({ sent, bounces, replies, positive, booked, placement }, d) {
  const bounce = sent > 0 ? bounces / sent : null;
  if (bounce != null && (bounce > d.bounceMax || (placement != null && placement < d.placementMin))) {
    return `It wasn’t landing: bounce ${pct(bounces, sent)}, inbox placement ${placement == null ? 'not measured' : `${Math.round(placement * 100)}%`}. That’s infrastructure, not your market.`;
  }
  if (sent > 0 && replies / sent < d.replyMin) {
    return `Your emails landed (bounce ${pct(bounces, sent)}), but too few people answered: a ${pct(replies, sent)} reply rate against a ${(d.replyMin * 100).toFixed(1)}% line. That points at the message or the list.`;
  }
  if (sent > 0 && positive / sent < d.positiveMin) {
    return `People answered (${pct(replies, sent)} reply rate), but few wanted it: ${pct(positive, sent)} positive against a ${(d.positiveMin * 100).toFixed(0)}% line. That’s the offer or the market, not the copy.`;
  }
  if (positive > 0 && booked / positive < d.bookedShareMin) {
    return `People wanted it — ${positive} positive replies — but only ${booked} booked. That’s the booking step, not the market.`;
  }
  return 'All four checks passed — it landed, people answered, some wanted it and they booked — but no qualified call was held inside the window.';
}

// ── Data gathering ────────────────────────────────────────────────────────────

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

async function learningTop(clientId, profile, client) {
  const niche = profile.niche || client.niche || null;
  if (!niche) return null;
  try {
    const raw = (await kv.hgetall(K.learning(String(niche).toLowerCase().replace(/[^a-z0-9-]+/g, '-')))) || {};
    let best = null;
    for (const [variant, v] of Object.entries(raw)) {
      const r = parseRec(v);
      if (!r || !Number(r.sends)) continue;
      const rate = Number(r.replies || 0) / Number(r.sends);
      if (!best || rate > best.rate) best = { variant, rate };
    }
    return best;
  } catch { return null; }
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

function producedLine(data, learning) {
  const parts = [];
  const vs = data.variants.filter((v) => v.sent > 0);
  if (vs.length) {
    const best = [...vs].sort((a, b) => b.rate - a.rate)[0];
    const others = vs.filter((v) => v !== best).map((v) => `${pct(v.replied, v.sent)} for ${v.variant}`);
    parts.push(`email version ${best.variant} (${pct(best.replied, best.sent)} reply rate${others.length ? ` vs ${others.join(', ')}` : ''})`);
  } else if (learning) {
    parts.push(`version ${learning.variant}, the best performer in this niche so far`);
  }
  const positives = data.replies.filter((r) => POSITIVE_KINDS.has(r.kind) && r.lead?.city);
  if (positives.length) {
    const [city, n] = countBy(positives.map((r) => r.lead), 'city')[0];
    parts.push(`${city} (${n} of ${positives.length} positive replies)`);
  }
  return parts.length ? parts.join(', and ') : 'not enough replies yet to name a winner';
}

function didntLine(paceLog) {
  if (!paceLog.length) return 'no pace check had to step in';
  return paceLog.map((p) => `Day ${p.day ?? '?'}: ${p.test || 'check'} — ${p.fix || 'no change'}`).join('; ');
}

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

/** Decision page URL for reports/emails (purpose decision:{tag}; see decision.js). */
export async function decisionLink(clientId, tag, ttlDays = 30) {
  const token = await mintToken(clientId, `decision:${tag}`, { ttl: ttlDays * 86400 });
  return pageUrl(token, 'decide');
}

/**
 * Render a report. Returns { ok, name, text, html, attachments, zero, rec,
 * blockedReason }. Never sends anything itself.
 * opts: { now, decisionUrl }
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

  if (name === 'day20') {
    return { ok: true, name, bookings: data.bookings, data };
  }

  // day29 / final
  const { plans, capacity } = await plansConfig(clientId);
  const target = await cfgTree(clientId, 'TARGET');
  const d = await cfgTree(clientId, 'DIAGNOSIS');
  const learning = await learningTop(clientId, data.profile, data.client);
  const rec = recommendPlan({
    qualified: totals.qualified, positive: totals.positive, companies: totals.companiesContacted,
    capacityPerWeek: data.profile.capacityPerWeek,
    kickoffDate: data.trial.agreementAcceptedAt ? fmtDay(String(data.trial.agreementAcceptedAt).slice(0, 10)) : null,
    extensionUsed: Boolean(data.trial.extensionStartedAt) || name === 'final',
    plans, capacity,
  });
  const market = marketReport(data, totals, { placement, sendsPerDay: await sendsPerDay(clientId, data.trial, now) });
  const rebooked = data.bookings.filter((b) => b.status === 'rebooked' || (Number(b.rebookAttempts) > 0 && ['held', 'booked'].includes(b.status))).length;
  const zero = Number(totals.qualified) === 0;
  const vars = {
    clientName: data.client.name || clientId,
    companies: totals.companiesContacted, sent: totals.sent,
    bounceRate: pct(totals.bounces, totals.sent), placement: placement == null ? 'not measured' : `${Math.round(placement * 100)}%`,
    replies: totals.replies, replyRate: pct(totals.replies, totals.sent),
    positive: totals.positive, positiveRate: pct(totals.positive, totals.sent),
    booked: totals.booked, held: totals.held, qualified: totals.qualified, rebooked,
    qualifiedCalls: `${totals.qualified} qualified call${Number(totals.qualified) === 1 ? '' : 's'}`,
    promiseMet: totals.qualified >= target.promise ? 'met' : 'not met',
    targetMet: totals.qualified >= target.target ? 'met' : 'not met',
    produced: producedLine(data, learning), didnt: didntLine(data.paceLog),
    rate: rec.rateText,
    starterReach: plans.starter.reach.toLocaleString('en-US'), starterCalls: rec.projections.starter ?? 'n/a', starterGuarantee: plans.starter.calls,
    growthReach: plans.growth.reach.toLocaleString('en-US'), growthCalls: rec.projections.growth ?? 'n/a', growthGuarantee: plans.growth.calls,
    openCount: market.openCount, recommendation: rec.text,
    decisionUrl: opts.decisionUrl || 'sent with tomorrow’s email',
    diagnosis: diagnose({ sent: totals.sent, bounces: totals.bounces, replies: totals.replies, positive: totals.positive, booked: totals.booked, placement }, d),
    leadCount: data.leads.length,
    variants: data.variants.length ? data.variants.map((v) => `version ${v.variant}: ${v.sent} sent, ${pct(v.replied, v.sent)} replied`).join('; ') : 'no variant data recorded',
    sendsPerDay: (await sendsPerDay(clientId, data.trial, now)) ?? 'n/a',
  };
  const lines = zero ? REPORT_ZERO_LINES : REPORT_LINES;
  let text;
  try {
    text = lines.map((l) => (l ? fill(`report:${name}`, l, vars) : '')).join('\n');
  } catch (err) {
    return block(clientId, name, err.missing || [err.message]);
  }
  const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${esc(text)}</div>`;
  await store(clientId, name, { html, text });
  await store(clientId, 'market', { html: market.html, text: market.csv });
  await logEvent(clientId, 'reports', 'report_rendered', { name, zero, recommendation: rec.plan || rec.kind });
  const slug = (data.client.name || clientId).replace(/[^A-Za-z0-9]+/g, '-');
  return {
    ok: true, name, zero, text, html, recommendation: rec, totals, market,
    attachments: [
      { filename: `${slug}-market-report.html`, content: market.html, contentType: 'text/html' },
      { filename: `${slug}-market-report.csv`, content: market.csv, contentType: 'text/csv' },
    ],
  };
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
