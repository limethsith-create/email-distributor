/**
 * The client's own dashboard (/c/{token}/dashboard): a read-only page where a
 * trial or paying client sees their sending as it happens — emails sent,
 * replies, interested, booked and held calls, the last 30 days day by day,
 * their inboxes, the newest replies and their booked calls. Everything comes
 * from the same stored counters the hub reads (hubClient, growthFor); nothing
 * is guessed. Owner-only data (alerts, jobs, notes, invoices, passwords) never
 * leaves this module.
 *
 * One long-lived link per client (token purpose `dashboard`, 400 days),
 * remembered on the trial hash as `dashboardLink` so it is the same link every
 * time; `fresh` replaces it (the old link stops working).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getTrial } from '@/lib/db/client';
import { mintToken, readToken, pageUrl } from '@/lib/pagetokens';

export const DASHBOARD_PURPOSE = 'dashboard';
const DASHBOARD_TTL = 400 * 86400;
const PAID = ['starter', 'growth', 'scale'];
const tokenIn = (url) => /\/c\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/.exec(String(url || ''))?.[1] || null;

/** The client's dashboard link: the remembered one while it works, else a new one. */
export async function dashboardLink(clientId, { fresh = false, now = new Date() } = {}) {
  if (!(await getClient(clientId))) throw new Error(`no client ${clientId}`);
  const t = await getTrial(clientId);
  if (!fresh && t.dashboardLink) {
    const raw = tokenIn(t.dashboardLink);
    if (raw && (await readToken(raw, { purpose: DASHBOARD_PURPOSE }))) return t.dashboardLink;
  }
  const token = await mintToken(clientId, DASHBOARD_PURPOSE, { ttl: DASHBOARD_TTL });
  const url = pageUrl(token, 'dashboard');
  await kv.hset(K.trial(clientId), { dashboardLink: url, dashboardLinkAt: now.toISOString() });
  return url;
}

const sum = (xs) => (xs || []).reduce((n, v) => n + (Number(v) || 0), 0);

/** Page data for a dashboard token, or { ok:false, error }. */
export async function dashboardView(raw, { now = new Date() } = {}) {
  const tok = await readToken(raw, { purpose: DASHBOARD_PURPOSE });
  if (!tok) return { ok: false, error: 'This link has expired or is not valid. Reply to our last email and we will send a new one.' };
  const { hubClient } = await import('@/lib/systems/hubview');
  const { growthFor } = await import('@/lib/systems/growth');
  const [d, g] = await Promise.all([hubClient(tok.clientId, { now }), growthFor(tok.clientId, { days: 30, now }).catch(() => null)]);
  if (!d) return { ok: false, error: 'This link has expired or is not valid.' };
  const row = d.row || {};
  const plan = String(row.plan || 'trial').toLowerCase();
  const e = g?.email || {};
  return {
    ok: true,
    company: row.name || tok.clientId,
    plan: PAID.includes(plan) ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : '30-day trial',
    paid: PAID.includes(plan),
    status: (row.simple && row.simple.label) || row.stateLabel || '',
    day: row.trialDay ?? null,
    five: row.five || null,
    last30: g ? { days: g.days, sent: e.sent || [], replies: e.replies || [], booked: e.booked || [], totals: { sent: sum(e.sent), replies: sum(e.replies), positive: sum(e.positive), booked: sum(e.booked) } } : null,
    inboxes: (d.inboxes || []).filter((i) => String(i.enabled) !== '0').map((i) => ({ email: i.email, dailyCap: i.dailyCap != null && i.dailyCap !== '' ? Number(i.dailyCap) : null, inboxRate7d: i.inboxRate7d ?? null, health: i.health || 'ok' })),
    replies: (d.replies || []).slice(0, 25).map((r) => ({ at: r.receivedAt || null, kind: r.kind || null, from: r.leadEmail || null, snippet: r.snippet || '' })),
    bookings: (d.bookings || []).slice(0, 25).map((b) => ({ at: b.scheduledAt || null, status: b.status || null, with: b.leadEmail || null })),
    updatedAt: now.toISOString(),
  };
}
