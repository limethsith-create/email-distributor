/**
 * Adapters to systems other stages own (built in parallel). Each one loads
 * the real module lazily when it exists and otherwise falls back to a small
 * local rule set, so Stage C works before and after the branches merge.
 *
 *  - checkCopy        → Stage B `checkEmail(rendered, profile)` in systems/copycheck.js
 *  - isWarmup         → Stage B `isWarmupMessage(headers)` in systems/warmup.js
 *  - optionalSystem   → any other stage's module (pricescout, leadfinder, …)
 *
 * The import path is a template string on purpose: the bundler then builds a
 * context over src/lib/systems/ instead of failing the build when a sibling
 * module is not there yet.
 */

const cache = new Map();

/** Load src/lib/systems/{name}.js, or null when it does not exist (cached). */
export async function optionalSystem(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  if (cache.has(name)) return cache.get(name);
  let mod = null;
  try { mod = await import(`@/lib/systems/${name}`); } catch { mod = null; }
  cache.set(name, mod);
  return mod;
}

/** Test hook: pretend a module is (or is not) present. */
export function __setOptionalSystem(name, mod) { cache.set(name, mod); }
export function __clearOptionalSystems() { cache.clear(); }

const norm = (s) => String(s || '').replace(/[\s,]+/g, ' ').trim().toLowerCase();

/**
 * Minimal local Copy Checker: postal address present, opt-out line present,
 * no unfilled {slot}, no [PLACEHOLDER. Returns { ok, failures: [rule] }.
 */
export function localCopyCheck(rendered = {}, profile = {}) {
  const text = `${rendered.subject || ''}\n${rendered.text || rendered.body || ''}`;
  const failures = [];
  if (!profile.postalAddress || !norm(text).includes(norm(profile.postalAddress))) failures.push('postal_address_missing');
  if (!/reply\s+["“']?stop\b/i.test(text)) failures.push('optout_line_missing');
  if (/\{[A-Za-z][A-Za-z0-9_.]*\}/.test(text)) failures.push('unfilled_slot');
  if (/\[PLACEHOLDER/i.test(text)) failures.push('placeholder');
  return { ok: failures.length === 0, failures, source: 'local' };
}

/** Normalise whatever Stage B's checker returns into { ok, failures, source }. */
function normalise(res) {
  if (res === true) return { ok: true, failures: [], source: 'copycheck' };
  if (res === false) return { ok: false, failures: ['copycheck_failed'], source: 'copycheck' };
  if (!res || typeof res !== 'object') return null;
  const ok = res.ok ?? res.pass ?? res.passed ?? (Array.isArray(res.failures) ? res.failures.length === 0 : undefined);
  if (typeof ok !== 'boolean') return null;
  const raw = res.failures || res.failed || res.errors || (res.rule ? [res.rule] : []);
  const failures = (Array.isArray(raw) ? raw : [raw]).map((f) => (typeof f === 'string' ? f : f?.rule || f?.name || JSON.stringify(f)));
  return { ok, failures: ok ? [] : (failures.length ? failures : ['copycheck_failed']), source: 'copycheck' };
}

/**
 * Copy Checker for one rendered email. `rendered` = { subject, body, text,
 * touch, firstTouch }. Uses Stage B's checkEmail when present; if it is
 * missing or throws, the local rules decide (never "pass because unknown").
 */
export async function checkCopy(rendered, profile) {
  const mod = await optionalSystem('copycheck');
  if (mod && typeof mod.checkEmail === 'function') {
    try {
      const out = normalise(await mod.checkEmail(rendered, profile));
      if (out) return out;
    } catch (err) {
      const local = localCopyCheck(rendered, profile);
      return { ...local, note: `copycheck threw: ${err?.message}` };
    }
  }
  return localCopyCheck(rendered, profile);
}

/** Warm-up marker check (SPEC §7.1 isolation). Header names are lower-case. */
export async function isWarmup(headers = {}) {
  const mod = await optionalSystem('warmup');
  if (mod && typeof mod.isWarmupMessage === 'function') {
    try { if (mod.isWarmupMessage(headers)) return true; } catch {}
  }
  return Boolean(headers['x-aviance-warm'] || headers['X-Aviance-Warm']);
}
