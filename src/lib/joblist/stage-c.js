/**
 * Scheduler jobs for Stage C (SPEC §5). Job shape: see src/lib/jobs.js.
 *
 * Every client job skips `aviance` (legacy engine) and checks client.state
 * in `due` so nothing runs for a client in the wrong state. IMAP jobs touch
 * one inbox per run; the send job at most one email per inbox.
 */

import { partsIn, ET, trialDay } from '@/lib/time';
import { isUsHoliday } from '@/lib/config';
import { minuteKey, bucketKey, usBusinessHours, dailyAt } from '@/lib/joblist/helpers';
import { isTrialClient, ccfg } from '@/lib/systems/stagec-common';

const trial = (client) => isTrialClient(client?.id);
const inStates = (client, states) => trial(client) && states.includes(client.state);
const hourKey = (p) => `${p.dayKey}T${String(p.hour).padStart(2, '0')}`;

const SEND_STATES = ['ready', 'sending', 'extension'];
const RUN_STATES = ['sending', 'paused', 'extension'];
const REPLY_STATES = ['sending', 'paused', 'extension', 'deciding', 'converted', 'not_now'];
const BOOKING_STATES = ['sending', 'paused', 'extension', 'deciding', 'converted', 'not_now'];

const send = {
  name: 'send',
  scope: 'client',
  cost: 3,
  minBudgetMs: 8_000,
  claimTtl: 180,
  async due({ client, now }) {
    if (!inStates(client, SEND_STATES)) return null;
    const p = partsIn(ET, now);
    return usBusinessHours(p) ? minuteKey(p) : null;
  },
  async run({ clientId, client, now, deadline }) {
    const { runSender } = await import('@/lib/systems/sender');
    return runSender(clientId, { now, deadline, client });
  },
};

const replies = {
  name: 'replies',
  scope: 'client',
  cost: 4,
  minBudgetMs: 8_000,
  claimTtl: 3600,
  async due({ client, now }) {
    if (!inStates(client, REPLY_STATES)) return null;
    const p = partsIn(ET, now);
    return usBusinessHours(p) ? minuteKey(p) : bucketKey(p, await ccfg(client.id, 'REPLIES.offHoursMinutes'));
  },
  async run({ clientId, now }) {
    const { runReplies } = await import('@/lib/systems/replies');
    return runReplies(clientId, { now });
  },
};

const bounces = {
  name: 'bounces',
  scope: 'client',
  cost: 4,
  minBudgetMs: 8_000,
  claimTtl: 600,
  async due({ client, now }) {
    if (!inStates(client, RUN_STATES)) return null;
    // Flags live on the client hash, which the tick has already loaded (no extra reads).
    const u = partsIn('UTC', now);
    const dailyDue = u.hour >= 13 && client.bounceDailyDay !== u.dayKey;
    if (!client.bounceScanWantedAt && !Number(client.bounceRoundLeft) && !dailyDue) return null;
    return bucketKey(partsIn(ET, now), 2);
  },
  async run({ clientId, now }) {
    const { runBounceScan } = await import('@/lib/systems/replies');
    return runBounceScan(clientId, { now });
  },
};

const emergency = {
  name: 'emergency',
  scope: 'client',
  cost: 1,
  claimTtl: 600,
  async due({ client, now }) {
    if (!inStates(client, RUN_STATES)) return null;
    const p = partsIn(ET, now);
    // Every tick while a request is waiting or an emergency is running (read
    // from the client hash the tick already loaded); a full trigger scan of
    // the counters every 5 minutes otherwise (free-tier command budget).
    if (client.emergencyRequested || client.emergencyActive === '1') return minuteKey(p);
    return bucketKey(p, 5);
  },
  async run({ clientId, now }) {
    const { runEmergency } = await import('@/lib/systems/emergency');
    return runEmergency(clientId, { now });
  },
};

const clientWatch = {
  name: 'client-watch',
  scope: 'client',
  cost: 2,
  claimTtl: 7200,
  async due({ client, now }) {
    if (!inStates(client, RUN_STATES)) return null;
    return hourKey(partsIn(ET, now));
  },
  async run({ clientId, now }) {
    const { runClientWatch } = await import('@/lib/systems/clientwatch');
    return runClientWatch(clientId, { now });
  },
};

const bookings = {
  name: 'bookings',
  scope: 'client',
  cost: 4,
  minBudgetMs: 8_000,
  claimTtl: 900,
  async due({ client, now }) {
    if (!inStates(client, BOOKING_STATES)) return null;
    return bucketKey(partsIn(ET, now), 5);
  },
  async run({ clientId, now }) {
    const { runBookings } = await import('@/lib/systems/bookings');
    return runBookings(clientId, { now });
  },
};

const reminders = {
  name: 'reminders',
  scope: 'client',
  cost: 2,
  claimTtl: 900,
  async due({ client, now }) {
    if (!inStates(client, BOOKING_STATES)) return null;
    return bucketKey(partsIn(ET, now), 5);
  },
  async run({ clientId, now }) {
    const { runReminders } = await import('@/lib/systems/bookings');
    return runReminders(clientId, { now });
  },
};

const noshow = {
  name: 'noshow',
  scope: 'client',
  cost: 2,
  claimTtl: 7200,
  async due({ client, now }) {
    if (!inStates(client, BOOKING_STATES)) return null;
    return hourKey(partsIn(ET, now));
  },
  async run({ clientId, now }) {
    const { runScorekeeper } = await import('@/lib/systems/scorekeeper');
    return runScorekeeper(clientId, { now });
  },
};

const notnow = {
  name: 'notnow',
  scope: 'client',
  cost: 2,
  claimTtl: 2 * 86400,
  async due({ client, now }) {
    if (!inStates(client, ['sending', 'extension', 'deciding'])) return null;
    const p = partsIn(ET, now);
    if (isUsHoliday(p.dayKey) || ['Sat', 'Sun'].includes(p.weekday)) return null;
    return dailyAt(p, '09:00');
  },
  async run({ clientId, now }) {
    const { runNotNow } = await import('@/lib/systems/replies');
    return runNotNow(clientId, { now });
  },
};

const pace = {
  name: 'pace',
  scope: 'client',
  cost: 2,
  claimTtl: 2 * 86400,
  async due({ client, now }) {
    if (!inStates(client, ['sending', 'extension'])) return null;
    const p = partsIn(ET, now);
    if (p.hour < 18 || p.hour >= 22) return null;
    const { getTrial } = await import('@/lib/db/client');
    const day = trialDay(await getTrial(client.id), now);
    const days = await ccfg(client.id, 'PACE.days');
    return days.includes(day) ? p.dayKey : null;
  },
  async run({ clientId, now }) {
    const { runPace } = await import('@/lib/systems/pace');
    return runPace(clientId, { now });
  },
};

const learning = {
  name: 'learning-weekly',
  scope: 'global',
  cost: 3,
  claimTtl: 8 * 86400,
  async due({ now }) {
    const p = partsIn(ET, now);
    return p.weekday === 'Mon' && p.hhmm >= '03:00' ? p.dayKey : null;
  },
  async run({ now }) {
    const { runLearningWeekly } = await import('@/lib/systems/learning');
    return runLearningWeekly({ now });
  },
};

export const JOBS = [emergency, send, reminders, clientWatch, noshow, notnow, pace, replies, bounces, bookings, learning];
