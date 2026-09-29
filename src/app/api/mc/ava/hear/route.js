/**
 * POST /api/mc/ava/hear — speech to text for Ava (docs/HUB-API.md "Ava (AI helper)").
 * Owner and team members. The recording (≤ 2 MB; webm, ogg, wav or mp4) as
 * the raw body with its content type, or as multipart form-data field `file`
 * (optional field / query `language`, e.g. "en").
 *   → 200 { text, model, ms }
 *   → 404 { error, needsKey: true }  no Groq key (the hub uses the browser's own speech recognition)
 *   → 400 / 413 / 415 { error }  nothing sent / too big / not audio · 429 / 502 { error }
 * The audio goes to Groq only (no training, not kept by default) and is not stored here.
 */

import { hearKey, transcribe, HearError, HEAR_MAX_BYTES } from '@/lib/ava/hear';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  const key = await hearKey().catch(() => null);
  if (!key) return Response.json({ error: 'Listening on the machine needs a Groq key (Settings › Keys).', needsKey: true }, { status: 404 });
  const url = new URL(request.url);
  let language = url.searchParams.get('language');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > HEAR_MAX_BYTES + 64 * 1024) return Response.json({ error: 'That recording is too long — keep it under 2 MB (about a minute).' }, { status: 413 });
  const ctype = String(request.headers.get('content-type') || '');
  try {
    let bytes; let type;
    if (/multipart\/form-data/i.test(ctype)) {
      const form = await request.formData();
      const file = form.get('file') || form.get('audio');
      if (!file || typeof file === 'string') throw new HearError('Send the recording as the form field "file".');
      bytes = new Uint8Array(await file.arrayBuffer());
      type = file.type || 'audio/webm';
      language = language || (typeof form.get('language') === 'string' ? form.get('language') : null);
    } else {
      bytes = new Uint8Array(await request.arrayBuffer());
      type = ctype || 'audio/webm';
    }
    return Response.json(await transcribe(bytes, { type, language, key }));
  } catch (err) {
    if (err instanceof HearError) return Response.json({ error: err.message }, { status: err.status });
    console.error('[ava] hear failed', err?.message);
    return Response.json({ error: 'Ava could not listen just now — try again.' }, { status: 500 });
  }
}
