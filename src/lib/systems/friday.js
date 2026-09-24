/**
 * Friday Update (SPEC §9.1). Every Friday 09:00 ET from Day −14, build weeks
 * included; under FRIDAY.maxWords words.
 *
 * Build weeks (warming/ready, or before Day 1): warm-up day from the inboxes'
 * warmupStartedAt, list size from the lead index, copy status from the
 * sequence record. Trial weeks: this week's and running counters, the last
 * Pace Check fix, what the client owes us, and a "Watch" line naming the
 * worst of bounce %, placement and inbox rate.
 *
 * The first FRIDAY.personalUpdates updates open with one fact taken from the
 * data by rule (a reply, a booking, the warm-up start). If no rule matches,
 * there is no personal line — never an invented one.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getTrial } from '@/lib/db/client';
import { requireCounters, sumDays } from '@/lib/db/counters';
import { countByStatus, getLead } from '@/lib/db/leads';
import { getInboxRecords } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { notifyClient, alertOwner } from '@/lib/notify';
import { fill } from '@/lib/templates/render';
import { FRIDAY_TRIAL_LINES, FRIDAY_BUILD_LINES } from '@/lib/templates/client/stage-d';
import { addDays, dayKeyIn, daysBetween, ET, trialDay } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { getReplies, getBookings, getPaceLog, pct, fmtDay, wordCount, ownerName, patchTrial
  , markReportRendered, cfgTree } from '@/lib/systems/dshared';

export const FRIDAY_STATES = new Set(['warming', 'ready', 'sending', 'paused', 'extension']);
const WEEK_FIELDS = ['sent', 'replies', 'positive', 'booked', 'held'];
const TOTAL_FIELDS = ['sent', 'replies', 'positive', 'booked', 'held', 'qualified', 'bounces', 'companiesContacted'];

function lastSevenDays(today) {
  return Array.from({ length: 7 }, (_, i) => addDays(today, -i));
}

function placementOf(client) {
  const v = Number(client?.canaryPlacement);
  if (client?.canaryPlacement == null || client.canaryPlacement === '' || !Number.isFinite(v)) return null;
  return v > 1 ? v / 100 : v;
}

/**
 * Watch line: the worst metric relative to its line. Over the line → named;
 * within 80% of the line → named with "watching it"; else all green.
 */
export function watchLine({ bounceRate, placement, inboxRate }, lines) {
  const metrics = [];
  if (bounceRate != null) metrics.push({ label: 'bounce', value: bounceRate, line: lines.bounceMax, higherIsBad: true });
  if (placement != null) metrics.push({ label: 'inbox placement', value: placement, line: lines.placementMin, higherIsBad: false });
  if (inboxRate != null) metrics.push({ label: 'inbox rate', value: inboxRate, line: lines.inboxRateMin, higherIsBad: false });
  if (!metrics.length) return 'all green';
  // Badness: >1 means over the line.
  for (const m of metrics) m.bad = m.higherIsBad ? m.value / m.line : (1 - m.value) / Math.max(1e-9, 1 - m.line);
  const worst = metrics.sort((a, b) => b.bad - a.bad)[0];
  const v = `${(worst.value * 100).toFixed(1)}%`;
  const l = `${Math.round(worst.line * 1000) / 10}%`;
  if (worst.bad > 1) return `${worst.label} at ${v}, ${worst.higherIsBad ? 'over' : 'under'} the ${l} line. Fixing it now.`;
  if (worst.bad >= 0.8) return `${worst.label} at ${v}, ${worst.higherIsBad ? 'under' : 'over'} the ${l} line. Watching it.`;
  return 'all green';
}

async function waitingOn(clientId, client, trial, now) {
  const items = [];
  const bookings = await getBookings(clientId);
  const pendingTaps = bookings.filter((b) => b.status === 'booked' && b.scheduledAt && Date.parse(b.scheduledAt) < now.getTime() - 3600_000 && !b.attendedTapAt).length;
  if (pendingTaps) items.push(`${pendingTaps} call tap${pendingTaps === 1 ? '' : 's'} (showed / no-show)`);
  const hot = Number(trial.unansweredHot) || 0;
  if (hot > 0) items.push(`${hot} hot lead${hot === 1 ? '' : 's'} to answer`);
  let seq = {};
  try { seq = (await kv.hgetall(K.sequence(clientId))) || {}; } catch {}
  if (['warming', 'ready'].includes(client.state) && seq.variantA && !seq.approvedAt) items.push('approving the emails');
  let profile = {};
  try { profile = (await kv.hgetall(K.profile(clientId))) || {}; } catch {}
  if (['warming', 'ready'].includes(client.state) && profile.bookingTested !== undefined && !(profile.bookingTested === true || profile.bookingTested === 'true' || profile.bookingTested === '1')) items.push('the booking-link test');
  return items.length ? items.join('; ') : 'nothing';
}

/** One fact from the data, chosen by rule, or null. */
async function personalLine(clientId, client, trial, weekDays, build) {
  const since = weekDays[weekDays.length - 1];
  const replies = (await getReplies(clientId)).filter((r) => ['interested', 'question'].includes(r.kind) && r.receivedAt && dayKeyIn(ET, new Date(r.receivedAt)) >= since)
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
  for (const r of replies) {
    const lead = r.leadEmail ? await getLead(clientId, r.leadEmail) : null;
    if (lead?.company) return `A reply came in from ${lead.company} on ${fmtDay(dayKeyIn(ET, new Date(r.receivedAt))).split(' ')[0]}.`;
  }
  const bookings = (await getBookings(clientId)).filter((b) => b.createdAt && dayKeyIn(ET, new Date(b.createdAt)) >= since && b.leadEmail);
  for (const b of bookings) {
    const lead = await getLead(clientId, b.leadEmail);
    if (lead?.company && b.scheduledAt) return `${lead.company} booked a call for ${fmtDay(dayKeyIn(ET, new Date(b.scheduledAt)))}.`;
  }
  if (build) {
    const inboxes = await getInboxRecords(clientId);
    const started = inboxes.map((i) => i.warmupStartedAt).filter(Boolean).sort()[0];
    if (started) return `Your inboxes started warming on ${fmtDay(dayKeyIn(ET, new Date(started)))}.`;
  }
  return null;
}

/**
 * Compose the update. Returns { ok, text, words, title, variant } or
 * { ok:false, blockedReason }.
 */
export async function composeFriday(clientId, now = new Date()) {
  const client = await getClient(clientId);
  const trial = await getTrial(clientId);
  const day = trialDay(trial, now);
  const today = dayKeyIn(ET, now);
  const weekDays = lastSevenDays(today);
  const build = ['warming', 'ready'].includes(client.state) || day == null || day < 1;
  const inboxes = await getInboxRecords(clientId);
  const rates = inboxes.map((i) => Number(i.inboxRate7d)).filter((n) => Number.isFinite(n)).map((n) => (n > 1 ? n / 100 : n));
  const inboxRate = rates.length ? Math.min(...rates) : null;
  const placement = placementOf(client);
  const diag = await cfgTree(clientId, 'DIAGNOSIS');
  const lowRate = await cfg(clientId, 'WARMUP.lowRate');
  const readyRate = await cfg(clientId, 'WARMUP.readyRate');
  const f = await cfgTree(clientId, 'FRIDAY');
  const waiting = await waitingOn(clientId, client, trial, now);
  let vars;
  let lines;
  let title;

  if (build) {
    const started = inboxes.map((i) => i.warmupStartedAt).filter(Boolean).sort()[0];
    const buildDays = await cfg(clientId, 'TRIAL.buildDays');
    const warmDay = started ? daysBetween(dayKeyIn(ET, new Date(started)), today) + 1 : null;
    const counts = await countByStatus(clientId);
    const listCount = Object.values(counts).reduce((a, b) => a + b, 0);
    let seq = {};
    try { seq = (await kv.hgetall(K.sequence(clientId))) || {}; } catch {}
    const copyStatus = seq.approvedAt ? `approved ${fmtDay(String(seq.approvedAt).slice(0, 10))}` : seq.variantA ? 'awaiting your approval' : 'being written';
    const buildWeek = day == null ? 1 : Math.min(2, Math.max(1, Math.floor((day + 14) / 7) + 1));
    vars = {
      clientName: client.name || clientId, buildWeek,
      warmDay: warmDay == null ? 'not started' : Math.min(warmDay, buildDays), warmDays: buildDays,
      listCount, copyStatus, day1Date: trial.day1Date ? fmtDay(trial.day1Date) : 'set once warm-up passes',
      waiting,
      watch: watchLine({ bounceRate: null, placement, inboxRate }, { bounceMax: diag.bounceMax, placementMin: diag.placementMin, inboxRateMin: readyRate }),
    };
    lines = FRIDAY_BUILD_LINES;
    title = `${vars.clientName} — build week ${buildWeek} of 2`;
  } else {
    const gate = await requireCounters(clientId, TOTAL_FIELDS);
    if (!gate.ok) return { ok: false, blockedReason: `missing counter(s): ${gate.missing.join(', ')}`, missing: gate.missing };
    const t = gate.values;
    const w = await sumDays(clientId, weekDays, WEEK_FIELDS);
    const pace = (await getPaceLog(clientId)).filter((p) => p.at && dayKeyIn(ET, new Date(p.at)) >= weekDays[6]);
    const target = await cfgTree(clientId, 'TARGET');
    const cap = await cfg(clientId, 'EXTENSION_CAP');
    const weekLabel = day > 30 ? `extension, day ${day} of ${cap}` : `trial week ${Math.min(f.trialWeeks, Math.max(1, Math.ceil(day / 7)))} of ${f.trialWeeks}`;
    vars = {
      clientName: client.name || clientId, weekLabel,
      sentWeek: w.sent, sentTotal: t.sent, companies: t.companiesContacted,
      repliesWeek: w.replies, replyRateWeek: pct(w.replies, w.sent), positiveWeek: w.positive,
      bookedWeek: w.booked, heldWeek: w.held, qualifiedTotal: t.qualified,
      promise: target.promise, target: target.target,
      thisWeek: pace.length ? pace[pace.length - 1].fix || 'no changes' : 'no changes',
      waiting,
      watch: watchLine({ bounceRate: t.sent > 0 ? t.bounces / t.sent : null, placement, inboxRate }, { bounceMax: diag.bounceMax, placementMin: diag.placementMin, inboxRateMin: lowRate }),
    };
    lines = FRIDAY_TRIAL_LINES;
    title = `${vars.clientName} — ${weekLabel}`;
  }

  let body;
  try {
    body = lines.map((l) => fill('friday_update', l, vars)).join('\n');
  } catch (err) {
    return { ok: false, blockedReason: err.message, missing: err.missing };
  }
  const sentCount = Number(trial.fridayCount) || 0;
  if (sentCount < f.personalUpdates) {
    const personal = await personalLine(clientId, client, trial, weekDays, build);
    if (personal && wordCount(`${personal}\n${body}`) < f.maxWords) body = `${personal}\n\n${body}`;
  }
  const words = wordCount(body);
  if (words >= f.maxWords) return { ok: false, blockedReason: `update is ${words} words (limit ${f.maxWords})` };
  return { ok: true, text: body, words, title, variant: build ? 'build' : 'trial', day };
}

/** Compose, store and send this Friday's update (idempotent per date). */
export async function runFriday(clientId, { now: realNow = new Date() } = {}) {
  const client = await getClient(clientId);
  if (!client || !FRIDAY_STATES.has(client.state)) return { skipped: 'state' };
  const now = clientNow(client, realNow);
  const date = dayKeyIn(ET, now);
  const name = `friday:${date}`;
  const c = await composeFriday(clientId, now);
  if (!c.ok) {
    await kv.hset(K.report(clientId, name), { renderedAt: new Date().toISOString(), html: '', text: '', blockedReason: c.blockedReason });
    await markReportRendered(clientId, name);
    await alertOwner('report_blocked', { clientId, scope: `${clientId}:${name}`, vars: { report: name, clientId }, body: `This Friday's update for ${clientId} was not sent: ${c.blockedReason}.`, did: 'Nothing was sent to the client.' });
    await logEvent(clientId, 'friday', 'friday_blocked', { date, reason: c.blockedReason });
    return { sent: false, blockedReason: c.blockedReason };
  }
  const sig = await ownerName(clientId, 'The Friday update');
  if (!sig) return { sent: false, blockedReason: 'OWNER.signerName not set' };
  await kv.hset(K.report(clientId, name), { renderedAt: new Date().toISOString(), html: '', text: c.text, blockedReason: '' });
  await markReportRendered(clientId, name);
  const res = await notifyClient(clientId, 'friday_update', { title: c.title, body: c.text, ownerName: sig }, { dedupe: `friday_update:${date}` });
  if (res.sent) {
    await kv.hincrby(K.trial(clientId), 'fridayCount', 1);
    await patchTrial(clientId, { lastFridayAt: realNow.toISOString() });
    await logEvent(clientId, 'friday', 'friday_sent', { date, variant: c.variant, words: c.words });
  }
  return { sent: Boolean(res.sent), deduped: res.deduped || undefined, variant: c.variant, words: c.words };
}

