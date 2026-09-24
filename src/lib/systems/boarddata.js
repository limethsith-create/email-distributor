/**
 * What the Mission Control board (SPEC §10.1) and the owner digests show
 * about each client, computed in one place so the two never disagree.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getAllClients, getTrial, ACTIVE_TRIAL_STATES } from '@/lib/db/client';
import { getTotals } from '@/lib/db/counters';
import { getInboxRecords } from '@/lib/db/inboxes';
import { getPromises } from '@/lib/db/promises';
import { getAlertLog } from '@/lib/notify';
import { addDays, partsIn } from '@/lib/time';
import { clientNow, clientTrialDay } from '@/lib/testclock';
import { computeHealth, COLOUR_RANK } from '@/lib/systems/health';
import { LIMITS } from '@/lib/systems/usage';

export const FIVE = ['sent', 'replies', 'positive', 'booked', 'qualified'];

export async function clientRow(c, { alerts = [], now = new Date() } = {}) {
  const [trial, totals, inboxes, promises] = await Promise.all([
    getTrial(c.id), getTotals(c.id).catch(() => ({})), getInboxRecords(c.id).catch(() => []), getPromises(c.id).catch(() => []),
  ]);
  const day = clientTrialDay(c, trial, now);
  const open = alerts.filter((a) => a.clientId === c.id && !a.acknowledged);
  const health = computeHealth({ client: c, trial, totals, day, alerts: open, promises, now: clientNow(c, now), quietWarnDays: await cfg(c.id, 'CLIENT.quietWarnDays') });
  const rates = inboxes.map((i) => Number(i.inboxRate7d)).filter(Number.isFinite).map((n) => (n > 1 ? n / 100 : n));
  let lastJobAt = null;
  const { JOBS } = await import('@/lib/jobs');
  const names = [...new Set(JOBS.filter((j) => j.scope === 'client').map((j) => j.name))];
  if (names.length) {
    try {
      const p = kv.pipeline();
      for (const n of names) p.get(K.jobLast(n, c.id));
      const rows = await p.exec();
      for (const r of rows) if (r?.at && (!lastJobAt || r.at > lastJobAt)) lastJobAt = r.at;
    } catch {}
  }
  return {
    id: c.id, name: c.name || c.id, state: c.state, plan: c.plan || 'trial',
    trialDay: day, day1Date: trial.day1Date || null, day30Date: trial.day30Date || (trial.day1Date ? addDays(trial.day1Date, 29) : null),
    health: health.colour, healthReasons: health.reasons,
    five: Object.fromEntries(FIVE.map((f) => [f, Number.isFinite(totals[f]) ? totals[f] : null])),
    inboxRate: rates.length ? Math.min(...rates) : null,
    lastJobAt,
    openAlerts: open.length, urgentAlerts: open.filter((a) => a.urgent).length,
    extension: c.state === 'extension',
  };
}

async function usagePct(service, field, limit, month) {
  try {
    const row = (await kv.hgetall(K.usage(service, month))) || {};
    const used = Number(row[field]);
    if (!Number.isFinite(used) || !limit) return { used: row[field] ?? null, limit, pct: null };
    return { used, limit, pct: Math.round((used / limit) * 100) };
  } catch { return { used: null, limit, pct: null }; }
}

export async function boardData(now = new Date()) {
  const [hb, clients, alerts] = await Promise.all([kv.hgetall(K.heartbeat()).catch(() => ({})), getAllClients(), getAlertLog(500)]);
  const rows = await Promise.all(clients.map((c) => clientRow(c, { alerts, now })));
  rows.sort((a, b) => COLOUR_RANK[a.health] - COLOUR_RANK[b.health] || b.urgentAlerts - a.urgentAlerts || b.openAlerts - a.openAlerts || a.id.localeCompare(b.id));
  const month = partsIn('UTC', now).monthKey;
  const reoonLimit = LIMITS.reoon.monthly;
  const reoon = await usagePct('reoon', LIMITS.reoon.field, reoonLimit, month);
  const trialRows = rows.filter((r) => r.id !== 'aviance' && r.id !== '_test');
  return {
    heartbeat: { lastTickAt: hb?.lastTickAt || null, ageSec: hb?.lastTickAt ? Math.round((now.getTime() - Date.parse(hb.lastTickAt)) / 1000) : null, source: hb?.lastTickSource || null, lastSendAt: hb?.lastSendAt || null },
    usage: {
      redis: await usagePct('redis', LIMITS.redis.field, LIMITS.redis.monthly, month),
      places: await usagePct('places', LIMITS.places.field, await cfg(null, 'PLACES.monthlyEnterprise'), month),
      reoon: { ...reoon, remaining: Number.isFinite(reoon.used) ? Math.max(0, reoonLimit - reoon.used) : null },
    },
    activeTrials: trialRows.filter((r) => ACTIVE_TRIAL_STATES.has(r.state)).length,
    maxActiveTrials: await cfg(null, 'MAX_ACTIVE_TRIALS'),
    extensions: trialRows.filter((r) => r.extension).length,
    openAlerts: alerts.filter((a) => !a.acknowledged).length,
    clients: rows,
  };
}
