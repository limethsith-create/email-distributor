/**
 * Scheduler jobs for Stage B (SPEC §5, §7). Job shape: see src/lib/jobs.js.
 * Every client job skips `aviance` (legacy engine) and checks client.state.
 *
 *  warmup            global  every 10 min (sender tz 07:00–22:00 checked per inbox)
 *  warmup-read       global  every 5 min; each mailbox read at most every 30 min, ≤ 2 per run
 *  warmup-daily      global  daily 23:45 ET — inboxRate7d + readiness streak, pool size
 *  canary            client  from 07:30 ET, every 5 min until today's run is done, Day −3 onwards
 *  ramp              client  daily 00:05 ET — dailyCap per inbox
 *  leadfinder-start  client  hourly in `warming` until the first dispatch succeeds
 *  leadfinder-refill client  daily 02:00 ET when unsent < LIST.refillBelow
 *  approval          client  hourly in `warming`, inside OWNER.usHours (ET) — link Day −7, reminders, silence
 *  readiness         client  hourly from 10:00 ET in `warming` — warming → ready / Day 1 slide
 */

import { WARMUP_STATES } from '@/lib/db/client';
import { cfg } from '@/lib/config';
import { partsIn, ET } from '@/lib/time';
import { bucketKey, dailyAt } from '@/lib/joblist/helpers';
import { onClientClock } from '@/lib/joblist/helpers';

const SKIP = new Set(['aviance', '_helper']);
const trialClient = (c) => c && !SKIP.has(c.id);
/**
 * Any trial client whose inboxes are in the warm-up circle (from the clients
 * the tick loaded) — or, with WARMUP_V2.avianceAlone, the aviance client.
 */
async function anyWarmingOrAviance(clients) {
  if ((clients || []).some((c) => trialClient(c) && WARMUP_STATES.has(c.state))) return true;
  if (!(clients || []).some((c) => c && c.id === 'aviance' && c.state !== 'deleted')) return false;
  return Boolean(await cfg(null, 'WARMUP_V2.avianceAlone')) && Boolean(await cfg(null, 'WARMUP.includeAviance'));
}
const hourKey = (p) => `${p.dayKey}T${String(p.hour).padStart(2, '0')}`;

const warmup = {
  name: 'warmup',
  scope: 'global',
  cost: 5,
  minBudgetMs: 12_000,
  claimTtl: 1200,
  async due({ now, clients }) {
    if (!(await anyWarmingOrAviance(clients))) return null; // helpers only warm client inboxes
    const every = await cfg(null, 'BUILD.warmupEveryMin');
    return bucketKey(partsIn(ET, now), every);
  },
  async run(ctx) {
    const { runWarmupSend } = await import('@/lib/systems/warmup');
    return runWarmupSend({ now: ctx.now, deadline: ctx.deadline, clients: ctx.clients });
  },
};

const warmupRead = {
  name: 'warmup-read',
  scope: 'global',
  cost: 6,
  minBudgetMs: 14_000,
  claimTtl: 600,
  async due({ now, clients, heartbeat }) {
    if (!(await anyWarmingOrAviance(clients))) return null;
    const p = partsIn(ET, now);
    const [from, to] = await cfg(null, 'BUILD.warmupReadHours');
    if (p.hhmm < from || p.hhmm >= to) return null;
    const { isThrottled } = await import('@/lib/systems/usage');
    // Usage Meter at 80 %+ on Redis → reads slow down (SPEC §10.4).
    const base = await cfg(null, 'BUILD.warmupReadRunEveryMin');
    const every = (await isThrottled('redis', heartbeat || {})) ? Math.max(base, 20) : base;
    return bucketKey(p, every);
  },
  async run(ctx) {
    const { runWarmupRead } = await import('@/lib/systems/warmup');
    return runWarmupRead({ now: ctx.now, deadline: ctx.deadline, clients: ctx.clients });
  },
};

const warmupDaily = {
  name: 'warmup-daily',
  scope: 'global',
  cost: 4,
  minBudgetMs: 6000,
  async due({ now }) { return dailyAt(partsIn(ET, now), '23:45'); },
  async run(ctx) {
    const { runWarmupDaily } = await import('@/lib/systems/warmup');
    return runWarmupDaily({ now: ctx.now, clients: ctx.clients });
  },
};

/**
 * warmup-daily for a client on a scaled Test Mode clock: the readiness check
 * runs once per *virtual* day (23:45 on its clock), so "two consecutive daily
 * checks" takes two virtual days, not two real ones.
 */
const warmupDailyScaled = {
  name: 'warmup-daily-scaled',
  scope: 'client',
  cost: 4,
  minBudgetMs: 6000,
  async due({ client, now }) {
    const { hasScaledClock } = await import('@/lib/testclock');
    if (!trialClient(client) || !hasScaledClock(client) || !WARMUP_STATES.has(client.state)) return null;
    return dailyAt(partsIn(ET, now), '23:45');
  },
  async run({ client, realNow }) {
    const { runWarmupDaily } = await import('@/lib/systems/warmup');
    return runWarmupDaily({ now: realNow, clients: [client], scaled: true });
  },
};

const canary = {
  name: 'canary',
  scope: 'client',
  cost: 6,
  minBudgetMs: 12_000,
  claimTtl: 900,
  async due({ client, now }) {
    if (!trialClient(client) || !WARMUP_STATES.has(client.state)) return null;
    const { canaryDue } = await import('@/lib/systems/canary');
    return canaryDue(client, now);
  },
  async run(ctx) {
    const { runCanary } = await import('@/lib/systems/canary');
    return runCanary({ client: ctx.client, now: ctx.now, deadline: ctx.deadline });
  },
};

/**
 * Spam test (Deliverability v2, systems/placement.js): from PLACEMENT.at ET,
 * every 5 min until today's run is settled — Day −3 onwards while warming,
 * Day 1, then weekly while sending. Small state machine, bounded per run.
 */
const placement = {
  name: 'placement',
  scope: 'client',
  cost: 5,
  minBudgetMs: 12_000,
  claimTtl: 900,
  async due({ client, now }) {
    if (!trialClient(client) || !WARMUP_STATES.has(client.state)) return null;
    const { placementDue } = await import('@/lib/systems/placement');
    return placementDue(client, now);
  },
  async run(ctx) {
    const { runPlacement } = await import('@/lib/systems/placement');
    return runPlacement({ client: ctx.client, now: ctx.now, deadline: ctx.deadline });
  },
};

const ramp = {
  name: 'ramp',
  scope: 'client',
  cost: 2,
  async due({ client, now }) {
    if (!trialClient(client) || !WARMUP_STATES.has(client.state)) return null;
    return dailyAt(partsIn(ET, now), await cfg(client.id, 'BUILD.rampAt'));
  },
  async run(ctx) {
    const { runRamp } = await import('@/lib/systems/ramp');
    return runRamp({ client: ctx.client, now: ctx.now });
  },
};

const leadfinderStart = {
  name: 'leadfinder-start',
  scope: 'client',
  cost: 2,
  claimTtl: 3600,
  async due({ client, now }) {
    if (!trialClient(client) || client.state !== 'warming') return null;
    const { getState } = await import('@/lib/systems/leadfinder');
    const st = await getState(client.id);
    if (st.initialAt) return null;
    return hourKey(partsIn(ET, now));
  },
  async run(ctx) {
    const { dispatchLeadFinder } = await import('@/lib/systems/leadfinder');
    const r = await dispatchLeadFinder(ctx.clientId, { mode: 'initial' });
    if (!r.ok) throw new Error(`dispatch failed: ${r.error}`);
    return r;
  },
};

const leadfinderRefill = {
  name: 'leadfinder-refill',
  scope: 'client',
  cost: 3,
  async due({ client, now }) {
    if (!trialClient(client) || !['warming', 'ready', 'sending', 'extension', 'converted'].includes(client.state)) return null;
    return dailyAt(partsIn(ET, now), await cfg(client.id, 'BUILD.refillAt'));
  },
  async run(ctx) {
    const { refillDue, dispatchLeadFinder, getState } = await import('@/lib/systems/leadfinder');
    const st = await getState(ctx.clientId);
    if (!st.initialAt) return { skipped: 'initial run not started' };
    const due = await refillDue(ctx.clientId, ctx.now);
    if (!due.due) return { skipped: due.reason || `unsent ${due.unsent}` };
    return dispatchLeadFinder(ctx.clientId, { mode: 'refill' });
  },
};

const approval = {
  name: 'approval',
  scope: 'client',
  cost: 3,
  claimTtl: 3600,
  async due({ client, now }) {
    if (!trialClient(client) || client.state !== 'warming') return null;
    // Every run may email the client (the link, a reminder, the silence note): inside the owner's
    // US hours only (US Eastern), never at midnight their time.
    const p = partsIn(ET, now);
    const [from, to] = await cfg(null, 'OWNER.usHours');
    if (p.hhmm < from || p.hhmm >= to) return null;
    return hourKey(p);
  },
  async run(ctx) {
    const { runApprovalJob } = await import('@/lib/systems/approval');
    return runApprovalJob({ client: ctx.client, now: ctx.now });
  },
};

const readiness = {
  name: 'readiness',
  scope: 'client',
  cost: 3,
  claimTtl: 3600,
  async due({ client, now }) {
    if (!trialClient(client) || client.state !== 'warming') return null;
    const p = partsIn(ET, now);
    if (p.hhmm < (await cfg(client.id, 'BUILD.readinessAt'))) return null;
    return hourKey(p);
  },
  async run(ctx) {
    const { runReadiness } = await import('@/lib/systems/readiness');
    return runReadiness({ client: ctx.client, now: ctx.now });
  },
};

export const JOBS = [warmup, warmupRead, warmupDaily, warmupDailyScaled, canary, placement, ramp, leadfinderStart, leadfinderRefill, approval, readiness].map(onClientClock);
