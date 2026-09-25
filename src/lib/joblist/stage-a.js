/**
 * Scheduler jobs for Stage A (SPEC §5). Job shape: see src/lib/jobs.js.
 *
 * Cheap `due` checks: they read only the client hash the tick already
 * loaded (state + `intakeStep`, a small flag the intake systems set while
 * work is in flight), so an idle client costs no extra Redis reads. Every
 * job skips `aviance` and respects the §4 state guards.
 *
 *  onboarding-nudge  daily 10:00 ET      onboarding            Day +2/+4 reminders, +7 close
 *  queue-promote     daily 10:05 ET      (global)              pop queue:trial into free slots
 *  onboard-calls     every ONBOARDCALL.checkEveryMinutes (global) while an onboarding call is open:
 *                    inbox (replies, bookings), reminders, overdue (docs/ONBOARD-CALL.md)
 *  market            every minute        onboarding + 'market' continue the count; hourly when waiting
 *  pricescout        every minute        awaiting_purchase + 'pricescout'
 *  purchase-nudge    hourly              awaiting_purchase     12 h reminder, 48 h escalation
 *  setup-check       every minute while running, else hourly   setup_check
 *  welcome           hourly              warming + 'welcome'   retry welcome_two_dates
 *  auth              daily 06:00 ET      warming..extension    SPF/DKIM/DMARC/MX
 *  blacklist         daily 06:10 ET      warming..extension    DNSBL
 *  dmarc             daily 06:20 ET      (global)              DMARC reports; every 10 min while a backlog remains
 *  booking-test      hourly              warming..extension    Day −4 and on calendar URL change
 *  booking-reminder  daily 10:00 ET      warming / ready       until "It worked" is tapped
 *  promo-check       monthly, 1st 09:00  (global)              expired promos, Cloudflare .com price
 *  research          every minute        researchStep=running  Applicant Research (Intake v2), bounded + resumable
 *  registrar-prices  monthly, 1st 09:10  (global)              live Porkbun prices (keyless) for the shopping list
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { WARMUP_STATES } from '@/lib/db/client';
import { partsIn, ET } from '@/lib/time';
import { minuteKey, bucketKey, dailyAt } from '@/lib/joblist/helpers';
import { onClientClock } from '@/lib/joblist/helpers';

const skip = (client) => !client || client.id === 'aviance';
const hourKey = (p) => `${p.dayKey}T${String(p.hour).padStart(2, '0')}`;
const et = (now) => partsIn(ET, now);

const onboardingNudge = {
  name: 'onboarding-nudge',
  scope: 'client',
  cost: 3,
  minBudgetMs: 6000,
  async due({ client, now }) {
    if (skip(client) || client.state !== 'onboarding') return null;
    return dailyAt(et(now), '10:00');
  },
  async run({ clientId, now }) {
    const { runOnboardingNudge } = await import('@/lib/systems/gatekeeper');
    return runOnboardingNudge({ clientId, now });
  },
};

const queuePromote = {
  name: 'queue-promote',
  scope: 'global',
  cost: 3,
  minBudgetMs: 6000,
  async due({ now, clients }) {
    if (!(clients || []).some((c) => c.state === 'queued')) return null;
    return dailyAt(et(now), '10:05');
  },
  async run({ now }) {
    const { promoteFromQueue } = await import('@/lib/systems/gatekeeper');
    return promoteFromQueue({ now });
  },
};

const market = {
  name: 'market',
  scope: 'client',
  cost: 4,
  minBudgetMs: 10_000,
  claimTtl: 7200,
  async due({ client, now }) {
    if (skip(client) || client.state !== 'onboarding') return null;
    if (client.intakeStep === 'market') return minuteKey(et(now));
    if (client.intakeStep === 'market_wait') return hourKey(et(now));
    return null;
  },
  async run({ clientId, now, deadline }) {
    const { runMarketCount } = await import('@/lib/systems/market');
    return runMarketCount(clientId, { now, deadline: deadline - 1000 });
  },
};

const pricescout = {
  name: 'pricescout',
  scope: 'client',
  cost: 4,
  minBudgetMs: 12_000,
  claimTtl: 600,
  async due({ client, now }) {
    if (skip(client) || client.state !== 'awaiting_purchase' || client.intakeStep !== 'pricescout') return null;
    return minuteKey(et(now));
  },
  async run({ clientId, now, deadline }) {
    const { runPriceScout } = await import('@/lib/systems/pricescout');
    return runPriceScout(clientId, { now, deadline: deadline - 1000 });
  },
};

const purchaseNudge = {
  name: 'purchase-nudge',
  scope: 'client',
  cost: 2,
  claimTtl: 7200,
  async due({ client, now }) {
    if (skip(client) || client.state !== 'awaiting_purchase') return null;
    return hourKey(et(now));
  },
  async run({ clientId, now }) {
    const { runPurchaseNudge } = await import('@/lib/systems/pricescout');
    return runPurchaseNudge({ clientId, now });
  },
};

const setupCheck = {
  name: 'setup-check',
  scope: 'client',
  cost: 5,
  minBudgetMs: 15_000,
  claimTtl: 7200,
  async due({ client, now }) {
    if (skip(client) || client.state !== 'setup_check') return null;
    const p = et(now);
    return client.intakeStep === 'setup_running' ? minuteKey(p) : hourKey(p);
  },
  async run({ clientId, now, deadline }) {
    const { runSetupCheck } = await import('@/lib/systems/setupcheck');
    return runSetupCheck(clientId, { now, deadline: deadline - 1000 });
  },
};

const welcome = {
  name: 'welcome',
  scope: 'client',
  cost: 2,
  claimTtl: 7200,
  async due({ client, now }) {
    if (skip(client) || client.state !== 'warming' || client.intakeStep !== 'welcome') return null;
    return hourKey(et(now));
  },
  async run({ clientId, now }) {
    const { sendWelcome } = await import('@/lib/systems/setupcheck');
    return sendWelcome(clientId, { now });
  },
};

const LIVE_DOMAIN = new Set(['warming', 'ready', 'sending', 'paused', 'extension']);

const auth = {
  name: 'auth',
  scope: 'client',
  cost: 3,
  minBudgetMs: 6000,
  async due({ client, now }) {
    if (skip(client) || !LIVE_DOMAIN.has(client.state)) return null;
    return dailyAt(et(now), '06:00');
  },
  async run({ clientId, now }) {
    const { runAuthCheck } = await import('@/lib/systems/authguard');
    return runAuthCheck({ clientId, now });
  },
};

const blacklist = {
  name: 'blacklist',
  scope: 'client',
  cost: 3,
  minBudgetMs: 6000,
  async due({ client, now }) {
    if (skip(client) || !LIVE_DOMAIN.has(client.state)) return null;
    return dailyAt(et(now), '06:10');
  },
  async run({ clientId, now }) {
    const { runBlacklistCheck } = await import('@/lib/systems/authguard');
    return runBlacklistCheck({ clientId, now });
  },
};

const dmarc = {
  name: 'dmarc',
  scope: 'global',
  cost: 5,
  minBudgetMs: 14_000,
  claimTtl: 86400,
  async due({ now, clients, heartbeat }) {
    if (!(clients || []).some((c) => c.id !== 'aviance' && WARMUP_STATES.has(c.state))) return null;
    const p = et(now);
    if (p.hhmm < '06:20') return null;
    // A backlog (more reports than one run reads) is worked off in the
    // morning, 10 minutes apart. The scan mirrors its `more` flag onto the
    // heartbeat hash the tick already read, so this costs no Redis read.
    if (p.hour < 12 && heartbeat?.dmarcMore === '1') return bucketKey(p, 10);
    return p.dayKey;
  },
  async run({ now, clients }) {
    const { runDmarcScan } = await import('@/lib/systems/authguard');
    return runDmarcScan({ now, clients });
  },
};

const bookingTest = {
  name: 'booking-test',
  scope: 'client',
  cost: 4,
  minBudgetMs: 12_000,
  claimTtl: 7200,
  async due({ client, now }) {
    if (skip(client) || !['warming', 'ready', 'sending', 'extension'].includes(client.state)) return null;
    return hourKey(et(now));
  },
  async run({ clientId, now }) {
    const { runBookingTest } = await import('@/lib/systems/bookingtest');
    return runBookingTest(clientId, { now });
  },
};

const bookingReminder = {
  name: 'booking-reminder',
  scope: 'client',
  cost: 3,
  async due({ client, now }) {
    if (skip(client) || !['warming', 'ready'].includes(client.state)) return null;
    return dailyAt(et(now), '10:00');
  },
  async run({ clientId, now }) {
    const { runBookingReminder } = await import('@/lib/systems/bookingtest');
    return runBookingReminder({ clientId, now });
  },
};

// Intake v2: Applicant Research continues every minute while the client hash
// says `researchStep = running` (set when an application arrives; cleared
// when done or failed). Reads nothing beyond the client hash to decide.
const research = {
  name: 'research',
  scope: 'client',
  cost: 3,
  minBudgetMs: 8000,
  claimTtl: 600,
  async due({ client, now }) {
    if (skip(client) || client.researchStep !== 'running') return null;
    return minuteKey(et(now));
  },
  async run({ clientId, now, deadline }) {
    const { runResearch } = await import('@/lib/systems/research');
    return runResearch(clientId, { now, deadline: deadline - 1000 });
  },
};

// Intake v2: live registrar prices from keyless public APIs (Porkbun), monthly.
const registrarPrices = {
  name: 'registrar-prices',
  scope: 'global',
  cost: 2,
  minBudgetMs: 6000,
  claimTtl: 40 * 86400,
  async due({ now }) {
    const p = et(now);
    return p.dayKey.endsWith('-01') && p.hhmm >= '09:10' ? p.monthKey : null;
  },
  async run({ now }) {
    const { runRegistrarPriceRefresh } = await import('@/lib/systems/domains');
    return runRegistrarPriceRefresh({ now });
  },
};

// Onboarding call (docs/ONBOARD-CALL.md): read the onboarding-call inbox, send
// the reminders that are due, raise overdue alerts — only while some client's
// hash (already loaded by the tick) says its onboarding call is open. Shares
// one throttle with the hub's check and the check after Approve. The same
// check reads every other client's mail into their conversation and sends the
// reply bot's answers (docs/REPLYBOT-MEET.md) — no extra runs of its own.
const onboardCalls = {
  name: 'onboard-calls',
  scope: 'global',
  cost: 4,
  minBudgetMs: 15_000,
  claimTtl: 600,
  async due({ now, clients }) {
    if (!(clients || []).some((c) => c.onboardCallOpen === '1' || c.onboardCallOpen === 1)) return null;
    const every = Math.max(1, Number(await cfg(null, 'ONBOARDCALL.checkEveryMinutes')) || 2);
    return bucketKey(et(now), every);
  },
  async run({ now, clients }) {
    const { checkOnboardCalls } = await import('@/lib/systems/onboardcall');
    return checkOnboardCalls({ now, clients });
  },
};

const promoCheck = {
  name: 'promo-check',
  scope: 'global',
  cost: 3,
  minBudgetMs: 12_000,
  claimTtl: 40 * 86400,
  async due({ now }) {
    const p = et(now);
    return p.dayKey.endsWith('-01') && p.hhmm >= '09:00' ? p.monthKey : null;
  },
  async run({ now }) {
    const { runPromoCheck } = await import('@/lib/systems/pricescout');
    return runPromoCheck({ now });
  },
};

export const JOBS = [onboardingNudge, queuePromote, onboardCalls, research, market, pricescout, purchaseNudge, setupCheck, welcome, auth, blacklist, dmarc, bookingTest, bookingReminder, promoCheck, registrarPrices].map(onClientClock);
