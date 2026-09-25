/**
 * /api/mc/google — the hub's Settings › Google Meet (docs/REPLYBOT-MEET.md §3,
 * the owner's steps in docs/GOOGLE-SETUP.md). Admin cookie or hub token
 * (middleware).
 *   GET → { status: 'not_set_up|ready_to_connect|connected|broken', account,
 *           redirectUri, hasClient, clientFrom, connectedAt, brokenAt, problem, encKey }
 *   POST { action: 'saveClient', clientId, clientSecret } → the status
 *        { action: 'connect' } → { url } (Google's consent screen; its `state` lives 10 minutes)
 *        { action: 'disconnect' } → the status + { revoked }
 *        { action: 'test' } → { ok, meetLink } (a 15-minute event with a Meet, deleted straight away)
 *   → 400/409/502/503 { error } in plain words.
 * The Client ID, the Client secret and the tokens are never in any answer.
 */

import { logEvent } from '@/lib/db/events';
import { googleStatus, saveClient, connectUrl, disconnect, testMeet, GoogleError } from '@/lib/ext/google';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const fail = (err) => Response.json({ error: err.message }, { status: err.status || 502 });

export async function GET() {
  try {
    return Response.json(await googleStatus());
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'saveClient': return Response.json({ ok: true, ...(await saveClient({ clientId: body.clientId, clientSecret: body.clientSecret })) });
      case 'connect': return Response.json({ url: await connectUrl() });
      case 'disconnect': return Response.json({ ok: true, ...(await disconnect()) });
      case 'test': return Response.json(await testMeet());
      default: return Response.json({ error: 'Unknown action — use saveClient, connect, disconnect or test.' }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof GoogleError) return fail(err);
    await logEvent(null, 'mc', 'google_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
