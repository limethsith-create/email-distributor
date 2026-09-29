/**
 * POST /api/mc/ava/chat — ask Ava (docs/HUB-API.md "Ava (AI helper)").
 * Owner and team members (middleware lets team members POST here).
 *   body { messages: [{ role: 'user'|'assistant', content }], page: { view, clientId, clientName?, tab }, voice?: true, stream?: true,
 *          user?: { firstName, role } }   (role is taken ONLY from the verified request, never from the body)
 *
 * JSON (default):
 *   → 200 { reply, actions: [...], suggestions: [3], brain, model, tried: [{ brain, model, ok, ms, error }], ms }
 *   → 503 { error, needsKeys: true } no AI key yet · 429 { error } too many questions
 *   → 502 { error, tried } no brain answered · 400 { error } bad body
 *
 * Streaming — `accept: text/event-stream`, `?stream=1` or body `stream: true`
 * → 200 text/event-stream (always; a failure is an `error` event):
 *   event: delta    data: {"text":"…"}                       pieces of the answer as it is written
 *   event: actions  data: {"actions":[…],"suggestions":[…]}   once, after the text
 *   event: done     data: {"brain":"groq","model":"…","ms":1234,"tried":[…],"suggestions":[…]}
 *   event: error    data: {"error":"…","status":503,"needsKeys":true?,"tried":[…]?}
 * The tool look-ups happen before the first delta (not streamed).
 */

import { avaChat, prepareChat, answerChat, AvaError } from '@/lib/ava/chat';
import { whoIsAsking } from '@/lib/ava/who';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function wantsStream(request, body) {
  const url = new URL(request.url);
  const q = url.searchParams.get('stream');
  if (q === '1' || q === 'true') return true;
  if (body && body.stream === true) return true;
  return /text\/event-stream/i.test(request.headers.get('accept') || '');
}

function errorBody(err) {
  if (err instanceof AvaError) return { status: err.status, body: { error: err.message, ...err.extra } };
  console.error('[ava] chat failed', err?.message);
  return { status: 500, body: { error: 'Ava ran into a problem — try again.' } };
}

function stream(body, user) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (event, data) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { open = false; }
      };
      // A first comment line so every proxy starts passing bytes at once.
      try { controller.enqueue(enc.encode(': ava\n\n')); } catch { open = false; }
      try {
        const q = await prepareChat(body, user);
        const r = await answerChat(q, { onDelta: (text) => { if (text) send('delta', { text }); } });
        send('actions', { actions: r.actions, suggestions: r.suggestions });
        send('done', { brain: r.brain, model: r.model, ms: r.ms, tried: r.tried, suggestions: r.suggestions, ...(r.cut ? { cut: true } : {}) });
      } catch (err) {
        const e = errorBody(err);
        send('error', { ...e.body, status: e.status });
      }
      open = false;
      try { controller.close(); } catch { /* closed by the client */ }
    },
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  const streaming = wantsStream(request, body);
  if (!body || typeof body !== 'object') {
    if (streaming) return new Response(`event: error\ndata: ${JSON.stringify({ error: 'Send { messages, page }.', status: 400 })}\n\n`, { status: 200, headers: SSE_HEADERS });
    return Response.json({ error: 'Send { messages, page }.' }, { status: 400 });
  }
  const user = await whoIsAsking(request);
  if (streaming) return new Response(stream(body, user), { status: 200, headers: SSE_HEADERS });
  try {
    return Response.json(await avaChat(body, user));
  } catch (err) {
    const e = errorBody(err);
    return Response.json(e.body, { status: e.status });
  }
}
