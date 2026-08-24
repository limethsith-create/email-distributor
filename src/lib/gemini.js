/**
 * Shared Gemini helper — model auto-discovery + generation.
 *
 * Google retires model names over time (hardcoded names eventually 404).
 * Instead of guessing, we ask the API which models THIS key can use, pick a
 * current flash model that supports generateContent, and cache the choice in
 * KV for a day. If a cached model starts 404ing, the cache is cleared and the
 * next call re-discovers. All failures return null — callers always have a
 * non-AI fallback.
 */

import { kv } from '@vercel/kv';

const MODEL_CACHE_KEY = 'gemini_working_model';

export async function getWorkingModel(apiKey) {
  try {
    const cached = await kv.get(MODEL_CACHE_KEY);
    if (cached) return cached;
  } catch {}
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const usable = (data.models || []).filter(
      (m) => (m.supportedGenerationMethods || []).includes('generateContent')
    );
    const pick =
      usable.find((m) => /flash/i.test(m.name) && !/thinking|image|live|audio|tts|embed|8b|lite/i.test(m.name)) ||
      usable.find((m) => /flash/i.test(m.name)) ||
      usable[0];
    if (!pick) return null;
    const name = pick.name.replace(/^models\//, '');
    try { await kv.set(MODEL_CACHE_KEY, name, { ex: 86400 }); } catch {}
    return name;
  } catch {
    return null;
  }
}

/** Generate text. Returns the text or null (never throws). */
export async function geminiGenerate(apiKey, prompt, opts = {}) {
  const { temperature = 0.7, maxOutputTokens = 300 } = opts;
  if (!apiKey) return null;
  const model = await getWorkingModel(apiKey);
  if (!model) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) {
      // Cached model has gone stale — clear so next call re-discovers.
      if (res.status === 404) { try { await kv.del(MODEL_CACHE_KEY); } catch {} }
      return null;
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return text.trim() || null;
  } catch {
    return null;
  }
}
