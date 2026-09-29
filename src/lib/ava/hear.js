/**
 * Ava's ears on the machine (docs/HUB-API.md "Ava (AI helper)"): a short
 * recording → text through Groq's Whisper (free; Groq does not train on API
 * data). The whisper model is picked from Groq's own model list (a turbo one
 * first). No Groq key → the route answers 404 and the hub keeps the browser's
 * own speech recognition.
 */

import { secretOf } from '@/lib/secrets';
import { MODELS_IO } from '@/lib/ava/models';

export const HEAR_IO = {
  fetch: (...a) => globalThis.fetch(...a),
  timeoutMs: 15_000,
};
export const HEAR_MAX_BYTES = 2 * 1024 * 1024;
export const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const TYPES = /^audio\/(webm|ogg|wav|x-wav|wave|mp4|m4a|x-m4a|mpeg|mp3|aac)|^video\/(webm|mp4)/i;
const EXT = { webm: 'webm', ogg: 'ogg', wav: 'wav', 'x-wav': 'wav', wave: 'wav', mp4: 'mp4', m4a: 'm4a', 'x-m4a': 'm4a', mpeg: 'mp3', mp3: 'mp3', aac: 'm4a' };
/** Words Whisper should spell right. */
export const HEAR_PROMPT = 'Aviance, Ava, the hub, trials, paying clients, onboarding call, launch call, warm-up, CheapInboxes, Groq, Cloudflare, Google Meet, reply bot, Starter, Growth, Scale.';

export class HearError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

let picked = { at: 0, model: null };
export const __resetHear = () => { picked = { at: 0, model: null }; };

/** The best whisper model Groq offers now (6 h memory; env AVA_WHISPER_MODEL wins). */
export async function whisperModel(key) {
  const env = String(process.env.AVA_WHISPER_MODEL || '').trim();
  if (env) return env;
  if (picked.model && MODELS_IO.now() - picked.at < 6 * 3600e3) return picked.model;
  let ids = [];
  try {
    const res = await HEAR_IO.fetch(GROQ_MODELS_URL, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
    const j = res.ok ? await res.json() : null;
    ids = (j?.data || []).filter((m) => m && m.active !== false).map((m) => String(m.id)).filter((id) => /whisper/i.test(id));
  } catch { ids = []; }
  const rank = (id) => (/large-v3-turbo/i.test(id) ? 0 : /turbo/i.test(id) ? 1 : /large-v3/i.test(id) ? 2 : /large/i.test(id) ? 3 : 4);
  const model = ids.sort((a, b) => rank(a) - rank(b))[0] || 'whisper-large-v3-turbo';
  picked = { at: MODELS_IO.now(), model };
  return model;
}

/** Is there a Groq key (the route's 404 otherwise)? */
export const hearKey = () => secretOf('GROQ_API_KEY');

/**
 * Audio bytes → { text, model, ms }. `type` = the recording's content type,
 * `language` = optional ISO code (e.g. "en").
 */
export async function transcribe(bytes, { type = 'audio/webm', language = null, key } = {}) {
  const size = bytes?.byteLength ?? bytes?.length ?? 0;
  if (!size) throw new HearError('Send the recording (webm, ogg, wav or mp4).');
  if (size > HEAR_MAX_BYTES) throw new HearError('That recording is too long — keep it under 2 MB (about a minute).', 413);
  const t = String(type || '').split(';')[0].trim().toLowerCase() || 'audio/webm';
  if (!TYPES.test(t)) throw new HearError('Send webm, ogg, wav or mp4 audio.', 415);
  const ext = EXT[t.split('/')[1]] || 'webm';
  const model = await whisperModel(key);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: t }), `speech.${ext}`);
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('prompt', HEAR_PROMPT);
  if (language && /^[a-z]{2}$/i.test(language)) form.append('language', language.toLowerCase());
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HEAR_IO.timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await HEAR_IO.fetch(GROQ_TRANSCRIBE_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: ctl.signal });
  } catch {
    throw new HearError(ctl.signal.aborted ? 'Groq took too long to listen — try again.' : 'Groq could not be reached — try again.', 502);
  } finally {
    clearTimeout(timer);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 429) throw new HearError('Too many recordings right now — try again in a minute.', 429);
    if (res.status === 401 || res.status === 403) throw new HearError('Groq refused the key — check it in Settings › Keys.', 502);
    if (/model/i.test(String(j?.error?.message || '')) && res.status >= 400 && res.status < 500) __resetHear();
    throw new HearError(`Groq could not listen (${res.status}).`, 502);
  }
  return { text: String(j?.text || '').trim(), model, ms: Date.now() - t0 };
}
