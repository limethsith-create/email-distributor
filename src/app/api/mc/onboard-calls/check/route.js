/**
 * POST /api/mc/onboard-calls/check — the hub calls this when it opens the
 * Trials screen or a trial (docs/ONBOARD-CALL.md §3): read the onboarding-call
 * inbox, send the reminders that are due, raise overdue alerts. Throttled to
 * ONBOARDCALL.checkEveryMinutes (shared with the job and Approve), so the hub
 * may call it on every open.
 *   → { ok, checked, newReplies, booked, remindersSent, skipped?: 'too soon', error? }
 */

import { checkOnboardCalls } from '@/lib/systems/onboardcall';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST() {
  try {
    return Response.json(await checkOnboardCalls());
  } catch (err) {
    console.error('[onboard-calls] check failed', err);
    return Response.json({ ok: false, checked: 0, newReplies: 0, booked: 0, remindersSent: 0, error: String(err?.message || err) }, { status: 500 });
  }
}
