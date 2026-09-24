/**
 * Wrap-up (SPEC §9.7, §3 Deletion).
 *
 * Retire (Day 45 in `not_now`, or DAYJOBS.stopRetireDays after "Stop the
 * trial"): disable the inboxes, set domain.retiredAt, take the inboxes out of
 * warmup:pool, set trial.endedAt (if not yet set) and dataDeleteAt = endedAt
 * + DELETE.afterEndDays, state `retired`, owner alert `cancel_inboxes` — and
 * that alert repeats daily until the owner ticks "done" in Mission Control.
 *
 * Delete (on dataDeleteAt): remove every client:{id}:* / inbox:{id}:* /
 * pacing:{id} / lead:{id}:* key via SCAN, keep the stub `client:{id}` with
 * state `deleted`, mainDomain (one trial per company, ever) and what the
 * 90-day win-back needs; learning:* is never touched (no personal data).
 */

import { kv } from '@vercel/kv';
import { K, clientKeyPatterns } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getTrial, setState, updateClient } from '@/lib/db/client';
import { getInboxRecords, patchInbox } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { addDays, dayKeyIn, ET } from '@/lib/time';
import { patchTrial, recordLedger } from '@/lib/systems/dshared';

/** Fields kept on the stub after deletion. */
export const STUB_FIELDS = ['name', 'contactName', 'contactEmail', 'mainDomain', 'state', 'plan', 'createdAt', 'endedAt', 'winbackAt', 'winbackSentAt', 'deletedAt', 'stateChangedAt', 'updatedAt'];

async function removeFromPool(clientId, emails) {
  const members = [];
  for (const e of emails) members.push(e, `${clientId}:${e}`, K.inbox(clientId, e));
  try { if (members.length) await kv.srem(K.warmupPool(), ...members); } catch {}
}

export async function retireClient(clientId, { now = new Date(), reason = 'day45' } = {}) {
  const client = await getClient(clientId);
  if (!client) return { skipped: 'no client' };
  if (['retired', 'deleted', 'converted'].includes(client.state)) return { skipped: client.state };
  const trial = await getTrial(clientId);
  const at = now.toISOString();
  const inboxes = await getInboxRecords(clientId);
  for (const i of inboxes) await patchInbox(clientId, i.email, { enabled: '0', retiredAt: at });
  await removeFromPool(clientId, inboxes.map((i) => i.email));
  await kv.hset(K.domain(clientId), { retiredAt: at });
  const endedAt = trial.endedAt || at;
  const endDay = dayKeyIn(ET, new Date(endedAt));
  const dataDeleteAt = addDays(endDay, await cfg(clientId, 'DELETE.afterEndDays'));
  const winbackAt = addDays(endDay, await cfg(clientId, 'WINBACK.days'));
  await patchTrial(clientId, { endedAt, endReason: trial.endReason || reason, dataDeleteAt, winbackAt });
  await updateClient(clientId, { endedAt, winbackAt });
  if (client.state === 'not_now') {
    await setState(clientId, 'retired', reason);
  } else {
    // An early stop (Stop the trial / client quiet) ends from a running state:
    // the state machine has no direct edge, so this is a logged forced move.
    await setState(clientId, 'retired', `${reason} (early end from ${client.state})`, { force: true });
  }
  await recordLedger(clientId, { retiredAt: at, endReason: trial.endReason || reason });
  await logEvent(clientId, 'wrapup', 'retired', { inboxes: inboxes.length, dataDeleteAt, reason });
  await cancelInboxesReminder(clientId, { inboxes: inboxes.map((i) => i.email) });
  return { retired: true, inboxes: inboxes.length, dataDeleteAt };
}

/** Daily until trial.inboxesCancelledAt is set (Mission Control tick). */
export async function cancelInboxesReminder(clientId, { inboxes = null } = {}) {
  const trial = await getTrial(clientId);
  if (trial.inboxesCancelledAt) return { skipped: 'done' };
  const list = inboxes || (await getInboxRecords(clientId)).map((i) => i.email);
  return alertOwner('cancel_inboxes', {
    clientId,
    body: `${clientId} is retired. Cancel these inboxes with the provider so they stop billing:\n${list.map((e) => `• ${e}`).join('\n') || '• (no inbox records left — check the provider account)'}\n\nThen tick "Inboxes cancelled" on the client page.`,
    did: 'Inboxes are switched off and out of the warm-up circle; the domain is marked retired. This reminder repeats daily until ticked.',
  });
}

export async function markInboxesCancelled(clientId, now = new Date()) {
  await patchTrial(clientId, { inboxesCancelledAt: now.toISOString() });
  await logEvent(clientId, 'wrapup', 'inboxes_cancelled', {});
}

async function scanKeys(pattern) {
  const out = [];
  let cursor = 0;
  for (let i = 0; i < 1000; i++) {
    const res = await kv.scan(cursor, { match: pattern, count: 500 });
    const [next, keys] = Array.isArray(res) ? res : [0, []];
    out.push(...(keys || []));
    cursor = next;
    if (String(next) === '0') break;
  }
  return [...new Set(out)];
}

/** Every key belonging to a client except the stub hash itself. */
export async function clientDataKeys(clientId) {
  const keys = [];
  for (const p of clientKeyPatterns(clientId)) keys.push(...(p.includes('*') ? await scanKeys(p) : ((await kv.exists(p)) ? [p] : [])));
  return [...new Set(keys)].filter((k) => k !== K.client(clientId));
}

async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += 100) await kv.del(...keys.slice(i, i + 100));
}

/** On dataDeleteAt: purge, keep the stub. */
export async function deleteClientData(clientId, { now = new Date(), force = false } = {}) {
  const client = await getClient(clientId);
  if (!client) return { skipped: 'no client' };
  if (client.state !== 'retired' && !force) return { skipped: client.state };
  const trial = await getTrial(clientId);
  const today = dayKeyIn(ET, now);
  if (!force && (!trial.dataDeleteAt || trial.dataDeleteAt > today)) return { skipped: 'not due', dataDeleteAt: trial.dataDeleteAt || null };
  const keys = await clientDataKeys(clientId);
  await deleteKeys(keys);
  const drop = Object.keys(client).filter((f) => f !== 'id' && !STUB_FIELDS.includes(f));
  if (drop.length) await kv.hdel(K.client(clientId), ...drop);
  await updateClient(clientId, { deletedAt: now.toISOString(), endedAt: client.endedAt || trial.endedAt || now.toISOString(), winbackAt: client.winbackAt || trial.winbackAt || '' });
  if (client.state === 'retired') await setState(clientId, 'deleted', 'data deletion date reached');
  else await setState(clientId, 'deleted', 'data deletion (forced)', { force: true });
  await logEvent(clientId, 'wrapup', 'deleted', { keys: keys.length });
  return { deleted: keys.length };
}

/** Test Mode reset: remove everything including the stub. */
export async function purgeClient(clientId) {
  const keys = await clientDataKeys(clientId);
  await deleteKeys([...keys, K.client(clientId)]);
  await kv.srem(K.clients(), clientId);
  const { syncClientIndex } = await import('@/lib/db/client');
  await syncClientIndex();
  return { purged: keys.length + 1 };
}
