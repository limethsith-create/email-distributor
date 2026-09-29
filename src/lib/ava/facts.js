/**
 * The owner's "Business facts" note for Ava (docs/HUB-API.md "Ava (AI
 * helper)") — a short text he writes himself (what Aviance sells, tone,
 * prices he quotes, anything Ava should know). ≤ 4 KB, Redis `ava:facts`
 * (JSON { text, updatedAt, by }). Ava gets the parts that fit each question
 * (lib/ava/kb.js), through the same personal-data net as every tool output.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

export const FACTS_MAX_BYTES = 4096;

const parse = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** → { text, updatedAt, by } (empty text when none). */
export async function getFacts() {
  const v = parse(await kv.get(K.avaFacts()).catch(() => null));
  return { text: typeof v?.text === 'string' ? v.text : '', updatedAt: v?.updatedAt || null, by: v?.by || null };
}

/** Save (the route checks it is the owner). Empty text clears it. Over 4 KB → 400. */
export async function setFacts(text, by = 'owner', now = new Date()) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (Buffer.byteLength(t, 'utf8') > FACTS_MAX_BYTES) { const e = new Error(`Keep it under 4 KB (about 600 words) — this is ${Buffer.byteLength(t, 'utf8')} bytes.`); e.status = 400; throw e; }
  const item = { text: t, updatedAt: now.toISOString(), by: String(by || 'owner').slice(0, 60) };
  await kv.set(K.avaFacts(), JSON.stringify(item));
  return { ok: true, ...item };
}
