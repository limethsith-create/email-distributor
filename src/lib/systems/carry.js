/**
 * Carry the intake on without the heartbeat.
 *
 * Until cron-job.org calls the tick, nothing runs on a clock. The steps up to
 * warm-up must still move, so the hub's check (POST /api/mc/onboard-calls/check,
 * called whenever the owner opens the Trials screen or a trial) and the
 * agreement's after() run the Stage A client jobs that would otherwise wait for
 * a tick:
 *   research          the applicant research, when its own hand-over stopped
 *   market            the market count, when the 20 s agreement request ran out
 *   pricescout        the shopping list alert and the client's "setup in progress"
 *   setup-check       a manual purchase's next setup round (a CheapInboxes one
 *                     is moved on by its own sync)
 *   welcome           welcome_two_dates, when it could not go the first time
 *   onboarding-nudge  the onboarding page's reminders and the Day +7 close
 * through the SAME job definitions and the SAME per-period claims the tick uses
 * (jobs:claim:{job}:{client}:{period} + the client hash's `jp:{job}`), so a
 * period that ran here never runs again when the heartbeat starts. With a fresh
 * heartbeat (a tick in the last 5 minutes) it does nothing: the tick owns it.
 *
 * Warm-up, sending, replies, reports and everything after them still need the
 * heartbeat (docs/HUB-API.md "Journey run").
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAllClients, getClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { claim } from '@/lib/scheduler';
import { JOBS } from '@/lib/jobs';

export const CARRY_JOBS = ['research', 'market', 'pricescout', 'setup-check', 'welcome', 'onboarding-nudge'];
export const HEARTBEAT_FRESH_MS = 5 * 60e3;

/** A tick ran in the last HEARTBEAT_FRESH_MS (the scheduler is carrying the jobs itself). */
export async function heartbeatFresh(now = new Date()) {
  let hb = {};
  try { hb = (await kv.hgetall(K.heartbeat())) || {}; } catch { return false; }
  const t = Date.parse(hb.lastTickAt || '');
  return Number.isFinite(t) && now.getTime() - t < HEARTBEAT_FRESH_MS;
}

/**
 * Run the due CARRY_JOBS once each, for every client (or one). Never throws.
 * → { ran: [{ job, clientId }], skipped?: 'heartbeat', stopped?: 'budget' }
 */
export async function carryIntake({ now = new Date(), deadline = Date.now() + 20_000, clientId = null } = {}) {
  try {
    if (await heartbeatFresh(now)) return { ran: [], skipped: 'heartbeat' };
    const clients = (clientId ? [await getClient(clientId)] : await getAllClients()).filter((c) => c && c.id !== 'aviance' && c.id !== '_test');
    const ran = [];
    for (const name of CARRY_JOBS) {
      const job = JOBS.find((j) => j.name === name && j.scope === 'client');
      if (!job) continue;
      for (const client of clients) {
        // A CheapInboxes purchase being set up: its own sync runs the setup rounds (docs/AUTO-BUY.md).
        if (name === 'setup-check' && String(client.autobuyOpen) === '1') continue;
        if (Date.now() > deadline - (job.minBudgetMs || 4000)) return { ran, stopped: 'budget' };
        let period = null;
        try { period = await job.due({ client, clientId: client.id, now, clients }); } catch { period = null; }
        if (!period || client[`jp:${name}`] === period) continue;
        if (!(await claim(name, client.id, period, job.claimTtl || 86400))) continue;
        await kv.hset(K.client(client.id), { [`jp:${name}`]: period });
        const t0 = Date.now();
        try {
          await job.run({ client, clientId: client.id, now, deadline, period, clients });
          ran.push({ job: name, clientId: client.id });
          await kv.hset(K.client(client.id), { [`jl:${name}`]: JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, ok: true, by: 'check' }) });
        } catch (err) {
          await logEvent(client.id, 'carry', 'job_failed', { job: name, error: String(err?.message || err).slice(0, 200) });
        }
        // The job may have moved the client on (the market passed → the Price Scout is due next).
        Object.assign(client, (await getClient(client.id)) || {});
      }
    }
    if (ran.length) await logEvent(null, 'carry', 'carried', { ran });
    return { ran };
  } catch (err) {
    try { await logEvent(null, 'carry', 'failed', { error: String(err?.message || err).slice(0, 200) }); } catch {}
    return { ran: [], error: String(err?.message || err) };
  }
}
