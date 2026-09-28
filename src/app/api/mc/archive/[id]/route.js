/**
 * GET /api/mc/archive/{id} → the saved archive as JSON (systems/archive.js):
 * { id, createdAt, totals, days, sent, replies, bounces, leads }.
 * `?section=days|sent|replies|bounces|leads` returns { id, createdAt, totals, <section> } only
 * (smaller downloads for a big archive). Owner only.
 */

import { readArchive } from '@/lib/systems/archive';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SECTIONS = new Set(['days', 'sent', 'replies', 'bounces', 'leads']);
const ID_RE = /^arc-[0-9]{8}-[0-9]{6}-[a-z0-9]{4,8}$/;

export async function GET(request, { params }) {
  if (request.headers.get('x-hub-role') === 'employee') return Response.json({ error: 'Read-only: ask the owner to do this.' }, { status: 403 });
  const id = String(params?.id || '');
  if (!ID_RE.test(id)) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    const archive = await readArchive(id);
    if (!archive) return Response.json({ error: 'not found' }, { status: 404 });
    const section = new URL(request.url).searchParams.get('section');
    if (section && SECTIONS.has(section)) {
      return Response.json({ id: archive.id, createdAt: archive.createdAt, totals: archive.totals, [section]: archive[section] });
    }
    return new Response(JSON.stringify(archive), {
      headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${id}.json"` },
    });
  } catch (err) {
    return Response.json({ error: err?.message || 'The archive did not load.' }, { status: 500 });
  }
}
