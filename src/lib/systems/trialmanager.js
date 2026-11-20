/**
 * Client day jobs — the `day-jobs` job (SPEC §5). Daily 09:00 ET. Every
 * client is a paying client: sending simply goes on, month after month.
 * Each step is idempotent (trial-hash markers + deduped client emails), so a
 * second run the same day is a no-op. (The `trial` hash name is kept: it is
 * where a client's dates live — Day 1, the first send, the agreement.)
 *
 *   Day −7        build check → owner alert build_behind if list / copy / warm-up is behind
 *   Day 1+        day1_started once trial.firstSendAt exists (also the quicker day1-notice job)
 *   stop          trial.endReason set by Client Watch / their Stop button → handover,
 *                 then retire after DAYJOBS.stopRetireDays
 *   retired       deletion on dataDeleteAt (wrapup job)
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getTrial } from '@/lib/db/client';
import { countByStatus } from '@/lib/db/leads';
import { getInboxRecords } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { alertOwner, notifyClient } from '@/lib/notify';
import { trialDay, dayKeyIn, daysBetween, ET } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { sendHandover } from '@/lib/systems/handover';
import { retireClient } from '@/lib/systems/wrapup';
import { patchTrial, ownerName } from '@/lib/systems/dshared';
import { clientButtonsText } from '@/lib/systems/clientwatch';

export const DAYJOB_STATES = new Set(['warming', 'ready', 'sending', 'paused']);

// ── Day −7 build check ────────────────────────────────────────────────────────

export async function buildCheck(clientId, now) {
  const behind = [];
  const inboxes = await getInboxRecords(clientId);
  const low = await cfg(clientId, 'WARMUP.lowRate');
  if (!inboxes.length) behind.push('no inboxes stored');
  else {
    const notStarted = inboxes.filter((i) => !i.warmupStartedAt).length;
    if (notStarted) behind.push(`${notStarted} inbox${notStarted === 1 ? '' : 'es'} not warming`);
    const lowRate = inboxes.filter((i) => Number.isFinite(Number(i.inboxRate7d)) && i.inboxRate7d !== '' && Number(i.inboxRate7d) < low).map((i) => i.email);
    if (lowRate.length) behind.push(`inbox rate under ${Math.round(low * 100)}%: ${lowRate.join(', ')}`);
  }
  const counts = await countByStatus(clientId);
  const listCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const startMin = await cfg(clientId, 'LIST.startMin');
  if (listCount < startMin) behind.push(`list has ${listCount} contacts (need ${startMin} to start)`);
  let seq = {};
  try { seq = (await kv.hgetall(K.sequence(clientId))) || {}; } catch {}
  if (!seq.variantA) behind.push('emails not written yet');
  await patchTrial(clientId, { buildCheckAt: now.toISOString() });
  if (behind.length) {
    await alertOwner('build_behind', {
      clientId, vars: { what: behind[0] },
      body: `Day −7 build check for ${clientId}:\n${behind.map((b) => `• ${b}`).join('\n')}`,
      did: 'Nothing changed; Day 1 still depends on the warm-up, approval and spam-test gates.',
    });
    await logEvent(clientId, 'trialmanager', 'build_behind', { behind });
    return { behind };
  }
  await logEvent(clientId, 'trialmanager', 'build_on_track', { listCount, inboxes: inboxes.length });
  return { behind: [] };
}

// ── Day 1 notice ──────────────────────────────────────────────────────────────

export async function sendDay1Notice(clientId, now = new Date()) {
  const trial = await getTrial(clientId);
  if (!trial.firstSendAt || trial.day1NoticeAt) return { skipped: true };
  const sig = await ownerName(clientId, 'The Day 1 email');
  if (!sig) return { held: 'OWNER.signerName' };
  const inboxes = await getInboxRecords(clientId);
  const sender = inboxes.find((i) => i.enabled === '1' || i.enabled === 1 || i.enabled === true)?.email || inboxes[0]?.email;
  if (!sender) return { held: 'no inbox record' };
  // Their own dashboard (systems/clientdash.js): the link goes out with the first emails.
  let dashboardLine = 'Your numbers come in the Friday update.';
  try {
    const { dashboardLink } = await import('@/lib/systems/clientdash');
    dashboardLine = `You can watch the sending as it happens, any time: ${await dashboardLink(clientId, { now })}`;
  } catch {}
  await notifyClient(clientId, 'day1_started', { senderAddress: sender, dashboardLine, buttons: await clientButtonsText(clientId), ownerName: sig }, { dedupe: 'day1_started' });
  await patchTrial(clientId, { day1NoticeAt: now.toISOString() });
  return { sent: 'day1_started' };
}

// ── Stop (Client Watch sets trial.endReason when a client goes quiet) ───────────

async function earlyEnd(clientId, trial, now) {
  const out = {};
  if (!trial.handoverSentAt) out.handover = await sendHandover(clientId, 'early_stop', { now });
  const days = await cfg(clientId, 'DAYJOBS.stopRetireDays');
  const today = dayKeyIn(ET, now);
  // An older stop set trial.retireAt (+7 days); Client Watch's quiet end sets only endedAt.
  const due = trial.retireAt ? today >= String(trial.retireAt).slice(0, 10) : Boolean(trial.endedAt) && daysBetween(dayKeyIn(ET, new Date(trial.endedAt)), today) >= days;
  if (due) out.retire = await retireClient(clientId, { now, reason: trial.endReason || 'early_stop' });
  return out;
}

/** The whole day job for one client. */
export async function runDayJobs(clientId, { now: realNow = new Date() } = {}) {
  if (clientId === 'aviance') return { skipped: 'aviance' };
  const client = await getClient(clientId);
  if (!client || !DAYJOB_STATES.has(client.state)) return { skipped: 'state' };
  const now = clientNow(client, realNow);
  const trial = await getTrial(clientId);
  const day = trialDay(trial, now);
  const out = { day, state: client.state };
  const s = client.state;

  if (['warming', 'ready'].includes(s)) {
    if (day === -7 && !trial.buildCheckAt) out.buildCheck = await buildCheck(clientId, now);
    return out;
  }

  // sending / paused: sending goes on; only a stop ends it.
  if (trial.firstSendAt && !trial.day1NoticeAt) out.day1 = await sendDay1Notice(clientId, now);
  if (trial.endReason && trial.endedAt) out.stop = await earlyEnd(clientId, trial, now);
  return out;
}
