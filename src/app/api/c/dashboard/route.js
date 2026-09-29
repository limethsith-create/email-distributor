/**
 * The client's page — the shared view (public; the signed page token, purpose
 * `dashboard`, is the only credential). GET ?token=… → page data
 * (systems/clientdash.js, docs/HUB-API.md "The client's page (shared view)").
 * 404 for an unknown, expired or replaced link; 429 past 120 calls a minute.
 */

import { dashboardView, overLimit } from '@/lib/systems/clientdash';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  try {
    if (overLimit(token)) return Response.json({ ok: false, error: 'Too many requests — wait a minute and refresh.' }, { status: 429 });
    const view = await dashboardView(token);
    return Response.json(view, { status: view.ok ? 200 : 404, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[dashboard] view failed', err);
    return Response.json({ ok: false, error: 'Something went wrong loading this page. Please try again in a minute.' }, { status: 500 });
  }
}
