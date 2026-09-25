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
import { onClientClock } from '@/lib/joblist/helpers';
import { isTrialClient, ccfg } from '@/lib/systems/stagec-common';

const trial = (client) => isTrialClient(client?.id);
const inStates = (client, states) => trial(client) && states.includes(client.state);
const hourKey = (p) => `${p.dayKey}T${String(p.hour).padStart(2, '0')}`;

// `converted` keeps sending on the trial pair (SPEC §9.8), so the send job,
// bounce scans and the Emergency Runner still run for it; the trial-only
// jobs (client watch, pace) do not.
const SEND_STATES = ['ready', 'sending', 'extension', 'converted'];
const RUN_STATES = ['sending', 'paused', 'extension'];
const DELIVERY_STATES = ['sending', 'paused', 'extension', 'converted'];
const REPLY_STATES = ['sending', 'paused', 'extension', 'deciding', 'converted', 'not_now'];
const BOOKING_STATES = ['sending', 'paused', 'extension', 'deciding', 'converted', 'not_now'];

// Stagger per-client polling so three clients do not all open IMAP in the same minute.
const offsetOf = (id) => [...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7);
const staggered = (p, minutes, id) => {
  const shifted = { ...p, minuteOfDay: p.minuteOfDay - (offsetOf(id) % minutes) };
  if (shifted.minuteOfDay < 0) return null; // just after midnight: wait for the first full bucket
  return bucketKey(shifted, minutes);
};

const send = {
  name: 'send',
  scope: 'client',
  cost: 3,
  minBudgetMs: 8_000,
  claimTtl: 180,
  async due({ client, now }) {
    if (!inStates(client, SEND_STATES)) return null;
    const p = partsIn(ET, now);
    if (!usBusinessHours(p)) return null;
    // The sender stores when it is next worth running (pacing, caps, no lead
    // in window yet) on the client hash; until then this costs nothing.
    if (client.state !== 'ready' && client.sendNextDueAt && Date.parse(client.sendNextDueAt) > now.getTime()) return null;
    return minuteKey(p);
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
    // Every inbox every REPLIES.usHoursMinutes (5) in US hours, every
    // REPLIES.offHoursMinutes (20) otherwise (Redis budget, integration.md).
    const every = usBusinessHours(p) ? await ccfg(client.id, 'REPLIES.usHoursMinutes') : await ccfg(client.id, 'REPLIES.offHoursMinutes');
    return staggered(p, every, client.id);
  },
  async run({ clientId, now, deadline }) {
    const { runReplies } = await import('@/lib/systems/replies');
    return runReplies(clientId, { now, deadline });
  },
};

const hotChaser = {
  name: 'hot-chaser',
  scope: 'client',
  cost: 2,
  claimTtl: 7200,
  async due({ client, now }) {
    if (!inStates(client, REPLY_STATES) || client.bookingWatch !== '1') return null;
    return hourKey(partsIn(ET, now));
  },
  async run({ clientId, now }) {
    const { runChasers } = await import('@/lib/systems/replies');
    return runChasers(clientId, { now });
  },
};

const bounces = {
  name: 'bounces',
  scope: 'client',
  cost: 4,
  minBudgetMs: 8_000,
  claimTtl: 600,
  async due({ client, now }) {
    if (!inStates(client, DELIVERY_STATES)) return null;
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
    if (!inStates(client, DELIVERY_STATES)) return null;
    const p = partsIn(ET, now);
    // Every tick while a request is waiting or an emergency is running (read
    // from the client hash the tick already loaded); a full trigger scan of
    // the counters every 5 minutes otherwise (free-tier command budget).
    if (client.emergencyRequested || client.emergencyActive === '1') return minuteKey(p);
    // Full trigger scan every 15 min after new sends (the sender sets
    // sentSinceScan), and once a day at noon for the time-based triggers
    // (no replies for 2 days, the green-day count while halved).
    if (client.sentSinceScan === '1' && usBusinessHours(p)) return staggered(p, 15, client.id);
    return dailyAt(p, '12:00');
  },
  async run({ clientId, now }) {
    const { runEmergency } = await import('@/lib/systems/emergency');
    const r = await runEmergency(clientId, { now });
    return { ...(r || {}), _clientFields: { sentSinceScan: '0' } };
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

// Bookings, reminders, the no-show ladder and the hot-lead chaser only have
// work after the first hot lead (client.bookingWatch, set by the Reply
// Handler): before that no booking link has gone to anyone.
const watching = (client) => inStates(client, BOOKING_STATES) && client.bookingWatch === '1';

const bookings = {
  name: 'bookings',
  scope: 'client',
  cost: 4,
  minBudgetMs: 8_000,
  claimTtl: 900,
  async due({ client, now }) {
    if (!watching(client)) return null;
    const p = partsIn(ET, now);
    // Calendar confirmations: every 15 min in US hours, hourly otherwise (handoff is due within 2 h).
    return usBusinessHours(p) ? staggered(p, 15, client.id) : hourKey(p);
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
    if (!watching(client)) return null;
    // 24 h / 1 h reminders and the +1 h tap: 15-minute resolution is enough.
    return bucketKey(partsIn(ET, now), 15);
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
    if (!watching(client)) return null;
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
    // Hourly 09:00–11:59 so a run cut short by the tick budget finishes the
    // same morning (each follow-up is deduped per lead and date).
    return p.hour >= 9 && p.hour < 12 ? hourKey(p) : null;
  },
  async run({ clientId, now, deadline }) {
    const { runNotNow } = await import('@/lib/systems/replies');
    return runNotNow(clientId, { now, deadline });
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
    // Once a day from 18:00; the run checks whether today is a pace day
    // (reading the trial hash here would cost a read every tick until 22:00).
    return p.dayKey;
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

// ── Leads + Copy v2: the verification waterfall ─────────────────────────────
// Leads exist from `warming` on (the Lead Finder runs during the build weeks),
// so verification runs from then, while the client has leads waiting
// (client.verifyPending, set when a batch lands) and not before
// client.verifyNextDueAt (tomorrow when every free budget is spent).
const VERIFY_STATES = ['warming', 'ready', 'sending', 'paused', 'extension', 'converted'];

const leadVerify = {
  name: 'lead-verify',
  scope: 'client',
  cost: 2,
  minBudgetMs: 9_000,
  claimTtl: 600,
  async due({ client, now }) {
    if (!inStates(client, VERIFY_STATES) || client.verifyPending !== '1') return null;
    if (client.verifyNextDueAt && Date.parse(client.verifyNextDueAt) > now.getTime()) return null;
    return bucketKey(partsIn(ET, now), await ccfg(client.id, 'VERIFY.everyMin'));
  },
  async run({ clientId, client, now, deadline }) {
    const { runVerify } = await import('@/lib/systems/verify');
    return runVerify(clientId, { now, deadline, client });
  },
};

const leadVerifyDaily = {
  name: 'lead-verify-daily',
  scope: 'client',
  cost: 3,
  minBudgetMs: 8_000,
  claimTtl: 2 * 86400,
  async due({ client, now }) {
    if (!inStates(client, VERIFY_STATES)) return null;
    return dailyAt(partsIn(ET, now), '00:10');
  },
  async run({ clientId, now }) {
    const { runVerifyDaily } = await import('@/lib/systems/verify');
    const r = await runVerifyDaily(clientId, { now });
    return { ...r, _clientFields: r.queued ? { verifyPending: '1', verifyNextDueAt: '' } : {} };
  },
};

export const JOBS = [emergency, send, reminders, clientWatch, noshow, notnow, pace, replies, hotChaser, bounces, bookings, learning, leadVerify, leadVerifyDaily].map(onClientClock);
