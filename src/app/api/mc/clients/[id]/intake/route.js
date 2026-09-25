/**
 * /api/mc/clients/[id]/intake — Stage A status and owner actions for one
 * client (admin). GET: application, market count, shopping list, setup
 * checks, booking test. POST {action}:
 *   marketOverride {note}   accept the market as big enough (SPEC §6.3)
 *   rerunMarket             restart the market count
 *   rerunPriceScout         rebuild and resend the shopping list
 *   rerunSetup              start a full Setup Checker round now
 *   rerunBookingTest        test the calendar link now
 *   resendWelcome           retry welcome_two_dates
 *   rerunResearch           research the applicant again (website + Google listing)
 *   approveApplication      owner approves a website application (→ onboarding with the one
 *                           accepted_call email, or the queue); the onboarding-call check runs in after()
 *   declineApplication {reason}  owner declines it; the reason is emailed to the applicant
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { getClient, getProfile, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { overrideMarket, runMarketCount } from '@/lib/systems/market';
import { getShopping, runPriceScout } from '@/lib/systems/pricescout';
import { startSetupCheck, runSetupCheck, readChecks, sendWelcome } from '@/lib/systems/setupcheck';
import { runBookingTest } from '@/lib/systems/bookingtest';
import { asArray } from '@/lib/systems/intake-io';
import { approveApplication, declineApplication } from '@/lib/systems/gatekeeper';
import { after } from 'next/server';
import { rerunResearch, researchToEnd } from '@/lib/systems/research';
import { checkOnboardCallsQuietly } from '@/lib/systems/onboardcall';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const [application, market, shopping, setup, profile] = await Promise.all([
    kv.hgetall(K.application(id)).catch(() => null),
    kv.hgetall(K.market(id)).catch(() => null),
    getShopping(id),
    readChecks(id),
    getProfile(id),
  ]);
  const m = market || {};
  return Response.json({
    client,
    application: application || {},
    market: { status: m.status || null, round: m.round || null, source: m.source || null, queries: asArray(m.queries), uniqueIds: asArray(m.ids).length, count: Number(m.count) || 0, error: m.error || null, estimate: profile.marketEstimate ?? null, override: profile.marketOverride === '1' || profile.marketOverride === 1 },
    shopping,
    setup: { phase: setup.domain.setupPhase || null, checks: setup.checks, dmarcPassRate7d: setup.domain.dmarcPassRate7d ?? null },
    booking: { tested: profile.bookingTested === '1' || profile.bookingTested === 1, status: profile.bookingCheckStatus || null, problems: asArray(profile.bookingProblems), host: profile.bookingHost || null, firstSlotDays: profile.bookingFirstSlotDays ?? null, slots7d: profile.bookingSlots7d ?? null, testedAt: profile.bookingTestAt || null },
  });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const deadline = Date.now() + 20000;
  try {
    switch (body.action) {
      case 'rerunResearch':
      {
        const result = await rerunResearch(id, { deadline });
        // The whole-site pass takes longer than one request: it carries on right after the answer.
        if (result.status === 'pending') { try { after(() => researchToEnd(id, 52_000)); } catch { /* tests */ } }
        return Response.json({ ok: true, result });
      }
      case 'approveApplication':
      {
        const result = await approveApplication(id);
        // The heartbeat is not running yet: the onboarding-call check (inbox, reminders,
        // overdue) runs right after the answer too (throttled, never throws).
        try { after(() => checkOnboardCallsQuietly()); } catch { /* not inside a request (tests) */ }
        return Response.json({ ok: true, ...result });
      }
      case 'declineApplication':
        if (!String(body.reason || '').trim()) return Response.json({ error: 'Write the reason — it goes to the applicant.' }, { status: 400 });
        return Response.json({ ok: true, ...(await declineApplication(id, body.reason)) });
      case 'marketOverride':
        return Response.json({ ok: true, result: await overrideMarket(id, { note: body.note || '' }) });
      case 'rerunMarket':
        await kv.del(K.market(id));
        await updateClient(id, { intakeStep: 'market' });
        return Response.json({ ok: true, result: await runMarketCount(id, { deadline }) });
      case 'rerunPriceScout':
        await kv.del(K.onceClaim('shopping_list', id, 'sent'));
        await kv.hdel(K.shopping(id), 'sentAt', 'reminded12At', 'escalatedAt');
        await updateClient(id, { intakeStep: 'pricescout' });
        await logEvent(id, 'mc', 'pricescout_rerun', {});
        return Response.json({ ok: true, result: await runPriceScout(id, { deadline }) });
      case 'rerunSetup':
        if (client.state !== 'setup_check') return Response.json({ error: `client is in ${client.state}` }, { status: 409 });
        await startSetupCheck(id, { all: true });
        return Response.json({ ok: true, result: await runSetupCheck(id, { deadline }) });
      case 'rerunBookingTest':
        return Response.json({ ok: true, result: await runBookingTest(id, { force: true }) });
      case 'resendWelcome':
        return Response.json({ ok: true, result: await sendWelcome(id) });
      default:
        return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    await logEvent(id, 'mc', 'intake_action_failed', { action: body.action, error: String(err?.message || err).slice(0, 200) });
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
