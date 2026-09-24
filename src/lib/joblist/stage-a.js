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
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { WARMUP_STATES } from '@/lib/db/client';
import { partsIn, ET } from '@/lib/time';
import { minuteKey, bucketKey, dailyAt } from '@/lib/joblist/helpers';

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
  async due({ now, clients }) {
    if (!(clients || []).some((c) => c.id !== 'aviance' && WARMUP_STATES.has(c.state))) return null;
    const p = et(now);
    if (p.hhmm < '06:20') return null;
    // A backlog (more reports than one run reads) is worked off in the
    // morning, 10 minutes apart; the rest of the day costs no extra read.
    if (p.hour < 12) try {
      const st = await kv.get(K.dmarcState());
      if (st?.more) return bucketKey(p, 10);
    } catch {}
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

export const JOBS = [onboardingNudge, queuePromote, market, pricescout, purchaseNudge, setupCheck, welcome, auth, blacklist, dmarc, bookingTest, bookingReminder, promoCheck];
