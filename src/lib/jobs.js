/**
 * Job table (SPEC §5): the global jobs (Watchdog, Usage Meter, sales-call
 * reminders) and every per-client system's jobs, stage by stage.
 *
 * `due(ctx)` returns the period to claim (or null when not due). Periods:
 * minute jobs 'YYYY-MM-DDTHH:mm', bucketed jobs 'YYYY-MM-DDTHH:mm' rounded
 * down to the bucket, daily jobs 'YYYY-MM-DD'.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { partsIn, ET } from '@/lib/time';
import { runWatchdog } from '@/lib/systems/watchdog';
import { runUsageMeter } from '@/lib/systems/usage';
import { runSalesReminders } from '@/lib/systems/salescall';
import { JOBS as STAGE_A } from '@/lib/joblist/stage-a';
import { JOBS as STAGE_B } from '@/lib/joblist/stage-b';
import { JOBS as STAGE_C } from '@/lib/joblist/stage-c';
import { JOBS as STAGE_D } from '@/lib/joblist/stage-d';

import { minuteKey } from '@/lib/joblist/helpers';

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

/** Website sales calls: the day-before and 1-hour reminders (systems/salescall.js). Every 15 minutes (the 1-hour reminder's window is 55 minutes wide). */
const salesReminders = {
  name: 'sales-reminders',
  scope: 'global',
  cost: 1,
  claimTtl: 900,
  async due({ now }) { const p = partsIn('UTC', now); return `${p.dayKey}T${String(p.hour).padStart(2, '0')}:${String(Math.floor(p.minute / 15) * 15).padStart(2, '0')}`; },
  async run(ctx) {
    // The unpaid-invoice chase rides on this frequent job (systems/invoice.js); it never blocks the reminders.
    const { chaseUnpaidInvoices } = await import('@/lib/systems/invoice');
    const invoiceChase = await chaseUnpaidInvoices({ clients: ctx.clients, now: ctx.now }).catch((e) => ({ error: String(e?.message || e).slice(0, 120) }));
    return { ...(await runSalesReminders(ctx)), invoiceChase };
  },
};

export const JOBS = [watchdog, usage, salesReminders, ...STAGE_A, ...STAGE_B, ...STAGE_C, ...STAGE_D];

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
