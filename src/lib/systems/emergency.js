/**
 * Deliverability Emergency Runner (SPEC §8.10, Deliverability Emergency SOP).
 * Runs every tick; reads counters, canary and domain status only.
 *
 * Triggers (any one):
 *   bounce rate > 2 % over ≥ 50 recent sends · no replies for 2 business days
 *   on a campaign that had replies · canary placement < 70 % · domain
 *   blacklisted · DMARC pass < 80 % · a request on the client hash
 *   (`emergencyRequested`: canary, smoke test, pace Day 3)
 *
 * Steps, each logged, state kept in client:{id}:emergency:
 *   1 pause (state paused, warm-up continues), owner alert `emergency`
 *   2 per-inbox diagnosis: inbox over the line → enabled = 0 (still warming)
 *   6 client `deliverability_notice` the same day (sent right after step 2)
 *   3 re-verify every unsent lead (bounded per tick), drop invalid, ask for a refill
 *   4 domain listed, or canary < 50 % on every inbox → domain retired,
 *     `domain_burned` with a new shopping list; stays paused for the owner
 *   5 resume at half volume (client.emergencyHalved = 1)
 * Recovery: 3 green business days (bounce < 2 %, ≥ 1 reply, canary ≥ 85 %)
 * → emergencyHalved = 0, Ramp Planner restores full caps.
 *
 * Bounce limits (owner's rule: "pause at 1.5 % bounce, stop entirely at 2 %"),
 * both measured over the same window as the stop trigger (≥ SEND.smokeTestSends
 * recent sends): at or above BOUNCE.pause → every inbox cap halved today,
 * client.bounceHalved = 1 (the Ramp Planner keeps halving), owner alert
 * `bounce_pause`; above BOUNCE.max → the emergency sequence (stop). The pause
 * lifts after EMERGENCY.greenDays business days in a row under BOUNCE.pause.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getDomain, setState, SENDING_STATES, PAUSABLE_STATES } from '@/lib/db/client';
import { getInboxRecords, patchInbox } from '@/lib/db/inboxes';
import { getLeadsByStatus, getLead, saveLead } from '@/lib/db/leads';
import { getTotals, getDay } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { dayKeyIn, ET, addDays } from '@/lib/time';
import { recordEmergencyCause } from '@/lib/systems/learning';
import { notifyClientSafe } from '@/lib/systems/outbound';
import { ackAlerts } from '@/lib/notify';
import * as leadfinder from '@/lib/systems/leadfinder';
import {
  deps, alert, isTrialClient, lower, getRunState, patchRunState, businessDaysBetween, isBusinessDayKey, ccfg } from '@/lib/systems/stagec-common';

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export async function getEmergency(clientId) {
  return (await kv.hgetall(K.emergency(clientId))) || {};
}
async function patchEmergency(clientId, fields) {
  await kv.hset(K.emergency(clientId), Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v == null ? '' : v])));
}

/** Canary placements: overall (client) and per inbox; nulls when never measured. */
async function canaryReadings(clientId, client) {
  const inboxes = await getInboxRecords(clientId);
  const per = inboxes.map((r) => ({ email: r.email, placement: num(r.canaryPlacement) }));
  const min = num(client.canaryMinPlacement) ?? (per.some((p) => p.placement !== null) ? Math.min(...per.filter((p) => p.placement !== null).map((p) => p.placement)) : null);
  return { overall: num(client.canaryPlacement), min, per };
}

/**
 * Sum day counters back from today until ≥ `need` sends (max `maxDays`),
 * never including days on or before `notBefore` (the last resume day).
 */
async function recentWindow(clientId, now, need, maxDays, notBefore) {
  const out = { sent: 0, bounces: 0, replies: 0, days: [] };
  let day = dayKeyIn(ET, now);
  for (let i = 0; i < maxDays; i++) {
    if (notBefore && day <= notBefore) break;
    const d = await getDay(clientId, day);
    out.sent += d.sent || 0; out.bounces += d.bounces || 0; out.replies += d.replies || 0; out.days.push(day);
    if (out.sent >= need) break;
    day = addDays(day, -1);
  }
  return out;
}

/**
 * First trigger that fires → { code, detail } or null. Pure reads. `info`
 * (optional) receives the bounce window it measured, so the bounce pause
 * check reuses it instead of reading the counters twice.
 */
export async function detectTrigger(clientId, client, now = new Date(), info = null) {
  if (client.emergencyRequested) return { code: String(client.emergencyRequested), detail: `requested by ${client.emergencyRequested}` };
  const em = await getEmergency(clientId);
  const bounceMax = await ccfg(clientId, 'BOUNCE.max');
  const need = await ccfg(clientId, 'SEND.smokeTestSends');
  const maxDays = await ccfg(clientId, 'EMERGENCY_C.maxWindowDays');
  const win = await recentWindow(clientId, now, need, maxDays, em.resumedDay || null);
  if (info) info.window = win;
  if (win.sent >= need && win.bounces / win.sent > bounceMax) return { code: 'bounce', detail: `bounce ${Math.round((win.bounces / win.sent) * 1000) / 10}% over ${win.sent} sends (${win.days[win.days.length - 1]}–${win.days[0]})` };

  // Measurements that persist (blacklist, DMARC, canary) do not re-fire on the
  // day sending resumed; the next day's check (fresh numbers) decides.
  const cooling = em.resumedDay && dayKeyIn(ET, now) <= em.resumedDay;
  if (cooling) return null;
  const domain = await getDomain(clientId);
  if (lower(domain.blacklist) === 'listed') return { code: 'blacklisted', detail: `${domain.name || 'domain'} is on a blacklist` };
  const dmarc = num(domain.dmarcPassRate7d);
  if (dmarc !== null && dmarc < (await ccfg(clientId, 'EMERGENCY.dmarcMin'))) return { code: 'dmarc', detail: `DMARC pass ${Math.round(dmarc * 100)}%` };
  const canary = await canaryReadings(clientId, client);
  const placementMin = await ccfg(clientId, 'EMERGENCY.placementMin');
  if (canary.min !== null && canary.min < placementMin) return { code: 'canary', detail: `canary placement ${Math.round(canary.min * 100)}%` };

  const totals = await getTotals(clientId);
  const st = await getRunState(clientId);
  if ((totals.replies || 0) > 0 && st.lastReplyAt) {
    const since = Math.max(Date.parse(st.lastReplyAt), em.resumedAt ? Date.parse(em.resumedAt) : 0);
    const quietDays = businessDaysBetween(since, now.getTime());
    const noReplyDays = await ccfg(clientId, 'EMERGENCY.noReplyDays');
    if (quietDays >= noReplyDays) {
      const sentSince = await recentWindow(clientId, now, Infinity, quietDays + 1, dayKeyIn(ET, new Date(since)));
      // Silence only means trouble when this campaign's own reply rate says replies were due:
      // at a 3 % reply rate, 28 sends with no reply happen on a healthy domain almost half the
      // time. Fire when at least EMERGENCY.noReplyMinExpected replies were expected (5 → a
      // healthy campaign stays silent that long under 1 % of the time; the check runs every
      // tick for 30 days, so a looser line would still stop healthy trials).
      const rate = (totals.replies || 0) / Math.max(1, totals.sent || 0);
      const expected = sentSince.sent * rate;
      const minExpected = Number(await ccfg(clientId, 'EMERGENCY.noReplyMinExpected')) || 0;
      if (sentSince.sent > 0 && expected >= minExpected) return { code: 'no_replies', detail: `no replies for ${quietDays} business days (${sentSince.sent} sends since, about ${Math.round(expected * 10) / 10} expected)` };
    }
  }
  return null;
}

// ─── Steps ───────────────────────────────────────────────────────────────────

async function step1Pause(clientId, client, trigger, now) {
  const from = SENDING_STATES.has(client.state) ? client.state : (client.pausedFrom || 'sending');
  // A converted client stays converted; emergencyActive = 1 stops its sender.
  if (PAUSABLE_STATES.has(client.state)) await setState(clientId, 'paused', `emergency: ${trigger.code}`);
  await kv.hset(K.client(clientId), { emergencyActive: '1', pausedReason: client.state === 'paused' ? (client.pausedReason || 'emergency') : 'emergency', pausedAt: now.toISOString(), pausedFrom: from, emergencyRequested: '', emergencyRequestedAt: '' });
  await patchEmergency(clientId, { active: '1', trigger: trigger.code, detail: trigger.detail, startedAt: now.toISOString(), step: '1', pausedFrom: from, verifyIndex: 0, verified: 0, dropped: 0, burned: '', resumedAt: '', greenStreak: 0 });
  await logEvent(clientId, 'emergency', 'step1_paused', trigger);
  await alert('emergency', { clientId, scope: `${clientId}:${trigger.code}`, vars: { clientId, trigger: trigger.detail }, body: `Emergency stop for ${clientId}: ${trigger.detail}.`, did: 'Sending paused (warm-up continues). Next: per-inbox diagnosis, list re-verification, then resume at half volume.' });
}

async function step2Diagnose(clientId, client, now) {
  const inboxes = await getInboxRecords(clientId);
  const bounceMax = await ccfg(clientId, 'BOUNCE.max');
  const placementMin = await ccfg(clientId, 'EMERGENCY.placementMin');
  const sums = {};
  let day = dayKeyIn(ET, now);
  for (let i = 0; i < 7; i++) {
    const h = (await kv.hgetall(K.inboxSends(clientId, day))) || {};
    for (const r of inboxes) {
      sums[r.email] = sums[r.email] || { sent: 0, bounces: 0 };
      sums[r.email].sent += Number(h[r.email]) || 0;
      sums[r.email].bounces += Number(h[`${r.email}:bounces`]) || 0;
    }
    day = addDays(day, -1);
  }
  const disabled = [];
  const report = [];
  for (const r of inboxes) {
    const s = sums[r.email] || { sent: 0, bounces: 0 };
    const share = s.sent ? s.bounces / s.sent : 0;
    const canary = num(r.canaryPlacement);
    const bad = (s.sent >= 10 && share > bounceMax) || (canary !== null && canary < placementMin);
    report.push({ email: r.email, sent: s.sent, bounces: s.bounces, canary });
    if (bad && r.enabled === '1' && inboxes.length > 1 && disabled.length < inboxes.length - 1) {
      await patchInbox(clientId, r.email, { enabled: '0', disabledReason: 'emergency: over the bounce / placement line (still warming)', emergencyDisabledAt: now.toISOString() });
      disabled.push(r.email);
    }
  }
  await patchEmergency(clientId, { step: '2', diagnosis: JSON.stringify(report), disabledInboxes: JSON.stringify(disabled) });
  await logEvent(clientId, 'emergency', 'step2_diagnosis', { report, disabled });
  return disabled;
}

async function step6Notice(clientId, em) {
  if (em.noticeSentAt) return;
  const r = await notifyClientSafe(clientId, 'deliverability_notice', {}, { dedupe: `deliverability_notice:${em.startedAt}` });
  await patchEmergency(clientId, { noticeSentAt: new Date().toISOString(), noticeSent: r.sent ? '1' : '0' });
  await logEvent(clientId, 'emergency', 'step6_notice', { sent: Boolean(r.sent) });
}

/** Re-verify a bounded slice of unsent leads (MX; deep check when Stage B provides one). */
async function step3Reverify(clientId, em, now) {
  const perTick = await ccfg(clientId, 'EMERGENCY_C.verifyPerTick');
  const unsent = (await getLeadsByStatus(clientId, 'unsent', 5000)).map((l) => l.email).sort();
  const start = Number(em.verifyIndex) || 0;
  const slice = unsent.slice(start, start + perTick);
  const lf = deps.leadfinder || leadfinder;
  let dropped = Number(em.dropped) || 0;
  for (const email of slice) {
    let valid = true; let reason = null;
    const v = await deps.verifyEmail(email);
    if (v && v.valid === false) { valid = false; reason = v.reason; }
    const lead = await getLead(clientId, email);
    if (valid && lead && lower(lead.riskLevel) === 'risky' && lf && typeof lf.deepVerify === 'function') {
      try { const d = await lf.deepVerify(email, { now }); if (d && d.valid === false) { valid = false; reason = d.reason || 'deep check invalid'; } } catch {}
    }
    if (!valid && lead) {
      await saveLead(clientId, { ...lead, status: 'done', skipReason: `re-verify: ${reason}`, reverifiedAt: now.toISOString() }, lead.status);
      dropped++;
    }
  }
  const next = start + slice.length;
  const done = next >= unsent.length || slice.length === 0;
  await patchEmergency(clientId, { step: done ? '3done' : '3', verifyIndex: done ? 0 : next, verified: (Number(em.verified) || 0) + slice.length, dropped });
  if (done) {
    await logEvent(clientId, 'emergency', 'step3_reverified', { verified: (Number(em.verified) || 0) + slice.length, dropped });
    let refill = 'the daily Lead Finder refill tops the list up';
    if (lf && typeof lf.requestRefill === 'function') {
      try { const rr = await lf.requestRefill(clientId, { reason: 'emergency', now }); refill = rr.skipped ? `Lead Finder: ${rr.skipped}` : rr.ok ? 'Lead Finder refill requested' : `refill request failed: ${rr.error}`; } catch (err) { refill = `refill request failed: ${err.message}`; }
    }
    await patchEmergency(clientId, { refill });
  }
  return done;
}

async function step4Burned(clientId, client, em, now) {
  const domain = await getDomain(clientId);
  const canary = await canaryReadings(clientId, client);
  const burnedLine = await ccfg(clientId, 'EMERGENCY_C.burnedCanary');
  const measured = canary.per.filter((p) => p.placement !== null);
  const allLow = measured.length > 0 && measured.length === canary.per.length && measured.every((p) => p.placement < burnedLine);
  const listed = lower(domain.blacklist) === 'listed';
  if (!listed && !allLow) { await patchEmergency(clientId, { step: '4' }); return false; }
  await kv.hset(K.domain(clientId), { retiredAt: now.toISOString(), retiredReason: listed ? 'blacklisted' : 'canary below 50% on every inbox' });
  let listText = 'Run the Price Scout for this client from Mission Control to get a new shopping list.';
  try {
    const ps = deps.pricescout || (await import('@/lib/systems/pricescout'));
    listText = await ps.replacementShoppingList(clientId, { now, exclude: domain.name ? [domain.name] : [] });
  } catch (err) { listText = `The Price Scout failed (${err.message}). Run it from Mission Control.`; }
  await patchEmergency(clientId, { step: '4', burned: '1' });
  await logEvent(clientId, 'emergency', 'step4_domain_burned', { listed, allLow });
  await alert('domain_burned', { clientId, vars: { domain: domain.name || clientId }, body: `${domain.name || 'The trial domain'} for ${clientId} is burned (${listed ? 'blacklisted' : 'canary under 50% on every inbox'}).\n\n${listText}`, did: 'Domain marked retired. The trial stays paused until the replacement domain is set up and you resume it.' });
  return true;
}

async function step5Resume(clientId, client, em, now) {
  if (client.state === 'paused' && ['emergency'].includes(client.pausedReason)) {
    const to = ['extension', 'sending'].includes(em.pausedFrom) ? em.pausedFrom : 'sending';
    await setState(clientId, to, 'emergency: resumed at half volume');
  }
  await kv.hset(K.client(clientId), { emergencyActive: '0', emergencyHalved: '1', pausedReason: client.pausedReason === 'emergency' ? '' : (client.pausedReason || '') });
  // Halve today's caps now; the Ramp Planner keeps them halved from tomorrow (emergencyHalved).
  for (const r of await getInboxRecords(clientId)) {
    const cap = num(r.dailyCap);
    if (cap !== null) await patchInbox(clientId, r.email, { dailyCap: String(Math.floor(cap / 2)), capHalvedAt: now.toISOString() });
  }
  const st = await getRunState(clientId);
  if (st.smokeFailedAt && !st.smokeClearedAt) await patchRunState(clientId, { smokeClearedAt: now.toISOString(), smokeClearedBy: 'emergency re-verify' });
  await patchEmergency(clientId, { active: '0', step: '5', resumedAt: now.toISOString(), resumedDay: dayKeyIn(ET, now), greenStreak: 0, lastGreenDay: '' });
  await logEvent(clientId, 'emergency', 'step5_resumed', { halved: true });
}

/** Evaluate yesterday once per day while halved; 3 green business days → full caps. */
async function greenDays(clientId, client, em, now) {
  const yesterday = addDays(dayKeyIn(ET, now), -1);
  if (em.lastGreenDay === yesterday || (em.resumedDay && yesterday <= em.resumedDay)) return null;
  if (!isBusinessDayKey(yesterday)) { await patchEmergency(clientId, { lastGreenDay: yesterday }); return null; }
  const d = await getDay(clientId, yesterday);
  if (!d.sent) { await patchEmergency(clientId, { lastGreenDay: yesterday }); return null; }
  const bounceMax = await ccfg(clientId, 'BOUNCE.max');
  const gate = await ccfg(clientId, 'CANARY.gate');
  const canary = await canaryReadings(clientId, client);
  const green = (d.bounces || 0) / d.sent < bounceMax && (d.replies || 0) >= 1 && (canary.min === null || canary.min >= gate);
  const streak = green ? (Number(em.greenStreak) || 0) + 1 : 0;
  await patchEmergency(clientId, { lastGreenDay: yesterday, greenStreak: streak });
  await logEvent(clientId, 'emergency', 'green_day_check', { day: yesterday, green, streak, canaryMeasured: canary.min !== null });
  const need = await ccfg(clientId, 'EMERGENCY.greenDays');
  if (streak >= need) {
    await kv.hset(K.client(clientId), { emergencyHalved: '0' });
    await patchEmergency(clientId, { recoveredAt: now.toISOString() });
    await alert('emergency_resolved', { clientId, vars: { clientId }, body: `${clientId}: ${streak} green days in a row (bounce under 2%, replies coming in${canary.min === null ? '' : ', canary ≥ 85%'}).`, did: 'Half-volume lifted; the Ramp Planner restores full caps from its next run.' });
    // Resolved: the urgent `emergency` alert (and its to-do) is handled.
    await ackAlerts(clientId, ['emergency'], { reason: 'deliverability back to normal', now });
    return 'recovered';
  }
  return green ? 'green' : 'not green';
}

// ─── Bounce pause (1.5 %) ───────────────────────────────────────────────────

const pctText = (r) => `${Math.round(r * 1000) / 10}%`;

/**
 * Pure: does this window call for the bounce pause? → { rate } or null.
 * At or above the pause line and not above the stop line (that is the stop
 * trigger's job); only over a window of at least `need` sends.
 */
export function bouncePauseDue(win, { need = 50, pauseAt = 0.015, stopAt = 0.02 } = {}) {
  if (!win || !(win.sent >= need) || !(pauseAt < stopAt)) return null;
  const rate = win.bounces / win.sent;
  if (rate > stopAt || rate < pauseAt) return null;
  return { rate };
}

async function startBouncePause(clientId, win, rate, now) {
  const halved = [];
  for (const r of await getInboxRecords(clientId)) {
    const cap = num(r.dailyCap);
    if (cap === null) continue;
    await patchInbox(clientId, r.email, { dailyCap: String(Math.floor(cap / 2)), capHalvedAt: now.toISOString() });
    halved.push(`${r.email}: ${cap} → ${Math.floor(cap / 2)}`);
  }
  await kv.hset(K.client(clientId), { bounceHalved: '1', bouncePausedAt: now.toISOString(), bouncePauseRate: rate.toFixed(4), bounceGreenStreak: 0, bounceGreenDay: dayKeyIn(ET, now) });
  const detail = `bounce ${pctText(rate)} over ${win.sent} sends (${win.days[win.days.length - 1]}–${win.days[0]})`;
  await logEvent(clientId, 'emergency', 'bounce_pause', { rate, sent: win.sent, bounces: win.bounces, halved });
  const [pauseAt, stopAt, greenDays] = [await ccfg(clientId, 'BOUNCE.pause'), await ccfg(clientId, 'BOUNCE.max'), await ccfg(clientId, 'EMERGENCY.greenDays')];
  await alert('bounce_pause', {
    clientId, scope: `${clientId}:${dayKeyIn(ET, now)}`, vars: { clientId, rate: pctText(rate) },
    body: `${clientId}: ${detail} — at or over the ${pctText(pauseAt)} pause line (the stop line is ${pctText(stopAt)}).\n${halved.join('\n') || 'No inbox caps set yet.'}`,
    did: `Every inbox cap is halved from now; the Ramp Planner keeps them halved until ${greenDays} business days in a row are under ${pctText(pauseAt)}. Over ${pctText(stopAt)} the emergency stop runs by itself.`,
  });
  return { paused: true, rate, halved: halved.length };
}

/** While halved: judge yesterday once a day; EMERGENCY.greenDays green business days in a row lift the pause. */
async function bouncePauseRecovery(clientId, client, now, pauseAt) {
  const yesterday = addDays(dayKeyIn(ET, now), -1);
  if (client.bounceGreenDay && yesterday <= client.bounceGreenDay) return { halved: true };
  if (!isBusinessDayKey(yesterday)) { await kv.hset(K.client(clientId), { bounceGreenDay: yesterday }); return { halved: true }; }
  const d = await getDay(clientId, yesterday);
  if (!d.sent) { await kv.hset(K.client(clientId), { bounceGreenDay: yesterday }); return { halved: true }; }
  const green = (d.bounces || 0) / d.sent < pauseAt;
  const streak = green ? (Number(client.bounceGreenStreak) || 0) + 1 : 0;
  const need = await ccfg(clientId, 'EMERGENCY.greenDays');
  await logEvent(clientId, 'emergency', 'bounce_green_check', { day: yesterday, sent: d.sent, bounces: d.bounces || 0, green, streak });
  if (streak >= need) {
    await kv.hset(K.client(clientId), { bounceHalved: '0', bounceGreenStreak: streak, bounceGreenDay: yesterday, bouncePauseLiftedAt: now.toISOString() });
    await alert('bounce_pause_lifted', { clientId, vars: { clientId }, body: `${clientId}: ${streak} business days in a row under the ${pctText(pauseAt)} bounce line.`, did: 'Half caps lifted; the Ramp Planner restores full caps from its next run.' });
    return { lifted: true, streak };
  }
  await kv.hset(K.client(clientId), { bounceGreenStreak: streak, bounceGreenDay: yesterday });
  return { halved: true, green, streak };
}

/** Bounce pause check after the stop triggers found nothing (reuses their window). */
async function checkBouncePause(clientId, client, win, now) {
  const pauseAt = await ccfg(clientId, 'BOUNCE.pause');
  if (client.bounceHalved === '1') return bouncePauseRecovery(clientId, client, now, pauseAt);
  const due = bouncePauseDue(win, { need: await ccfg(clientId, 'SEND.smokeTestSends'), pauseAt, stopAt: await ccfg(clientId, 'BOUNCE.max') });
  if (!due) return null;
  return startBouncePause(clientId, win, due.rate, now);
}

/** The `emergency` job (every tick). */
export async function runEmergency(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const client = await getClient(clientId);
  if (!client) return { skipped: 'no client' };
  let em = await getEmergency(clientId);

  if (em.active === '1') {
    if (em.burned === '1') return { waiting: 'domain replacement (owner)' };
    if (em.step === '1') await step2Diagnose(clientId, client, now);
    em = await getEmergency(clientId);
    if (!em.noticeSentAt) await step6Notice(clientId, em);
    em = await getEmergency(clientId);
    if (em.step === '2' || em.step === '3') {
      const done = await step3Reverify(clientId, em, now);
      if (!done) return { step: 3, verifying: true };
      em = await getEmergency(clientId);
    }
    if (em.step === '3done') {
      if (await step4Burned(clientId, client, em, now)) return { step: 4, burned: true };
      em = await getEmergency(clientId);
    }
    if (em.step === '4') {
      await step5Resume(clientId, await getClient(clientId), em, now);
      await recordEmergencyCause(clientId, em.trigger || 'unknown');
      return { step: 5, resumed: true };
    }
    return { step: em.step };
  }

  if (!SENDING_STATES.has(client.state) && !(client.state === 'paused')) return { skipped: `state ${client.state}` };
  const out = {};
  if (client.emergencyHalved === '1') out.green = await greenDays(clientId, client, em, now);
  // A quiet pause (client side) does not start a deliverability emergency unless requested.
  if (client.state === 'paused' && !client.emergencyRequested) return out;
  const info = {};
  const trigger = await detectTrigger(clientId, client, now, info);
  if (!trigger) {
    const bounce = client.state === 'paused' ? null : await checkBouncePause(clientId, client, info.window, now);
    return { ...out, ok: true, ...(bounce ? { bounce } : {}) };
  }
  // The stop supersedes a bounce pause (its own resume halves the caps).
  if (client.bounceHalved === '1') await kv.hset(K.client(clientId), { bounceHalved: '0', bouncePauseEndedBy: `emergency: ${trigger.code}` });
  await step1Pause(clientId, client, trigger, now);
  await step2Diagnose(clientId, await getClient(clientId), now);
  await step6Notice(clientId, await getEmergency(clientId));
  return { ...out, started: trigger };
}

