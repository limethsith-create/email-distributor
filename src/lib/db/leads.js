/**
 * Per-client leads (SPEC §3). Leads live in client:{id}:leads (email → JSON)
 * with a status index in client:{id}:leads:index:{status} for fast lookups.
 * Statuses used by the index: unsent, in_sequence, replied, bounced,
 * suppressed, notnow, done.
 *
 * suppression:global is the one cross-client set: a STOP anywhere is a STOP
 * everywhere. Every insert and every send must pass `isBlocked`.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';

export const INDEX_STATUSES = ['unsent', 'in_sequence', 'replied', 'bounced', 'suppressed', 'notnow', 'done'];
const norm = (e) => String(e || '').trim().toLowerCase();
export const hostOf = (emailOrUrl) => {
  const s = norm(emailOrUrl);
  if (s.includes('@')) return s.split('@')[1];
  return s.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
};

export async function getLead(clientId, email) {
  const v = await kv.hget(K.leads(assertClientId(clientId)), norm(email));
  return v && typeof v === 'object' ? v : null;
}

export async function getLeads(clientId) {
  const map = (await kv.hgetall(K.leads(assertClientId(clientId)))) || {};
  return Object.values(map).filter((l) => l && typeof l === 'object');
}

export async function getLeadsByStatus(clientId, status, limit = 500) {
  const emails = ((await kv.smembers(K.leadIndex(clientId, status))) || []).slice(0, limit);
  if (!emails.length) return [];
  const res = await kv.hmget(K.leads(clientId), ...emails);
  return emails.map((e) => (res && res[e]) || null).filter(Boolean);
}

export async function countByStatus(clientId) {
  const p = kv.pipeline();
  for (const s of INDEX_STATUSES) p.scard(K.leadIndex(clientId, s));
  const r = await p.exec();
  return Object.fromEntries(INDEX_STATUSES.map((s, i) => [s, Number(r[i]) || 0]));
}

/** Write a lead and keep its index membership in step with `lead.status`. */
export async function saveLead(clientId, lead, previousStatus = null) {
  assertClientId(clientId);
  const email = norm(lead.email);
  const rec = { ...lead, email, clientId, updatedAt: new Date().toISOString() };
  const p = kv.pipeline();
  p.hset(K.leads(clientId), { [email]: rec });
  if (previousStatus && previousStatus !== rec.status) p.srem(K.leadIndex(clientId, previousStatus), email);
  if (rec.status) p.sadd(K.leadIndex(clientId, rec.status), email);
  await p.exec();
  return rec;
}

/** Re-read, patch, write (object or fn(existing) → patch|null). */
export async function patchLead(clientId, email, patch) {
  const existing = await getLead(clientId, email);
  if (!existing) return null;
  const p = typeof patch === 'function' ? patch(existing) : patch;
  if (!p) return existing;
  return saveLead(clientId, { ...existing, ...p }, existing.status);
}

export async function isSuppressed(email) {
  return (await kv.sismember(K.suppression(), norm(email))) === 1;
}

/** Global STOP. Keeps emails only, no names (SPEC §14.6). */
export async function suppress(email, clientId = null, reason = 'stop') {
  await kv.sadd(K.suppression(), norm(email));
  if (clientId) await patchLead(clientId, email, { status: 'suppressed', suppressedAt: new Date().toISOString(), suppressReason: reason });
}

export async function addToBlocklist(clientId, ...items) {
  const vals = items.flat().map((x) => (String(x).includes('@') ? norm(x) : hostOf(x))).filter(Boolean);
  if (vals.length) await kv.sadd(K.blocklist(clientId), ...vals);
  return vals.length;
}

/** Reason string when this address must never be emailed for this client, else null. */
export async function isBlocked(clientId, email) {
  const e = norm(email);
  const p = kv.pipeline();
  p.sismember(K.suppression(), e);
  p.sismember(K.blocklist(clientId), e);
  p.sismember(K.blocklist(clientId), hostOf(e));
  const [sup, em, host] = await p.exec();
  if (sup === 1) return 'suppressed';
  if (em === 1) return 'blocklist:email';
  if (host === 1) return 'blocklist:domain';
  return null;
}

/**
 * Insert new leads (status unsent). Skips duplicates, suppressed and
 * blocklisted addresses. Returns { added, skipped: {reason: n} }.
 */
export async function insertLeads(clientId, leads) {
  const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  let added = 0;
  const existing = (await kv.hgetall(K.leads(clientId))) || {};
  for (const raw of leads) {
    const email = norm(raw.email);
    if (!email.includes('@')) { bump('invalid'); continue; }
    if (existing[email]) { bump('duplicate'); continue; }
    const blocked = await isBlocked(clientId, email);
    if (blocked) { bump(blocked); continue; }
    const rec = await saveLead(clientId, { ...raw, email, status: 'unsent', createdAt: new Date().toISOString() });
    existing[email] = rec;
    added++;
  }
  return { added, skipped };
}
