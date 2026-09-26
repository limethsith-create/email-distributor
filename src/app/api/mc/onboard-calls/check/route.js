/**
 * POST /api/mc/onboard-calls/check — the hub calls this when it opens the
 * Trials screen or a trial (docs/ONBOARD-CALL.md §3): read the onboarding-call
 * inbox, send the reminders that are due, raise overdue alerts. Throttled to
 * ONBOARDCALL.checkEveryMinutes (shared with the job and Approve), so the hub
 * may call it on every open.
 *   → { ok, checked, newReplies, booked, remindersSent, skipped?: 'too soon', error?, autobuy? }
 *
 * The same call looks at the CheapInboxes account (docs/AUTO-BUY.md §4) while a
 * key is set — in parallel, throttled to CHEAPINBOXES.checkEveryMinutes (shared
 * with the `autobuy` job): new purchases found, matched and connected, the setup
 * checks moved on. `autobuy` = { ok, found, connected, ready, unmatched,
 * problems, skipped?, error? } is in the answer only when a key is set.
 *
 * Without the heartbeat it also carries the intake on (systems/carry.js): the
 * research, the market count, the Price Scout, a manual purchase's setup round,
 * the welcome email and the onboarding page's reminders — the tick's own jobs
 * and claims, nothing twice. `carried: [{ job, clientId }]` when any ran.
 */

import { checkOnboardCalls } from '@/lib/systems/onboardcall';
import { syncQuietly } from '@/lib/systems/autobuy';
import { carryIntake } from '@/lib/systems/carry';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // the CheapInboxes look may move a setup round on (DNS, SMTP, IMAP)

export async function POST() {
  const [calls, autobuy] = await Promise.all([
    checkOnboardCalls().then((r) => ({ r }), (err) => ({ err })),
    syncQuietly({ reason: 'hub', deadline: Date.now() + 22000 }),
  ]);
  // After both (never at the same time as the CheapInboxes sync's own setup round).
  const carry = await carryIntake({ deadline: Date.now() + 25000 });
  const extra = { ...(autobuy && autobuy.skipped !== 'not_set_up' ? { autobuy } : {}), ...(carry.ran?.length ? { carried: carry.ran } : {}) };
  if (calls.err) {
    console.error('[onboard-calls] check failed', calls.err);
    return Response.json({ ok: false, checked: 0, newReplies: 0, booked: 0, remindersSent: 0, error: String(calls.err?.message || calls.err), ...extra }, { status: 500 });
  }
  return Response.json({ ...calls.r, ...extra });
}
