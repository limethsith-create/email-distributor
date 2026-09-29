/**
 * Change requests (docs/HUB-API.md "Ava (AI helper)") — what someone asked
 * Ava to change about the hub or the machine. Ava cannot edit code; she
 * proposes `add_change_request`, the user presses it, and the hub posts it
 * here. The owner (or the developer) reads the list and marks each done.
 *
 * Redis: `ava:requests`, a list of JSON {id, at, by, text, status}, newest
 * first, capped at 200.
 */

import crypto from 'node:crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

export const REQUESTS_CAP = 200;

const parse = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

export async function listRequests() {
  const raw = (await kv.lrange(K.avaRequests(), 0, REQUESTS_CAP - 1)) || [];
  return { requests: raw.map(parse).filter(Boolean) };
}

/** Any signed-in hub user. `by` = their first name (or "owner" / "team member"). */
export async function addRequest(text, by, now = new Date()) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!t) { const e = new Error('Write what should change.'); e.status = 400; throw e; }
  const item = { id: crypto.randomUUID().slice(0, 12), at: now.toISOString(), by: String(by || 'someone').slice(0, 60), text: t, status: 'open' };
  await kv.lpush(K.avaRequests(), JSON.stringify(item));
  await kv.ltrim(K.avaRequests(), 0, REQUESTS_CAP - 1);
  return { ok: true, request: item };
}

/** The owner only (the route checks). */
export async function markDone(id, now = new Date()) {
  const raw = (await kv.lrange(K.avaRequests(), 0, REQUESTS_CAP - 1)) || [];
  const i = raw.findIndex((v) => parse(v)?.id === String(id || ''));
  if (i < 0) { const e = new Error('No such request.'); e.status = 404; throw e; }
  const item = { ...parse(raw[i]), status: 'done', doneAt: now.toISOString() };
  await kv.lset(K.avaRequests(), i, JSON.stringify(item));
  return { ok: true, request: item };
}
