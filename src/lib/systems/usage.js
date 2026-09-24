/**
 * Usage Meter (SPEC §10.4). Hourly. Systems that call a metered free service
 * count their own calls with `countUsage(service, field, n)`; this job
 * compares the month's totals with the free limits, alerts at USAGE.warn and
 * USAGE.stop, and sets throttle:{service} so non-essential jobs back off.
 *
 * Redis commands can only be measured through Upstash's management API
 * (UPSTASH_EMAIL + UPSTASH_API_KEY + UPSTASH_DB_ID). Without those the meter
 * records tick counts only and raises no Redis alert — it never guesses.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { alertOwner } from '@/lib/notify';
import { partsIn } from '@/lib/time';

export const LIMITS = {
  redis: { field: 'commands', monthly: 500_000 },
  places: { field: 'enterprise', monthly: null /* cfg PLACES.monthlyEnterprise */ },
  reoon: { field: 'checks', monthly: 600 },
};

const monthOf = (now = new Date()) => partsIn('UTC', now).monthKey;

export async function countUsage(service, field, n = 1) {
  try { await kv.hincrby(K.usage(service, monthOf()), field, n); } catch {}
}

// Throttle flags change at most hourly (Usage Meter); a warm instance reuses
// an answer for a minute instead of one Redis read per job per tick.
const throttleMemo = new Map();
/**
 * `heartbeat` (the hash a tick already read) answers without a Redis call:
 * the meter mirrors each flag there as `throttle:{service}` = `level|expiresAt`.
 */
export async function isThrottled(service, heartbeat = null) {
  if (heartbeat) {
    const [level, until] = String(heartbeat[`throttle:${service}`] || '').split('|');
    return Boolean(level) && Date.parse(until) > Date.now();
  }
  const hit = throttleMemo.get(service);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v = false;
  try { v = Boolean(await kv.get(`throttle:${service}`)); } catch { v = false; }
  const ms = Number(process.env.CFG_MEMO_MS ?? 60_000);
  if (ms > 0) throttleMemo.set(service, { v, exp: Date.now() + ms });
  return v;
}
export function clearThrottleMemo() { throttleMemo.clear(); }

async function upstashCommands() {
  const { UPSTASH_EMAIL: email, UPSTASH_API_KEY: key, UPSTASH_DB_ID: id } = process.env;
  if (!email || !key || !id) return null;
  try {
    const res = await fetch(`https://api.upstash.com/v2/redis/stats/${id}`, {
      headers: { authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const n = Number(j.total_monthly_requests ?? j.monthly_request_count ?? j.total_requests);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function runUsageMeter({ now = new Date() } = {}) {
  const month = monthOf(now);
  const report = {};
  const redis = await upstashCommands();
  if (redis != null) await kv.hset(K.usage('redis', month), { commands: redis, measuredAt: now.toISOString() });

  const warn = await cfg(null, 'USAGE.warn');
  const stop = await cfg(null, 'USAGE.stop');
  const placesLimit = await cfg(null, 'PLACES.monthlyEnterprise');

  for (const [service, spec] of Object.entries(LIMITS)) {
    const limit = service === 'places' ? placesLimit : spec.monthly;
    const row = (await kv.hgetall(K.usage(service, month))) || {};
    const used = Number(row[spec.field]);
    if (!Number.isFinite(used) || !limit) { report[service] = { used: row[spec.field] ?? null, limit, measured: false }; continue; }
    const ratio = used / limit;
    report[service] = { used, limit, pct: Math.round(ratio * 100) };
    if (ratio >= warn) {
      const level = ratio >= stop ? 'stop' : 'slow';
      await kv.set(`throttle:${service}`, level, { ex: 2 * 3600 });
      await kv.hset(K.heartbeat(), { [`throttle:${service}`]: `${level}|${new Date(Date.now() + 2 * 3600e3).toISOString()}` });
      throttleMemo.delete(service);
    }
    if (ratio >= stop) {
      await alertOwner('usage_95', { scope: service, vars: { service, pct: Math.round(ratio * 100) }, body: `${service}: ${used} of ${limit} this month.`, did: 'Non-essential jobs (list refills, canary) are paused; sending and replies continue.' });
    } else if (ratio >= warn) {
      await alertOwner('usage_80', { scope: service, vars: { service, pct: Math.round(ratio * 100) }, body: `${service}: ${used} of ${limit} this month.`, did: 'List refills and warm-up reads are slowed down.' });
    }
  }
  return report;
}
