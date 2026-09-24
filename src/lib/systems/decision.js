/**
 * Day 30 Decision (SPEC §9.4). `sendDecision` moves the client to `deciding`
 * and emails `decision_link`; the page at /c/[token]/decide shows the five
 * numbers, the one recommendation, the month-one bonus with a countdown to
 * bonusExpiresAt (= sentAt + TRIAL.bonusHours), and three buttons:
 *
 *   Start {plan}      → converted + Paid-plan starter (9.8)
 *   Talk to someone   → talk_request (urgent) with slots from OWNER.usHours; client gets talk_ack
 *   Not now           → not_now; the ladder runs (9.6)
 *
 * Tokens: purpose `decision:{tag}` (report link on Day 29, mail link on Day 30);
 * readToken('decision') accepts any of them. They live until after Day 45
 * because the page must work until the domain retires.
 */

import { cfg, isUsHoliday } from '@/lib/config';
import { getClient, getTrial, getProfile, setState } from '@/lib/db/client';
import { requireCounters } from '@/lib/db/counters';
import { addPromise } from '@/lib/db/promises';
import { logEvent } from '@/lib/db/events';
import { alertOwner, notifyClient } from '@/lib/notify';
import { readToken } from '@/lib/pagetokens';
import { trialDay, dayKeyIn, addDays, ET, partsIn, isWeekday, hhmmToMin } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { DECISION_FAQ } from '@/lib/templates/client/stage-d';
import { fill } from '@/lib/templates/render';
import { recommendPlan, plansConfig, decisionLink } from '@/lib/systems/reports';
import { startPlan } from '@/lib/systems/planstart';
import { patchTrial, recordLedger, ownerName, PLAN_NAMES, money, fmtDay, cfgTree } from '@/lib/systems/dshared';

export const FIVE = ['sent', 'replies', 'positive', 'booked', 'qualified'];
const FIVE_LABELS = { sent: 'Emails sent', replies: 'Replies', positive: 'Positive replies', booked: 'Calls booked', qualified: 'Qualified calls' };

async function recommendationFor(clientId, totals, trial, profile) {
  const { plans, capacity } = await plansConfig(clientId);
  return recommendPlan({
    qualified: totals.qualified, positive: totals.positive, companies: totals.companiesContacted,
    capacityPerWeek: profile.capacityPerWeek,
    kickoffDate: trial.agreementAcceptedAt ? fmtDay(String(trial.agreementAcceptedAt).slice(0, 10)) : null,
    extensionUsed: Boolean(trial.extensionStartedAt), plans, capacity,
  });
}

/**
 * Enter `deciding` and send the decision email. Safe to call again: the
 * state change is compare-and-set and the email is deduped.
 * opts: { now, zero }
 */
export async function sendDecision(clientId, { now: realNow = new Date(), zero = false } = {}) {
  const client = await getClient(clientId);
  const now = clientNow(client, realNow);
  const sig = await ownerName(clientId, 'The Day 30 decision email');
  if (!sig) return { held: 'OWNER.signerName' };
  const trial = await getTrial(clientId);
  const gate = await requireCounters(clientId, [...FIVE, 'companiesContacted']);
  if (!gate.ok) {
    await alertOwner('report_blocked', { clientId, scope: `${clientId}:decision`, vars: { report: 'decision', clientId }, body: `The Day 30 decision for ${clientId} is held: missing counter(s) ${gate.missing.join(', ')}.`, did: 'State unchanged; nothing sent.' });
    return { held: 'counters', missing: gate.missing };
  }
  if (client.state !== 'deciding') {
    const bonusHours = await cfg(clientId, 'TRIAL.bonusHours');
    await patchTrial(clientId, {
      decisionSentAt: now.toISOString(),
      bonusExpiresAt: new Date(now.getTime() + bonusHours * 3600_000).toISOString(),
      decisionDay: String(trialDay(trial, now) ?? 30),
    });
    await setState(clientId, 'deciding', zero ? 'decision (zero calls)' : 'decision');
    await recordLedger(clientId, {
      booked: gate.values.booked, qualified: gate.values.qualified, positive: gate.values.positive,
      companies: gate.values.companiesContacted, extension: Boolean(trial.extensionStartedAt), decidingAt: now.toISOString(),
    });
  }
  return sendDecisionEmail(clientId, { now, zero, sig, totals: gate.values });
}

/** The email half — retried by the day job until `decisionEmailAt` exists. */
export async function sendDecisionEmail(clientId, { now = new Date(), zero, sig, totals } = {}) {
  const trial = await getTrial(clientId);
  if (trial.decisionEmailAt) return { sent: false, already: true };
  const profile = await getProfile(clientId);
  sig = sig || (await ownerName(clientId, 'The Day 30 decision email'));
  if (!sig) return { held: 'OWNER.signerName' };
  if (!totals) {
    const gate = await requireCounters(clientId, [...FIVE, 'companiesContacted']);
    if (!gate.ok) return { held: 'counters' };
    totals = gate.values;
  }
  zero = zero ?? Number(totals.qualified) === 0;
  const rec = await recommendationFor(clientId, totals, trial, profile);
  const url = await decisionLink(clientId, 'mail', 30);
  const bonusCfg = rec.plan ? (await cfgTree(clientId, 'BONUS'))?.[rec.plan] : null;
  const vars = zero
    ? { day: trialDay(trial, now) ?? 30, companies: totals.companiesContacted, replies: totals.replies, positive: totals.positive, decisionUrl: url, recommendationLine: rec.text, ownerName: sig }
    : { decisionUrl: url, recommendationLine: `My one recommendation: ${rec.short}.`, bonusLine: bonusCfg ? `${bonusCfg[0]} calls for the price of ${bonusCfg[1]}` : 'none on this plan', bonusExpires: new Date(trial.bonusExpiresAt || now).toUTCString().replace(':00 GMT', ' UTC'), ownerName: sig };
  const res = await notifyClient(clientId, zero ? 'decision_link_zero' : 'decision_link', vars, { dedupe: 'decision_link' });
  if (res.sent || res.deduped) await patchTrial(clientId, { decisionEmailAt: new Date().toISOString() });
  await logEvent(clientId, 'decision', 'decision_sent', { zero, recommendation: rec.plan || rec.kind });
  return { sent: Boolean(res.sent), zero, recommendation: rec.plan || rec.kind };
}

// ── Talk slots ────────────────────────────────────────────────────────────────

/** Next US business days × two times inside OWNER.usHours (ET). */
export function talkSlots(now, usHours, { days = 3 } = {}) {
  const [start, end] = usHours;
  const s = hhmmToMin(start);
  const e = hhmmToMin(end);
  const times = [s, Math.min(s + 180, e - 30)].filter((m, i, a) => m < e && a.indexOf(m) === i);
  const out = [];
  let day = dayKeyIn(ET, now);
  for (let i = 0; i < 14 && out.length < days * times.length; i++) {
    day = addDays(day, 1);
    const wd = partsIn(ET, new Date(`${day}T17:00:00Z`)).weekday;
    if (!isWeekday(wd) || isUsHoliday(day)) continue;
    for (const m of times) out.push(`${fmtDay(day)}, ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} ET`);
  }
  return out;
}

// ── Page data + actions ───────────────────────────────────────────────────────

async function resolve(rawToken) {
  const tok = await readToken(rawToken, { purpose: 'decision' });
  if (!tok) return null;
  const client = await getClient(tok.clientId);
  if (!client) return null;
  return { clientId: tok.clientId, client };
}

/** Everything the decision page renders. Never shows a missing number as 0. */
export async function decisionView(rawToken, { now: realNow = new Date() } = {}) {
  const r = await resolve(rawToken);
  if (!r) return { ok: false, error: 'This link has expired or is not valid.' };
  const { clientId, client } = r;
  const now = clientNow(client, realNow);
  const [trial, profile, gate] = await Promise.all([getTrial(clientId), getProfile(clientId), requireCounters(clientId, [...FIVE, 'companiesContacted'])]);
  const numbers = FIVE.map((f) => ({ key: f, label: FIVE_LABELS[f], value: Number.isFinite(gate.values[f]) ? gate.values[f] : null }));
  const rec = gate.ok ? await recommendationFor(clientId, gate.values, trial, profile) : null;
  const plans = await cfgTree(clientId, 'PLANS');
  const bonusCfg = rec?.plan ? (await cfgTree(clientId, 'BONUS'))?.[rec.plan] : null;
  const expiresAt = trial.bonusExpiresAt || null;
  const perCall = rec?.plan ? money(Math.round(plans[rec.plan].price / plans[rec.plan].calls)) : money(Math.round(plans.starter.price / plans.starter.calls));
  const faq = DECISION_FAQ.map((x) => {
    let a;
    try { a = fill('decision_faq', x.a, { capacityPerWeek: profile.capacityPerWeek, perCall }); } catch { a = null; }
    return a ? { q: x.q, a } : null;
  }).filter(Boolean);
  const open = ['deciding', 'not_now'].includes(client.state);
  return {
    ok: true,
    clientName: client.name || clientId,
    state: client.state,
    open,
    opensOn: trial.day1Date ? fmtDay(addDays(trial.day1Date, 29)) : null,
    decided: client.state === 'converted' ? 'plan' : client.state === 'not_now' ? 'notnow' : trial.talkRequestedAt ? 'talk' : null,
    numbers,
    companies: Number.isFinite(gate.values.companiesContacted) ? gate.values.companiesContacted : null,
    recommendation: rec ? { plan: rec.plan, planName: rec.plan ? PLAN_NAMES[rec.plan] : null, price: rec.plan ? money(plans[rec.plan].price) : null, text: rec.text, kind: rec.kind } : null,
    bonus: bonusCfg && expiresAt ? { calls: bonusCfg[0], forCalls: bonusCfg[1], expiresAt, expired: now.getTime() > Date.parse(expiresAt) } : null,
    now: now.toISOString(),
    faq,
  };
}

/**
 * One button press. action ∈ start | talk | notnow. Idempotent: a second
 * press returns the current outcome without doing anything twice.
 */
export async function decide(rawToken, action, { now: realNow = new Date() } = {}) {
  const r = await resolve(rawToken);
  if (!r) return { ok: false, error: 'This link has expired or is not valid.' };
  const { clientId, client } = r;
  const now = clientNow(client, realNow);
  const trial = await getTrial(clientId);

  if (action === 'start') {
    if (client.state === 'converted') return { ok: true, outcome: 'converted', plan: client.plan, already: true };
    if (!['deciding', 'not_now'].includes(client.state)) return { ok: false, error: 'The decision is not open.' };
    const gate = await requireCounters(clientId, [...FIVE, 'companiesContacted']);
    if (!gate.ok) return { ok: false, error: 'Numbers are still being finalised — try again later.' };
    const rec = await recommendationFor(clientId, gate.values, trial, await getProfile(clientId));
    if (!rec.plan) return { ok: false, error: 'There is no plan to start from these numbers.' };
    const changed = await setState(clientId, 'converted', `Start ${PLAN_NAMES[rec.plan]} clicked`);
    if (!changed) return { ok: true, outcome: 'converted', already: true };
    const bonus = Boolean(trial.bonusExpiresAt) && now.getTime() <= Date.parse(trial.bonusExpiresAt);
    await startPlan(clientId, rec.plan, { bonus, now });
    return { ok: true, outcome: 'converted', plan: rec.plan, bonus };
  }

  if (action === 'talk') {
    if (!['deciding', 'not_now'].includes(client.state)) return { ok: false, error: 'The decision is not open.' };
    if (trial.talkRequestedAt) return { ok: true, outcome: 'talk', already: true };
    const sig = await ownerName(clientId, 'The talk acknowledgement');
    const slots = talkSlots(now, await cfg(clientId, 'OWNER.usHours'));
    await patchTrial(clientId, { talkRequestedAt: now.toISOString(), decision: 'talk' });
    await alertOwner('talk_request', {
      clientId,
      body: `${client.contactName || 'The client'} (${client.name || clientId}, ${client.contactEmail || 'no email on file'}) tapped "Talk to someone" on the Day 30 page.\n\nSlots offered to them (US Eastern):\n${slots.map((s) => `• ${s}`).join('\n')}`,
      did: sig ? 'Emailed the client these slots (talk_ack) and added a promise to answer within 1 business day.' : 'Could not email the slots: OWNER.signerName is not set. Reply to the client by hand.',
    });
    if (sig) await notifyClient(clientId, 'talk_ack', { slots: slots.map((s) => `• ${s}`).join('\n'), ownerName: sig }, { dedupe: 'talk_ack' });
    const due = addDays(dayKeyIn(ET, now), 1);
    await addPromise(clientId, `Answer ${client.name || clientId}'s "Talk to someone" request`, due);
    await logEvent(clientId, 'decision', 'talk_requested', { slots: slots.length });
    return { ok: true, outcome: 'talk', slots };
  }

  if (action === 'notnow') {
    if (client.state === 'not_now') return { ok: true, outcome: 'not_now', already: true };
    if (client.state !== 'deciding') return { ok: false, error: 'The decision is not open.' };
    await setState(clientId, 'not_now', 'Not now clicked');
    await patchTrial(clientId, { decision: 'notnow', decisionAt: now.toISOString() });
    await recordLedger(clientId, { converted: false, notNowAt: now.toISOString() });
    await alertOwner('decision_made', { clientId, vars: { choice: 'Not now' }, body: `${client.name || clientId} tapped "Not now" on the Day 30 page.`, did: 'State is not_now; the follow-up ladder and exit interview run automatically; the domain retires on Day 45.' });
    return { ok: true, outcome: 'not_now' };
  }
  return { ok: false, error: 'Unknown action.' };
}

/** Day 45 with no click (SPEC §9.4). */
export async function expireDecision(clientId, now = new Date()) {
  const changed = await setState(clientId, 'not_now', 'no click by Day 45');
  if (changed) {
    await patchTrial(clientId, { decision: 'none', decisionAt: now.toISOString() });
    await recordLedger(clientId, { converted: false, notNowAt: now.toISOString(), noClick: true });
  }
  return changed;
}
