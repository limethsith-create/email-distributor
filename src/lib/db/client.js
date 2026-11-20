/**
 * Client records and the client state machine (SPEC §3, §4). Every client is
 * a paying client; there is no trial.
 *
 * `client.state` is the single source of truth for where a client is. Only the
 * transitions in TRANSITIONS are legal; `setState` refuses anything else and
 * writes every change to the client's event log.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';

export const STATES = [
  'applied', 'declined', 'onboarding', 'closed_silent', 'awaiting_purchase',
  'setup_check', 'warming', 'ready', 'sending', 'paused', 'retired', 'deleted',
];

export const TRANSITIONS = {
  applied: ['declined', 'onboarding'],
  onboarding: ['closed_silent', 'awaiting_purchase', 'declined'],
  awaiting_purchase: ['setup_check'],
  setup_check: ['awaiting_purchase', 'warming'],
  warming: ['ready'],
  ready: ['sending'],
  sending: ['paused', 'retired'],
  paused: ['sending', 'retired'],
  retired: ['deleted'],
  declined: [],
  closed_silent: [],
  deleted: [],
};

/** States of a client being set up or sending (the hub counts these as active). */
export const ACTIVE_STATES = new Set([
  'onboarding', 'awaiting_purchase', 'setup_check', 'warming', 'ready', 'sending', 'paused',
]);
/** States where a cold email may ever go out. */
export const SENDING_STATES = new Set(['sending']);
/** Sending states that stop by moving to `paused`. */
export const PAUSABLE_STATES = new Set(['sending']);
/** States where warm-up keeps running. */
export const WARMUP_STATES = new Set(['warming', 'ready', 'sending', 'paused']);
/** States in which the scheduler runs per-client jobs at all. */
export const LIVE_STATES = new Set([
  'applied', 'onboarding', 'awaiting_purchase', 'setup_check', 'warming', 'ready',
  'sending', 'paused', 'retired',
]);

/** Terminal states no job ever acts on; the tick does not load these clients. */
export const REST_STATES = new Set(['declined', 'closed_silent']);

/**
 * The hub's "Test run" clients (systems/demo.js): three example clients the owner can click through (two finished, one trial mid-way).
 * They live in Redis like real clients, but nothing may ever act for them — no job, no email, no alert, no
 * outside call. Their ids are fixed, so the check needs no Redis read; the client hash also carries demo '1'.
 */
export const DEMO_IDS = new Set(['demo-harbor-dental', 'demo-summit-roofing', 'demo-lakeview-pt']);
export const isDemoId = (id) => DEMO_IDS.has(String(id || ''));
export const isDemo = (client) => Boolean(client) && (isDemoId(client.id) || client.demo === '1' || client.demo === 1 || client.demo === true);

const parseList = (v) => { if (Array.isArray(v)) return v; try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };

/**
 * The tick's client index, kept on system:heartbeat so a tick needs no
 * SMEMBERS: `clientIds` (every client) and `restClients` (in REST_STATES).
 */
export async function syncClientIndex() {
  const ids = await listClientIds();
  await kv.hset(K.heartbeat(), { clientIds: JSON.stringify(ids) });
  return ids;
}

async function markRest(id, rest) {
  const cur = parseList(await kv.hget(K.heartbeat(), 'restClients'));
  const next = rest ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
  if (next.length !== cur.length) await kv.hset(K.heartbeat(), { restClients: JSON.stringify(next) });
}

/** Client ids the tick should load, from the heartbeat hash it already read (null → unknown). */
export function tickClientIds(hb = {}) {
  if (!hb.clientIds) return null;
  const rest = new Set(parseList(hb.restClients));
  return parseList(hb.clientIds).filter((id) => !rest.has(id));
}

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

/**
 * Every client hash in one pipeline (tick step 2). `ids` skips the SMEMBERS. The Test run clients (isDemo)
 * are left out unless `includeDemo` — only the hub's views ask for them; every job, count and email path
 * never sees them.
 */
export async function getAllClients(ids = null, { includeDemo = false } = {}) {
  if (!ids) ids = await listClientIds();
  if (!includeDemo) ids = ids.filter((id) => !isDemoId(id));
  if (!ids.length) return [];
  const p = kv.pipeline();
  for (const id of ids) p.hgetall(K.client(id));
  const rows = await p.exec();
  return ids.map((id, i) => (rows[i] && Object.keys(rows[i]).length ? { id, ...rows[i] } : null)).filter((c) => c && (includeDemo || !isDemo(c)));
}

/**
 * Create a client. Refuses to overwrite an existing id. `fields.state`
 * defaults to 'applied'.
 */
export async function createClient(id, fields = {}) {
  assertClientId(id);
  if (isDemoId(id)) throw new Error(`client ${id} already exists`); // the Test run's ids are never a real client's
  const now = new Date().toISOString();
  const rec = { plan: 'starter', state: 'applied', createdAt: now, ...fields };
  const created = await kv.hsetnx(K.client(id), 'createdAt', now);
  if (!(created === 1 || created === true)) throw new Error(`client ${id} already exists`);
  await kv.hset(K.client(id), rec);
  await kv.sadd(K.clients(), id);
  await syncClientIndex();
  if (REST_STATES.has(rec.state)) await markRest(id, true);
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
  if (ok === 1) {
    await logEvent(id, 'state', 'changed', { from: current, to, reason, forced: force || undefined });
    if (REST_STATES.has(to) !== REST_STATES.has(current)) await markRest(id, REST_STATES.has(to));
  }
  return ok === 1;
}

/**
 * Stop cold sending for a reason: `sending` → `paused`.
 * Returns 'paused' | null (nothing was sending).
 */
export async function holdSending(id, reason, { now = new Date() } = {}) {
  const client = await getClient(id);
  if (!client) return null;
  if (PAUSABLE_STATES.has(client.state)) return (await setState(id, 'paused', reason)) ? 'paused' : null;
  return null;
}

export async function getHash(key) {
  try { return (await kv.hgetall(key)) || {}; } catch { return {}; }
}

export const getProfile = (id) => getHash(K.profile(id));
export const getTrial = (id) => getHash(K.trial(id));
export const getDomain = (id) => getHash(K.domain(id));
