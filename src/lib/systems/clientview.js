/**
 * Mission Control client page data (SPEC §10.1): the sections added in
 * Phase 6 — replies by kind, bookings with tap status, leads by status,
 * reports rendered, promises, invoice, health, and the dated milestones
 * still ahead for this client.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getTrial } from '@/lib/db/client';
import { countByStatus } from '@/lib/db/leads';
import { getTotals } from '@/lib/db/counters';
import { getPromises } from '@/lib/db/promises';
import { getAlertLog } from '@/lib/notify';
import { addDays, dayKeyIn, ET } from '@/lib/time';
import { clientNow, clientTrialDay } from '@/lib/testclock';
import { getReplies, getBookings, cfgTree } from '@/lib/systems/dshared';
import { getRenderedReports } from '@/lib/systems/reports';
import { getInvoice, invoiceView } from '@/lib/systems/invoice';
import { computeHealth } from '@/lib/systems/health';

/** Dated milestones from the trial record (Stage D's day-jobs schedule). */
export async function upcomingFor(client, trial, now = new Date()) {
  const T = await cfgTree(client.id, 'TRIAL');
  const cap = await cfg(client.id, 'EXTENSION_CAP');
  const at = await cfg(client.id, 'DAYJOBS.at');
  const vnow = clientNow(client, now);
  const today = dayKeyIn(ET, vnow);
  const items = [];
  const d1 = trial.day1Date;
  const onDay = (n) => (d1 ? addDays(d1, n - 1) : trial.signedDay ? addDays(trial.signedDay, n + 14) : null);
  const add = (date, what) => { if (date && date >= today) items.push({ date, time: `${at} ET`, what }); };
  if (['warming', 'ready'].includes(client.state)) add(onDay(-7), 'Day −7 build check');
  if (['sending', 'paused', 'warming', 'ready'].includes(client.state)) {
    add(onDay(20), 'Day 20 disposition sheet');
    add(onDay(T.reportDay), 'Day 29 Trial Report + Market Report');
    add(onDay(T.decisionDay), 'Day 30 decision (or extension if 0 qualified)');
  }
  if (client.state === 'extension') add(onDay(cap), `Extension cap (Day ${cap}) — decision with the zero-call report`);
  if (['deciding', 'not_now', 'converted'].includes(client.state)) {
    const shift = (Number(trial.decisionDay) || 30) - 30;
    add(onDay(31 + shift), 'Review request');
    if (client.state !== 'converted') {
      for (const n of T.ladderDays) add(onDay(n + shift), `Ladder Day ${n}`);
      add(onDay(T.retireDay + shift), 'Retire domain + inboxes');
    }
  }
  if (trial.dataDeleteAt) add(trial.dataDeleteAt, 'Delete client data');
  const winback = client.winbackAt || trial.winbackAt;
  if (winback) add(winback, '90-day win-back email');
  // Next Friday update.
  if (['warming', 'ready', 'sending', 'paused', 'extension'].includes(client.state)) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i);
      if (new Date(`${d}T12:00:00Z`).getUTCDay() === 5) { items.push({ date: d, time: '09:00 ET', what: 'Friday update' }); break; }
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

export async function clientExtras(client, now = new Date()) {
  const id = client.id;
  const [trial, replies, bookings, leadsByStatus, reports, promises, invoice, totals, alerts, sequence] = await Promise.all([
    getTrial(id), getReplies(id), getBookings(id), countByStatus(id).catch(() => ({})), getRenderedReports(id), getPromises(id).catch(() => []),
    getInvoice(id), getTotals(id).catch(() => ({})), getAlertLog(500), kv.hgetall(K.sequence(id)).catch(() => ({})),
  ]);
  const repliesByKind = {};
  for (const r of replies) repliesByKind[r.kind || 'unknown'] = (repliesByKind[r.kind || 'unknown'] || 0) + 1;
  const open = alerts.filter((a) => a.clientId === id && !a.acknowledged);
  const day = clientTrialDay(client, trial, now);
  const health = computeHealth({ client, trial, totals, day, alerts: open, promises, now: clientNow(client, now), quietWarnDays: await cfg(id, 'CLIENT.quietWarnDays') });
  const seq = sequence || {};
  return {
    trialDay: day,
    virtualNow: client.id === '_test' ? clientNow(client, now).toISOString() : null,
    counters: totals,
    health,
    leadsByStatus,
    repliesByKind,
    replies: replies.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))).slice(0, 50).map((r) => ({ id: r.id, kind: r.kind, leadEmail: r.leadEmail, receivedAt: r.receivedAt, snippet: String(r.snippet || '').slice(0, 200) })),
    bookings: bookings.sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).map((b) => ({
      id: b.id, leadEmail: b.leadEmail, scheduledAt: b.scheduledAt, status: b.status, qualified: b.qualified === true || b.qualified === 'true',
      tapped: Boolean(b.attendedTapAt), disputeReason: b.disputeReason || null,
    })),
    sequence: { active: seq.active || null, version: seq.version || null, approvedAt: seq.approvedAt || null, approvalMode: seq.approvalMode || null, hasA: Boolean(seq.variantA), hasB: Boolean(seq.variantB), checks: seq.checks || null },
    reports,
    promises,
    invoice: invoiceView(invoice),
    upcoming: await upcomingFor(client, trial, now),
  };
}
