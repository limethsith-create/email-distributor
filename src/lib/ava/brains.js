/**
 * Ava's brains (docs/HUB-API.md "Ava (AI helper)") — one Ava over several
 * AI services, all OpenAI-compatible chat completions, all chosen because
 * their terms say API inputs are NOT used for training:
 *
 *   groq       — free; Groq does not train on or (by default) keep API data.
 *                The main brain: a fast model and a stronger one.
 *   cloudflare — Workers AI, free daily allowance; Cloudflare does not use
 *                customer content to train. Needs the account id + a token.
 *   mistral    — La Plateforme's free "Experiment" plan, ONLY after the owner
 *                switches off "Anonymous improvement data" (Admin › Privacy):
 *                the free plan trains on API data by default. Kept 30 days for
 *                abuse checks. Tool calling.
 *   ollama     — Ollama Cloud: keeps no prompts or answers; a small free
 *                allowance (1 question at a time). gpt-oss:120b first.
 *   cerebras   — no longer free (a card and credit); not retained or trained on.
 *   gemini     — PAID key only (free Gemini keys may be used for training;
 *                the Keys card says so). OpenAI-compatible endpoint.
 *   openrouter — paid credits; every request carries
 *                provider {data_collection:'deny', zdr:true}, so OpenRouter
 *                only routes to providers that neither train nor keep data.
 *
 * Models are picked live from each service's model list (lib/ava/models.js),
 * never hard-coded to one id that can be switched off.
 *
 * Keys come from the keys store (lib/secrets.js: env wins, else Settings ›
 * Keys). Never returned by any answer.
 *
 * The router: a list of (brain, model) "slots" — Groq first (its quick model
 * for a short or spoken question, its fast model, or its strong model for a
 * smart question, then its other models: each has its own rate limit), then
 * Cloudflare, Mistral, Ollama, then the paid ones. A 429 / 5xx /
 * timeout / network error falls through to the next slot (each call ≤
 * AVA_TIMING.callMs, the whole question ≤ AVA_TIMING.totalMs). A 429 cools
 * that model down (per server instance; `retry-after` honoured up to 5 min);
 * a refused key cools the whole brain for 10 min. A model the service says is
 * gone is dropped from the list and the next one is tried at once. A brain
 * that refuses tools (400 about tools) is switched to the JSON fallback.
 */

import { secretOf, secretsSnapshot } from '@/lib/secrets';
import { modelsFor, dropModel, cachedModels, modelGone } from '@/lib/ava/models';

/** Seams for tests: the network and the clock. */
export const AVA_IO = {
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
};
export const AVA_TIMING = { callMs: 8_000, totalMs: 22_000, cooldownMs: 60_000, badKeyCooldownMs: 10 * 60_000, maxCooldownMs: 5 * 60_000 };

const CF = 'https://api.cloudflare.com/client/v4/accounts';

/** The brains in the order they are tried. `keys` = the env names a brain needs (all of them). */
export function brainList() {
  return [
    { id: 'groq', name: 'Groq', keys: ['GROQ_API_KEY'], url: 'https://api.groq.com/openai/v1/chat/completions', modelsUrl: 'https://api.groq.com/openai/v1/models', free: true },
    { id: 'cloudflare', name: 'Cloudflare Workers AI', keys: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'], free: true,
      url: (v) => `${CF}/${encodeURIComponent(v.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`,
      modelsUrl: (v) => `${CF}/${encodeURIComponent(v.CLOUDFLARE_ACCOUNT_ID)}/ai/models/search?task=Text%20Generation&per_page=100` },
    { id: 'mistral', name: 'Mistral (training switched off)', keys: ['MISTRAL_API_KEY'], url: 'https://api.mistral.ai/v1/chat/completions', modelsUrl: 'https://api.mistral.ai/v1/models', free: true },
    { id: 'ollama', name: 'Ollama Cloud', keys: ['OLLAMA_API_KEY'], url: 'https://ollama.com/v1/chat/completions', modelsUrl: 'https://ollama.com/v1/models', free: true },
    { id: 'cerebras', name: 'Cerebras', keys: ['CEREBRAS_API_KEY'], url: 'https://api.cerebras.ai/v1/chat/completions', modelsUrl: 'https://api.cerebras.ai/v1/models' },
    { id: 'gemini', name: 'Gemini (paid key)', keys: ['GEMINI_API_KEY'], url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
    { id: 'openrouter', name: 'OpenRouter (no-training providers only)', keys: ['OPENROUTER_API_KEY'], url: 'https://openrouter.ai/api/v1/chat/completions',
      extra: { provider: { data_collection: 'deny', zdr: true } }, headers: { 'X-Title': 'Aviance Ava' } },
  ];
}
/** The key a brain's Bearer is (the last of its keys: Cloudflare's token). */
const bearerKey = (b) => b.keys[b.keys.length - 1];

// ─── in-memory state (per server instance) ──────────────────────────────────

const state = new Map();   // id or id|model → { lastError, lastErrorAt, lastOkAt, coolUntil, noTools, noReasoning }
const st = (id) => { if (!state.has(id)) state.set(id, { lastError: null, lastErrorAt: null, lastOkAt: null, coolUntil: 0, noTools: false, noReasoning: false }); return state.get(id); };
export const __resetBrains = () => state.clear();
export const brainState = (id) => ({ ...st(id) });

const slotId = (s) => `${s.brain.id}|${s.model}`;
const cooling = (id) => st(id).coolUntil > AVA_IO.now();
const slotCooling = (s) => cooling(s.brain.id) || cooling(slotId(s));

/** The brains with every key they need → [{ ...brain, apiKey, url, modelsUrl }] (keys server-side only). */
export async function keyedBrains() {
  const snap = await secretsSnapshot();
  const out = [];
  for (const b of brainList()) {
    const v = {};
    for (const k of b.keys) v[k] = await secretOf(k, snap);
    if (!b.keys.every((k) => v[k])) continue;
    out.push({ ...b, apiKey: v[bearerKey(b)], url: typeof b.url === 'function' ? b.url(v) : b.url, modelsUrl: typeof b.modelsUrl === 'function' ? b.modelsUrl(v) : b.modelsUrl || null });
  }
  return out;
}

/** GET /api/mc/ava/status → brains: [{ id, name, ready, model, models, lastError, lastOkAt }] (never a key). */
export async function brainsStatus() {
  const keyed = await keyedBrains();
  const byId = new Map(keyed.map((b) => [b.id, b]));
  const out = [];
  for (const b of brainList()) {
    const s = st(b.id);
    const kb = byId.get(b.id);
    let model = null; let models = [];
    if (kb) { const m = await modelsFor(kb, { wait: true }); model = m.fast; models = m.ranked.slice(0, 12); }
    else { const c = cachedModels(b.id); model = c?.fast || null; models = c?.ranked?.slice(0, 12) || []; }
    const cool = cooling(b.id);
    out.push({
      id: b.id, name: b.name, ready: Boolean(kb) && !cool, model, models,
      lastError: !kb ? `No key yet — add ${b.keys.join(' and ')} in Settings › Keys` : cool ? `${s.lastError || 'Resting after too many questions'} (resting until ${new Date(s.coolUntil).toISOString()})` : s.lastError,
      lastOkAt: s.lastOkAt,
    });
  }
  return out;
}

/** A "smart" question: why / how / plan / compare / explain / write…, or long. */
export function isSmart(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = String(last?.content || '');
  const words = q.trim().split(/\s+/).filter(Boolean).length;
  if (words > 25 || q.length > 160) return true;
  return /\b(why|how (?:do|does|can|should|to|would|could)|plan|compare|comparison|explain|difference|versus|vs\.?|steps?|strategy|pros|cons|should (?:i|we)|write|draft|improve|analy[sz]e|summari[sz]e)\b/i.test(q);
}
/** Kept for older callers: a request is "short" when it is not a smart one. */
export const isShort = (messages) => !isSmart(messages);

/**
 * The (brain, model) slots to try, in order. Groq: 3 models (smart first for
 * a smart question, the quick one for a short or spoken one); every other
 * brain: 2. Cooling slots go last. The brains' model lists are read side by
 * side (never one after another).
 */
export async function planSlots(brains, { smart = false, quick = false } = {}) {
  const slots = [];
  const lists = await Promise.all(brains.map((b) => modelsFor(b)));
  for (const [i, brain] of brains.entries()) {
    const m = lists[i];
    const first = smart ? m.smart || m.fast : quick ? m.quick || m.fast : m.fast || m.smart;
    const list = [first, ...m.ranked.filter((x) => x !== first)].filter(Boolean).slice(0, brain.id === 'groq' ? 3 : 2);
    for (const model of list) slots.push({ brain, model });
  }
  return [...slots.filter((s) => !slotCooling(s)), ...slots.filter((s) => slotCooling(s))];
}

// ─── one call ────────────────────────────────────────────────────────────────

/** Extra settings for thinking models (off again for a brain that refuses them). */
function reasoningExtras(brain, model, smart) {
  if (st(brain.id).noReasoning) return {};
  if (/gpt-oss/i.test(model) && ['groq', 'cerebras'].includes(brain.id)) return { reasoning_effort: smart ? 'medium' : 'low' };
  if (/qwen3|qwen\/qwen3/i.test(model) && brain.id === 'groq') return { reasoning_format: 'hidden' };
  return {};
}

/** Read an OpenAI-style SSE stream → the assembled message; `onDelta(text)` for each content piece. */
async function readStream(res, onDelta, { idleMs, signal }) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const calls = [];
  let done = false;
  while (!done) {
    let timer;
    const idle = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), idleMs); });
    let r;
    try { r = await Promise.race([reader.read(), idle]); } finally { clearTimeout(timer); }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { done = true; break; }
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j?.error) throw Object.assign(new Error(String(j.error.message || j.error).slice(0, 200)), { name: 'StreamError' });
      const d = j?.choices?.[0]?.delta || {};
      if (typeof d.content === 'string' && d.content) { content += d.content; onDelta(d.content); }
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const k = Number.isInteger(tc.index) ? tc.index : calls.length;
        const c = calls[k] || (calls[k] = { id: null, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
    }
  }
  try { reader.releaseLock(); } catch { /* fine */ }
  const tool_calls = calls.filter((c) => c && c.function.name);
  return { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) };
}

/**
 * One chat completion on one model. `body` is the OpenAI-shaped request
 * without `model`. With `onDelta` the answer is streamed (the text pieces go
 * to onDelta as they come; tool calls are assembled).
 * → { ok, message, ms } | { ok: false, status, error, retryable, toolsRefused, gone, ms }.
 */
export async function callBrain(brain, body, { model = brain.model, timeoutMs = AVA_TIMING.callMs, onDelta = null, smart = false } = {}) {
  const t0 = AVA_IO.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1, timeoutMs));
  const extras = reasoningExtras(brain, model, smart);
  let res;
  try {
    res = await AVA_IO.fetch(brain.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${brain.apiKey}`, ...(onDelta ? { accept: 'text/event-stream' } : {}), ...(brain.headers || {}) },
      body: JSON.stringify({ model, ...body, ...extras, ...(onDelta ? { stream: true } : {}), ...(brain.extra || {}) }),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ctl.signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return { ok: false, status: 0, error: timedOut ? 'timed out' : 'could not be reached', retryable: true, ms: AVA_IO.now() - t0 };
  }
  clearTimeout(timer);
  const isSse = /text\/event-stream/i.test(res.headers?.get?.('content-type') || '');
  if (res.ok && onDelta && isSse && res.body) {
    try {
      const message = await readStream(res, onDelta, { idleMs: timeoutMs, signal: ctl.signal });
      return { ok: true, message, ms: AVA_IO.now() - t0, streamed: true };
    } catch (err) {
      return { ok: false, status: 0, error: err?.name === 'TimeoutError' ? 'timed out' : `stream broke: ${String(err?.message || err).slice(0, 120)}`, retryable: true, ms: AVA_IO.now() - t0, partial: true };
    }
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  const ms = AVA_IO.now() - t0;
  if (res.ok) {
    const message = json?.choices?.[0]?.message;
    if (!message) return { ok: false, status: res.status, error: 'answered with nothing', retryable: true, ms };
    if (onDelta && typeof message.content === 'string' && message.content && !(message.tool_calls || []).length) onDelta(message.content);
    return { ok: true, message, ms };
  }
  const errObj = Array.isArray(json) ? json[0] : json;
  const raw = String(errObj?.error?.message || errObj?.message || errObj?.errors?.[0]?.message || (typeof errObj?.error === 'string' ? errObj.error : '') || errObj?.error?.code || '').slice(0, 200);
  const code = String(errObj?.error?.code || '');
  // "tools are not supported" → the JSON fallback; a model that just wrote a broken tool call (Groq's tool_use_failed) → the next slot.
  const toolUseFailed = /tool_use_failed|failed to call a function|failed_generation/i.test(`${code} ${raw}`);
  const toolsRefused = res.status === 400 && !toolUseFailed && /(tool|function)[\s\S]{0,40}(not|un)\s?support|does not support (tool|function)|(tools?|functions?) (is|are) not (supported|available|allowed)/i.test(raw) && !/reasoning/i.test(raw);
  const reasoningRefused = res.status === 400 && Object.keys(extras).length > 0 && /reasoning/i.test(raw);
  const gone = modelGone(res.status, `${code} ${raw}`);
  const retryAfter = Number(res.headers?.get?.('retry-after'));
  return {
    ok: false, status: res.status, retryable: res.status === 429 || res.status >= 500 || res.status === 408 || res.status === 413 || toolUseFailed,
    toolsRefused, reasoningRefused, gone, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    error: gone ? `model ${model} is not available` : res.status === 429 ? 'too many questions right now' : res.status === 401 || res.status === 403 ? 'the key was refused' : `said ${res.status}${raw ? `: ${raw}` : ''}`,
    ms,
  };
}

function noteFail(slot, r) {
  const b = st(slot.brain.id);
  const s = st(slotId(slot));
  const at = new Date(AVA_IO.now()).toISOString();
  b.lastError = `${slot.brain.name} (${slot.model}) ${r.error}`.slice(0, 240);
  b.lastErrorAt = at;
  s.lastError = b.lastError; s.lastErrorAt = at;
  if (r.status === 429) s.coolUntil = AVA_IO.now() + Math.min(r.retryAfterMs || AVA_TIMING.cooldownMs, AVA_TIMING.maxCooldownMs);
  if (r.status === 401 || r.status === 403) b.coolUntil = AVA_IO.now() + AVA_TIMING.badKeyCooldownMs;
}
function noteOk(slot) {
  for (const id of [slot.brain.id, slotId(slot)]) {
    const s = st(id);
    s.lastOkAt = new Date(AVA_IO.now()).toISOString();
    s.lastError = null;
    s.coolUntil = 0;
  }
}

export const usesTools = (brain) => !st(brain.id).noTools;

/**
 * Ask the slots in `order` until one answers. `build(slot)` makes the body
 * (it depends on whether that brain takes tools). `deadline` = epoch ms for
 * the whole question. Every attempt goes into `tried`. With `onDelta` the
 * answer streams; once text has gone out, a broken stream is not retried
 * elsewhere (it would repeat itself) — it ends with what came.
 * → { slot, brain, model, message } | null (nothing answered in time).
 */
export async function ask(order, build, { deadline, tried, onDelta = null, smart = false }) {
  for (const slot of order) {
    let again = true;
    while (again) {
      again = false;
      const left = deadline - AVA_IO.now();
      if (left <= 250) { tried.push({ brain: slot.brain.id, model: slot.model, ok: false, ms: 0, error: 'no time left' }); return null; }
      let sent = false;
      const relay = onDelta ? (t) => { if (onDelta(t, slot)) sent = true; } : null;
      const r = await callBrain(slot.brain, build(slot), { model: slot.model, timeoutMs: Math.min(AVA_TIMING.callMs, left), onDelta: relay, smart });
      if (r.ok) {
        noteOk(slot);
        tried.push({ brain: slot.brain.id, model: slot.model, ok: true, ms: r.ms, error: null });
        return { slot, brain: slot.brain, model: slot.model, message: r.message };
      }
      tried.push({ brain: slot.brain.id, model: slot.model, ok: false, ms: r.ms, error: r.error });
      if (sent) { noteFail(slot, r); return { slot, brain: slot.brain, model: slot.model, message: { role: 'assistant', content: '' }, cut: true }; }
      if (r.toolsRefused && !st(slot.brain.id).noTools) { st(slot.brain.id).noTools = true; again = true; continue; }
      if (r.reasoningRefused && !st(slot.brain.id).noReasoning) { st(slot.brain.id).noReasoning = true; again = true; continue; }
      if (r.gone) { await dropModel(slot.brain.id, slot.model); continue; }
      noteFail(slot, r);
    }
  }
  return null;
}
