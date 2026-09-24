/**
 * Tick dispatcher (SPEC §5). One call of /api/cron/tick runs every job that
 * is due, cheapest first, inside a 20-second budget, and leaves the rest for
 * the next tick.
 *
 * A job is { name, scope: 'client'|'global', cost, due(ctx) → period|null,
 * run(ctx) → result }. `due` returns the period string the job claims
 * (jobs:claim:{job}:{scope}:{period}, SET NX) — so two pingers hitting the
 * same minute can never run a job twice. Claim first, act second, never
 * release on failure: the error streak + job_failing alert handle retries.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAllClients } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { cfg } from '@/lib/config';
import { dayKeyIn, ET } from '@/lib/time';
import { JOBS } from '@/lib/jobs';

export const TICK_BUDGET_MS = 20_000;

/** SET NX claim; true when this caller owns the period. */
export async function claim(job, scope, period, ttlSeconds) {
  const res = await kv.set(K.jobClaim(job, scope, period), Date.now(), { nx: true, ex: Math.max(60, ttlSeconds) });
  return res === 'OK';
}

async function onJobError(job, scope, err) {
  const day = dayKeyIn(ET);
  const detail = { job, scope, error: String(err?.message || err).slice(0, 300) };
  await logEvent(scope === 'global' ? null : scope, 'scheduler', 'job_error', detail);
  let streak = 0;
  try {
    const p = kv.pipeline();
    p.hincrby(K.errors(job, day), scope, 1);
    p.expire(K.errors(job, day), 14 * 86400);
    p.incr(K.errorStreak(job, scope));
    p.expire(K.errorStreak(job, scope), 86400);
    const res = await p.exec();
    streak = Number(res[2]) || 0;
  } catch {}
  const limit = await cfg(null, 'WATCHDOG.jobFailStreak');
  if (streak >= limit) {
    await alertOwner('job_failing', {
      clientId: scope === 'global' ? null : scope,
      scope: `${job}:${scope}`,
      vars: { job, scope },
      body: `The ${job} job has failed ${streak} times in a row for ${scope}.\nLast error: ${detail.error}`,
      did: 'State was left unchanged; the job retries on every tick.',
    });
  }
}

async function onJobOk(job, scope) {
  try { await kv.del(K.errorStreak(job, scope)); } catch {}
}

/**
 * Run one tick.
 * @param {object} opts { source, now, only: jobName, clientId, force }
 *   only/clientId/force let Mission Control "force a job now".
 */
export async function runTick({ source = 'unknown', now = new Date(), only = null, clientId = null, force = false } = {}) {
  const started = Date.now();
  const deadline = started + TICK_BUDGET_MS;
  const ran = [];
  const skipped = [];

  try {
    const p = kv.pipeline();
    p.hset(K.heartbeat(), { lastTickAt: now.toISOString(), lastTickSource: source });
    p.hincrby(K.heartbeat(), `ticks:${dayKeyIn(ET, now)}`, 1);
    await p.exec();
  } catch {}

  const clients = (await getAllClients()).filter((c) => !clientId || c.id === clientId);
  const base = { now, source, deadline, clients };

  const work = [];
  for (const job of JOBS) {
    if (only && job.name !== only) continue;
    if (job.scope === 'global') {
      if (clientId) continue;
      work.push({ job, scope: 'global', ctx: { ...base } });
    } else {
      for (const client of clients) {
        work.push({ job, scope: client.id, ctx: { ...base, client, clientId: client.id } });
      }
    }
  }
  work.sort((a, b) => (a.job.cost || 1) - (b.job.cost || 1));

  for (const { job, scope, ctx } of work) {
    const label = `${job.name}:${scope}`;
    if (Date.now() > deadline - (job.minBudgetMs || 2000)) { skipped.push({ job: label, reason: 'budget' }); continue; }
    let period;
    try {
      period = force ? `force-${now.getTime()}` : await job.due(ctx);
    } catch (err) {
      await onJobError(job.name, scope, err);
      continue;
    }
    if (!period) continue;
    let owned = false;
    try {
      owned = await claim(job.name, scope, period, job.claimTtl || 86400);
    } catch (err) {
      skipped.push({ job: label, reason: `claim failed: ${err.message}` });
      continue;
    }
    if (!owned) { skipped.push({ job: label, reason: 'claimed' }); continue; }
    const t0 = Date.now();
    try {
      const result = await job.run({ ...ctx, period });
      await onJobOk(job.name, scope);
      try { await kv.set(K.jobLast(job.name, scope), { at: new Date().toISOString(), ms: Date.now() - t0, ok: true }, { ex: 30 * 86400 }); } catch {}
      ran.push({ job: label, period, ms: Date.now() - t0, result: summarize(result) });
    } catch (err) {
      try { await kv.set(K.jobLast(job.name, scope), { at: new Date().toISOString(), ms: Date.now() - t0, ok: false, error: String(err?.message || err).slice(0, 200) }, { ex: 30 * 86400 }); } catch {}
      await onJobError(job.name, scope, err);
      ran.push({ job: label, period, ms: Date.now() - t0, error: String(err?.message || err).slice(0, 200) });
    }
  }

  return { ran, skipped, ms: Date.now() - started };
}

function summarize(result) {
  if (result == null || typeof result !== 'object') return result;
  const s = JSON.stringify(result);
  return s.length > 600 ? JSON.parse(JSON.stringify({ truncated: true, keys: Object.keys(result) })) : result;
}
