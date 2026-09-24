/**
 * Trial Manager — the `day-jobs` job (SPEC §5, §9). Daily 09:00 ET on the
 * client's own clock (Test Mode runs it on the scaled clock). Everything is
 * routed by `trialDay` and state; each step is idempotent (trial-hash
 * markers + deduped client emails), so a second run the same day is a no-op.
 *
 *   Day −7        build check → owner alert build_behind if list / copy / warm-up is behind
 *   Day 1+        day1_started once trial.firstSendAt exists (also the quicker day1-notice job)
 *   Day 20–25     disposition_sheet (once, only when there are bookings)
 *   Day ≥ 29      trial_report + Market Report (once)
 *   Day ≥ 30      1+ qualified → handover + decision; 0 → extension (extension.js)
 *   extension     first qualified call or EXTENSION_CAP → decision
 *   deciding+     ladder by ladder day (ladder.js), Day 45 retire
 *   early stop    trial.endReason set by Client Watch / Stop the trial → handover,
 *                 then retire after DAYJOBS.stopRetireDays
 *   retired       deletion on dataDeleteAt (wrapup job); winback WINBACK.days after end
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getTrial } from '@/lib/db/client';
import { requireCounters } from '@/lib/db/counters';
import { countByStatus } from '@/lib/db/leads';
import { getInboxRecords } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { alertOwner, notifyClient } from '@/lib/notify';
import { mintToken, pageUrl } from '@/lib/pagetokens';
import { trialDay, addDays, dayKeyIn, daysBetween, ET } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { renderReport, decisionLink } from '@/lib/systems/reports';
import { sendDecision, sendDecisionEmail } from '@/lib/systems/decision';
import { startExtension, checkExtension } from '@/lib/systems/extension';
import { sendHandover } from '@/lib/systems/handover';
import { runLadder, runWinback, ladderDayOf } from '@/lib/systems/ladder';
import { retireClient } from '@/lib/systems/wrapup';
import { getBookings, patchTrial, ownerName, fmtDay, cfgTree } from '@/lib/systems/dshared';
import { getLead } from '@/lib/db/leads';

export const DAYJOB_STATES = new Set(['warming', 'ready', 'sending', 'paused', 'extension', 'deciding', 'converted', 'not_now', 'retired', 'deleted']);

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
  const day1 = trial.day1Date || dayKeyIn(ET, new Date(trial.firstSendAt));
  if (!sender) return { held: 'no inbox record' };
  await notifyClient(clientId, 'day1_started', { senderAddress: sender, day30Date: fmtDay(trial.day30Date || addDays(day1, 29)), ownerName: sig }, { dedupe: 'day1_started' });
  await patchTrial(clientId, { day1NoticeAt: now.toISOString() });
  return { sent: 'day1_started' };
}

// ── Day 20 disposition sheet ──────────────────────────────────────────────────

export async function sendDisposition(clientId, now) {
  const bookings = await getBookings(clientId);
  if (!bookings.length) {
    await patchTrial(clientId, { dispositionSentAt: 'none' });
    await logEvent(clientId, 'reports', 'disposition_skipped', { reason: 'no bookings' });
    return { skipped: 'no bookings' };
  }
  const sig = await ownerName(clientId, 'The disposition sheet');
  if (!sig) return { held: 'OWNER.signerName' };
  const rows = [];
  for (const b of bookings.sort((a, c) => String(a.scheduledAt).localeCompare(String(c.scheduledAt)))) {
    const lead = b.leadEmail ? await getLead(clientId, b.leadEmail) : null;
    // Stage C's tap page (/c/[token]/tap) reads purpose tap:{bookingId}.
    const token = await mintToken(clientId, `tap:${b.id}`, { ttl: 6 * 86400 });
    const showed = b.status === 'held' ? 'yes' : b.status === 'noshow' ? 'no' : b.attendedTapAt ? 'tapped' : 'not tapped yet';
    const fit = b.status === 'wrongfit' ? 'no' : b.qualified === true || b.qualified === 'true' ? 'yes' : '—';
    rows.push(`• ${lead?.company || b.leadEmail || 'Unmatched booking'} — ${b.scheduledAt ? fmtDay(String(b.scheduledAt).slice(0, 10)) : 'date unknown'} — showed: ${showed} — right fit: ${fit} — outcome: ${b.status || 'booked'}\n  Tap: ${pageUrl(token, 'tap')}`);
  }
  await notifyClient(clientId, 'disposition_sheet', { rows: rows.join('\n\n'), ownerName: sig }, { dedupe: 'disposition_sheet' });
  await kv.hset(K.report(clientId, 'day20'), { renderedAt: new Date().toISOString(), html: '', text: rows.join('\n'), blockedReason: '' });
  await kv.sadd(K.reports(clientId), 'day20');
  await patchTrial(clientId, { dispositionSentAt: now.toISOString() });
  return { sent: 'disposition_sheet', rows: rows.length };
}

// ── Day 29 report ─────────────────────────────────────────────────────────────

export async function sendTrialReport(clientId, now) {
  const url = await decisionLink(clientId, 'report', 30);
  const r = await renderReport('day29', clientId, { now, decisionUrl: url });
  if (!r.ok) return { held: r.blockedReason };
  const sig = await ownerName(clientId, 'The Trial Report');
  if (!sig) return { held: 'OWNER.signerName' };
  await notifyClient(clientId, r.zero ? 'trial_report_zero' : 'trial_report', { body: r.text, ownerName: sig }, { dedupe: 'trial_report:day29', attachments: r.attachments });
  await patchTrial(clientId, { reportSentAt: now.toISOString() });
  return { sent: r.zero ? 'trial_report_zero' : 'trial_report' };
}

// ── Day 30 ────────────────────────────────────────────────────────────────────

export async function day30(clientId, now) {
  const gate = await requireCounters(clientId, ['qualified']);
  if (!gate.ok) {
    await alertOwner('report_blocked', { clientId, scope: `${clientId}:day30`, vars: { report: 'Day 30 decision', clientId }, body: `Day 30 for ${clientId} is held: the qualified counter is missing.`, did: 'State unchanged (still sending); retried tomorrow.' });
    return { held: 'counters' };
  }
  if (gate.values.qualified >= 1) {
    const h = await sendHandover(clientId, 'day30', { now });
    const d = await sendDecision(clientId, { now, zero: false });
    return { decision: d, handover: h };
  }
  const e = await startExtension(clientId, { now });
  if (e.refused) return { decision: await sendDecision(clientId, { now, zero: true }) };
  return { extension: e };
}

// ── Early end (Client Watch / Stop the trial set trial.endReason) ─────────────

async function earlyEnd(clientId, trial, now) {
  const out = {};
  if (!trial.handoverSentAt) out.handover = await sendHandover(clientId, 'early_stop', { now });
  const days = await cfg(clientId, 'DAYJOBS.stopRetireDays');
  if (trial.endedAt && daysBetween(dayKeyIn(ET, new Date(trial.endedAt)), dayKeyIn(ET, now)) >= days) out.retire = await retireClient(clientId, { now, reason: trial.endReason || 'early_stop' });
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
  const T = await cfgTree(clientId, 'TRIAL');
  const out = { day, state: client.state };
  const s = client.state;

  if (['warming', 'ready'].includes(s)) {
    if (day === -7 && !trial.buildCheckAt) out.buildCheck = await buildCheck(clientId, now);
    return out;
  }

  if (['sending', 'paused', 'extension'].includes(s)) {
    if (trial.firstSendAt && !trial.day1NoticeAt) out.day1 = await sendDay1Notice(clientId, now);
    if (trial.endReason && trial.endedAt) { out.earlyEnd = await earlyEnd(clientId, trial, now); return out; }
    if (day == null) return out;
    if (s !== 'extension') {
      if (day >= 20 && day <= 25 && !trial.dispositionSentAt) out.disposition = await sendDisposition(clientId, now);
      if (day >= T.reportDay && !trial.reportSentAt) out.report = await sendTrialReport(clientId, now);
      if (day >= T.decisionDay && (trial.reportSentAt || out.report?.sent)) out.day30 = await day30(clientId, now);
    } else {
      out.extension = await checkExtension(clientId, { now, day });
    }
    return out;
  }

  if (s === 'deciding' && !trial.decisionEmailAt) out.decisionEmail = await sendDecisionEmail(clientId, { now });
  if (['deciding', 'converted', 'not_now'].includes(s)) {
    out.ladder = await runLadder(clientId, { ladderDay: ladderDayOf(trial, day), now });
    return out;
  }
  if (['retired', 'deleted'].includes(s)) out.winback = await runWinback(clientId, { now });
  return out;
}
