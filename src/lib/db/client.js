/**
 * Client records and the trial state machine (SPEC §3, §4).
 *
 * `client.state` is the single source of truth for where a trial is. Only the
 * transitions in TRANSITIONS are legal; `setState` refuses anything else and
 * writes every change to the client's event log.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';

export const STATES = [
  'applied', 'declined', 'queued', 'onboarding', 'closed_silent', 'awaiting_purchase',
  'setup_check', 'warming', 'ready', 'sending', 'paused', 'extension', 'deciding',
  'converted', 'not_now', 'retired', 'deleted',
];

export const TRANSITIONS = {
  applied: ['declined', 'queued', 'onboarding'],
  queued: ['onboarding', 'declined'],
  onboarding: ['closed_silent', 'awaiting_purchase', 'declined'],
  awaiting_purchase: ['setup_check'],
  setup_check: ['awaiting_purchase', 'warming'],
  warming: ['ready'],
  ready: ['sending'],
  sending: ['paused', 'extension', 'deciding'],
  paused: ['sending', 'extension', 'deciding'],
  extension: ['deciding', 'paused'],
  deciding: ['converted', 'not_now'],
  not_now: ['retired', 'converted'],
  retired: ['deleted'],
  converted: [],
  declined: [],
  closed_silent: [],
  deleted: [],
};

/** States where the client counts toward MAX_ACTIVE_TRIALS (SPEC §4). */
export const ACTIVE_TRIAL_STATES = new Set([
  'onboarding', 'awaiting_purchase', 'setup_check', 'warming', 'ready', 'sending', 'paused', 'extension',
]);
/** States where a cold email may ever go out. */
export const SENDING_STATES = new Set(['sending', 'extension']);
/** States where warm-up keeps running. */
export const WARMUP_STATES = new Set(['warming', 'ready', 'sending', 'paused', 'extension']);
/** States in which the scheduler runs per-client jobs at all. */
export const LIVE_STATES = new Set([
  'applied', 'queued', 'onboarding', 'awaiting_purchase', 'setup_check', 'warming', 'ready',
  'sending', 'paused', 'extension', 'deciding', 'converted', 'not_now', 'retired',
]);

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export async function listClientIds() {
  try { return ((await kv.smembers(K.clients())) || []).sort(); } catch { return []; }
}

export async function getClient(id) {
  assertClientId(id);
  const rec = await kv.hgetall(K.client(id));
  return rec && Object.keys(rec).length ? { id, ...rec } : null;
}

/** Every client hash in one pipeline (tick step 2). */
export async function getAllClients() {
  const ids = await listClientIds();
  if (!ids.length) return [];
  const p = kv.pipeline();
  for (const id of ids) p.hgetall(K.client(id));
  const rows = await p.exec();
  return ids.map((id, i) => (rows[i] && Object.keys(rows[i]).length ? { id, ...rows[i] } : null)).filter(Boolean);
}

/**
 * Create a client. Refuses to overwrite an existing id. `fields.state`
 * defaults to 'applied'.
 */
export async function createClient(id, fields = {}) {
  assertClientId(id);
  const now = new Date().toISOString();
  const rec = { plan: 'trial', state: 'applied', createdAt: now, ...fields };
  const created = await kv.hsetnx(K.client(id), 'createdAt', now);
  if (!(created === 1 || created === true)) throw new Error(`client ${id} already exists`);
  await kv.hset(K.client(id), rec);
  await kv.sadd(K.clients(), id);
  await logEvent(id, 'client', 'created', { state: rec.state, name: rec.name || null });
  return { id, ...rec };
}

export async function updateClient(id, fields) {
  assertClientId(id);
  await kv.hset(K.client(id), { ...fields, updatedAt: new Date().toISOString() });
}

/**
 * Move a client to a new state. Compare-and-set on the current state so two
 * ticks racing on the same transition cannot both win. Returns true when this
 * call made the change.
 */
export async function setState(id, to, reason = null, { force = false } = {}) {
  assertClientId(id);
  if (!STATES.includes(to)) throw new Error(`unknown state ${to}`);
  const script = `
    local cur = redis.call('HGET', KEYS[1], 'state')
    if cur ~= ARGV[1] then return 0 end
    redis.call('HSET', KEYS[1], 'state', ARGV[2], 'stateChangedAt', ARGV[3])
    return 1`;
  const current = await kv.hget(K.client(id), 'state');
  if (current === to) return false;
  if (!force && !canTransition(current, to)) {
    await logEvent(id, 'state', 'illegal_transition', { from: current, to, reason });
    throw new Error(`illegal transition ${current} -> ${to} for ${id}`);
  }
  const ok = await kv.eval(script, [K.client(id)], [String(current), to, new Date().toISOString()]);
  if (ok === 1) await logEvent(id, 'state', 'changed', { from: current, to, reason, forced: force || undefined });
  return ok === 1;
}

export async function getHash(key) {
  try { return (await kv.hgetall(key)) || {}; } catch { return {}; }
}

export const getProfile = (id) => getHash(K.profile(id));
export const getTrial = (id) => getHash(K.trial(id));
export const getDomain = (id) => getHash(K.domain(id));
