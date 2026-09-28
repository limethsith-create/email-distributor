/**
 * The client's dashboard (public; the signed page token, purpose `dashboard`,
 * is the only credential). GET ?token=… → page data (systems/clientdash.js).
 */

import { dashboardView } from '@/lib/systems/clientdash';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  try {
    const view = await dashboardView(token);
    return Response.json(view, { status: view.ok ? 200 : 404 });
  } catch (err) {
    console.error('[dashboard] view failed', err);
    return Response.json({ ok: false, error: 'Something went wrong loading this page. Please try again in a minute.' }, { status: 500 });
  }
}
