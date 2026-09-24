/**
 * Small helpers shared by the Stage D systems (report, close, Mission
 * Control). Reading other stages' records is done defensively here: values
 * may arrive as objects or JSON strings, and any missing record is treated
 * as "not there", never as a zero (SPEC §1 rule 4).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, defaultOf } from '@/lib/config';
import { alertOwner } from '@/lib/notify';
import { logEvent } from '@/lib/db/events';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read an object setting leaf by leaf, so an override stored on any path
 * (the whole key, a sub-object or one leaf) is seen. Leaf overrides win.
 */
export async function cfgTree(clientId, key) {
  const def = defaultOf(key);
  const whole = await cfg(clientId, key);
  if (!isPlain(def)) return whole;
  const out = {};
  for (const k of Object.keys(def)) {
    const sub = isPlain(def[k]) ? await cfgTree(clientId, `${key}.${k}`) : await cfg(clientId, `${key}.${k}`);
    const same = JSON.stringify(sub) === JSON.stringify(def[k]);
    out[k] = same && isPlain(whole) && k in whole ? whole[k] : sub;
  }
  return out;
}

export function parseRec(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

async function hashRecords(key) {
  let raw;
  try { raw = (await kv.hgetall(key)) || {}; } catch { raw = {}; }
  return Object.entries(raw).map(([id, v]) => { const r = parseRec(v); return r ? { id, ...r } : null; }).filter(Boolean);
}

export const getReplies = (clientId) => hashRecords(K.replies(clientId));
export const getBookings = (clientId) => hashRecords(K.bookings(clientId));

export async function getPaceLog(clientId) {
  try {
    const rows = (await kv.lrange(K.paceLogRead(clientId), 0, 199)) || [];
    return rows.map(parseRec).filter(Boolean).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  } catch { return []; }
}

export async function patchTrial(clientId, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (Object.keys(clean).length) await kv.hset(K.trial(clientId), clean);
}

/**
 * A "to set" config value (SPEC §12). Missing → config_missing alert (once a
 * day per key) and null, so the caller holds instead of inventing.
 */
export async function requireSetting(clientId, key, why) {
  const v = await cfg(clientId, key);
  if (v === null || v === undefined || v === '') {
    await alertOwner('config_missing', {
      clientId,
      scope: `cfg:${key}`,
      vars: { key },
      body: `${why} is waiting on the setting ${key}. Fill it in at Mission Control → Config.`,
      did: 'Held the message; it goes out on the next run after the setting is filled.',
    });
    await logEvent(clientId, 'config', 'setting_missing', { key, why });
    return null;
  }
  return v;
}

export const ownerName = (clientId, why = 'A client email') => requireSetting(clientId, 'OWNER.signerName', why);

export function pct(n, d, digits = 1) {
  const a = Number(n);
  const b = Number(d);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 'n/a';
  return `${((a / b) * 100).toFixed(digits)}%`;
}

export function money(n) {
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'YYYY-MM-DD' → 'Mon 5 Oct'. */
export function fmtDay(dayKey) {
  if (!dayKey) return '';
  const d = new Date(`${String(dayKey).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(dayKey);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export const PLAN_NAMES = { starter: 'Starter', growth: 'Growth', scale: 'Scale' };

export function csv(rows, columns) {
  const q = (v) => {
    const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => q(r[c])).join(','))].join('\n');
}

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const wordCount = (text) => String(text || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

/**
 * Trial ledger (KPIs, SPEC §10.2 Monday digest): one aggregate row per trial,
 * no personal data, kept after deletion.
 */
export async function recordLedger(clientId, patch) {
  if (clientId === 'aviance') return;
  try {
    const cur = parseRec(await kv.hget(K.trialLedger(), clientId)) || {};
    await kv.hset(K.trialLedger(), { [clientId]: { ...cur, ...patch, updatedAt: new Date().toISOString() } });
  } catch (err) {
    await logEvent(clientId, 'ledger', 'ledger_write_failed', { error: err.message });
  }
}

export async function getLedger() {
  try {
    const raw = (await kv.hgetall(K.trialLedger())) || {};
    return Object.entries(raw).map(([id, v]) => ({ id, ...(parseRec(v) || {}) }));
  } catch { return []; }
}

export async function markReportRendered(clientId, name) {
  try { await kv.sadd(K.reports(clientId), name); } catch {}
}
