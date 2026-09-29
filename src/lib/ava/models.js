/**
 * Ava's model picker (docs/HUB-API.md "Ava (AI helper)") — no hard-coded
 * model that can die under us. On first use (then every 6 h) each brain's
 * own model list is read (OpenAI-compatible `GET /models`; Cloudflare's
 * `/ai/models/search`) and the best available models are chosen from a
 * preference list:
 *
 *   fast  — the default for everyday questions,
 *   smart — for "why / how / plan / compare / explain / long" questions
 *           (the fast one when nothing stronger is there).
 *
 * The rest of the usable models follow as fallbacks on the same brain (on
 * Groq every model has its own rate-limit bucket). Speech, guard, TTS,
 * embedding and "compound" models are never picked.
 *
 * Overrides win: env `AVA_{BRAIN}_MODEL` / `AVA_{BRAIN}_SMART_MODEL`, then
 * config `AVA_MODELS` ({ groq, groqSmart, cloudflare, … }).
 *
 *   quick — a short or spoken question (Groq gpt-oss-20b): the fastest good one.
 *
 * The list is kept in memory and in Redis (`ava:models:{brain}`, fresh 6 h,
 * kept a week), so a cold server instance does not call /models again. A
 * question never waits on a list it has: a stale one is used at once and
 * read again in the background; only a first-ever read waits (≤ DISCOVER_WAIT). A chat call that says
 * the model is gone (model_not_found / decommissioned) drops it from the
 * list at once (dropModel) and the next one is tried.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';

export const MODELS_TTL_MS = 6 * 3600e3;
export const MODELS_IO = {
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
  log: (...a) => console.log(...a),
  timeoutMs: 6000,
};

/** Never a chat model: speech, speech-to-text, guards, embeddings, images, Groq's retired "compound" systems. */
export const SKIP_RE = /whisper|tts|orpheus|playai|guard|compound|embed|bge-|rerank|distil|vision-only|image|flux|stable-diffusion|dreamshaper|lora|m2m100|translate|resnet|detr|melotts|nova-3|aura|smart-turn|deepgram|lucid|phoenix|toxic|llava|uform|safety/i;

/**
 * Preference lists per brain: each entry is an exact id or a RegExp; the
 * first entry that matches an available model wins (ties inside a RegExp:
 * the bigger number in the id first). `smart` is tried first for a smart
 * question; `fast` for everything else.
 */
export const PREFS = {
  groq: {
    // quick — a short or spoken question: the smallest good model answers first (it is the fastest).
    quick: ['openai/gpt-oss-20b'],
    fast: ['openai/gpt-oss-120b', /^qwen\/qwen3[\w.-]*$/i, /^moonshotai\/kimi/i, /^meta-llama\/llama-4/i, 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', /^qwen/i, /^llama/i, /^meta-llama\//i],
    smart: [/^qwen\/qwen3[\w.-]*$/i, /^moonshotai\/kimi/i, 'openai/gpt-oss-120b', /^meta-llama\/llama-4/i, 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
  },
  cloudflare: {
    quick: ['@cf/openai/gpt-oss-20b'],
    fast: ['@cf/openai/gpt-oss-120b', /^@cf\/zai-org\/glm/i, /^@cf\/qwen\/qwen3/i, /^@cf\/meta\/llama-4/i, /^@cf\/mistralai\/mistral-small/i, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-20b'],
    smart: ['@cf/openai/gpt-oss-120b', /^@cf\/zai-org\/glm/i, /^@cf\/qwen\/qwen3/i, /^@cf\/meta\/llama-4/i],
    // Kimi on Workers AI needs the paid plan: $0 only.
    skip: /kimi/i,
  },
  cerebras: {
    fast: ['gpt-oss-120b', /^zai-glm/i, /^qwen-3/i, /^llama-4/i, /^llama/i],
    smart: [/^zai-glm/i, 'gpt-oss-120b', /^qwen-3/i],
  },
  // La Plateforme (free "Experiment" plan, training switched off): the -latest aliases first.
  mistral: {
    fast: ['mistral-medium-latest', 'mistral-large-latest', /^mistral-medium/i, /^mistral-large/i, 'mistral-small-latest', /^mistral-small/i],
    smart: ['mistral-large-latest', 'mistral-medium-latest', /^mistral-large/i, /^mistral-medium/i, 'mistral-small-latest', /^mistral-small/i],
    skip: /moderation|ocr|voxtral|codestral|devstral|pixtral|magistral|saba|ministral|open-mistral|open-mixtral|mistral-tiny/i,
  },
  // Ollama Cloud: gpt-oss:120b first, then the biggest model there is.
  ollama: {
    fast: ['gpt-oss:120b', /^gpt-oss:120b/i, /./],
    smart: ['gpt-oss:120b', /^gpt-oss:120b/i, /./],
    bySize: true,
    skip: /coder|-vl\b|:vl|ocr/i,
  },
};

/** Default models when a brain has no list to read (Gemini, OpenRouter) or the list could not be read. */
export const FALLBACK = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  cloudflare: ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b'],
  cerebras: ['gpt-oss-120b'],
  mistral: ['mistral-medium-latest', 'mistral-small-latest'],
  ollama: ['gpt-oss:120b'],
  gemini: ['gemini-2.5-flash'],
  openrouter: ['openai/gpt-oss-120b'],
};

const mem = new Map();   // brain id → { at, available: [ids], ranked: [ids], fast, smart, source }
export const __resetModels = () => { mem.clear(); pending.clear(); };

const envOf = (name) => String(process.env[name] || '').trim() || null;
/** Newer first (the first number in the id: qwen3.8 before qwen3), then bigger (…-70b before …-8b). */
const versionOf = (id) => { const m = String(id).replace(/^[^/]*\//, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : 0; };
const sizeOf = (id) => { const m = String(id).match(/(\d+(?:\.\d+)?)b\b/i); return m ? Number(m[1]) : 0; };

/** Rank the ids by a preference list → [ids], best first (unmatched ones are left out). */
export function rankModels(ids, prefs = [], { bySize = false } = {}) {
  const out = [];
  for (const p of prefs) {
    const hits = ids.filter((id) => !out.includes(id) && (p instanceof RegExp ? p.test(id) : id === p));
    hits.sort(bySize
      ? (a, b) => sizeOf(b) - sizeOf(a) || versionOf(b) - versionOf(a) || a.localeCompare(b)
      : (a, b) => versionOf(b) - versionOf(a) || sizeOf(b) - sizeOf(a) || a.localeCompare(b));
    out.push(...hits);
  }
  return out;
}

/** Usable chat model ids out of a /models answer (OpenAI shape `data[]`, Cloudflare `result[]`). */
export function usableIds(json, brainId) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.result) ? json.result : Array.isArray(json?.models) ? json.models : [];
  const skip = PREFS[brainId]?.skip;
  const ids = [];
  for (const r of rows) {
    const id = String(r?.id || r?.name || '').replace(/^models\//, '').trim();
    if (!id || SKIP_RE.test(id) || (skip && skip.test(id))) continue;
    if (r?.active === false) continue;
    // Mistral lists what each model can do: Ava needs chat and tool calling.
    if (r?.capabilities && (r.capabilities.completion_chat === false || r.capabilities.function_calling === false)) continue;
    const task = String(r?.task?.name || r?.task || '');
    if (task && !/text generation/i.test(task)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Choose fast / smart / the ranked list from what is available. */
export function choose(brainId, available) {
  const p = PREFS[brainId] || {};
  const o = { bySize: Boolean(p.bySize) };
  const fastRank = rankModels(available, p.fast || [], o);
  const smartRank = rankModels(available, p.smart || p.fast || [], o);
  const ranked = [...fastRank];
  for (const id of smartRank) if (!ranked.includes(id)) ranked.push(id);
  const fast = fastRank[0] || null;
  const smart = smartRank.find((id) => id !== fast) || fast;
  const quick = (p.quick ? rankModels(available, p.quick, o)[0] : null) || fast;
  return { ranked, fast, smart, quick };
}

async function overridesFor(brainId) {
  const upper = brainId.toUpperCase();
  let conf = {};
  try { const v = await cfg(null, 'AVA_MODELS'); if (v && typeof v === 'object') conf = v; } catch { conf = {}; }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    fast: envOf(`AVA_${upper}_MODEL`) || str(conf[brainId]),
    smart: envOf(`AVA_${upper}_SMART_MODEL`) || str(conf[`${brainId}Smart`]),
    quick: envOf(`AVA_${upper}_QUICK_MODEL`) || str(conf[`${brainId}Quick`]),
  };
}

async function readList(brain) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MODELS_IO.timeoutMs);
  try {
    const res = await MODELS_IO.fetch(brain.modelsUrl, { method: 'GET', headers: { authorization: `Bearer ${brain.apiKey}`, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const ids = usableIds(json, brain.id);
    return ids.length ? ids : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const parse = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
/** Redis keeps the list a week; after 6 h it is "stale": still used at once, and read again in the background. */
const KEEP_S = 7 * 86400;
const pending = new Map();   // brain id → the running refresh (one at a time)
/** How long a question waits for a list nobody has read yet (a brand-new system) before it uses the defaults. */
export const DISCOVER_WAIT = { ms: 800 };

/** Read the brain's list now (memory + Redis). → the new entry, or null when it could not be read. */
function refresh(brain) {
  if (pending.has(brain.id)) return pending.get(brain.id);
  const p = (async () => {
    if (!brain.modelsUrl || !PREFS[brain.id]) return null;
    const now = MODELS_IO.now();
    const available = await readList(brain);
    if (!available) return null;
    const picked = choose(brain.id, available);
    if (!picked.ranked.length) return null;
    const entry = { at: now, available, ...picked, source: 'live' };
    mem.set(brain.id, entry);
    await kv.set(K.avaModels(brain.id), JSON.stringify({ at: now, available }), { ex: KEEP_S }).catch(() => {});
    MODELS_IO.log(`[ava] ${brain.id} models: fast=${picked.fast} smart=${picked.smart} quick=${picked.quick} (${picked.ranked.length} usable of ${available.length})`);
    return entry;
  })().catch(() => null).finally(() => pending.delete(brain.id));
  pending.set(brain.id, p);
  return p;
}

function defaultEntry(brainId, now) {
  const ranked = (FALLBACK[brainId] || []).slice();
  // A failed read is tried again in 10 minutes, not 6 hours.
  return { at: now - MODELS_TTL_MS + 10 * 60e3, available: ranked.slice(), ranked, fast: ranked[0] || null, smart: ranked[1] || ranked[0] || null, quick: ranked[0] || null, source: 'default' };
}

/**
 * The brain's models → { fast, smart, quick, ranked: [ids], source: 'live'|'cache'|'default'|'override' }.
 * `brain` = { id, apiKey, modelsUrl? }. Never throws.
 *
 * A question never waits on a model list it already has: a list older than
 * 6 h (in memory or Redis) is used at once and read again in the background.
 * Only a list nobody has read yet waits, and at most DISCOVER_WAIT.ms (then the
 * defaults; the read finishes in the background). `wait: true` (status, warm)
 * waits for a fresh read. `refresh: true` reads it again now.
 */
export async function modelsFor(brain, { refresh: again = false, wait = false } = {}) {
  const now = MODELS_IO.now();
  const ov = await overridesFor(brain.id);
  let entry = mem.get(brain.id);
  const canRead = Boolean(brain.modelsUrl && PREFS[brain.id]);
  if (again && canRead) entry = (await refresh(brain)) || entry;
  if (!entry) {
    const saved = parse(await kv.get(K.avaModels(brain.id)).catch(() => null));
    if (saved && Array.isArray(saved.available) && saved.available.length) {
      entry = { ...saved, at: Number(saved.at || 0), ...choose(brain.id, saved.available), source: 'cache' };
      mem.set(brain.id, entry);
    }
  }
  if (!entry || now - entry.at > MODELS_TTL_MS) {
    if (canRead) {
      const job = refresh(brain);
      if (!entry || wait) {
        const got = wait ? await job : await Promise.race([job, new Promise((r) => { const t = setTimeout(() => r(null), DISCOVER_WAIT.ms); t.unref?.(); })]);
        if (got) entry = got;
      }
    }
    if (!entry) { entry = defaultEntry(brain.id, now); mem.set(brain.id, entry); }
    else if (now - entry.at > MODELS_TTL_MS && entry.source === 'default') mem.set(brain.id, defaultEntry(brain.id, now));
  }
  const ranked = entry.ranked.slice();
  const fast = ov.fast || entry.fast;
  const smart = ov.smart || (ov.fast && !ov.smart ? ov.fast : entry.smart) || fast;
  const quick = ov.quick || ov.fast || entry.quick || fast;
  for (const id of [quick, smart, fast]) if (id && !ranked.includes(id)) ranked.unshift(id);
  return { fast, smart, quick, ranked, source: ov.fast || ov.smart || ov.quick ? 'override' : entry.source };
}

/** Every model-list read still running (a route awaits this after its answer is sent: next/server `after`). */
export const modelsSettled = () => Promise.all([...pending.values()]).then(() => undefined);

/** Start (or wait for) a model-list read for every brain given — the warm-up (GET /api/mc/ava/warm, after a question). */
export async function warmModels(brains, { wait = true } = {}) {
  const jobs = brains.map((b) => modelsFor(b, { wait }).catch(() => null));
  return wait ? Promise.all(jobs) : null;
}

/** A model the service says is gone: out of the list now (memory and Redis), so the next one is used. */
export async function dropModel(brainId, model) {
  const e = mem.get(brainId);
  if (!e) return;
  const available = e.available.filter((m) => m !== model);
  const picked = choose(brainId, available);
  const ranked = picked.ranked.length ? picked.ranked : e.ranked.filter((m) => m !== model);
  mem.set(brainId, { ...e, available, ranked, fast: picked.fast || ranked[0] || null, smart: picked.smart || ranked[0] || null, quick: picked.quick || picked.fast || ranked[0] || null });
  MODELS_IO.log(`[ava] ${brainId}: model ${model} is gone — dropped (next: ${ranked[0] || 'none'})`);
  await kv.set(K.avaModels(brainId), JSON.stringify({ at: e.at, available }), { ex: KEEP_S }).catch(() => {});
}

/** What the model list says without reading anything (status). */
export const cachedModels = (brainId) => { const e = mem.get(brainId); return e ? { ...e } : null; };

/** Does an error say "this model does not exist (any more)"? */
export function modelGone(status, message) {
  const m = String(message || '');
  if (/decommission|model_not_found|does not exist|no such model|not a valid model|model .*not (?:found|available|supported)|unknown model|invalid model|deprecated/i.test(m)) return true;
  return status === 404 && /model/i.test(m);
}
