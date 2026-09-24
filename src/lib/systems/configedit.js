/**
 * /mc/config editing (SPEC §10.1, §12). Every top-level setting in
 * config.js DEFAULTS is editable. A new value must have the same shape as
 * the default (same keys, same types; "to set" nulls accept text or a
 * number). Saving writes an override for the key AND every nested path
 * under it, so a system reading `PLANS` and one reading `PLANS.starter.price`
 * see the same value. Paths equal to their default are cleared instead.
 */

import { DEFAULTS, defaultOf, setOverride, globalOverrides } from '@/lib/config';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Error text, or null when `val` fits the shape of `def`. */
export function validateAgainst(def, val, path = '') {
  const at = path || 'value';
  if (def === null) {
    if (val === null || typeof val === 'string' || typeof val === 'number') return null;
    return `${at}: expected text, a number or null`;
  }
  if (typeof def === 'number') {
    if (typeof val !== 'number' || !Number.isFinite(val)) return `${at}: expected a number`;
    if (val < 0) return `${at}: must not be negative`;
    return null;
  }
  if (typeof def === 'boolean') return typeof val === 'boolean' ? null : `${at}: expected true or false`;
  if (typeof def === 'string') {
    if (typeof val !== 'string' || !val.trim()) return `${at}: expected text`;
    if (HHMM_RE.test(def) && !HHMM_RE.test(val)) return `${at}: expected HH:MM`;
    if (DATE_RE.test(def) && !DATE_RE.test(val)) return `${at}: expected YYYY-MM-DD`;
    return null;
  }
  if (Array.isArray(def)) {
    if (!Array.isArray(val)) return `${at}: expected a list`;
    if (def.length) {
      for (let i = 0; i < val.length; i++) {
        const e = validateAgainst(def[0], val[i], `${at}[${i}]`);
        if (e) {
          // Numbers in a list may be negative (e.g. APPROVAL.reminderDays).
          if (typeof def[0] === 'number' && typeof val[i] === 'number' && Number.isFinite(val[i])) continue;
          return e;
        }
      }
    }
    return null;
  }
  if (isObj(def)) {
    if (!isObj(val)) return `${at}: expected an object with keys ${Object.keys(def).join(', ')}`;
    const missing = Object.keys(def).filter((k) => !(k in val));
    const extra = Object.keys(val).filter((k) => !(k in def));
    if (missing.length) return `${at}: missing ${missing.join(', ')}`;
    if (extra.length) return `${at}: unknown ${extra.join(', ')}`;
    for (const k of Object.keys(def)) {
      // A null sub-default (e.g. PLAN_SHOPPING.growth) accepts an object too.
      if (def[k] === null && isObj(val[k])) continue;
      const e = validateAgainst(def[k], val[k], path ? `${path}.${k}` : k);
      if (e) return e;
    }
    return null;
  }
  return `${at}: unsupported setting type`;
}

function paths(key, value) {
  const out = [[key, value]];
  if (isObj(value)) for (const [k, v] of Object.entries(value)) if (defaultOf(`${key}.${k}`) !== undefined) out.push(...paths(`${key}.${k}`, v));
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function saveSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
  const err = validateAgainst(DEFAULTS[key], value, key);
  if (err) throw new Error(err);
  let written = 0;
  for (const [p, v] of paths(key, value)) {
    if (same(v, defaultOf(p))) await setOverride(null, p, undefined);
    else { await setOverride(null, p, v); written++; }
  }
  return { key, written };
}

export async function resetSetting(key) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
  const o = await globalOverrides();
  const keys = Object.keys(o).filter((k) => k === key || k.startsWith(`${key}.`));
  for (const k of keys) await setOverride(null, k, undefined);
  return { key, cleared: keys.length };
}

/** Effective global value of a top-level key (override tree merged over the default). */
function effective(key, overrides) {
  const merge = (p, def) => {
    if (p in overrides) return overrides[p];
    if (isObj(def)) return Object.fromEntries(Object.entries(def).map(([k, v]) => [k, merge(`${p}.${k}`, v)]));
    return def;
  };
  return merge(key, DEFAULTS[key]);
}

export async function listSettings() {
  const o = await globalOverrides();
  return Object.keys(DEFAULTS).map((key) => {
    const value = effective(key, o);
    return { key, default: DEFAULTS[key], value, overridden: !same(value, DEFAULTS[key]), toSet: JSON.stringify(value).includes('null') };
  });
}
