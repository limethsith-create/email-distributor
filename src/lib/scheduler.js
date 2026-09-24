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
 *
 * Redis budget (Upstash free tier, 500k commands/month — see
 * docs/assumptions/integration.md). A tick costs, before any job works:
 *   1  hgetall system:heartbeat   (global job bookkeeping, GitHub early exit)
 *   1+N smembers clients + one hgetall per client
 *   1  hset system:heartbeat at the end (lastTickAt, tick count, global jobs)
 * Job bookkeeping lives in fields of the hash each tick already reads —
 * `jp:{job}` (last period claimed), `jl:{job}` (last run), `je:{job}` (error
 * streak) on client:{id} for client jobs and on system:heartbeat for global
 * jobs — and is written once per client per tick (a job may add its own
 * fields through `result._clientFields`). A job whose period is
 * already recorded is skipped with no Redis command at all, so a daily job
 * costs one claim a day, not one per tick.
 *
 * The GitHub backup pinger (every 5 min) does nothing when the primary
 * pinger ticked in the last BACKUP_SKIP_MS: it is there for when cron-job.org
 * stops, not to double the work.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAllClients, tickClientIds, listClientIds } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { cfg, withConfigSnapshot } from '@/lib/config';
import { dayKeyIn, ET } from '@/lib/time';
import { JOBS } from '@/lib/jobs';

export const TICK_BUDGET_MS = 20_000;
export const BACKUP_SKIP_MS = 150_000;

/** SET NX claim; true when this caller owns the period. */
export async function claim(job, scope, period, ttlSeconds) {
  const res = await kv.set(K.jobClaim(job, scope, period), Date.now(), { nx: true, ex: Math.max(60, ttlSeconds) });
  return res === 'OK';
}

const parseRec = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** Last run of every job for one scope, from its hash fields (Mission Control). */
export function jobRecords(hash = {}) {
  const out = {};
  for (const [k, v] of Object.entries(hash || {})) if (k.startsWith('jl:')) out[k.slice(3)] = parseRec(v);
  return out;
}

async function onJobError(job, scope, err, streak) {
  const day = dayKeyIn(ET);
  const detail = { job, scope, error: String(err?.message || err).slice(0, 300) };
  await logEvent(scope === 'global' ? null : scope, 'scheduler', 'job_error', detail);
  try {
    const p = kv.pipeline();
    p.hincrby(K.errors(job, day), scope, 1);
    p.expire(K.errors(job, day), 14 * 86400);
    await p.exec();
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

/**
 * Run one tick.
 * @param {object} opts { source, now, only: jobName, clientId, force }
 *   only/clientId/force let Mission Control "force a job now".
 */
export async function runTick(opts = {}) {
  return withConfigSnapshot(() => tick(opts));
}

async function tick({ source = 'unknown', now = new Date(), only = null, clientId = null, force = false } = {}) {
  const started = Date.now();
  const deadline = started + TICK_BUDGET_MS;
  const ran = [];
  const skipped = [];

  let hb = {};
  try { hb = (await kv.hgetall(K.heartbeat())) || {}; } catch {}
  const heartbeat = { ...hb };

  // Backup pinger with a fresh primary heartbeat: nothing to do (one read).
  if (source === 'github' && !only && !clientId && !force && hb.lastTickAt && hb.lastTickSource !== 'github'
    && now.getTime() - Date.parse(hb.lastTickAt) < BACKUP_SKIP_MS) {
    return { ran, skipped: [{ job: '*', reason: 'primary heartbeat is fresh' }], ms: Date.now() - started, heartbeat };
  }

  const day = dayKeyIn(ET, now);
  const globalFields = { lastTickAt: now.toISOString(), lastTickSource: source, [`ticks:${day}`]: (Number(hb[`ticks:${day}`]) || 0) + 1 };
  const clientFields = new Map(); // clientId → fields to write at the end
  const fieldsFor = (scope) => {
    if (scope === 'global') return globalFields;
    if (!clientFields.has(scope)) clientFields.set(scope, {});
    return clientFields.get(scope);
  };

  try {
    // Client ids come from the heartbeat hash (no SMEMBERS); declined /
    // closed_silent clients are not loaded at all. Self-heals when missing.
    let ids = clientId ? [clientId] : tickClientIds(hb);
    if (!ids) { ids = await listClientIds(); globalFields.clientIds = JSON.stringify(ids); }
    const clients = (await getAllClients(ids)).filter((c) => !clientId || c.id === clientId);
    const base = { now, source, deadline, clients, heartbeat };

    const work = [];
    for (const job of JOBS) {
      if (only && job.name !== only) continue;
      if (job.scope === 'global') {
        if (clientId) continue;
        work.push({ job, scope: 'global', ctx: { ...base }, rec: hb });
      } else {
        for (const client of clients) {
          work.push({ job, scope: client.id, ctx: { ...base, client, clientId: client.id }, rec: client });
        }
      }
    }
    work.sort((a, b) => (a.job.cost || 1) - (b.job.cost || 1));

    for (const { job, scope, ctx, rec } of work) {
      const label = `${job.name}:${scope}`;
      let period;
      try {
        period = force ? `force-${now.getTime()}` : await job.due(ctx);
      } catch (err) {
        const streak = (Number(rec[`je:${job.name}`]) || 0) + 1;
        rec[`je:${job.name}`] = streak;
        fieldsFor(scope)[`je:${job.name}`] = streak;
        await onJobError(job.name, scope, err, streak);
        continue;
      }
      if (!period) continue;
      // Already claimed this period (by this or another pinger): no Redis call.
      if (!force && rec[`jp:${job.name}`] === period) continue;
      if (Date.now() > deadline - (job.minBudgetMs || 2000)) { skipped.push({ job: label, reason: 'budget' }); continue; }
      let owned = false;
      try {
        owned = await claim(job.name, scope, period, job.claimTtl || 86400);
      } catch (err) {
        skipped.push({ job: label, reason: `claim failed: ${err.message}` });
        continue;
      }
      if (!force) { rec[`jp:${job.name}`] = period; fieldsFor(scope)[`jp:${job.name}`] = period; }
      if (!owned) { skipped.push({ job: label, reason: 'claimed' }); continue; }
      const t0 = Date.now();
      try {
        let result = await job.run({ ...ctx, period });
        const f = fieldsFor(scope);
        // A client job may hand back fields for its own client hash (e.g. the
        // sender's next due time); they ride on the tick's single write.
        if (result && typeof result === 'object' && result._clientFields) {
          const { _clientFields, ...rest } = result;
          if (scope !== 'global') { Object.assign(f, _clientFields); Object.assign(rec, _clientFields); }
          result = rest;
        }
        if (Number(rec[`je:${job.name}`])) { rec[`je:${job.name}`] = 0; f[`je:${job.name}`] = 0; }
        f[`jl:${job.name}`] = JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, ok: true });
        ran.push({ job: label, period, ms: Date.now() - t0, result: summarize(result) });
      } catch (err) {
        const streak = (Number(rec[`je:${job.name}`]) || 0) + 1;
        rec[`je:${job.name}`] = streak;
        const f = fieldsFor(scope);
        f[`je:${job.name}`] = streak;
        f[`jl:${job.name}`] = JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, ok: false, error: String(err?.message || err).slice(0, 200) });
        await onJobError(job.name, scope, err, streak);
        ran.push({ job: label, period, ms: Date.now() - t0, error: String(err?.message || err).slice(0, 200) });
      }
    }
  } finally {
    // One write per client that changed and one heartbeat write.
    for (const [id, fields] of clientFields) {
      if (!Object.keys(fields).length) continue;
      try { await kv.hset(K.client(id), fields); } catch {}
    }
    try { await kv.hset(K.heartbeat(), globalFields); } catch {}
  }

  return { ran, skipped, ms: Date.now() - started, heartbeat };
}

function summarize(result) {
  if (result == null || typeof result !== 'object') return result;
  const s = JSON.stringify(result);
  return s.length > 600 ? JSON.parse(JSON.stringify({ truncated: true, keys: Object.keys(result) })) : result;
}
