/**
 * Scheduler jobs for Stage D (SPEC §5). Job shape: see src/lib/jobs.js.
 *
 * Per-client jobs skip `aviance` (it has no trial) and read the client's own
 * clock, so the `_test` client runs a whole trial on its scaled clock
 * (src/lib/testclock.js). The two digests are global and include aviance.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { partsIn, ET, OWNER_TZ } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { dailyAt, bucketKey } from '@/lib/joblist/helpers';

const trialClient = (client) => client && client.id !== 'aviance';
const etParts = (client, now) => partsIn(ET, clientNow(client, now));

const dayJobs = {
  name: 'day-jobs',
  scope: 'client',
  cost: 6,
  minBudgetMs: 8000,
  claimTtl: 3 * 86400,
  async due({ client, now }) {
    if (!trialClient(client)) return null;
    const { DAYJOB_STATES } = await import('@/lib/systems/trialmanager');
    if (!DAYJOB_STATES.has(client.state)) return null;
    return dailyAt(etParts(client, now), await cfg(client.id, 'DAYJOBS.at'));
  },
  async run({ clientId, now }) {
    const { runDayJobs } = await import('@/lib/systems/trialmanager');
    return runDayJobs(clientId, { now });
  },
};

const day1Notice = {
  name: 'day1-notice',
  scope: 'client',
  cost: 2,
  claimTtl: 3600,
  async due({ client, now }) {
    if (!trialClient(client) || !['sending', 'paused', 'extension'].includes(client.state)) return null;
    let t = {};
    try { t = (await kv.hmget(K.trial(client.id), 'firstSendAt', 'day1NoticeAt')) || {}; } catch { return null; }
    if (!t.firstSendAt || t.day1NoticeAt) return null;
    return bucketKey(etParts(client, now), 15);
  },
  async run({ clientId, client, now }) {
    const { sendDay1Notice } = await import('@/lib/systems/trialmanager');
    return sendDay1Notice(clientId, clientNow(client, now));
  },
};

const friday = {
  name: 'friday',
  scope: 'client',
  cost: 5,
  minBudgetMs: 6000,
  claimTtl: 3 * 86400,
  async due({ client, now }) {
    if (!trialClient(client)) return null;
    const { FRIDAY_STATES } = await import('@/lib/systems/friday');
    if (!FRIDAY_STATES.has(client.state)) return null;
    const p = etParts(client, now);
    return p.weekday === 'Fri' ? dailyAt(p, '09:00') : null;
  },
  async run({ clientId, now }) {
    const { runFriday } = await import('@/lib/systems/friday');
    return runFriday(clientId, { now });
  },
};

const invoiceJob = {
  name: 'invoice',
  scope: 'client',
  cost: 3,
  claimTtl: 3 * 86400,
  async due({ client, now }) {
    if (!trialClient(client) || client.state !== 'converted') return null;
    return dailyAt(etParts(client, now), '10:00');
  },
  async run({ clientId, now }) {
    const { runInvoiceJob } = await import('@/lib/systems/invoice');
    return runInvoiceJob(clientId, { now });
  },
};

const cancelInboxes = {
  name: 'cancel-inboxes',
  scope: 'client',
  cost: 2,
  claimTtl: 3 * 86400,
  async due({ client, now }) {
    if (!trialClient(client) || client.state !== 'retired') return null;
    return dailyAt(etParts(client, now), '09:30');
  },
  async run({ clientId }) {
    const { cancelInboxesReminder } = await import('@/lib/systems/wrapup');
    return cancelInboxesReminder(clientId);
  },
};

const wrapup = {
  name: 'wrapup',
  scope: 'client',
  cost: 4,
  minBudgetMs: 8000,
  claimTtl: 3 * 86400,
  async due({ client, now }) {
    if (!trialClient(client) || client.state !== 'retired') return null;
    return dailyAt(etParts(client, now), '09:15');
  },
  async run({ clientId, client, now }) {
    const { deleteClientData } = await import('@/lib/systems/wrapup');
    return deleteClientData(clientId, { now: clientNow(client, now) });
  },
};

const morning = {
  name: 'morning',
  scope: 'global',
  cost: 5,
  minBudgetMs: 8000,
  claimTtl: 3 * 86400,
  async due({ now }) { return dailyAt(partsIn(OWNER_TZ, now), await cfg(null, 'DIGEST.morningAt')); },
  async run({ now }) {
    const { morningDigest } = await import('@/lib/systems/digests');
    const r = await morningDigest({ now });
    return { allGreen: r.allGreen, sent: r.sent };
  },
};

const monday = {
  name: 'monday',
  scope: 'global',
  cost: 5,
  minBudgetMs: 8000,
  claimTtl: 3 * 86400,
  async due({ now }) {
    const p = partsIn(OWNER_TZ, now);
    return p.weekday === 'Mon' ? dailyAt(p, await cfg(null, 'DIGEST.mondayAt')) : null;
  },
  async run({ now }) {
    const { mondayDigest } = await import('@/lib/systems/digests');
    const r = await mondayDigest({ now });
    return { sent: r.sent, finished: r.finished };
  },
};

export const JOBS = [day1Notice, cancelInboxes, invoiceJob, wrapup, friday, dayJobs, morning, monday];
