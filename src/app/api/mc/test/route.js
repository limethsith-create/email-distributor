/**
 * Test Mode API (SPEC §10.7). Admin session required (middleware).
 *   GET                                  → status of the `_test` client
 *   POST {action:'start', from}          → from = 'apply' | 'sending'
 *   POST {action:'reset'}
 *   POST {action:'jump', day}
 *   POST {action:'simulate', kind}       → reply kinds, booking, held, noshow, sends, bounce_spike, heartbeat_loss
 *   POST {action:'tick'}                 → run every job for `_test` now (normal due rules)
 */

import { startTest, resetTest, jumpToDay, simulate, testStatus, REPLY_KINDS, TEST_ID } from '@/lib/systems/testmode';
import { getEvents } from '@/lib/db/events';
import { runTick } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const status = await testStatus();
  return Response.json({ ...status, replyKinds: REPLY_KINDS, events: status.running ? await getEvents(TEST_ID, 80) : [] });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'start': return Response.json({ ok: true, ...(await startTest({ from: body.from === 'sending' ? 'sending' : 'apply' })) });
      case 'reset': return Response.json({ ok: true, ...(await resetTest()) });
      case 'jump': return Response.json({ ok: true, ...(await jumpToDay(Number(body.day))) });
      case 'simulate': return Response.json({ ok: true, ...(await simulate(String(body.kind))) });
      case 'tick': return Response.json({ ok: true, result: await runTick({ source: 'mc-test', clientId: TEST_ID }) });
      default: return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
