/**
 * Day 30 decision page API (SPEC §9.4). Public route: the signed page token
 * (purpose decision:*) is the only credential.
 *   GET  ?token=…                → page data
 *   POST {token, action}         → action ∈ start | talk | notnow
 */

import { decisionView, decide } from '@/lib/systems/decision';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  try {
    const view = await decisionView(token);
    return Response.json(view, { status: view.ok ? 200 : 404 });
  } catch (err) {
    console.error('[decide] view failed', err);
    return Response.json({ ok: false, error: 'Something went wrong loading this page. Please try again in a minute.' }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!['start', 'talk', 'notnow'].includes(body.action)) return Response.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
  try {
    const res = await decide(String(body.token || ''), body.action);
    return Response.json(res, { status: res.ok ? 200 : 409 });
  } catch (err) {
    console.error('[decide] action failed', err);
    const { alertOwner } = await import('@/lib/notify');
    await alertOwner('job_failing', { scope: 'decide-page', vars: { job: 'decision page', scope: body.action }, body: `A client pressed "${body.action}" on the Day 30 page and it failed: ${err.message}`, did: 'Nothing changed; the client saw an error and can press again.' }).catch(() => {});
    return Response.json({ ok: false, error: 'That did not go through. Please try again, or reply to our last email.' }, { status: 500 });
  }
}
