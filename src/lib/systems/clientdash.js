/**
 * The client's own page (/c/{token}/dashboard) — the shared view: what the
 * owner and the people he gave access to (by email, `shareDashboard`) both
 * look at. Five tabs: Overview (their numbers, the last 30 days, where they
 * are), Conversations (every prospect who wrote back), Emails sent, Calls, and
 * Messages (the conversation with us, read-only). Everything comes from the
 * stored counters and records the hub reads; nothing is guessed. Owner-only
 * data (money, fit score, costs, to-dos, rule names, deliverability
 * internals, credentials, lead grades) never leaves this module.
 * docs/HUB-API.md "The client's page (shared view)".
 *
 * One long-lived link per client (token purpose `dashboard`, 400 days),
 * remembered on the trial hash as `dashboardLink` so it is the same link every
 * time; `fresh` replaces it (the old link stops working). The owner can email
 * it to anyone from the hub (`shareDashboard`); who it went to is kept on the
 * trial hash as `dashboardSharedWith` ([{email, at}]) and `unshareDashboard`
 * replaces the link and empties that list. A Test run client's link works too
 * (read-only, for the owner's preview); sharing one sends nothing.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getTrial, isDemoId } from '@/lib/db/client';
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
  // A Test run client's link (the owner's preview): its token lookup is removed with the test run.
  if (isDemoId(clientId)) {
    const [{ sha256 }, { DEMO_KEYS }] = await Promise.all([import('@/lib/crypto'), import('@/lib/systems/demo')]);
    await kv.sadd(DEMO_KEYS, `tokenidx:${sha256(token)}`).catch(() => {});
  }
  await kv.hset(K.trial(clientId), { dashboardLink: url, dashboardLinkAt: now.toISOString() });
  return url;
}

/** Who the owner emailed the dashboard to (trial.dashboardSharedWith): [{ email, at }], oldest first. */
export async function sharedWith(clientId, trial = null) {
  const raw = (trial || (await getTrial(clientId)) || {}).dashboardSharedWith;
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = []; } }
  return Array.isArray(list) ? list.filter((x) => x && x.email).map((x) => ({ email: String(x.email), at: x.at || null })) : [];
}

// ─── the shared view (docs/HUB-API.md "The client's page (shared view)") ─────

/**
 * What the client's page shows and the hub shows under "Shared with <Business>": their numbers, the last 30
 * days, where they are, their calls and the conversation with us. NEVER here: money / invoices, the fit score,
 * costs, the owner's to-dos, reply-bot rule names, other clients, deliverability internals (inbox rates,
 * placement, health), credentials, lead grades.
 */
export const JOURNEY = [
  { key: 'applied', label: 'Applied' },
  { key: 'onboarding', label: 'Onboarding call' },
  { key: 'setup', label: 'Setting up' },
  { key: 'sending', label: 'Sending emails' },
  { key: 'done', label: 'Done' },
];
const STEP_OF = {
  applied: 0, queued: 0,
  onboarding: 1,
  awaiting_purchase: 2, setup_check: 2, warming: 2, ready: 2,
  sending: 3, paused: 3, extension: 3, converted: 3,
  deciding: 4, not_now: 4, retired: 4, declined: 4, closed_silent: 4, deleted: 4,
};
const has = (v) => v != null && v !== '' && v !== '0' && v !== 'false';
const isoOr = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const numOr = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
const lowerOf = (s) => String(s || '').trim().toLowerCase();
function asObj(v) {
  if (v && typeof v === 'object') return v;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

const ET_TZ = 'America/New_York';
/** "Tue, Nov 4, 10:00 AM ET" (the owner's time, as the hub shows it). */
export function etWhen(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return `${new Date(t).toLocaleString('en-US', { timeZone: ET_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
}
/** "Monday, November 3" for a YYYY-MM-DD day. */
const longDay = (day) => { const t = Date.parse(`${day}T12:00:00Z`); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }) : null; };

/**
 * Where they are, in one plain sentence (never the owner's to-do) — the same sentences the hub shows under
 * "Shared with <Business>".
 */
export function statusLine({ state, paid, planName = null, day, day1Date = null, onboard = {}, launch = {} }) {
  const setting = 'Setting up the new email inboxes and the list of people to write to.';
  switch (state) {
    case 'applied': return 'Application received — it is being reviewed.';
    case 'queued': return 'Accepted — waiting for a start date.';
    case 'onboarding':
      if (has(onboard.heldAt)) return setting;
      if (has(onboard.bookedFor)) return `The onboarding call is booked for ${etWhen(onboard.bookedFor)}.`;
      return 'Accepted — next is the onboarding call.';
    case 'awaiting_purchase': case 'setup_check': case 'ready':
      if (has(launch.bookedFor) && !has(launch.heldAt) && !has(launch.noShowAt)) return `Setting up. The launch call is booked for ${etWhen(launch.bookedFor)}.`;
      return setting;
    case 'warming': {
      const d1 = day1Date ? longDay(day1Date) : null;
      return `Warming up the new inboxes, so the emails land in the inbox and not in spam.${d1 ? ` Emails start on ${d1}.` : ''}`;
    }
    case 'sending': case 'extension':
      return !paid && day != null && day > 0 ? `Sending emails — day ${day} of 30.` : 'Sending emails.';
    case 'paused': return 'Sending is paused for now.';
    case 'deciding': return 'The 30 days are done. Next: choosing whether to go on.';
    case 'declined': return 'Not going ahead.';
    default: return paid && planName ? `On the ${planName}.` : 'The trial is finished.';
  }
}

const PAID_LABEL = (plan) => (PAID.includes(plan) ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : '30-day trial');

/** A token → the client id it opens (null: unknown, expired, replaced by unshareDashboard, or the client is gone). */
export async function sharedClientId(raw) {
  const tok = await readToken(raw, { purpose: DASHBOARD_PURPOSE });
  if (!tok) return null;
  return (await getClient(tok.clientId)) ? tok.clientId : null;
}

/**
 * At most `max` calls a minute per link, counted in this server's memory (no Redis command: the page's reads
 * stay the only cost, and nothing is left in the store). True when over.
 */
const HITS = new Map();
/** Tests: forget the counts. */
export const resetRateLimit = () => HITS.clear();
export function overLimit(raw, { max = 120, now = new Date() } = {}) {
  const minute = Math.floor(now.getTime() / 60e3);
  const key = String(raw || '').slice(0, 64);
  const cur = HITS.get(key);
  const n = cur && cur.minute === minute ? cur.n + 1 : 1;
  HITS.set(key, { minute, n });
  if (HITS.size > 5000) for (const [k, v] of HITS) if (v.minute !== minute) HITS.delete(k);
  return n > max;
}

const CALL_STATUS = { booked: 'booked', held: 'showed', noshow: 'no_show', no_show: 'no_show', rebooked: 'moved', disputed: 'checking' };
const PAST_ONBOARDING = new Set(['awaiting_purchase', 'setup_check', 'warming', 'ready', 'sending', 'paused', 'extension', 'deciding', 'converted', 'not_now', 'retired']);
const PAST_LAUNCH = new Set(['sending', 'paused', 'extension', 'deciding', 'converted', 'not_now', 'retired']);

/** The client's calls: prospects' booked calls (newest first) and their two setup calls with us. */
async function callsOf(clientId, client, bookingsRaw, onboard, launch) {
  const list = Object.values(bookingsRaw || {}).filter((b) => b && isoOr(b.scheduledAt));
  const { leadsByEmail } = await import('@/lib/systems/maillog');
  const leads = list.length ? await leadsByEmail(clientId, list.map((b) => b.leadEmail).filter(Boolean)) : new Map();
  const prospects = list.map((b) => {
    const lead = leads.get(lowerOf(b.leadEmail)) || {};
    return {
      at: isoOr(b.scheduledAt),
      name: lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
      email: b.leadEmail || null,
      company: lead.company || lead.company_name || null,
      status: has(b.cancelledAt) ? 'cancelled' : CALL_STATUS[b.status] || 'booked',
    };
  }).sort((a, b) => b.at.localeCompare(a.at));
  const state = client.state || 'applied';
  const setupCall = (kind, raw, sent, past) => {
    const r = has(sent) ? raw || {} : {};
    const status = has(r.heldAt) ? 'done' : has(r.skipped) ? 'not_needed' : has(r.noShowAt) ? 'missed' : has(r.bookedFor) ? 'booked' : past ? 'not_needed' : 'not_booked';
    return { kind, label: kind === 'onboarding' ? 'Onboarding call' : 'Launch call', at: isoOr(r.bookedFor), status };
  };
  const ours = [
    setupCall('onboarding', onboard, client.onboardCallSentAt, PAST_ONBOARDING.has(state)),
    setupCall('launch', launch, client.launchCallSentAt, PAST_LAUNCH.has(state)),
  ];
  return { prospects, ours };
}

/** Page data for a dashboard token, or { ok:false, error }. */
export async function dashboardView(raw, { now = new Date() } = {}) {
  const tok = await readToken(raw, { purpose: DASHBOARD_PURPOSE });
  const bad = { ok: false, error: 'This link has expired or is not valid. Reply to our last email and we will send a new one.' };
  if (!tok) return bad;
  const id = tok.clientId;
  const client = await getClient(id);
  if (!client) return bad;
  const [{ getTotals }, { getBookings }, { clientNow, clientTrialDay }, { dayKeyIn, addDays, ET }, { threadFor }] = await Promise.all([
    import('@/lib/db/counters'), import('@/lib/systems/bookings'), import('@/lib/testclock'), import('@/lib/time'), import('@/lib/systems/maillog'),
  ]);
  const today = dayKeyIn(ET, clientNow(client, now));
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const p = kv.pipeline();
  for (const d of days) p.hgetall(K.countersDay(id, d));
  const [trial, totals, bookingsRaw, onboard, launch, rows, convo] = await Promise.all([
    getTrial(id),
    getTotals(id).catch(() => ({})),
    getBookings(id).catch(() => ({})),
    has(client.onboardCallSentAt) ? kv.hgetall(K.onboardCall(id)).catch(() => ({})) : {},
    has(client.launchCallSentAt) ? kv.hgetall(K.launchCall(id)).catch(() => ({})) : {},
    p.exec(),
    threadFor(id, 'client', { shared: true }).catch(() => null),
  ]);
  const plan = String(client.plan || 'trial').toLowerCase();
  const paid = PAID.includes(plan);
  const day = clientTrialDay(client, trial || {}, now);
  const state = client.state || 'applied';
  const step = STEP_OF[state] ?? 4;
  const t = (f) => numOr(totals?.[f]);
  const sent = t('sent');
  const share = (n) => (sent && n != null ? Math.round((n / sent) * 1000) / 1000 : null);
  const series = (f) => (rows || []).map((r) => Number(asObj(r)?.[f]) || 0);
  const five = { sent, opened: null, replies: t('replies'), bounced: t('bounces'), interested: t('positive'), booked: t('booked') };
  const status = statusLine({ state, paid, planName: PAID_LABEL(plan), day, day1Date: trial?.day1Date || null, onboard: onboard || {}, launch: launch || {} });
  return {
    ok: true,
    company: client.name || id,
    plan: PAID_LABEL(plan),
    paid,
    demo: isDemoId(id),
    status,
    day: paid ? null : day ?? null,
    five,
    rates: { replies: share(five.replies), bounced: share(five.bounced), interested: five.replies && five.interested != null ? Math.round((five.interested / five.replies) * 1000) / 1000 : null },
    sentSince: trial?.day1Date || null,                // "Since <day>" under Emails sent
    openedTracked: false,
    last30: { days, sent: series('sent'), replies: series('replies'), booked: series('booked'), totals: { sent: sum(series('sent')), replies: sum(series('replies')), booked: sum(series('booked')) } },
    journey: { steps: JOURNEY, current: step, currentKey: JOURNEY[step].key, status },
    calls: await callsOf(id, client, bookingsRaw, onboard || {}, launch || {}),
    messages: convo ? convo.messages : [],
    replyTo: (onboard && onboard.fromInbox) || null,
    updatedAt: now.toISOString(),
  };
}

const sum = (xs) => (xs || []).reduce((n, v) => n + (Number(v) || 0), 0);
