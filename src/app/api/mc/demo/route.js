/**
 * /api/mc/demo — the hub's "Test run": two finished example clients to click
 * through (systems/demo.js, docs/HUB-API.md "Test run (demo clients)"). Owner
 * only: the middleware denies employees the whole path; both methods check again.
 *
 *   GET                         → { loaded, ids, at }
 *   POST { action: 'load' }     → { ok, ids }       (a second load replaces the first)
 *   POST { action: 'remove' }   → { ok, removed }   (every key the test run wrote)
 */

import { demoStatus, loadDemo, removeDemo } from '@/lib/systems/demo';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const READ_ONLY = 'Read-only: ask the owner to do this.';
const isEmployee = (request) => request.headers.get('x-hub-role') === 'employee';

export async function GET(request) {
  if (isEmployee(request)) return Response.json({ error: READ_ONLY }, { status: 403 });
  try {
    return Response.json(await demoStatus());
  } catch (err) {
    return Response.json({ error: err?.message || 'The test run status did not load.' }, { status: 500 });
  }
}

export async function POST(request) {
  if (isEmployee(request)) return Response.json({ error: READ_ONLY }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'load') return Response.json(await loadDemo());
    if (body.action === 'remove') return Response.json(await removeDemo());
    return Response.json({ error: 'action must be load or remove' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err?.message || 'The test run did not finish.' }, { status: 500 });
  }
}
