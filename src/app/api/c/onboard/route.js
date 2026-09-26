/**
 * POST /api/c/onboard — the client's onboarding page API (SPEC §6.2).
 * Public (signed token): token in the body (`token`) or the `x-page-token`
 * header. Actions: load | save (partial, save-and-resume) | accept (the
 * click-to-accept agreement, which then starts the Market Counter).
 */

import { after } from 'next/server';
import { readToken } from '@/lib/pagetokens';
import { loadOnboarding, saveOnboarding, acceptAgreement } from '@/lib/systems/onboarding';
import { carryIntake } from '@/lib/systems/carry';

export const dynamic = 'force-dynamic';
// The agreement runs the market count for up to 20 s; after the answer the count (if it needs
// longer) and the Price Scout carry on here when the heartbeat is not running (systems/carry.js).
export const maxDuration = 60;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const raw = body.token || request.headers.get('x-page-token');
  const t = await readToken(raw, { purpose: 'onboarding' });
  if (!t) return Response.json({ error: 'This link has expired or is not valid. Reply to our email and we will send a new one.' }, { status: 401 });
  const id = t.clientId;
  try {
    switch (body.action) {
      case 'load':
        return Response.json(await loadOnboarding(id));
      case 'save': {
        const r = await saveOnboarding(id, body.fields || {});
        return Response.json({ ...r, ...(await loadOnboarding(id)) });
      }
      case 'accept': {
        const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
        const r = await acceptAgreement(id, { name: body.name, title: body.title, agree: body.agree === true, ip, deadline: Date.now() + 20000 });
        if (!r.ok) return Response.json(r, { status: 400 });
        try { after(() => carryIntake({ clientId: id, deadline: Date.now() + 30000 })); } catch { /* not inside a request (tests) */ }
        return Response.json({ ...r, ...(await loadOnboarding(id)) });
      }
      default:
        return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error('[onboard]', id, err?.message);
    return Response.json({ error: 'Something went wrong saving this page. Your earlier answers are kept; please try again in a minute.' }, { status: 500 });
  }
}
