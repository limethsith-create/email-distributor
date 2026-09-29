/**
 * Ava's brains (docs/HUB-API.md "Ava (AI helper)") — one Ava over several
 * AI services, all OpenAI-compatible chat completions, all chosen because
 * their terms say API inputs are NOT used for training:
 *
 *   cerebras   — free tier; inputs/outputs not retained or trained on.
 *   groq       — free tier; Groq may not train on inputs/outputs.
 *   gemini     — PAID key only (free Gemini keys may be used for training;
 *                the Keys card says so). OpenAI-compatible endpoint.
 *   openrouter — paid credits; every request carries
 *                provider {data_collection:'deny', zdr:true}, so OpenRouter
 *                only routes to providers that neither train nor keep data.
 * (Mistral's free "Experiment" plan trains by default: not used.)
 *
 * Keys come from the keys store (lib/secrets.js: env wins, else Settings ›
 * Keys). Never returned by any answer.
 *
 * The router: the fastest ready brain first for a short request, the
 * strongest first for a longer one. A 429 / 5xx / timeout / network error
 * falls through to the next brain (each call ≤ AVA_TIMING.callMs, the whole
 * question ≤ AVA_TIMING.totalMs). A 429 cools that brain down for a while
 * (in memory, per server instance; `retry-after` is honoured up to 5 min).
 * A brain that refuses tools (400 about tools) is switched to the JSON
 * fallback for the rest of this instance's life.
 */

import { secretOf, secretsSnapshot } from '@/lib/secrets';

/** Seams for tests: the network and the clock. */
export const AVA_IO = {
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
};
export const AVA_TIMING = { callMs: 10_000, totalMs: 20_000, cooldownMs: 60_000, badKeyCooldownMs: 10 * 60_000, maxCooldownMs: 5 * 60_000 };

const env = (name, dflt) => String(process.env[name] || '').trim() || dflt;

/** speed: 1 = fastest. strength: 1 = strongest. */
export function brainList() {
  return [
    { id: 'cerebras', name: 'Cerebras', key: 'CEREBRAS_API_KEY', url: 'https://api.cerebras.ai/v1/chat/completions', model: env('AVA_CEREBRAS_MODEL', 'gpt-oss-120b'), speed: 1, strength: 2 },
    { id: 'groq', name: 'Groq', key: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', model: env('AVA_GROQ_MODEL', 'llama-3.3-70b-versatile'), speed: 2, strength: 4 },
    { id: 'gemini', name: 'Gemini (paid key)', key: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: env('AVA_GEMINI_MODEL', 'gemini-2.5-flash'), speed: 3, strength: 1 },
    { id: 'openrouter', name: 'OpenRouter (no-training providers only)', key: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions', model: env('AVA_OPENROUTER_MODEL', 'openai/gpt-oss-120b'), speed: 4, strength: 3,
      extra: { provider: { data_collection: 'deny', zdr: true } }, headers: { 'X-Title': 'Aviance Ava' } },
  ];
}

// ─── in-memory state (per server instance) ──────────────────────────────────

const state = new Map();   // id → { lastError, lastErrorAt, lastOkAt, coolUntil, noTools }
const st = (id) => { if (!state.has(id)) state.set(id, { lastError: null, lastErrorAt: null, lastOkAt: null, coolUntil: 0, noTools: false }); return state.get(id); };
export const __resetBrains = () => state.clear();
export const brainState = (id) => ({ ...st(id) });

const cooling = (id) => st(id).coolUntil > AVA_IO.now();

/** The brains with a key, each with its key (server-side only) → [{ ...brain, apiKey }]. */
export async function keyedBrains() {
  const snap = await secretsSnapshot();
  const out = [];
  for (const b of brainList()) {
    const apiKey = await secretOf(b.key, snap);
    if (apiKey) out.push({ ...b, apiKey });
  }
  return out;
}

/** GET /api/mc/ava/status → brains: [{ id, name, ready, model, lastError, lastOkAt }] (never a key). */
export async function brainsStatus() {
  const keyed = new Set((await keyedBrains()).map((b) => b.id));
  return brainList().map((b) => {
    const s = st(b.id);
    const has = keyed.has(b.id);
    const cool = cooling(b.id);
    return {
      id: b.id, name: b.name, ready: has && !cool, model: b.model,
      lastError: !has ? `No key yet — add ${b.key} in Settings › Keys` : cool ? `${s.lastError || 'Resting after too many questions'} (resting until ${new Date(s.coolUntil).toISOString()})` : s.lastError,
      lastOkAt: s.lastOkAt,
    };
  });
}

/** Short request → fastest first; longer → strongest first. Cooling brains go last (tried only if nothing else is left). */
export function orderBrains(brains, { short }) {
  const rank = short ? (b) => b.speed : (b) => b.strength;
  const sorted = brains.slice().sort((a, b) => rank(a) - rank(b));
  return [...sorted.filter((b) => !cooling(b.id)), ...sorted.filter((b) => cooling(b.id))];
}

/** A request is "short" when the newest user message and the whole talk are small. */
export function isShort(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const total = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  return String(last?.content || '').length <= 160 && total <= 1500;
}

// ─── one call ────────────────────────────────────────────────────────────────

/**
 * One chat completion. `body` is the OpenAI-shaped request without `model`.
 * → { ok, message, ms } | { ok: false, status, error, retryable, toolsRefused, ms }.
 */
export async function callBrain(brain, body, { timeoutMs = AVA_TIMING.callMs } = {}) {
  const t0 = AVA_IO.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1, timeoutMs));
  let res;
  try {
    res = await AVA_IO.fetch(brain.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${brain.apiKey}`, ...(brain.headers || {}) },
      body: JSON.stringify({ model: brain.model, ...body, ...(brain.extra || {}) }),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ctl.signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return { ok: false, status: 0, error: timedOut ? 'timed out' : 'could not be reached', retryable: true, ms: AVA_IO.now() - t0 };
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  clearTimeout(timer);
  const ms = AVA_IO.now() - t0;
  if (res.ok) {
    const message = json?.choices?.[0]?.message;
    if (!message) return { ok: false, status: res.status, error: 'answered with nothing', retryable: true, ms };
    return { ok: true, message, ms };
  }
  const raw = String(json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || '').slice(0, 200);
  const toolsRefused = res.status === 400 && /tool|function/i.test(raw);
  const retryAfter = Number(res.headers?.get?.('retry-after'));
  return {
    ok: false, status: res.status, retryable: res.status === 429 || res.status >= 500 || res.status === 408,
    toolsRefused, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    error: res.status === 429 ? 'too many questions right now' : res.status === 401 || res.status === 403 ? 'the key was refused' : `said ${res.status}${raw ? `: ${raw}` : ''}`,
    ms,
  };
}

function noteFail(brain, r) {
  const s = st(brain.id);
  s.lastError = `${brain.name} ${r.error}`.slice(0, 240);
  s.lastErrorAt = new Date(AVA_IO.now()).toISOString();
  if (r.status === 429) s.coolUntil = AVA_IO.now() + Math.min(r.retryAfterMs || AVA_TIMING.cooldownMs, AVA_TIMING.maxCooldownMs);
  if (r.status === 401 || r.status === 403) s.coolUntil = AVA_IO.now() + AVA_TIMING.badKeyCooldownMs;
}
function noteOk(brain) {
  const s = st(brain.id);
  s.lastOkAt = new Date(AVA_IO.now()).toISOString();
  s.lastError = null;
  s.coolUntil = 0;
}

export const usesTools = (brain) => !st(brain.id).noTools;

/**
 * Ask the brains in `order` until one answers. `build(brain)` makes the body
 * (it depends on whether that brain takes tools). `deadline` = epoch ms for
 * the whole question. Every attempt goes into `tried`.
 * → { brain, message } | null (nothing answered in time).
 */
export async function ask(order, build, { deadline, tried }) {
  for (const brain of order) {
    let again = true;
    while (again) {
      again = false;
      const left = deadline - AVA_IO.now();
      if (left <= 250) { tried.push({ brain: brain.id, ok: false, ms: 0, error: 'no time left' }); return null; }
      const r = await callBrain(brain, build(brain), { timeoutMs: Math.min(AVA_TIMING.callMs, left) });
      if (r.ok) {
        noteOk(brain);
        tried.push({ brain: brain.id, ok: true, ms: r.ms, error: null });
        return { brain, message: r.message };
      }
      tried.push({ brain: brain.id, ok: false, ms: r.ms, error: r.error });
      if (r.toolsRefused && !st(brain.id).noTools) { st(brain.id).noTools = true; again = true; continue; }
      noteFail(brain, r);
    }
  }
  return null;
}
