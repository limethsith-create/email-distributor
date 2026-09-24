/**
 * Template filling (SPEC §11). `{name}` slots are filled from `vars`; a slot
 * with no value is an error, never a blank — callers turn that into a
 * report_blocked-style alert instead of sending a hole.
 */

export class TemplateError extends Error {
  constructor(name, missing) {
    super(`template ${name}: missing ${missing.join(', ')}`);
    this.template = name;
    this.missing = missing;
  }
}

const SLOT_RE = /\{([A-Za-z][A-Za-z0-9_.]*)\}/g;

export function slotsOf(text) {
  return [...new Set([...String(text).matchAll(SLOT_RE)].map((m) => m[1]))];
}

function lookup(vars, path) {
  let cur = vars;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function fill(name, text, vars = {}) {
  const missing = [];
  const out = String(text).replace(SLOT_RE, (whole, key) => {
    const v = lookup(vars, key);
    if (v === undefined || v === null || v === '') { missing.push(key); return whole; }
    return String(v);
  });
  if (missing.length) throw new TemplateError(name, [...new Set(missing)]);
  return out;
}
