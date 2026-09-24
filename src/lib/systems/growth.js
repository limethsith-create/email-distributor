/**
 * Growth history for one trial (docs/HUB-API.md "growth"): what the hub's
 * charts draw — daily sending, replies and bookings, daily warm-up volume and
 * inbox rate per inbox, and each placement test — straight from the stored
 * daily counters. A day with nothing recorded is null, never a guessed 0.
 *
 * One pipeline per call (≈ days × (2 + inboxes) commands), so the hub loads
 * it only when the Growth tab is opened, never on its auto-refresh.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { getInboxRecords } from '@/lib/db/inboxes';
import { addDays, dayKeyIn, ET } from '@/lib/time';
import { clientNow } from '@/lib/testclock';

const EMAIL_FIELDS = ['sent', 'sentD0', 'replies', 'positive', 'booked', 'held', 'qualified', 'bounces'];
const parse = (v, fb) => { if (v == null || v === '') return fb; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fb; } };
const numOrNull = (row, f) => (row && row[f] !== undefined && row[f] !== null && row[f] !== '' ? Number(row[f]) : null);

/** Rolling inbox rate: inbox / (inbox + spam) over the 7 days ending at i (null when nothing observed). */
function rolling(inbox, spam, i) {
  let a = 0;
  let b = 0;
  let seen = false;
  for (let k = Math.max(0, i - 6); k <= i; k++) {
    if (inbox[k] != null || spam[k] != null) seen = true;
    a += inbox[k] || 0;
    b += spam[k] || 0;
  }
  return seen && a + b > 0 ? Math.round((a / (a + b)) * 1000) / 1000 : null;
}

export async function growthFor(clientId, { days = 45, now = new Date() } = {}) {
  const client = await getClient(clientId);
  if (!client) return null;
  const n = Math.min(90, Math.max(7, Number(days) || 45));
  const today = dayKeyIn(ET, clientNow(client, now));
  const dayKeys = Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
  const inboxes = await getInboxRecords(clientId).catch(() => []);

  const p = kv.pipeline();
  for (const d of dayKeys) p.hgetall(K.countersDay(clientId, d));
  for (const d of dayKeys) p.hgetall(K.canary(clientId, d));
  for (const ib of inboxes) for (const d of dayKeys) p.hgetall(K.warmupStats(ib.email, d));
  p.lrange(K.placement(clientId), 0, -1); // spam-test scores (Deliverability v2), last item
  const rows = await p.exec();
  const placementRows = rows.pop() || [];

  const counters = rows.slice(0, n);
  const canary = rows.slice(n, 2 * n);
  const email = Object.fromEntries(EMAIL_FIELDS.map((f) => [f, counters.map((r) => numOrNull(r, f))]));
  const warmupCounters = { sent: counters.map((r) => numOrNull(r, 'warmupSent')), inbox: counters.map((r) => numOrNull(r, 'warmupInbox')), spam: counters.map((r) => numOrNull(r, 'warmupSpam')) };

  const perInbox = inboxes.map((ib, j) => {
    const stats = rows.slice(2 * n + j * n, 2 * n + (j + 1) * n);
    const sent = stats.map((r) => numOrNull(r, 'sent'));
    const inbox = stats.map((r) => numOrNull(r, 'inbox'));
    const spam = stats.map((r) => numOrNull(r, 'spam'));
    return {
      email: ib.email,
      dailyCap: ib.dailyCap !== undefined && ib.dailyCap !== '' ? Number(ib.dailyCap) : null,
      warmupStartedAt: ib.warmupStartedAt || null,
      sent, inbox, spam,
      rate: dayKeys.map((_, i) => rolling(inbox, spam, i)),
    };
  });

  // Warm-up totals across the client's inboxes (from the per-inbox stats, the source of truth).
  const sumAt = (field, i) => {
    let any = false;
    let t = 0;
    for (const ib of perInbox) if (ib[field][i] != null) { any = true; t += ib[field][i]; }
    return any ? t : null;
  };
  const wSent = dayKeys.map((_, i) => sumAt('sent', i) ?? warmupCounters.sent[i]);
  const wInbox = dayKeys.map((_, i) => sumAt('inbox', i) ?? warmupCounters.inbox[i]);
  const wSpam = dayKeys.map((_, i) => sumAt('spam', i) ?? warmupCounters.spam[i]);

  const placement = [];
  dayKeys.forEach((d, i) => {
    const run = canary[i];
    if (!run || run.phase !== 'done') return;
    const res = parse(run.result, {});
    if (res.overall == null) return;
    placement.push({ day: d, at: run.doneAt || null, tool: 'seed', inboxRate: Math.round(res.overall * 1000) / 1000, score: null, min: res.min ?? null, perProvider: res.perProvider || null });
  });
  // Spam tests (mail-tester / dkimvalidator): one entry per tool per day, the
  // lowest inbox score that day (the one the Day 1 gate looks at); per inbox
  // in `perInbox`. A test that could not finish has no score and is left out.
  const inRange = new Set(dayKeys);
  const byDayTool = new Map();
  for (const raw of placementRows) {
    const e = parse(raw, null);
    if (!e || e.tool === 'seed' || !inRange.has(e.day) || (e.score == null && e.spamAssassin == null)) continue;
    const k = `${e.day}|${e.tool}`;
    const cur = byDayTool.get(k) || { day: e.day, at: e.at || null, tool: e.tool, inboxRate: null, score: null, spamAssassin: null, min: null, perProvider: null, perInbox: {} };
    if (e.score != null) cur.score = cur.score == null ? e.score : Math.min(cur.score, e.score);
    if (e.spamAssassin != null) cur.spamAssassin = cur.spamAssassin == null ? e.spamAssassin : Math.max(cur.spamAssassin, e.spamAssassin);
    if (e.inbox) cur.perInbox[e.inbox] = e.score ?? e.spamAssassin;
    if (e.at && (!cur.at || e.at > cur.at)) cur.at = e.at;
    byDayTool.set(k, cur);
  }
  placement.push(...byDayTool.values());
  placement.sort((a, b) => (a.day === b.day ? String(a.at || '').localeCompare(String(b.at || '')) : a.day.localeCompare(b.day)));

  return {
    days: dayKeys,
    email,
    warmup: { sent: wSent, inbox: wInbox, spam: wSpam, rate: dayKeys.map((_, i) => rolling(wInbox, wSpam, i)) },
    inboxes: perInbox.map(({ email: e, dailyCap, warmupStartedAt, sent, rate }) => ({ email: e, dailyCap, warmupStartedAt, sent, rate })),
    placement,
  };
}
