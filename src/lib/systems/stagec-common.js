/**
 * Shared plumbing for the Stage C run systems (SPEC §8): injectable network
 * pieces (so tests never touch SMTP / IMAP / DNS), the config word lists,
 * time-zone and business-hour arithmetic, and the small per-client run-state
 * hash (client:{id}:sendstate).
 *
 * Nothing here sends mail or changes a lead by itself.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, isUsHoliday } from '@/lib/config';
import { partsIn, ET, addDays, isWeekday } from '@/lib/time';

// ─── Injectable network pieces ───────────────────────────────────────────────

/**
 * Every outside effect Stage C has goes through `deps`, so a test can swap
 * SMTP, IMAP, DNS and the Notifier for stubs with `setDeps({...})`.
 * Defaults are loaded lazily (dynamic import) to keep this module light.
 */
export const deps = {
  async sendEmail(account, opts) { const m = await import('@/lib/mailer'); return m.sendEmail(account, opts); },
  async notifyClient(clientId, key, vars, opts) { const m = await import('@/lib/notify'); return m.notifyClient(clientId, key, vars, opts); },
  async alertOwner(key, opts) { const m = await import('@/lib/notify'); return m.alertOwner(key, opts); },
  async verifyEmail(email) { const m = await import('@/lib/email-verify'); return m.verifyEmail(email); },
  async scanMailbox(account, opts) { const m = await import('@/lib/systems/imap-scan'); return m.scanMailbox(account, opts); },
};
const DEFAULT_DEPS = { ...deps };

export function setDeps(overrides = {}) { Object.assign(deps, overrides); }
export function resetDeps() { Object.assign(deps, DEFAULT_DEPS); cfgCache.clear(); }

// ─── Settings with a short memo ──────────────────────────────────────────────

const cfgCache = new Map();
const CFG_TTL_MS = 60_000;
/**
 * cfg() with a 60-second in-process memo. Stage C jobs run every minute and
 * read the same thresholds many times per tick; each uncached read is up to
 * two Redis commands (SPEC §13 free-tier budget). An override edited in
 * Mission Control takes effect within a minute.
 */
export async function ccfg(clientId, key) {
  const k = `${clientId || ''}|${key}`;
  const hit = cfgCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await cfg(clientId, key);
  cfgCache.set(k, { v, exp: Date.now() + CFG_TTL_MS });
  return v;
}

/** Ask for a bounce scan (flag on the client hash, which the tick already loads). */
export async function requestBounceScan(clientId, at = new Date().toISOString()) {
  await kv.hset(K.client(clientId), { bounceScanWantedAt: at });
}

/** Owner alert that never throws (an alert failing must not break the job that raised it). */
export async function alert(key, opts) {
  try { return await deps.alertOwner(key, opts); } catch (err) { console.error('[stage-c] alert failed', key, err?.message); return { sent: false, error: err?.message }; }
}

// ─── Which clients Stage C serves ────────────────────────────────────────────

/** Trial clients only: the aviance client keeps its legacy engine; _helper is not a client. */
export const isTrialClient = (id) => Boolean(id) && id !== 'aviance' && id !== '_helper';

// ─── Config word lists (config/*.txt, SPEC §12) ──────────────────────────────

const LIST_DEFAULTS = {
  angry: ['stop emailing', 'remove me now', 'how did you get', 'spam', 'scam', 'unsubscribe me immediately', 'f***', 'fuck'],
  claims: ['we met', 'as discussed', 'your order'],
  bookingSubjects: ['new event:', 'invitation:', 'updated invitation:', 'new booking', 'booking confirmed', 'booked:', 'confirmed:', 'has scheduled', 'scheduled:', 'new meeting', 'canceled:', 'cancelled:'],
};
const listCache = new Map();

/**
 * One phrase per line from config/{name}.txt ('#' comments). Falls back to
 * the built-in copy of the same list when the file cannot be read (e.g. a
 * serverless bundle that did not ship the folder), so a missing file can
 * never switch a safety rule off.
 */
export function configList(name) {
  if (listCache.has(name)) return listCache.get(name);
  let items = null;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'config', `${name}.txt`), 'utf8');
    items = raw.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
  } catch { items = null; }
  if (!items || !items.length) items = LIST_DEFAULTS[name] || [];
  listCache.set(name, items);
  return items;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

export const lower = (s) => String(s || '').trim().toLowerCase();
export const shortHash = (s, n = 16) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
export const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'on'].includes(lower(v));
export function parseJson(v, fallback = null) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
/** Profile list fields may be arrays, JSON strings or comma/newline lists. */
export function listField(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const j = parseJson(v, null);
  if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
}

/** Niche name for the Learning Library and backup copy (see docs/assumptions/stage-c.md). */
export function nicheOf(client = {}, profile = {}) {
  const raw = profile.niche || client.niche || listField(profile.industry)[0] || 'default';
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
}

// ─── Time zones ──────────────────────────────────────────────────────────────

/** Minutes east of UTC for `tz` at instant `ms`. */
export function tzOffsetMin(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m = {};
  for (const p of f.formatToParts(new Date(ms))) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, (+m.hour) % 24, +m.minute, +m.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Wall-clock time in `tz` → Date (DST-aware). */
export function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, tz = ET) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMin(tz, guess);
  let utc = guess - off * 60000;
  const off2 = tzOffsetMin(tz, utc);
  if (off2 !== off) utc = guess - off2 * 60000;
  return new Date(utc);
}

/** A business day in the US: weekday and not a federal holiday. */
export function isBusinessDayKey(dayKey) {
  const wd = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !isUsHoliday(dayKey);
}

/** Is `lead`'s own clock inside [start, end) on a business day? (SPEC §8.1 window) */
export function leadWindowOpen(lead, now, [start, end] = ['09:00', '17:00']) {
  const p = partsIn(lead?.tz || ET, now);
  if (!isWeekday(p.weekday) || isUsHoliday(p.dayKey)) return false;
  return p.hhmm >= start && p.hhmm < end;
}

/** Next `n` business days strictly after today in `tz` (day keys). */
export function nextBusinessDays(tz, now, n = 2) {
  const out = [];
  let day = partsIn(tz, now).dayKey;
  for (let i = 0; i < 30 && out.length < n; i++) {
    day = addDays(day, 1);
    if (isBusinessDayKey(day)) out.push(day);
  }
  return out;
}

export function formatWhen(date, tz = ET) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}

/**
 * Two named slots (SPEC §8.3): the next business day at 10:00 and the one
 * after at 14:00, in the lead's own time zone.
 */
export function namedSlots(tz, now) {
  const zone = tz || ET;
  const [a, b] = nextBusinessDays(zone, now, 2);
  const mk = (day, h) => { const [y, m, d] = day.split('-').map(Number); return zonedToUtc(y, m, d, h, 0, 0, zone); };
  const s1 = mk(a, 10);
  const s2 = mk(b, 14);
  return [{ at: s1.toISOString(), label: formatWhen(s1, zone) }, { at: s2.toISOString(), label: formatWhen(s2, zone) }];
}

/** Business days (ET) elapsed from `fromMs` to `toMs`: whole business days after the start day. */
export function businessDaysBetween(fromMs, toMs) {
  if (!fromMs || !toMs || toMs <= fromMs) return 0;
  let day = partsIn(ET, new Date(fromMs)).dayKey;
  const end = partsIn(ET, new Date(toMs)).dayKey;
  let n = 0;
  for (let i = 0; i < 400 && day < end; i++) {
    day = addDays(day, 1);
    if (day <= end && isBusinessDayKey(day)) n++;
  }
  return n;
}

/** Hours from `fromMs` to `toMs` that fall on US business days (ET), counted hour by hour. */
export function businessHoursBetween(fromMs, toMs) {
  if (!fromMs || !toMs || toMs <= fromMs) return 0;
  let ms = 0;
  const step = 15 * 60000;
  for (let t = fromMs; t < toMs && ms < 1000 * 3600000; t += step) {
    if (isBusinessDayKey(partsIn(ET, new Date(t)).dayKey)) ms += Math.min(step, toMs - t);
  }
  return ms / 3600000;
}

// ─── Run state (client:{id}:sendstate) ───────────────────────────────────────

export async function getRunState(clientId) {
  try { return (await kv.hgetall(K.sendState(clientId))) || {}; } catch { return {}; }
}
export async function patchRunState(clientId, fields) {
  const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v == null ? '' : v]));
  await kv.hset(K.sendState(clientId), clean);
}

/** SET NX claim for a one-shot action (SPEC §5: claim first, act second). */
export async function claimOnce(scope, clientId, id, ttlSeconds = 400 * 86400) {
  const res = await kv.set(K.jobClaim(scope, clientId, id), Date.now(), { nx: true, ex: ttlSeconds });
  return res === 'OK';
}
export async function releaseOnce(scope, clientId, id) {
  try { await kv.del(K.jobClaim(scope, clientId, id)); } catch {}
}

/**
 * Heartbeat fields the Watchdog's send-stall alarm reads. A send clears the
 * stall marker; "an inbox was due, a lead was ready, and nothing went out"
 * starts it. Unlike the aviance job this never clears the marker on a quiet
 * minute: the field is shared, and clearing it would mask a stall on another
 * client.
 */
export async function heartbeatAfterSend({ sent, dueButUnsent }) {
  const now = new Date().toISOString();
  try {
    if (sent > 0) await kv.hset(K.heartbeat(), { lastSendAt: now, firstDueUnsentAt: '' });
    else if (dueButUnsent) {
      const hb = (await kv.hgetall(K.heartbeat())) || {};
      if (!hb.firstDueUnsentAt) await kv.hset(K.heartbeat(), { firstDueUnsentAt: now });
    }
  } catch {}
}
