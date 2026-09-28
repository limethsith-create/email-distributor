/**
 * /api/mc/archive — the owner's own outreach history, saved and cleared
 * (systems/archive.js, docs/HUB-API.md "Outreach archive"). Owner only: the
 * middleware denies employees the whole path; the POST checks again.
 *
 *   GET                                      → { archives: [{ id, createdAt, totals, bytes, chunks, clearedAt?, cleared? }] }
 *   POST { action: 'save' }                  → { ok, id, totals }                (a snapshot; nothing is cleared)
 *   POST { action: 'clear', confirm: 'CLEAR' } → { ok, archiveId, totals, cleared: { leads, suppressed, keys } }
 */

import { listArchives, buildOutreachArchive, saveArchive, clearOutreach } from '@/lib/systems/archive';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const isEmployee = (request) => request.headers.get('x-hub-role') === 'employee';

export async function GET(request) {
  if (isEmployee(request)) return Response.json({ error: 'Read-only: ask the owner to do this.' }, { status: 403 });
  try {
    return Response.json({ archives: await listArchives() });
  } catch (err) {
    return Response.json({ error: err?.message || 'The archives did not load.' }, { status: 500 });
  }
}

export async function POST(request) {
  if (isEmployee(request)) return Response.json({ error: 'Read-only: ask the owner to do this.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'save') {
      const archive = await buildOutreachArchive();
      const entry = await saveArchive(archive);
      return Response.json({ ok: true, id: entry.id, totals: entry.totals });
    }
    if (body.action === 'clear') {
      return Response.json(await clearOutreach({ confirm: body.confirm }));
    }
    return Response.json({ error: 'action must be save or clear' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err?.message || 'That did not go through. Nothing was cleared.' }, { status: err?.status || 500 });
  }
}
