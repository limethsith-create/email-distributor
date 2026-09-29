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
 * The list is kept in memory and in Redis (`ava:models:{brain}`, 6 h), so a
 * cold server instance does not call /models again. A chat call that says
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
    fast: ['openai/gpt-oss-120b', /^qwen\/qwen3[\w.-]*$/i, /^moonshotai\/kimi/i, /^meta-llama\/llama-4/i, 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', /^qwen/i, /^llama/i, /^meta-llama\//i],
    smart: [/^qwen\/qwen3[\w.-]*$/i, /^moonshotai\/kimi/i, 'openai/gpt-oss-120b', /^meta-llama\/llama-4/i, 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
  },
  cloudflare: {
    fast: ['@cf/openai/gpt-oss-120b', /^@cf\/zai-org\/glm/i, /^@cf\/qwen\/qwen3/i, /^@cf\/meta\/llama-4/i, /^@cf\/mistralai\/mistral-small/i, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-20b'],
    smart: ['@cf/openai/gpt-oss-120b', /^@cf\/zai-org\/glm/i, /^@cf\/qwen\/qwen3/i, /^@cf\/meta\/llama-4/i],
    // Kimi on Workers AI needs the paid plan: $0 only.
    skip: /kimi/i,
  },
  cerebras: {
    fast: ['gpt-oss-120b', /^zai-glm/i, /^qwen-3/i, /^llama-4/i, /^llama/i],
    smart: [/^zai-glm/i, 'gpt-oss-120b', /^qwen-3/i],
  },
};

/** Default models when a brain has no list to read (Gemini, OpenRouter) or the list could not be read. */
export const FALLBACK = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  cloudflare: ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b'],
  cerebras: ['gpt-oss-120b'],
  gemini: ['gemini-2.5-flash'],
  openrouter: ['openai/gpt-oss-120b'],
};

const mem = new Map();   // brain id → { at, available: [ids], ranked: [ids], fast, smart, source }
export const __resetModels = () => mem.clear();

const envOf = (name) => String(process.env[name] || '').trim() || null;
/** Newer first (the first number in the id: qwen3.8 before qwen3), then bigger (…-70b before …-8b). */
const versionOf = (id) => { const m = String(id).replace(/^[^/]*\//, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : 0; };
const sizeOf = (id) => { const m = String(id).match(/(\d+(?:\.\d+)?)b\b/i); return m ? Number(m[1]) : 0; };

/** Rank the ids by a preference list → [ids], best first (unmatched ones are left out). */
export function rankModels(ids, prefs = []) {
  const out = [];
  for (const p of prefs) {
    const hits = ids.filter((id) => !out.includes(id) && (p instanceof RegExp ? p.test(id) : id === p));
    hits.sort((a, b) => versionOf(b) - versionOf(a) || sizeOf(b) - sizeOf(a) || a.localeCompare(b));
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
    const task = String(r?.task?.name || r?.task || '');
    if (task && !/text generation/i.test(task)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Choose fast / smart / the ranked list from what is available. */
export function choose(brainId, available) {
  const p = PREFS[brainId] || {};
  const fastRank = rankModels(available, p.fast || []);
  const smartRank = rankModels(available, p.smart || p.fast || []);
  const ranked = [...fastRank];
  for (const id of smartRank) if (!ranked.includes(id)) ranked.push(id);
  const fast = fastRank[0] || null;
  const smart = smartRank.find((id) => id !== fast) || fast;
  return { ranked, fast, smart };
}

async function overridesFor(brainId) {
  const upper = brainId.toUpperCase();
  let conf = {};
  try { const v = await cfg(null, 'AVA_MODELS'); if (v && typeof v === 'object') conf = v; } catch { conf = {}; }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    fast: envOf(`AVA_${upper}_MODEL`) || str(conf[brainId]),
    smart: envOf(`AVA_${upper}_SMART_MODEL`) || str(conf[`${brainId}Smart`]),
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

/**
 * The brain's models → { fast, smart, ranked: [ids], source: 'live'|'cache'|'default'|'override' }.
 * `brain` = { id, apiKey, modelsUrl? }. Never throws.
 */
export async function modelsFor(brain, { refresh = false } = {}) {
  const now = MODELS_IO.now();
  const ov = await overridesFor(brain.id);
  let entry = mem.get(brain.id);
  if (!entry || refresh || now - entry.at > MODELS_TTL_MS) {
    entry = null;
    if (!refresh) {
      const saved = parse(await kv.get(K.avaModels(brain.id)).catch(() => null));
      if (saved && Array.isArray(saved.available) && now - Number(saved.at || 0) <= MODELS_TTL_MS) entry = { ...saved, ...choose(brain.id, saved.available), source: 'cache' };
    }
    if (!entry && brain.modelsUrl && PREFS[brain.id]) {
      const available = await readList(brain);
      if (available) {
        const picked = choose(brain.id, available);
        if (picked.ranked.length) {
          entry = { at: now, available, ...picked, source: 'live' };
          await kv.set(K.avaModels(brain.id), JSON.stringify({ at: now, available }), { ex: Math.round(MODELS_TTL_MS / 1000) }).catch(() => {});
          MODELS_IO.log(`[ava] ${brain.id} models: fast=${picked.fast} smart=${picked.smart} (${picked.ranked.length} usable of ${available.length})`);
        }
      }
    }
    if (!entry) {
      const ranked = (FALLBACK[brain.id] || []).slice();
      // A failed read is tried again in 10 minutes, not 6 hours.
      entry = { at: now - MODELS_TTL_MS + 10 * 60e3, available: ranked.slice(), ranked, fast: ranked[0] || null, smart: ranked[1] || ranked[0] || null, source: 'default' };
    }
    mem.set(brain.id, entry);
  }
  const ranked = entry.ranked.slice();
  const fast = ov.fast || entry.fast;
  const smart = ov.smart || (ov.fast && !ov.smart ? ov.fast : entry.smart) || fast;
  for (const id of [smart, fast]) if (id && !ranked.includes(id)) ranked.unshift(id);
  return { fast, smart, ranked, source: ov.fast || ov.smart ? 'override' : entry.source };
}

/** A model the service says is gone: out of the list now (memory and Redis), so the next one is used. */
export async function dropModel(brainId, model) {
  const e = mem.get(brainId);
  if (!e) return;
  const available = e.available.filter((m) => m !== model);
  const picked = choose(brainId, available);
  const ranked = picked.ranked.length ? picked.ranked : e.ranked.filter((m) => m !== model);
  mem.set(brainId, { ...e, available, ranked, fast: picked.fast || ranked[0] || null, smart: picked.smart || ranked[0] || null });
  MODELS_IO.log(`[ava] ${brainId}: model ${model} is gone — dropped (next: ${ranked[0] || 'none'})`);
  await kv.set(K.avaModels(brainId), JSON.stringify({ at: e.at, available }), { ex: Math.round(MODELS_TTL_MS / 1000) }).catch(() => {});
}

/** What the model list says without reading anything (status). */
export const cachedModels = (brainId) => { const e = mem.get(brainId); return e ? { ...e } : null; };

/** Does an error say "this model does not exist (any more)"? */
export function modelGone(status, message) {
  const m = String(message || '');
  if (/decommission|model_not_found|does not exist|no such model|not a valid model|model .*not (?:found|available|supported)|unknown model|invalid model|deprecated/i.test(m)) return true;
  return status === 404 && /model/i.test(m);
}
