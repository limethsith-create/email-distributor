/**
 * Sender (SPEC §8.1) — the per-client cold engine for trial clients. Evolved
 * from /api/cron/auto-send (which keeps running the aviance client): per-inbox
 * pacing with jitter, FRESH_MIN_SHARE, follow-up expiry, SET NX lead claims,
 * SMTP error classification and inbox health are kept. New here:
 *
 *   - called per client; reads that client's inboxes, sequence, caps, leads
 *   - window = the lead's own tz 09:00–17:00 Mon–Fri (no US holidays), inside
 *     the inbox ceiling 08:00–19:00 ET
 *   - 4 touches from client:{id}:sequence (variant A/B per lead), threaded
 *   - pre-send gate: Compliance Guard + Copy Checker + suppression + blocklist
 *     + riskLevel rule (risky only when safe + catch-all are used up)
 *   - first-50 smoke test, open tracking off, companiesContacted
 *   - state check: sending | extension only; ready → sending on Day 1
 *   - "I'm away" halves the day's volume (profile.awayRanges)
 *   - at most one email per inbox per tick; hard cap 25 cold / inbox / day
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { HARD_COLD_CAP, isUsHoliday } from '@/lib/config';
import { getClient, getProfile, getTrial, setState, SENDING_STATES } from '@/lib/db/client';
import { getAccounts, patchInbox } from '@/lib/db/inboxes';
import { getLeadsByStatus, getLead, saveLead, isBlocked, hostOf } from '@/lib/db/leads';
import { bump, getTotals } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { varsFor, renderTouch, TemplateError } from '@/lib/systems/sequence';
import { getInboxHealth, recordSendSuccess, recordSendFailure, updateInboxHealth, shouldSkipInbox } from '@/lib/inbox-health';
import { partsIn, dayKeyIn, ET, isWeekday, hhmmToMin, trialDay, addDays } from '@/lib/time';
import { guardOutbound, unsubscribeHeaders } from '@/lib/systems/compliance';
import { checkCopy } from '@/lib/systems/copycheck-adapter';
import { recordLearning } from '@/lib/systems/learning';
import { textToHtml, indexMessageId, renderTemplate } from '@/lib/systems/outbound';
import {
  deps, alert, isTrialClient, lower, parseJson, truthy, listField, leadWindowOpen,
  getRunState, patchRunState, heartbeatAfterSend, nicheOf, requestBounceScan, ccfg } from '@/lib/systems/stagec-common';
import { fill } from '@/lib/templates/render';

export const TOUCHES = ['d0', 'd3', 'd7', 'd10'];
const DAY_MS = 864e5;
const CLAIM_TTL = 300;

// ─── Sequence ────────────────────────────────────────────────────────────────

/** The client's approved copy (Stage B): { A, B, active, version }. */
export async function loadClientSequence(clientId) {
  const h = (await kv.hgetall(K.sequence(clientId))) || {};
  const ok = (s) => (s && Array.isArray(s.touches) && s.touches.length ? s : null);
  return {
    A: ok(parseJson(h.variantA)),
    B: ok(parseJson(h.variantB)),
    active: ['A', 'B'].includes(String(h.active || '').toUpperCase()) ? String(h.active).toUpperCase() : 'both',
    version: Number(h.version) || 1,
  };
}

/** Which variant this lead gets (sticky once the first touch went out). */
export function pickVariant(seqs, lead) {
  const has = (v) => Boolean(seqs[v]);
  if (lead.sentVariant && has(lead.sentVariant)) return lead.sentVariant;
  if (seqs.active !== 'both' && has(seqs.active)) return seqs.active;
  const want = String(lead.sequenceVariant || '').toUpperCase();
  if (has(want)) return want;
  return has('A') ? 'A' : 'B';
}

/** Next touch for a lead, or null when the sequence is finished. */
export function nextTouch(lead) {
  if (!lead.sent_at) return 'd0';
  for (const t of ['d3', 'd7', 'd10']) if (!lead[`${t}_sent_at`] && !lead[`${t}_skipped_at`]) return t;
  return null;
}

/** When `touch` is due (ms) given the gaps [0, 3, 4, 3] (days after the previous touch). */
export function touchDueAt(lead, touch, gaps) {
  const i = TOUCHES.indexOf(touch);
  if (i <= 0) return 0;
  const prev = TOUCHES[i - 1];
  const prevAt = prev === 'd0' ? lead.sent_at : (lead[`${prev}_sent_at`] || lead[`${prev}_skipped_at`]);
  if (!prevAt) return Infinity;
  return Date.parse(prevAt) + (Number(gaps[i]) || 0) * DAY_MS;
}

// ─── Caps, windows, pacing ───────────────────────────────────────────────────

/** Cap from the trial day when Ramp has not written one (RAMP.caps). */
export function rampCapForDay(day, caps) {
  if (!day || day < 1) return 0;
  for (const [range, cap] of Object.entries(caps || {})) {
    const m = /^(\d+)(?:-(\d+)|\+)$/.exec(range);
    if (!m) continue;
    const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : Infinity;
    if (day >= lo && day <= hi) return Number(cap) || 0;
  }
  return 0;
}

/** Is `dayKey` inside any "I'm away" range? profile.awayRanges = [{from, to}] (inclusive day keys). */
export function isAway(profile, dayKey) {
  const ranges = parseJson(profile?.awayRanges, []) || [];
  return Array.isArray(ranges) && ranges.some((r) => r && r.from && r.to && dayKey >= r.from && dayKey <= r.to);
}

export async function inboxCap(clientId, record, { trialDayNum, away }) {
  const coldCap = Math.min(HARD_COLD_CAP, await ccfg(clientId, 'COLD_CAP'));
  const raw = record?.dailyCap;
  let cap = raw !== undefined && raw !== null && raw !== '' && !Number.isNaN(Number(raw))
    ? Number(raw)
    : rampCapForDay(trialDayNum, await ccfg(clientId, 'RAMP.caps'));
  cap = Math.max(0, Math.min(coldCap, HARD_COLD_CAP, Math.floor(cap)));
  if (away) cap = Math.floor(cap / 2);
  return cap;
}

function minutesLeftEt(now, end) {
  return Math.max(0, hhmmToMin(end) - partsIn(ET, now).minuteOfDay);
}

export async function computeNextSendAt(clientId, remainingAfter, now, end) {
  const left = minutesLeftEt(now, end);
  if (left <= 0) return null;
  const min = await ccfg(clientId, 'PACING.minGapMin');
  const max = await ccfg(clientId, 'PACING.maxGapMin');
  const base = left / Math.max(1, remainingAfter);
  const gap = Math.max(min, Math.min(max, base * (0.85 + Math.random() * 0.3)));
  return new Date(now.getTime() + gap * 60000).toISOString();
}

// ─── Smoke test (first 50) ───────────────────────────────────────────────────

/**
 * Advance the first-50 smoke test. Called by the sender and after every
 * bounce scan. Returns { cleared, failed, waiting }.
 *  - total sends < 50: nothing to do (allowance = 50 − sent)
 *  - reached 50: hold, ask for a bounce scan now
 *  - after that scan: bounce rate > 3 % → emergencyRequested = smoke_bounce
 *  - else ask for a second scan 2 h after reaching 50; after it (still ≤ 3 %) → cleared
 */
export async function evaluateSmoke(clientId, now = new Date()) {
  const st = await getRunState(clientId);
  if (st.smokeClearedAt) return { cleared: true };
  if (st.smokeFailedAt) return { failed: true };
  const limit = await ccfg(clientId, 'SEND.smokeTestSends');
  const totals = await getTotals(clientId);
  const sent = Number(totals.sent) || 0;
  if (sent < limit) return { waiting: 'sending', allowance: limit - sent };
  if (!st.smokeReachedAt) {
    await patchRunState(clientId, { smokeReachedAt: now.toISOString() });
    await requestBounceScan(clientId, now.toISOString());
    await logEvent(clientId, 'sender', 'smoke_reached', { sent });
    return { waiting: 'first scan' };
  }
  const scanned = st.bounceScanDoneAt || '';
  if (!scanned || scanned < st.smokeReachedAt) return { waiting: 'first scan' };
  const bounces = Number(totals.bounces) || 0;
  const rate = sent ? bounces / sent : 0;
  const max = await ccfg(clientId, 'SEND.smokeTestBounceMax');
  if (rate > max) {
    await patchRunState(clientId, { smokeFailedAt: now.toISOString() });
    await kv.hset(K.client(clientId), { emergencyRequested: 'smoke_bounce', emergencyRequestedAt: now.toISOString() });
    await logEvent(clientId, 'sender', 'smoke_failed', { sent, bounces, rate: Math.round(rate * 1000) / 10 });
    return { failed: true, rate };
  }
  const hours = await ccfg(clientId, 'SMOKE.rescanHours');
  const secondAt = Date.parse(st.smokeReachedAt) + hours * 3600e3;
  if (now.getTime() < secondAt) return { waiting: 'second scan time' };
  if (!st.smokeRescanAt) {
    await patchRunState(clientId, { smokeRescanAt: now.toISOString() });
    await requestBounceScan(clientId, now.toISOString());
    return { waiting: 'second scan' };
  }
  if (scanned < st.smokeRescanAt) return { waiting: 'second scan' };
  await patchRunState(clientId, { smokeClearedAt: now.toISOString() });
  await logEvent(clientId, 'sender', 'smoke_cleared', { sent, bounces, rate: Math.round(rate * 1000) / 10 });
  return { cleared: true };
}

// ─── Day 1 ───────────────────────────────────────────────────────────────────

/** ready → sending at the first US business morning on/after day1Date (SPEC §4). */
export async function maybeStartDay1(client, now = new Date()) {
  const p = partsIn(ET, now);
  if (!isWeekday(p.weekday) || isUsHoliday(p.dayKey)) return { started: false, reason: 'not a US business day' };
  const [start] = await ccfg(client.id, 'SEND.windowLeadTz');
  if (p.hhmm < start) return { started: false, reason: 'before 9 AM ET' };
  const trial = await getTrial(client.id);
  if (trial.day1Date && p.dayKey < trial.day1Date) return { started: false, reason: `day 1 is ${trial.day1Date}` };
  const changed = await setState(client.id, 'sending', 'day 1 — first send window');
  return { started: true, changed };
}

async function markFirstSend(clientId, now) {
  const trial = await getTrial(clientId);
  if (trial.firstSendAt) return;
  const today = dayKeyIn(ET, now);
  const fields = { firstSendAt: now.toISOString() };
  if (trial.day1Date !== today) {
    fields.day1Date = today;
    fields.day30Date = addDays(today, 29);
    fields.day1MovedFrom = trial.day1Date || '';
  }
  await kv.hset(K.trial(clientId), fields);
  await logEvent(clientId, 'sender', 'first_send', fields);
}

// ─── Lead pools ──────────────────────────────────────────────────────────────

const RISK_ORDER = { safe: 0, catchall: 1, risky: 2 };
function riskOf(lead) { return RISK_ORDER[lower(lead.riskLevel)] ?? 0; }

/** Pace settings the Pace Checks may have switched on (client:{id}:pace). */
export async function loadPace(clientId) {
  const h = (await kv.hgetall(K.pace(clientId))) || {};
  return {
    compressed: truthy(h.compressed),
    earlySend: truthy(h.earlySend),
    softInterested: truthy(h.softInterested),
    narrowSlice: parseJson(h.narrowSlice, null),
    exclude: parseJson(h.exclude, null),
  };
}

function excluded(lead, pace) {
  const ex = pace.exclude;
  if (!ex) return false;
  const size = lower(lead.sizeBand || lead.size);
  const title = lower(lead.title);
  if (size && (ex.sizeBands || []).map(lower).includes(size)) return true;
  if (title && (ex.titles || []).map(lower).some((t) => t && title.includes(t))) return true;
  return false;
}

function inSlice(lead, slice) {
  if (!slice || !slice.field) return false;
  return lower(lead[slice.field]) === lower(slice.value);
}

/**
 * Order fresh leads: pace exclusions dropped; risky leads only when no safe
 * or catch-all lead is left in the whole pool; then narrow slice first,
 * referrals first, early-morning leads first (pace), score, then random.
 */
export function orderFresh(unsent, { pace, now, window }) {
  const pool = unsent.filter((l) => !excluded(l, pace));
  const hasSafer = pool.some((l) => riskOf(l) < 2);
  const eligible = pool.filter((l) => (hasSafer ? riskOf(l) < 2 : true));
  const open = eligible.filter((l) => leadWindowOpen(l, now, window));
  for (const l of open) l.__r = Math.random();
  const localHour = (l) => partsIn(l.tz || ET, now).hour;
  open.sort((a, b) => (Number(inSlice(b, pace.narrowSlice)) - Number(inSlice(a, pace.narrowSlice)))
    || (Number(b.source === 'referral') - Number(a.source === 'referral'))
    || (pace.earlySend ? localHour(a) - localHour(b) : 0)
    || (riskOf(a) - riskOf(b))
    || ((Number(b.score) || 0) - (Number(a.score) || 0))
    || (a.__r - b.__r));
  for (const l of open) delete l.__r;
  return { open, poolSize: pool.length };
}

/** Due follow-ups by inbox (oldest first) + expired ones. */
export function dueFollowUps(inSeq, { now, gaps, graceDays, window }) {
  const due = [];
  const expired = [];
  const nowMs = now.getTime();
  for (const lead of inSeq) {
    const touch = nextTouch(lead);
    if (!touch || touch === 'd0') continue;
    if (lead.holdUntil && Date.parse(lead.holdUntil) > nowMs) continue;
    const at = touchDueAt(lead, touch, gaps);
    if (!Number.isFinite(at) || at > nowMs) continue;
    if (nowMs - at > graceDays * DAY_MS) { expired.push({ lead, touch, at }); continue; }
    if (!leadWindowOpen(lead, now, window)) continue;
    due.push({ lead, touch, at });
  }
  due.sort((a, b) => a.at - b.at);
  return { due, expired };
}

// ─── Building one email ──────────────────────────────────────────────────────

const reSubject = (s) => `Re: ${String(s || '').replace(/^\s*re:\s*/i, '').trim()}`;

/** Slot values for a trial lead: sequence.varsFor + client-level slots (Copy Engine names). */
export function trialVars(lead, { client = {}, profile = {}, account = null }) {
  const base = varsFor(lead, { profile, account });
  return {
    ...base,
    SenderName: profile.senderName || base.SenderName,
    ClientCompany: client.name || profile.companyName,
    oneLiner: profile.oneLiner || profile.sellsTo,
    niche: base.niche || profile.niche || listField(profile.industry)[0],
    ICP: base.ICP || profile.icp,
  };
}

/**
 * Render subject/text/html/threading for one touch. Throws TemplateError on a
 * missing slot. Threading: d3 in the d0 thread; d7 a new thread when its
 * touch has a subject; d10 in the d7 thread (d0's when d7 was skipped).
 */
export function buildTouch({ seq, touch, lead, vars, referral = false }) {
  let subject; let body; let footer; let thread;
  if (referral && touch === 'd0') {
    const r = renderTemplate('referral_intro', { ...vars, Referrer: lead.referrerName, Greeting: vars.FirstName ? `Hi ${vars.FirstName},` : 'Hi there,', Company: vars.Company });
    subject = r.subject; body = r.text; thread = 'new';
    footer = seq.footer ? fill('sequence:d0:footer', seq.footer, vars) : '';
  } else {
    const c = renderTouch(seq, touch, vars);
    subject = c.subject; body = c.body; footer = c.footer; thread = c.thread;
  }
  const headers = {};
  if (touch !== 'd0') {
    if (thread === 'd0' || (thread === 'd7' && !lead.d7_message_id)) {
      subject = reSubject(lead.original_subject || subject);
      const refs = [lead.original_message_id, lead.d3_message_id].filter(Boolean);
      if (refs.length) { headers.inReplyTo = refs[refs.length - 1]; headers.references = refs; }
    } else if (thread === 'd7') {
      subject = reSubject(lead.d7_subject || subject);
      headers.inReplyTo = lead.d7_message_id;
      headers.references = [lead.original_message_id, lead.d7_message_id].filter(Boolean);
    }
  }
  if (!subject) throw new TemplateError(`sequence:${touch}`, ['subject']);
  const text = footer ? `${body}\n\n${footer}` : body;
  const note = footer ? footer.split(/\n\s*\n/).pop().trim() : '';
  const bodyOnly = footer ? `${body}\n\n${footer.slice(0, footer.length - note.length).trim()}` : body;
  return { subject, body, text, html: textToHtml(bodyOnly, note), headers, thread };
}

// ─── Recording ───────────────────────────────────────────────────────────────

async function saveLeadPatch(clientId, email, patch) {
  const existing = await getLead(clientId, email);
  if (!existing) return null;
  return saveLead(clientId, { ...existing, ...patch }, existing.status);
}

async function recordSuccess(clientId, { account, lead, touch, built, res, variant, version, now, niche }) {
  const at = now.toISOString();
  const base = { account_used: account.email, last_touch: touch, last_touch_at: at, send_count: (Number(lead.send_count) || 0) + 1 };
  let patch;
  if (touch === 'd0') {
    patch = { ...base, status: 'in_sequence', sent_at: at, original_subject: built.subject, original_message_id: res.messageId || null, sentVariant: variant, sentVersion: version, sequence_day: 0 };
  } else {
    patch = { ...base, [`${touch}_sent_at`]: at, [`${touch}_message_id`]: res.messageId || null, [`${touch}_subject`]: built.subject, sequence_day: Number(touch.slice(1)) };
    if (touch === 'd10') { patch.status = 'done'; patch.sequenceCompleteAt = at; }
  }
  const saved = await saveLeadPatch(clientId, lead.email, patch);
  await indexMessageId(clientId, res.messageId, lead.email);
  const day = dayKeyIn(ET, now);
  const p = kv.pipeline();
  p.hincrby(K.inboxSends(clientId, day), account.email, 1);
  p.hincrby(K.inboxSends(clientId, day), `${account.email}:${touch}`, 1);
  p.expire(K.inboxSends(clientId, day), 30 * 86400);
  await p.exec();
  await bump(clientId, 'sent', 1, now);
  await bump(clientId, `sent${touch.toUpperCase()}`, 1, now);
  if (touch === 'd0') {
    const host = hostOf(lead.email);
    if (host && (await kv.sadd(K.sentHosts(clientId), host)) === 1) await bump(clientId, 'companiesContacted', 1, now);
    await markFirstSend(clientId, now);
  }
  await recordSendSuccess(account.email, { ms: res.ms, response: res.response, messageId: res.messageId });
  await recordLearning(clientId, 'sends', { lead: saved || { ...lead, ...patch }, niche, at });
  await kv.del(K.leadClaim(clientId, lead.email));
}

async function recordFailure(clientId, { account, lead, touch, res, now }) {
  const kind = res.kind || 'other';
  const at = now.toISOString();
  await recordSendFailure(account.email, res);
  await requestBounceScan(clientId, at);
  await logEvent(clientId, 'sender', 'send_failed', { to: lead.email, inbox: account.email, touch, kind, error: String(res.error || '').slice(0, 200) });
  if (kind === 'recipient') {
    await saveLeadPatch(clientId, lead.email, { status: 'bounced', bouncedAt: at, bounceReason: String(res.response || res.error || '').slice(0, 200), bounceSource: 'smtp-reject' });
    await bump(clientId, 'bounces', 1, now);
    await kv.hincrby(K.inboxSends(clientId, dayKeyIn(ET, now)), `${account.email}:bounces`, 1);
    await kv.del(K.leadClaim(clientId, lead.email));
    return 'bounced';
  }
  if (kind === 'content') {
    await saveLeadPatch(clientId, lead.email, touch === 'd0'
      ? { status: 'done', skipReason: 'rejected by receiving server', last_error: res.response || res.error, last_error_at: at }
      : { last_error: res.response || res.error, last_error_at: at });
    await kv.del(K.leadClaim(clientId, lead.email));
    return 'rejected';
  }
  if (kind === 'auth') {
    await patchInbox(clientId, account.email, { enabled: '0', disabledReason: 'login failed — check the app password', disabledAt: at });
    await updateInboxHealth(account.email, { disabledReason: `Login failed (${res.responseCode || res.code || 'EAUTH'}): check the app password`, disabledAt: at });
    await alert('inbox_auth_fail', { clientId, scope: account.email, vars: { email: account.email }, body: `SMTP login failed for ${account.email} (${clientId}).`, did: 'The inbox was switched off for cold sending; the lead goes back to the pool.' });
  }
  await saveLeadPatch(clientId, lead.email, { last_error: String(res.error || '').slice(0, 200), last_error_at: at });
  await kv.del(K.leadClaim(clientId, lead.email));
  return kind;
}

async function closeLead(clientId, lead, status, reason) {
  await saveLeadPatch(clientId, lead.email, { status, skipReason: reason, skippedAt: new Date().toISOString() });
  await kv.del(K.leadClaim(clientId, lead.email));
  await logEvent(clientId, 'sender', 'lead_skipped', { to: lead.email, status, reason });
}

// ─── One attempt ─────────────────────────────────────────────────────────────

/**
 * Try to send `touch` to `lead` from `account`. Returns
 * { sent, stopInbox, stopClient, skipped, reason }.
 */
async function attempt(clientId, { account, lead: candidate, touch, ctx, now }) {
  const email = lower(candidate.email);
  const got = await kv.set(K.leadClaim(clientId, email), now.getTime(), { nx: true, ex: CLAIM_TTL });
  if (got !== 'OK') return { skipped: true, reason: 'claimed' };
  const lead = await getLead(clientId, email);
  const release = () => kv.del(K.leadClaim(clientId, email));
  if (!lead || nextTouch(lead) !== touch || (touch === 'd0' && lead.status !== 'unsent') || (touch !== 'd0' && lead.status !== 'in_sequence')) {
    await release();
    return { skipped: true, reason: 'lead moved on' };
  }

  // Gate 1: suppression + blocklist (lead-specific, final).
  const blocked = await isBlocked(clientId, email);
  if (blocked) {
    await closeLead(clientId, lead, blocked === 'suppressed' ? 'suppressed' : 'done', blocked);
    return { skipped: true, reason: blocked };
  }
  // Gate 2: the address still has a mail server (first touch only; cached per domain).
  if (touch === 'd0') {
    const v = await deps.verifyEmail(email);
    if (v && v.valid === false) { await closeLead(clientId, lead, 'done', `unverified: ${v.reason}`); return { skipped: true, reason: 'unverified' }; }
  }

  const variant = pickVariant(ctx.seqs, lead);
  const seq = ctx.seqs[variant];
  let built;
  try {
    built = buildTouch({ seq, touch, lead, vars: trialVars(lead, { client: ctx.client, profile: ctx.profile, account }), referral: lead.source === 'referral' });
  } catch (err) {
    const missing = err instanceof TemplateError ? err.missing.join(', ') : err.message;
    if (touch === 'd0') { await closeLead(clientId, lead, 'done', `copy slot missing: ${missing}`); }
    else {
      const at = now.toISOString();
      await saveLeadPatch(clientId, email, touch === 'd10'
        ? { status: 'done', d10_skipped_at: at, d10_skip_reason: `copy slot missing: ${missing}` }
        : { [`${touch}_skipped_at`]: at, [`${touch}_skip_reason`]: `copy slot missing: ${missing}` });
      await release();
    }
    return { skipped: true, reason: `copy: ${missing}` };
  }

  // Gate 3: Copy Checker (Stage B, with the local fallback).
  const copy = await checkCopy({ subject: built.subject, body: built.body, text: built.text, touch, firstTouch: touch === 'd0', variant }, ctx.profile);
  if (!copy.ok) {
    await release();
    await logEvent(clientId, 'sender', 'copy_blocked', { touch, variant, failures: copy.failures });
    await alert('copy_blocked', { clientId, scope: `${clientId}:${variant}:${touch}`, vars: { clientId, rule: copy.failures.join(', ') }, body: `Touch ${touch} of variant ${variant} failed the Copy Checker: ${copy.failures.join(', ')}.`, did: 'Sending for this client is held until the copy passes.' });
    return { stopClient: true, reason: 'copy_blocked' };
  }

  // Gate 4: Compliance Guard.
  const headers = { ...unsubscribeHeaders(email, account.email) };
  const guard = await guardOutbound(clientId, { to: email, fromName: account.displayName, fromAddress: account.email, subject: built.subject, text: built.text, headers }, { profile: ctx.profile, inboxEmails: ctx.inboxEmails, firstTouch: touch === 'd0', now });
  if (!guard.ok) {
    if (guard.leadSpecific) { await closeLead(clientId, lead, guard.rule === 'suppressed' ? 'suppressed' : 'done', `compliance: ${guard.rule}`); return { skipped: true, reason: guard.rule }; }
    await release();
    return { stopClient: true, reason: `compliance: ${guard.rule}` };
  }

  let res;
  try {
    res = await deps.sendEmail(account, { to: email, subject: built.subject, text: built.text, html: built.html, headers, noTrack: true, touch, ...built.headers });
  } catch (err) {
    res = { success: false, kind: 'other', error: err.message };
  }
  if (res && res.success) {
    await recordSuccess(clientId, { account, lead, touch, built, res, variant, version: lead.sentVersion || ctx.seqs.version, now, niche: ctx.niche });
    return { sent: true, detail: { to: email, inbox: account.email, touch, variant, subject: built.subject } };
  }
  const outcome = await recordFailure(clientId, { account, lead, touch, res: res || {}, now });
  return { failed: true, outcome, stopInbox: ['auth', 'transient', 'other'].includes(outcome) };
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** True when every inbox of the client has a future nextSendAt or no sends left today. */
async function allInboxesIdle(clientId, now) {
  const p = kv.pipeline();
  p.smembers(K.inboxes(clientId));
  p.hgetall(K.pacing(clientId));
  const [emails, pacing] = await p.exec();
  if (!emails || !emails.length) return false;
  const today = dayKeyIn(ET, now);
  return emails.every((e) => {
    const rec = parseJson((pacing || {})[e], null);
    if (!rec) return false;
    if (rec.nextSendAt && Date.parse(rec.nextSendAt) > now.getTime()) return true;
    return rec.day === today && Number(rec.remaining) <= 0;
  });
}

/**
 * One tick of the Sender for one client. At most one email per inbox.
 * Returns a summary for the scheduler log.
 */
export async function runSender(clientId, { now = new Date(), deadline = Date.now() + 15_000, client: loaded = null } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  // Cheap idle path (2 commands): every inbox paced or at today's cap → nothing to do.
  if (loaded && SENDING_STATES.has(loaded.state)) {
    const idle = await allInboxesIdle(clientId, now);
    if (idle) return { sent: 0, paced: true, idle: true };
  }
  let client = loaded && loaded.state !== 'ready' ? loaded : await getClient(clientId);
  if (!client) return { skipped: 'no client' };
  if (client.state === 'ready') {
    const r = await maybeStartDay1(client, now);
    if (!r.started) return { skipped: r.reason };
    client = await getClient(clientId);
  }
  if (!SENDING_STATES.has(client.state)) return { skipped: `state ${client.state}` };
  if (client.legalHoldAt) return { skipped: 'legal hold — owner must clear it' };

  const p = partsIn(ET, now);
  const inboxWin = await ccfg(clientId, 'SEND.windowInboxEt');
  if (!isWeekday(p.weekday) || isUsHoliday(p.dayKey) || p.hhmm < inboxWin[0] || p.hhmm >= inboxWin[1]) return { skipped: 'outside the inbox window' };

  const [profile, trial, seqs] = await Promise.all([getProfile(clientId), getTrial(clientId), loadClientSequence(clientId)]);
  if (!seqs.A && !seqs.B) {
    await alert('config_missing', { clientId, scope: `${clientId}:sequence`, vars: { key: 'approved sequence' }, body: `${clientId} is in ${client.state} but client:${clientId}:sequence has no variant to send.`, did: 'Sending is held.' });
    return { blocked: 'no sequence' };
  }
  const missing = ['senderName', 'postalAddress'].filter((f) => !profile[f]);
  if (missing.length) {
    await alert('config_missing', { clientId, scope: `${clientId}:footer`, vars: { key: missing.join(', ') }, body: `${clientId} cannot send: the email footer needs ${missing.join(' and ')} (legally required).`, did: 'Sending is held.' });
    return { blocked: 'footer', missing };
  }

  // Smoke test: cap total sends at 50 until the bounce scans clear it.
  const smoke = await evaluateSmoke(clientId, now);
  if (smoke.failed || (!smoke.cleared && smoke.waiting !== 'sending')) return { held: 'smoke test', smoke };
  let allowance = smoke.cleared ? Infinity : smoke.allowance;

  const accounts = (await getAccounts(clientId, { enabledOnly: true })).filter((a) => a.appPassword);
  if (!accounts.length) return { skipped: 'no enabled inbox' };
  const inboxEmails = (await getAccounts(clientId)).map((a) => a.email);

  const day = p.dayKey;
  const [counts, pacingMap, health, pace] = await Promise.all([
    kv.hgetall(K.inboxSends(clientId, day)).then((r) => r || {}),
    kv.hgetall(K.pacing(clientId)).then((r) => r || {}),
    getInboxHealth(),
    loadPace(clientId),
  ]);
  const tDay = trialDay(trial, now);
  const away = isAway(profile, day);
  const share = Math.min(0.9, Math.max(0, Number(await ccfg(clientId, 'FRESH_MIN_SHARE')) || 0));
  const status = [];
  for (const a of accounts) {
    const cap = await inboxCap(clientId, a.record, { trialDayNum: tDay, away });
    const sent = Number(counts[a.email]) || 0;
    const fresh = Number(counts[`${a.email}:d0`]) || 0;
    const pacing = parseJson(pacingMap[a.email], null);
    const nextAt = pacing?.nextSendAt ? Date.parse(pacing.nextSendAt) : 0;
    const skip = shouldSkipInbox(health[a.email], now.getTime());
    status.push({
      account: a, cap, sent, remaining: Math.max(0, cap - sent),
      followUpsToday: Math.max(0, sent - fresh), followUpBudget: Math.max(0, cap - Math.min(cap, Math.ceil(cap * share))),
      ready: !nextAt || nextAt <= now.getTime(), skip: skip.skip ? skip.reason : null,
    });
  }
  const due = status.filter((s) => s.remaining > 0 && s.ready && !s.skip).sort((a, b) => (b.remaining - a.remaining) || (Math.random() - 0.5));
  if (!due.length) return { sent: 0, paced: true, away, inboxes: status.map((s) => ({ email: s.account.email, cap: s.cap, sent: s.sent, ready: s.ready, skip: s.skip })) };

  const window = await ccfg(clientId, 'SEND.windowLeadTz');
  const gaps = await ccfg(clientId, pace.compressed ? 'SEQUENCE.compressedGaps' : 'SEQUENCE.gaps');
  const graceDays = await ccfg(clientId, 'FOLLOWUP_GRACE_DAYS');
  const [inSeq, unsent] = await Promise.all([getLeadsByStatus(clientId, 'in_sequence', 5000), getLeadsByStatus(clientId, 'unsent', 5000)]);
  const { due: followUps, expired } = dueFollowUps(inSeq, { now, gaps, graceDays, window });
  for (const { lead, touch, at } of expired.slice(0, 40)) {
    await saveLeadPatch(clientId, lead.email, { status: 'done', expiredAt: now.toISOString(), expiredTouch: touch, expiredReason: `${touch} was due ${new Date(at).toISOString().slice(0, 10)}, more than ${graceDays} days ago` });
  }
  const { open: fresh, poolSize } = orderFresh(unsent, { pace, now, window });

  const ctx = { client, profile, seqs, inboxEmails, niche: nicheOf(client, profile) };
  const results = { sent: 0, details: [], skipped: 0, failed: 0 };
  let tried = 0;
  const used = new Set();

  for (const s of due) {
    if (allowance <= 0) break;
    if (Date.now() > deadline - 3000) { results.budget = true; break; }
    const inbox = s.account.email;
    let sentThis = false;
    let stopInbox = false;

    // 1) follow-ups first on the thread's own inbox, within the follow-up budget
    const reserveFresh = s.followUpsToday >= s.followUpBudget && poolSize > 0;
    if (!reserveFresh) {
      for (const fu of followUps) {
        if (sentThis || stopInbox) break;
        if (lower(fu.lead.account_used) !== inbox || used.has(fu.lead.email)) continue;
        tried++;
        const r = await attempt(clientId, { account: s.account, lead: fu.lead, touch: fu.touch, ctx, now });
        used.add(fu.lead.email);
        if (r.stopClient) { results.blocked = r.reason; break; }
        if (r.sent) { sentThis = true; results.details.push(r.detail); }
        else if (r.failed) { results.failed++; stopInbox = r.stopInbox; if (r.outcome !== 'bounced') break; }
        else results.skipped++;
        if (Date.now() > deadline - 3000) break;
      }
    }
    if (results.blocked) break;

    // 2) a fresh first touch
    let scanned = 0;
    for (const lead of fresh) {
      if (sentThis || stopInbox || scanned++ >= 25) break;
      if (used.has(lead.email)) continue;
      used.add(lead.email);
      tried++;
      const r = await attempt(clientId, { account: s.account, lead, touch: 'd0', ctx, now });
      if (r.stopClient) { results.blocked = r.reason; break; }
      if (r.sent) { sentThis = true; results.details.push(r.detail); }
      else if (r.failed) { results.failed++; stopInbox = r.stopInbox; }
      else results.skipped++;
      if (Date.now() > deadline - 3000) break;
    }
    if (results.blocked) break;

    if (sentThis) {
      results.sent++;
      allowance--;
      const nextSendAt = await computeNextSendAt(clientId, Math.max(0, s.remaining - 1), now, inboxWin[1]);
      await kv.hset(K.pacing(clientId), { [inbox]: { nextSendAt, lastSendAt: now.toISOString(), remaining: Math.max(0, s.remaining - 1), day: p.dayKey } });
    }
  }

  if (results.sent > 0 && !smoke.cleared) await evaluateSmoke(clientId, now);
  await heartbeatAfterSend({ sent: results.sent, dueButUnsent: results.sent === 0 && tried > 0 && !results.blocked });
  return { ...results, followUpsDue: followUps.length, freshOpen: fresh.length, expired: expired.length, away };
}
