/**
 * Black box log (SPEC §10.5). Every system writes {at, system, event, detail}
 * to client:{id}:events (capped at 5,000) or events:global. Details are
 * scrubbed: no secrets, and any long text is cut to a 200-char snippet.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

const CAP = 5000;
const SECRET_RE = /pass(word)?|secret|token|app_?password|apikey|api_key|authorization/i;

function scrub(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 197)}...` : value;
  if (typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_RE.test(k) ? '[redacted]' : scrub(v, depth + 1);
  return out;
}

/** Append one event. Never throws (logging must not break a job). */
export async function logEvent(clientId, system, event, detail = null) {
  const entry = { at: new Date().toISOString(), system, event, detail: scrub(detail) };
  const key = clientId ? K.events(clientId) : K.eventsGlobal();
  try {
    const p = kv.pipeline();
    p.lpush(key, entry);
    p.ltrim(key, 0, CAP - 1);
    await p.exec();
  } catch (err) {
    console.error('[events] write failed', key, event, err?.message);
  }
  return entry;
}

export async function getEvents(clientId, limit = 200) {
  try {
    return (await kv.lrange(clientId ? K.events(clientId) : K.eventsGlobal(), 0, limit - 1)) || [];
  } catch {
    return [];
  }
}
