/**
 * Job table (SPEC §5). Phase 1 wires the aviance outreach engine and the
 * Watchdog into the tick; later phases append their systems here.
 *
 * `due(ctx)` returns the period to claim (or null when not due). Periods:
 * minute jobs 'YYYY-MM-DDTHH:mm', bucketed jobs 'YYYY-MM-DDTHH:mm' rounded
 * down to the bucket, daily jobs 'YYYY-MM-DD'.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { SENDING_STATES } from '@/lib/db/client';
import { partsIn, isWeekday, ET } from '@/lib/time';
import { runWatchdog } from '@/lib/systems/watchdog';
import { runUsageMeter } from '@/lib/systems/usage';
import { JOBS as STAGE_A } from '@/lib/joblist/stage-a';
import { JOBS as STAGE_B } from '@/lib/joblist/stage-b';
import { JOBS as STAGE_C } from '@/lib/joblist/stage-c';
import { JOBS as STAGE_D } from '@/lib/joblist/stage-d';

import { minuteKey, bucketKey, usBusinessHours } from '@/lib/joblist/helpers';

function internalRequest(path) {
  const headers = {};
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
  return new Request(`http://internal${path}`, { headers });
}

// ── aviance: the pre-trial engine, driven by the tick ─────────────────────────

// Names are unique across every job file (claims, last-run records and the
// Mission Control "force a job now" button key off the name); the aviance
// engine's jobs carry an aviance- prefix so a forced trial `send` / `replies`
// can never start the legacy engine. Each run also refuses any other client.
const notAviance = (clientId) => (clientId !== 'aviance' ? { skipped: 'aviance engine only' } : null);

const avianceSend = {
  name: 'aviance-send',
  scope: 'client',
  cost: 3,
  minBudgetMs: 12_000,
  claimTtl: 180,
  async due({ client, now }) {
    if (client.id !== 'aviance' || !SENDING_STATES.has(client.state)) return null;
    const p = partsIn(ET, now);
    return usBusinessHours(p) ? minuteKey(p) : null;
  },
  async run({ clientId }) {
    const refused = notAviance(clientId);
    if (refused) return refused;
    const { GET } = await import('@/app/api/cron/auto-send/route');
    const res = await GET(internalRequest('/api/cron/auto-send?skipReplies=1'));
    const body = await res.json();
    if (res.status >= 500) throw new Error(body.error || `auto-send ${res.status}`);
    const sent = (Number(body.sent) || 0) + (Number(body.followUpsSent) || 0);
    const due = (body.accountStatus || []).some((s) => s.remaining > 0 && s.ready && !s.skipped);
    const now = new Date().toISOString();
    try {
      if (sent > 0) {
        await kv.hset(K.heartbeat(), { lastSendAt: now, firstDueUnsentAt: '' });
      } else if (due && !body.paced) {
        const hb = (await kv.hgetall(K.heartbeat())) || {};
        if (!hb.firstDueUnsentAt) await kv.hset(K.heartbeat(), { firstDueUnsentAt: now });
      } else {
        await kv.hset(K.heartbeat(), { firstDueUnsentAt: '' });
      }
    } catch {}
    return { sent, blocked: body.blocked || null, message: body.message || null, detail: body.detail ? { to: body.detail.to, touch: body.detail.touch } : null };
  },
};

const avianceReplies = {
  name: 'aviance-replies',
  scope: 'client',
  cost: 4,
  minBudgetMs: 10_000,
  claimTtl: 3600,
  async due({ client, now }) {
    if (client.id !== 'aviance' || ['deleted', 'retired'].includes(client.state)) return null;
    const p = partsIn(ET, now);
    return bucketKey(p, usBusinessHours(p) ? 5 : 20);
  },
  async run({ clientId, deadline }) {
    const refused = notAviance(clientId);
    if (refused) return refused;
    const { checkAllReplies } = await import('@/lib/reply-checker');
    const r = await checkAllReplies({ deadlineMs: deadline - 1000 });
    if (r.skipped === 'locked') return { skipped: 'locked' };
    return { newReplies: r.matchedLeads, bounces: (r.bounces || []).length, errors: (r.errors || []).length };
  },
};

const avianceEodReport = {
  name: 'aviance-eod-report',
  scope: 'client',
  cost: 5,
  minBudgetMs: 10_000,
  async due({ client, now }) {
    if (client.id !== 'aviance') return null;
    const p = partsIn(ET, now);
    return isWeekday(p.weekday) && p.hour >= 19 && p.hour < 22 ? p.dayKey : null;
  },
  async run({ clientId }) {
    const refused = notAviance(clientId);
    if (refused) return refused;
    // Outside the send window the legacy sender runs its end-of-day report
    // path (which has its own once-a-day guard).
    const { GET } = await import('@/app/api/cron/auto-send/route');
    const res = await GET(internalRequest('/api/cron/auto-send?skipReplies=1'));
    const body = await res.json();
    return { report: body.report || null };
  },
};

// ── global ───────────────────────────────────────────────────────────────────

const watchdog = {
  name: 'watchdog',
  scope: 'global',
  cost: 1,
  claimTtl: 180,
  // Only while a send-stall marker exists (the heartbeat hash the tick read).
  async due({ now, heartbeat }) { return heartbeat && !heartbeat.firstDueUnsentAt ? null : minuteKey(partsIn(ET, now)); },
  async run(ctx) { return runWatchdog(ctx); },
};

const usage = {
  name: 'usage',
  scope: 'global',
  cost: 2,
  claimTtl: 7200,
  async due({ now }) { const p = partsIn('UTC', now); return `${p.dayKey}T${String(p.hour).padStart(2, '0')}`; },
  async run(ctx) { return runUsageMeter(ctx); },
};

export const JOBS = [watchdog, usage, avianceSend, avianceReplies, avianceEodReport, ...STAGE_A, ...STAGE_B, ...STAGE_C, ...STAGE_D];

/**
 * Tick budget (20 s, SPEC §5): a job starts only when at least minBudgetMs
 * is left. Jobs that email, call an API or open IMAP/DNS but set no value of
 * their own get one here (the scheduler default of 2 s only suits jobs that
 * touch Redis alone), so a late start can never push a tick past cron-job.org's
 * 30-second cut-off.
 */
const NETWORK_BUDGET_MS = {
  watchdog: 4000, usage: 5000,
  'purchase-nudge': 5000, welcome: 5000, 'booking-reminder': 5000,
  'leadfinder-start': 5000, 'leadfinder-refill': 5000, approval: 6000, readiness: 6000,
  'hot-chaser': 6000, emergency: 6000, 'client-watch': 5000, reminders: 6000, noshow: 6000, notnow: 8000, pace: 5000, 'learning-weekly': 4000,
  'day1-notice': 5000, invoice: 5000, 'cancel-inboxes': 5000,
};
for (const job of JOBS) if (job.minBudgetMs == null && NETWORK_BUDGET_MS[job.name]) job.minBudgetMs = NETWORK_BUDGET_MS[job.name];

/** Job names that appear more than once (must be empty; tests check it). */
export function duplicateJobNames(jobs = JOBS) {
  const seen = new Set();
  const dup = new Set();
  for (const j of jobs) { if (seen.has(j.name)) dup.add(j.name); seen.add(j.name); }
  return [...dup];
}
