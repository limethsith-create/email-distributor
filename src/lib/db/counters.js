/**
 * Stored counters (SPEC §3, rule 4). Reports render only from these. A
 * missing required counter blocks the report — it never renders as 0.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { dayKeyIn, ET } from '@/lib/time';

export const COUNTER_FIELDS = [
  'sent', 'sentD0', 'sentD3', 'sentD7', 'sentD10', 'bounces', 'replies', 'positive', 'booked', 'held',
  'qualified', 'noshows', 'wrongfit', 'warmupSent', 'warmupInbox', 'warmupSpam', 'warmupRescued', 'companiesContacted',
];

/** Add to today's and the running total in one pipeline. */
export async function bump(clientId, field, n = 1, now = new Date()) {
  const day = dayKeyIn(ET, now);
  const p = kv.pipeline();
  p.hincrby(K.countersDay(clientId, day), field, n);
  p.expire(K.countersDay(clientId, day), 120 * 86400);
  p.hincrby(K.countersTotal(clientId), field, n);
  await p.exec();
}

/** Make sure a counter exists (at 0) so reports know it was tracked, not missing. */
export async function initCounters(clientId, fields = COUNTER_FIELDS) {
  const p = kv.pipeline();
  for (const f of fields) p.hsetnx(K.countersTotal(clientId), f, 0);
  await p.exec();
}

export async function getTotals(clientId) {
  const raw = (await kv.hgetall(K.countersTotal(clientId))) || {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
}

export async function getDay(clientId, day) {
  const raw = (await kv.hgetall(K.countersDay(clientId, day))) || {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
}

/** Sum a set of fields over several day keys (missing days count as 0 only if the total exists). */
export async function sumDays(clientId, days, fields) {
  const p = kv.pipeline();
  for (const d of days) p.hgetall(K.countersDay(clientId, d));
  const rows = await p.exec();
  const out = Object.fromEntries(fields.map((f) => [f, 0]));
  for (const r of rows) for (const f of fields) out[f] += Number(r?.[f]) || 0;
  return out;
}

/**
 * Rule 4 gate: returns { ok, values, missing } for the fields a report needs.
 */
export async function requireCounters(clientId, fields) {
  const totals = await getTotals(clientId);
  const missing = fields.filter((f) => !Number.isFinite(totals[f]));
  return { ok: missing.length === 0, values: totals, missing };
}
