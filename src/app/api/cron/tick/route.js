/**
 * The single heartbeat entry (SPEC §5). cron-job.org calls it every minute
 * and GitHub Actions every 5 minutes, both with Authorization: Bearer
 * CRON_SECRET. Without the secret: 401. Healthchecks.io is pinged only after
 * a tick that completed.
 */

import { runTick } from '@/lib/scheduler';
import { pingHealthcheck } from '@/lib/systems/watchdog';
import { safeEqual } from '@/lib/crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: the tick never runs open
  const header = request.headers.get('authorization') || '';
  return safeEqual(header, `Bearer ${secret}`);
}

export async function GET(request) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || request.headers.get('x-tick-source') || 'unknown').slice(0, 20);
  try {
    const result = await runTick({ source });
    // Test Mode "simulate heartbeat loss" suppresses the dead-man ping so Healthchecks fires
    // (a field on the heartbeat hash the tick already read: no extra Redis command).
    const until = result.heartbeat?.skipPingsUntil;
    const skip = until && Date.parse(until) > Date.now();
    const hc = skip ? { ok: false, skipped: 'test: heartbeat loss' } : await pingHealthcheck(process.env.HC_PING_URL);
    const { heartbeat, ...summary } = result;
    return Response.json({ ok: true, source, ...summary, healthcheck: hc.ok ? 'pinged' : hc.skipped || hc.error || 'failed' });
  } catch (err) {
    console.error('[tick] failed', err);
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

export const POST = GET;
