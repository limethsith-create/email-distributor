/** Promise Register (SPEC §10.6). client:{id}:promises: id → {text, dueAt, madeAt, doneAt}. */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

export async function addPromise(clientId, text, dueAt, { done = false } = {}) {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const now = new Date().toISOString();
  await kv.hset(K.promises(clientId), { [id]: { id, text, dueAt, madeAt: now, doneAt: done ? now : null } });
  return id;
}

export async function completePromise(clientId, id) {
  const p = await kv.hget(K.promises(clientId), id);
  if (p) await kv.hset(K.promises(clientId), { [id]: { ...p, doneAt: new Date().toISOString() } });
}

export async function getPromises(clientId) {
  return Object.values((await kv.hgetall(K.promises(clientId))) || {}).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
}
