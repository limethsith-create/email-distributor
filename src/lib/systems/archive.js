/**
 * Outreach archive (docs/HUB-API.md "Outreach archive"): the owner's own
 * outreach history (the legacy engine: the `leads` hash, sent_log, replies_v3,
 * bounces, the open stores …) saved as ONE JSON object in Redis, so the old
 * process can be cleared and the new one (one email per person) starts clean.
 *
 *   buildOutreachArchive() → { id, createdAt, totals, days, sent, replies, bounces, leads }
 *   saveArchive(archive)   → index entry { id, createdAt, totals, bytes, chunks }
 *   readArchive(id)        → the archive object (null when there is no such archive)
 *   listArchives()         → index entries, newest first
 *   clearOutreach({confirm:'CLEAR'}) → archives first, checks the saved copy, then clears
 *
 * The day-by-day numbers come from the /api/daily-log builder (lib/daily-log.js),
 * read strictly (a failed read throws instead of counting as empty). Lead
 * records are copied field by field from an allow-list: no passwords, tokens
 * or message ids ever go into an archive.
 */

import crypto from 'node:crypto';
import { kv } from '@vercel/kv';
import { K, LEGACY, archiveId } from '@/lib/db/keys';
import { buildDailyLog } from '@/lib/daily-log';
import { getTodayKey, normalizeEmail } from '@/lib/metrics';

/** Largest stored piece of an archive (the JSON string Redis keeps for one chunk). */
export const CHUNK_BYTES = 400 * 1024;
const WRITE_BATCH = 500;
// The capped lists are read whole (sent_log keeps 5 000, open_events 5 000).
const SENT_LOG_ALL = 5000;
const OPEN_EVENTS_ALL = 5000;
const INDEX_MAX = 200;

/** Lead fields worth keeping (business facts and what happened); everything else is left out. */
const LEAD_FIELDS = [
  'email', 'company', 'name', 'first_name', 'last_name', 'title', 'industry', 'city', 'state', 'country', 'website', 'phone',
  'campaign', 'source', 'status', 'createdAt', 'updatedAt',
  'sent_at', 'd3_sent_at', 'd7_sent_at', 'd10_sent_at', 'd7_skipped_at', 'account_used', 'original_subject', 'd7_subject',
  'send_count', 'sequence_day', 'opened_at', 'last_opened_at', 'open_count',
  'replied_at', 'reply_kind', 'reply_intent', 'reply_subject', 'reply_preview', 'reply_text', 'reply_touch', 'reply_account',
  'bounced_at', 'bounce_reason', 'bounce_inbox', 'unsubscribed_at', 'unsubscribe_reason', 'suppressed',
  'expired_at', 'expired_touch', 'completed_at',
];

/** The history keys a clear deletes (company_sent and suppression stay). */
export const HISTORY_KEYS = [
  LEGACY.sentLog, LEGACY.dailySends, LEGACY.replies, LEGACY.bounces, LEGACY.opens, LEGACY.opensFirst,
  LEGACY.opensFirstHuman, LEGACY.openCounts, LEGACY.openEvents, LEGACY.replyEvents, LEGACY.conversations,
  LEGACY.msgIdIndex, LEGACY.stats,
];

const CONTACTED_STATUSES = new Set(['sent', 'sent-d0', 'sent-d3', 'sent-d7', 'sent-d10', 'follow-up-sent', 'sequence_complete', 'sequence_expired', 'replied', 'bounced']);

/** Was this lead ever emailed (or at least tried: a send-time bounce)? */
export function isContacted(lead) {
  if (!lead || typeof lead !== 'object') return false;
  if (lead.sent_at || lead.d3_sent_at || lead.d7_sent_at || lead.d10_sent_at || lead.account_used || lead.original_message_id) return true;
  return CONTACTED_STATUSES.has(String(lead.status || '').trim().toLowerCase());
}

function leadRow(lead) {
  const out = {};
  for (const f of LEAD_FIELDS) {
    let v = f === 'company' ? lead.company || lead.company_name : lead[f];
    if (v === undefined || v === null || v === '') continue;
    if (f === 'email') v = normalizeEmail(v);
    out[f] = v;
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
function newArchiveId(now) {
  const d = new Date(now);
  const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `arc-${day}-${time}-${crypto.randomBytes(3).toString('hex')}`;
}

const byAt = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));

/** Everything the owner's own outreach did, as one JSON object (nothing is changed). */
export async function buildOutreachArchive({ now = new Date() } = {}) {
  const raw = (await kv.hgetall(LEGACY.leads)) || {};
  const all = Object.values(raw).filter((l) => l && typeof l === 'object' && l.email);
  const { days: logDays } = await buildDailyLog({ sentLogMax: SENT_LOG_ALL, openEventsMax: OPEN_EVENTS_ALL, leads: all, strict: true });

  const sent = [];
  const replies = [];
  const bounces = [];
  const openedBy = new Set();
  const days = [];
  for (const d of logDays) {
    for (const s of d.sent) sent.push({ at: s.timestamp || null, to: s.to, company: s.company || '', subject: s.subject || '', touch: s.touch || 'd0', from: s.from || null });
    for (const r of d.replies) replies.push({ at: r.repliedAt || null, from: r.from || r.leadEmail || '', company: r.company || '', subject: r.subject || '', text: r.text || r.snippet || '' });
    for (const b of d.bounces) bounces.push({ at: b.bouncedAt || null, email: b.email, reason: b.reason || 'Unknown', account: b.account || null });
    for (const o of d.opens) if (o.email) openedBy.add(o.email);
    days.push({ date: d.date, sent: d.sent.length, opened: d.opens.length, replies: d.replies.length, bounces: d.bounces.length });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  sent.sort(byAt);
  replies.sort(byAt);
  bounces.sort(byAt);
  const sendDays = days.filter((d) => d.sent > 0).map((d) => d.date);
  const leads = all.filter(isContacted).map(leadRow).sort((a, b) => String(a.sent_at || '').localeCompare(String(b.sent_at || '')));

  return {
    id: newArchiveId(now),
    createdAt: new Date(now).toISOString(),
    totals: {
      sent: sent.length,
      opened: openedBy.size,
      replies: replies.length,
      bounces: bounces.length,
      days: sendDays.length,
      firstDay: sendDays[0] || null,
      lastDay: sendDays[sendDays.length - 1] || null,
    },
    days,
    sent,
    replies,
    bounces,
    leads,
  };
}

/** Split the archive's JSON text into pieces whose stored form ({i, d}) is at most CHUNK_BYTES. */
export function chunkText(text, limit = CHUNK_BYTES) {
  const pieces = [];
  let pos = 0;
  let guess = Math.floor(limit * 0.9);
  while (pos < text.length) {
    let size = Math.min(text.length - pos, guess);
    for (;;) {
      if (size > 1 && /[\uD800-\uDBFF]/.test(text[pos + size - 1] || '') && pos + size < text.length) size -= 1; // never split a character in two
      const stored = Buffer.byteLength(JSON.stringify({ i: pieces.length, d: text.slice(pos, pos + size) }));
      if (stored <= limit) break;
      size = Math.max(1, Math.floor(size * (limit / stored) * 0.97));
    }
    pieces.push(text.slice(pos, pos + size));
    pos += size;
    guess = Math.max(guess, size);
  }
  return pieces;
}

function parseEntry(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** Store an archive in chunks plus an index entry; a failed write removes what it wrote and throws. */
export async function saveArchive(archive) {
  const id = archiveId(archive?.id);
  const text = JSON.stringify(archive);
  const pieces = chunkText(text);
  try {
    for (let i = 0; i < pieces.length; i += 20) {
      await Promise.all(pieces.slice(i, i + 20).map((d, j) => kv.set(K.archiveChunk(id, i + j), { i: i + j, d })));
    }
  } catch (err) {
    await Promise.all(pieces.map((_, i) => kv.del(K.archiveChunk(id, i)).catch(() => {})));
    throw new Error(`could not save the archive: ${err?.message || err}`);
  }
  const entry = { id, createdAt: archive.createdAt, totals: archive.totals, bytes: Buffer.byteLength(text), chunks: pieces.length };
  await kv.lpush(K.archiveIndex(), JSON.stringify(entry));
  await kv.ltrim(K.archiveIndex(), 0, INDEX_MAX - 1);
  return entry;
}

/** Saved archives, newest first: [{ id, createdAt, totals, bytes, chunks, clearedAt? }]. */
export async function listArchives() {
  const rows = (await kv.lrange(K.archiveIndex(), 0, INDEX_MAX - 1)) || [];
  return rows.map(parseEntry).filter((e) => e && e.id);
}

/** The whole archive, reassembled (null when there is no such archive). */
export async function readArchive(id) {
  archiveId(id);
  const entry = (await listArchives()).find((e) => e.id === id);
  if (!entry) return null;
  const n = Number(entry.chunks) || 0;
  const rows = await Promise.all(Array.from({ length: n }, (_, i) => kv.get(K.archiveChunk(id, i))));
  const parts = rows.map((r, i) => {
    const c = parseEntry(r);
    if (!c || Number(c.i) !== i || typeof c.d !== 'string') throw new Error(`archive ${id} is missing piece ${i + 1} of ${n}`);
    return c.d;
  });
  return JSON.parse(parts.join(''));
}

/** The saved copy says the same as what was built (lengths and totals). */
function sameCounts(a, b) {
  if (!a || !b) return false;
  for (const k of ['days', 'sent', 'replies', 'bounces', 'leads']) if ((a[k] || []).length !== (b[k] || []).length) return false;
  return JSON.stringify(a.totals) === JSON.stringify(b.totals) && a.id === b.id;
}

export class ArchiveError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function markCleared(id, patch) {
  const rows = (await kv.lrange(K.archiveIndex(), 0, INDEX_MAX - 1)) || [];
  const i = rows.findIndex((r) => parseEntry(r)?.id === id);
  if (i >= 0) await kv.lset(K.archiveIndex(), i, JSON.stringify({ ...parseEntry(rows[i]), ...patch }));
}

/**
 * Archive, then clear the owner's own outreach history. Nothing is deleted
 * unless the archive was saved AND read back with the same counts. Holds the
 * auto-send lock throughout, so no email goes out between the snapshot and the
 * clear. → { ok, archiveId, cleared: { leads, suppressed, keys } }
 */
export async function clearOutreach({ confirm, now = new Date() } = {}) {
  if (confirm !== 'CLEAR') throw new ArchiveError('To clear, send confirm: "CLEAR". Nothing was changed.', 400);
  const lockToken = `archive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const got = await kv.set(LEGACY.sendLock, lockToken, { nx: true, ex: 600 });
  if (got !== 'OK') throw new ArchiveError('An email is being sent right now. Try again in a minute. Nothing was changed.', 409);
  try {
    // 1) Archive first, and prove the saved copy reads back whole.
    const archive = await buildOutreachArchive({ now });
    const entry = await saveArchive(archive);
    const back = await readArchive(entry.id);
    if (!sameCounts(archive, back)) throw new ArchiveError('The saved archive did not read back the same. Nothing was cleared.', 500);

    // 2) Never email these people again: every contacted lead and every address in the send history.
    const emails = new Set();
    for (const l of archive.leads) if (l.email) emails.add(normalizeEmail(l.email));
    for (const s of archive.sent) if (s.to) emails.add(normalizeEmail(s.to));
    for (const b of archive.bounces) if (b.email) emails.add(normalizeEmail(b.email));
    emails.delete('');
    const list = [...emails];
    const reason = `archived_outreach:${entry.id}`;
    for (let i = 0; i < list.length; i += WRITE_BATCH) {
      const part = list.slice(i, i + WRITE_BATCH);
      await kv.sadd(LEGACY.suppression, ...part);
      await kv.hset(K.archiveSuppressed(), Object.fromEntries(part.map((e) => [e, reason])));
    }

    // 3) Remove the contacted leads (the uncontacted ones stay).
    const leadKeys = archive.leads.map((l) => l.email).filter(Boolean);
    let removed = 0;
    for (let i = 0; i < leadKeys.length; i += WRITE_BATCH) removed += Number(await kv.hdel(LEGACY.leads, ...leadKeys.slice(i, i + WRITE_BATCH))) || 0;

    // 4) The history keys. Today's per-inbox send counts are put back so the daily cap stays honest.
    const today = getTodayKey(now);
    const sends = (await kv.hgetall(LEGACY.dailySends).catch(() => null)) || {};
    const keepToday = Object.fromEntries(Object.entries(sends).filter(([f]) => f.includes(`:${today}`)));
    const keys = [];
    for (const key of HISTORY_KEYS) if (Number(await kv.del(key)) > 0) keys.push(key);
    if (Object.keys(keepToday).length) await kv.hset(LEGACY.dailySends, keepToday);

    // 5) The aviance client's own per-client counters (client:aviance:counters:*), if it has any.
    let cursor = '0';
    const counterKeys = [];
    do {
      const [next, batch] = await kv.scan(cursor, { match: 'client:aviance:counters:*', count: 500 });
      cursor = String(next);
      counterKeys.push(...(batch || []));
    } while (cursor !== '0');
    for (const key of counterKeys) if (Number(await kv.del(key)) > 0) keys.push(key);

    const cleared = { leads: removed, suppressed: list.length, keys };
    await markCleared(entry.id, { clearedAt: new Date().toISOString(), cleared }).catch(() => {});
    return { ok: true, archiveId: entry.id, totals: archive.totals, cleared };
  } finally {
    try { if ((await kv.get(LEGACY.sendLock)) === lockToken) await kv.del(LEGACY.sendLock); } catch {}
  }
}
