/**
 * Promise Register (SPEC §10.6). Promises come from onboarding (Stage A),
 * client change requests (Stage B), the "Talk to someone" button, and any
 * owner note typed on the client page with a date — that last source lives
 * here. Due-today promises go into the morning digest; overdue ones turn the
 * board card yellow (health.js).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { addPromise, getPromises, completePromise } from '@/lib/db/promises';
import { logEvent } from '@/lib/db/events';
import { dayKeyIn, ET } from '@/lib/time';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Owner note from the client page; a date makes it a promise. */
export async function addOwnerNote(clientId, text, dueDate = null, now = new Date()) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t) throw new Error('note is empty');
  if (dueDate && !DATE_RE.test(dueDate)) throw new Error('date must be YYYY-MM-DD');
  const prev = (await kv.hget(K.client(clientId), 'ownerNotes')) || '';
  const line = `${dayKeyIn(ET, now)}: ${t}${dueDate ? ` (due ${dueDate})` : ''}`;
  await kv.hset(K.client(clientId), { ownerNotes: prev ? `${prev}\n${line}` : line });
  let promiseId = null;
  if (dueDate) promiseId = await addPromise(clientId, t, dueDate);
  await logEvent(clientId, 'promises', dueDate ? 'promise_added' : 'note_added', { dueDate, promiseId });
  return { promiseId };
}

export { getPromises, completePromise };

/** { dueToday, overdue } for one client (open promises only). */
export async function promisesDue(clientId, now = new Date()) {
  const today = dayKeyIn(ET, now);
  const open = (await getPromises(clientId)).filter((p) => !p.doneAt && p.dueAt);
  return {
    dueToday: open.filter((p) => String(p.dueAt).slice(0, 10) === today),
    overdue: open.filter((p) => String(p.dueAt).slice(0, 10) < today),
  };
}
