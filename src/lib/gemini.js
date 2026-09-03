/**
 * Shared Gemini helper — model auto-discovery + generation (text and JSON).
 *
 * Google retires model names over time (hardcoded names eventually 404).
 * Instead of guessing, we ask the API which models THIS key can use, rank the
 * current general-purpose flash models newest-first, and cache the choice in
 * KV for a day. If the cached model starts failing with a 4xx (retired,
 * renamed, or rejecting an option), the cache is cleared and the next call
 * re-discovers. All failures return null — callers always have a non-AI
 * fallback.
 *
 * thinkingBudget: 0 disables the model's internal reasoning phase on the
 * 2.5+ family — without it those models can burn the whole token budget on
 * thinking and return empty text (the gemini_empty bug). Older models reject
 * the option with a 400, so it is only sent to models that support it.
 */

import { kv } from '@vercel/kv';

const MODEL_CACHE_KEY = 'gemini_working_model';
const API = 'https://generativelanguage.googleapis.com/v1beta';

// Never pick specialised or experimental variants for plain text work.
const EXCLUDE_RE = /thinking|image|live|audio|tts|embed|8b|lite|preview|exp|omni|vision|native|computer|robotics|deep|research/i;

/** Rank: newer version first, then "flash" over anything else. */
function rankModel(name) {
  const m = /(\d+)(?:\.(\d+))?/.exec(name);
  const version = m ? parseFloat(`${m[1]}.${m[2] || 0}`) : 0;
  const flash = /flash/i.test(name) ? 1 : 0;
  const latestAlias = /-latest$/i.test(name) ? 0.5 : 0;
  return version * 10 + flash * 5 + latestAlias;
}

export async function getWorkingModel(apiKey) {
  try {
    const cached = await kv.get(MODEL_CACHE_KEY);
    if (cached && typeof cached === 'string') return cached;
  } catch {}
  try {
    const res = await fetch(`${API}/models?key=${apiKey}&pageSize=200`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const usable = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /gemini/i.test(n));
    const clean = usable.filter((n) => !EXCLUDE_RE.test(n) && /flash/i.test(n));
    const pool = clean.length ? clean : usable.filter((n) => !/image|live|audio|tts|embed/i.test(n));
    pool.sort((a, b) => rankModel(b) - rankModel(a));
    const pick = pool[0];
    if (!pick) return null;
    try { await kv.set(MODEL_CACHE_KEY, pick, { ex: 86400 }); } catch {}
    return pick;
  } catch {
    return null;
  }
}

function supportsThinkingConfig(model) {
  const m = /(\d+)(?:\.(\d+))?/.exec(model);
  if (!m) return false;
  return parseFloat(`${m[1]}.${m[2] || 0}`) >= 2.5;
}

async function callGemini(apiKey, model, body, timeoutMs) {
  const res = await fetch(`${API}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!res.ok) {
    // A retired/renamed model or a rejected option → re-discover next time.
    // Rate limits (429) and outages (5xx) keep the cache; the model is fine.
    if (res.status === 400 || res.status === 404) { try { await kv.del(MODEL_CACHE_KEY); } catch {} }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    console.warn(`[gemini] ${model} -> HTTP ${res.status} ${detail}`);
    return null;
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  return text.trim() || null;
}

/** Generate text. Returns the text or null (never throws). */
export async function geminiGenerate(apiKey, prompt, opts = {}) {
  const { temperature = 0.7, maxOutputTokens = 2048, timeoutMs = 20000 } = opts;
  if (!apiKey) return null;
  const model = await getWorkingModel(apiKey);
  if (!model) return null;
  try {
    const generationConfig = { temperature, maxOutputTokens };
    if (supportsThinkingConfig(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    return await callGemini(apiKey, model, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }, timeoutMs);
  } catch (err) {
    console.warn(`[gemini] generate failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Generate a JSON object. Uses the API's JSON response mode and tolerates a
 * fenced or prefixed answer. Returns the parsed object or null.
 */
export async function geminiGenerateJson(apiKey, prompt, opts = {}) {
  const { temperature = 0.2, maxOutputTokens = 512, timeoutMs = 15000 } = opts;
  if (!apiKey) return null;
  const model = await getWorkingModel(apiKey);
  if (!model) return null;
  try {
    const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
    if (supportsThinkingConfig(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const text = await callGemini(apiKey, model, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }, timeoutMs);
    return parseJsonLoose(text);
  } catch (err) {
    console.warn(`[gemini] json failed: ${err?.message || err}`);
    return null;
  }
}

/** Parse JSON out of a model answer that may carry fences or prose around it. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch {} }
  return null;
}
