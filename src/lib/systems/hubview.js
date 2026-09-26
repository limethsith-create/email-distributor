/**
 * Hub view (docs/HUB-API.md): what the Aviance Hub's Trials section shows.
 *
 * For every client it turns the stored state of the thirteen systems into
 * one card each (status + one line), and derives the owner's to-do list —
 * "what you're supposed to do" — from state and flags, never from guesses.
 * `systemsFor`, `todosFor` and `stateLabelFor` are pure (ctx → data) so they
 * are unit-tested on fixtures; `loadContext` gathers the ctx from Redis.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getAllClients, getClient, getProfile, getTrial, getDomain } from '@/lib/db/client';
import { getInboxRecords, publicInbox } from '@/lib/db/inboxes';
import { getEvents } from '@/lib/db/events';
import { getAlertLog, baseUrl } from '@/lib/notify';
import { clientNow } from '@/lib/testclock';
import { boardData, clientRow } from '@/lib/systems/boarddata';
import { clientExtras } from '@/lib/systems/clientview';
import { readChecks } from '@/lib/systems/setupcheck';
import { getShopping } from '@/lib/systems/pricescout';
import { researchView } from '@/lib/systems/research';
import { deliverabilityView } from '@/lib/systems/deliverability';
import { leadQualityView } from '@/lib/systems/grader';
import { inquirySummary } from '@/lib/systems/inquiries';
import { getState as leadfinderState } from '@/lib/systems/leadfinder';
import { getApproval } from '@/lib/systems/approval';
import { getPaceLog } from '@/lib/systems/pace';
import { getRunState } from '@/lib/systems/stagec-common';
import { listQueue } from '@/lib/systems/gatekeeper';
import { overduePromises } from '@/lib/systems/health';
import { jobRecords } from '@/lib/scheduler';
import { loadAccounts } from '@/lib/smtp-accounts';
import { JOBS } from '@/lib/jobs';
import { onboardSettings, onboardCallView, onboardCallFor, ownerWhen, ownerDayWord } from '@/lib/systems/onboardcall';
import { conversationFor, needsReplyFor } from '@/lib/systems/conversation';
import { formatDay } from '@/lib/systems/intake-io';
import { autobuyView, readRec as readAutobuy, autobuySettings, AUTOBUY_STATES } from '@/lib/systems/autobuy';
import { isConnected as cheapInboxesConnected, readDomainIndex, unmatchedOf } from '@/lib/ext/cheapinboxes';
import { warmupView, hubWarmupData, WARMUP_VIEW_STATES } from '@/lib/systems/warmup';

export const STATE_LABELS = {
  applied: 'Applied', queued: 'In the queue', onboarding: 'Onboarding', awaiting_purchase: 'Waiting for you to buy',
  setup_check: 'Checking the setup', warming: 'Warming up', ready: 'Ready for Day 1', sending: 'Sending', paused: 'Paused',
  extension: 'Free extension', deciding: 'Deciding', converted: 'Converted', not_now: 'Not now', retired: 'Retired',
  deleted: 'Deleted', declined: 'Declined', closed_silent: 'Never finished onboarding',
};

export const STAGES = [
  { key: 'intake', label: 'Applied & queued', states: ['applied', 'queued'] },
  { key: 'onboard', label: 'Onboarding', states: ['onboarding'] },
  { key: 'setup', label: 'Buying & setup', states: ['awaiting_purchase', 'setup_check'] },
  { key: 'build', label: 'Warm-up & build', states: ['warming', 'ready'] },
  { key: 'live', label: 'Sending', states: ['sending', 'paused', 'extension'] },
  { key: 'decide', label: 'Deciding', states: ['deciding'] },
  { key: 'won', label: 'Converted', states: ['converted'] },
  { key: 'closing', label: 'Not now & closing', states: ['not_now', 'retired'] },
  { key: 'ended', label: 'Ended', states: ['declined', 'closed_silent', 'deleted'] },
];

const SYSTEM_ORDER = ['intake', 'market', 'purchase', 'setup', 'warmup', 'list', 'copy', 'canary', 'sending', 'replies', 'calls', 'reports', 'closing'];
const SYSTEM_LABELS = {
  intake: 'Intake', market: 'Market count', purchase: 'Domain & inboxes', setup: 'Setup checks', warmup: 'Warm-up', list: 'Lead list',
  copy: 'Copy & approval', canary: 'Placement & ramp', sending: 'Sending', replies: 'Replies', calls: 'Calls', reports: 'Reports & decision', closing: 'Close-out',
};

// ─── small helpers ────────────────────────────────────────────────────────────

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const has = (v) => v !== null && v !== undefined && v !== '';
const truthy = (v) => v === true || v === '1' || v === 'true' || v === 1;
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
const rate = (v) => { const x = n(v); if (!Number.isFinite(x)) return null; return x > 1 ? x / 100 : x; };
const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : null);
const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export function ago(iso, now = new Date()) {
  if (!iso) return '';
  const s = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function daysSince(iso, now) {
  if (!iso) return null;
  const d = Math.floor((now.getTime() - Date.parse(iso)) / 864e5);
  return Number.isFinite(d) ? d + 1 : null;
}

const sys = (key, status, line, detail = []) => ({ key, label: SYSTEM_LABELS[key], status, line, detail: detail.filter(Boolean) });

const parseJ = (v, fb) => { if (v == null || v === '') return fb; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fb; } };

/** The stored application → the hub's shape (docs/HUB-API.md "application"), or null. */
export function applicationView(raw) {
  if (!raw || !Object.keys(raw).length) return null;
  return {
    receivedAt: raw.receivedAt || null,
    source: raw.source || null,
    review: raw.review || null,
    decidedAt: raw.decidedAt || null,
    decision: raw.decision || null,
    declineReason: raw.declineReason || null,
    answers: parseJ(raw.answers, []),
    fit: parseJ(raw.fit, null),
  };
}

/** The research Fit Score (systems/fitscore.js) → the board's badge { score, grade, label, confidence }, or null. */
export function scoreBadge(raw) {
  const f = parseJ(raw, null);
  if (!f || !f.label) return null;
  return { score: typeof f.score === 'number' ? f.score : null, grade: f.grade || null, label: f.label, confidence: f.confidence ?? null };
}
const badgeText = (b) => (b ? `fit score ${b.score !== null ? `${b.score}/100` : '—'} (${b.label})` : '');

const underReview = (ctx) => ctx.client.state === 'applied' && ctx.application?.review === 'pending';

// ─── state label ──────────────────────────────────────────────────────────────

export function stateLabelFor(ctx) {
  const { client, trial = {}, day, shopping = {}, now } = ctx;
  const base = STATE_LABELS[client.state] || client.state;
  if (underReview(ctx)) return `${base} — waiting for your review`;
  switch (client.state) {
    case 'queued': return client.queueExpectedDate ? `${base} — expected ${client.queueExpectedDate}` : base;
    case 'onboarding': return trial.onboardingSentAt ? `${base} — link sent ${ago(trial.onboardingSentAt, now)}` : base;
    case 'awaiting_purchase': return shopping.sentAt ? `${base} — ${ago(shopping.sentAt, now)}` : base;
    case 'warming': return trial.day1Date ? `${base} — Day ${day} (Day 1 on ${trial.day1Date})` : base;
    case 'ready': return trial.day1Date ? `${base} — Day 1 on ${trial.day1Date}` : base;
    case 'sending': return day != null ? `${base} — Day ${day} of 30` : base;
    case 'paused': return client.pausedReason ? `${base} — ${client.pausedReason}` : base;
    case 'extension': return day != null ? `${base} — Day ${day}` : base;
    case 'deciding': return trial.bonusExpiresAt ? `${base} — bonus until ${String(trial.bonusExpiresAt).slice(0, 16).replace('T', ' ')}` : base;
    case 'converted': return client.paidAt ? `${base} — paid` : client.planStartedAt ? `${base} — invoice out` : base;
    case 'not_now': return day != null ? `${base} — Day ${day}` : base;
    case 'retired': return trial.dataDeleteAt ? `${base} — data deleted on ${trial.dataDeleteAt}` : base;
    case 'declined': return client.declineReason ? `${base} — ${client.declineReason}` : base;
    default: return base;
  }
}

// ─── the thirteen systems ─────────────────────────────────────────────────────

const STATE_INDEX = ['applied', 'queued', 'onboarding', 'awaiting_purchase', 'setup_check', 'warming', 'ready', 'sending', 'paused', 'extension', 'deciding', 'converted', 'not_now', 'retired', 'deleted'];
const past = (state, target) => STATE_INDEX.indexOf(state) > STATE_INDEX.indexOf(target);
const ENDED = new Set(['declined', 'closed_silent']);

export function systemsFor(ctx) {
  const { client, trial = {}, profile = {}, domain = {}, checks = {}, shopping = {}, inboxes = [], leads = {}, lf = {}, approval = {}, sequence = {}, counters = {}, bookings = [], hot = [], invoice = null, pacelog = [], reports = [], runState = {}, now, minMarket = 1000 } = ctx;
  const st = client.state;
  const out = [];

  // 1. Intake
  const app = ctx.application;
  if (underReview(ctx)) out.push(sys('intake', 'waiting', `${app.source === 'website' ? 'Website application' : 'Application'} — waiting for your review${app.fit?.summary ? ` · ${app.fit.summary}` : ''}`, (app.fit?.lines || []).filter((l) => l.status !== 'pass').map((l) => `${l.label}: ${l.status} — ${l.note}`)));
  else if (st === 'applied') out.push(sys('intake', 'working', 'Application received · fit check running'));
  else if (st === 'queued') out.push(sys('intake', 'waiting', `In the queue${client.queueExpectedDate ? ` · expected ${client.queueExpectedDate}` : ''}`));
  else if (st === 'declined') out.push(sys('intake', 'off', `Declined${client.declineReason ? ` · ${client.declineReason}` : ''}`));
  else if (st === 'closed_silent') out.push(sys('intake', 'off', 'Never finished onboarding'));
  else if (st === 'onboarding') out.push(sys('intake', 'waiting', `Onboarding link sent ${ago(trial.onboardingSentAt, now) || '—'} · waiting for the form and agreement`, [trial.onboardingRemindersSent ? `${trial.onboardingRemindersSent} reminder(s) sent` : null, ctx.onboardCall ? `Onboarding call: ${ctx.onboardCall.label}` : null]));
  else out.push(sys('intake', 'ok', `Agreement accepted ${dateOf(trial.agreementAcceptedAt) || ''}${trial.agreementName ? ` by ${trial.agreementName}` : ''}`.trim()));

  // 2. Market count
  const est = n(profile.marketEstimate);
  if (client.declineReason === 'market_small') out.push(sys('market', 'blocked', `Market too small${est != null ? `: ${est.toLocaleString('en-US')} (minimum ${minMarket.toLocaleString('en-US')})` : ''}`, ['Override it from the Setup tab if you disagree']));
  else if (client.intakeStep === 'market_wait') out.push(sys('market', 'working', 'Counting matching companies…'));
  else if (est != null) out.push(sys('market', 'ok', `${est.toLocaleString('en-US')} matching companies (minimum ${minMarket.toLocaleString('en-US')})${profile.marketSource === 'override' ? ' · overridden by you' : ''}`, [profile.marketCheckedAt ? `checked ${dateOf(profile.marketCheckedAt)}` : null]));
  else out.push(sys('market', 'off', 'Runs when the agreement is accepted'));

  // 3. Domain & inboxes (Price Scout + purchase; CheapInboxes auto-buy, docs/AUTO-BUY.md)
  const ab = ctx.autobuy || null;
  if (ab && ab.status === 'ready_to_buy') out.push(sys('purchase', 'waiting', ab.label, [ab.buy?.price != null ? `domain $${ab.buy.price} at CheapInboxes` : null, ...(ab.buy?.alternatives || []).map((a) => `or ${a.domain}${a.price != null ? ` ($${a.price})` : ''}`), ab.problem]));
  else if (ab && ab.domain && ab.status !== 'done' && !past(st, 'setup_check')) out.push(sys('purchase', ab.problem ? 'blocked' : 'working', ab.label, [...ab.steps.map((x) => `${x.label}: ${x.done ? 'done' : 'waiting'}`), ab.problem]));
  else if (shopping.boughtAt) out.push(sys('purchase', 'ok', `Bought ${dateOf(shopping.boughtAt)} · ${domain.name || shopping.chosenDomain || ''} · ${inboxes.length} inbox${inboxes.length === 1 ? '' : 'es'}`));
  else if (shopping.sentAt) out.push(sys('purchase', shopping.escalatedAt ? 'blocked' : 'waiting', `Shopping list sent ${ago(shopping.sentAt, now)} · ${shopping.chosenDomain || 'domain'}${has(shopping.total) ? ` · about $${shopping.total}` : ''}`, [shopping.escalatedAt ? 'Overdue — 48 h without a purchase' : null, (shopping.unconfirmed || []).length ? `${shopping.unconfirmed.length} price(s) unconfirmed` : null]));
  else if (client.intakeStep === 'pricescout') out.push(sys('purchase', 'working', 'Finding the cheapest domain and inboxes…'));
  else if (past(st, 'awaiting_purchase')) out.push(sys('purchase', 'ok', `${domain.name || ''} · ${inboxes.length} inbox${inboxes.length === 1 ? '' : 'es'}`.trim()));
  else out.push(sys('purchase', 'off', 'Shopping list goes out once the market count passes'));

  // 4. Setup checks
  const checkNames = Object.keys(checks || {});
  const failing = checkNames.filter((k) => checks[k]?.status === 'fail');
  const pending = checkNames.filter((k) => !checks[k]?.status || checks[k].status === 'pending');
  const checkLines = checkNames.map((k) => `${k}: ${checks[k]?.status || 'pending'}${checks[k]?.detail ? ` — ${String(checks[k].detail).slice(0, 80)}` : ''}`);
  if (domain.setupPhase === 'passed') {
    const extra = [];
    if (has(domain.dmarcPassRate7d)) extra.push(`DMARC pass rate ${pct(rate(domain.dmarcPassRate7d))}`);
    if (domain.blacklist) extra.push(`blacklists: ${domain.blacklist}`);
    const bad = domain.blacklist === 'listed' || (has(domain.dmarcPassRate7d) && rate(domain.dmarcPassRate7d) < 0.8);
    out.push(sys('setup', bad ? 'blocked' : 'ok', `All checks passed ${dateOf(domain.setupPassedAt) || ''}${extra.length ? ` · ${extra.join(' · ')}` : ''}`.trim(), checkLines));
  } else if (domain.setupPhase === 'failed') out.push(sys('setup', 'blocked', `Failed: ${failing.join(', ') || 'see checks'} · re-checks every hour`, checkLines));
  else if (st === 'setup_check') out.push(sys('setup', 'working', `Checking… ${pending.length ? `${pending.length} check(s) still running` : ''}`.trim(), checkLines));
  else out.push(sys('setup', 'off', 'Runs when you paste the logins'));

  // 5. Warm-up
  const warm = inboxes.filter((i) => i.warmupStartedAt);
  if (warm.length) {
    const days = warm.map((i) => daysSince(i.warmupStartedAt, now)).filter((d) => d != null);
    const rates = warm.map((i) => rate(i.inboxRate7d)).filter((r) => r != null);
    const minDay = days.length ? Math.min(...days) : null;
    const minRate = rates.length ? Math.min(...rates) : null;
    const disabled = inboxes.filter((i) => i.disabledReason);
    const ready = minDay != null && minDay >= 14 && minRate != null && minRate >= 0.9;
    const status = disabled.length ? 'blocked' : ctx.warmup?.status === 'waiting_for_helpers' ? 'waiting' : ready ? 'ok' : 'working';
    out.push(sys('warmup', status, `Day ${minDay ?? '—'} of 14 · inbox rate ${minRate != null ? pct(minRate) : 'not measured yet'} · ${warm.length} inbox${warm.length === 1 ? '' : 'es'}`,
      inboxes.map((i) => `${i.email}: ${rate(i.inboxRate7d) != null ? pct(rate(i.inboxRate7d)) : '—'}${i.disabledReason ? ` — DISABLED: ${i.disabledReason}` : ''}`)));
  } else out.push(sys('warmup', past(st, 'setup_check') || st === 'setup_check' ? 'waiting' : 'off', inboxes.length ? 'Inboxes stored, warm-up starts when the setup checks pass' : 'Starts when the inboxes are in'));

  // 6. Lead list
  const total = Object.values(leads).reduce((a, b) => a + (Number(b) || 0), 0);
  if (total || lf.status) {
    const unsent = Number(leads.unsent) || 0;
    const finder = lf.status === 'running' ? `finder running since ${ago(lf.dispatchedAt, now)}` : lf.lastDispatchError ? `finder error: ${lf.lastDispatchError}` : lf.status ? `finder ${lf.status}` : '';
    const status = lf.lastDispatchError ? 'blocked' : lf.status === 'running' ? 'working' : total >= 200 ? 'ok' : 'working';
    out.push(sys('list', status, `${total.toLocaleString('en-US')} contacts · ${unsent} unsent · ${Number(leads.in_sequence) || 0} in sequence${finder ? ` · ${finder}` : ''}`,
      Object.entries(leads).filter(([, v]) => Number(v)).map(([k, v]) => `${k}: ${v}`)));
  } else out.push(sys('list', past(st, 'setup_check') ? 'working' : 'off', past(st, 'setup_check') ? 'Lead Finder not started yet' : 'Starts with warm-up'));

  // 7. Copy & approval
  const openChange = Object.values(approval.sections || {}).some((s) => s?.status === 'change');
  if (sequence.approvedAt) out.push(sys('copy', 'ok', `Approved by ${sequence.approvalMode === 'silence' ? 'silence' : 'click'} ${dateOf(sequence.approvedAt)} · version ${sequence.version || 1} · active ${sequence.active || 'both'}`));
  else if (openChange) out.push(sys('copy', 'waiting', `Change requested by the client (round ${approval.round || 1}) — edit the copy, then it re-sends`, (approval.changes || []).slice(-2).map((c) => `${c.section}: ${String(c.text || '').slice(0, 100)}`)));
  else if (approval.sentAt) out.push(sys('copy', 'waiting', `Approval link sent ${ago(approval.sentAt, now)} · waiting for the client`));
  else if (sequence.variantA) out.push(sys('copy', 'working', 'Copy built · approval link goes out on Day −7'));
  else out.push(sys('copy', past(st, 'setup_check') ? 'working' : 'off', past(st, 'setup_check') ? 'Copy not built yet' : 'Built during warm-up'));

  // 8. Placement & ramp (canary + ramp planner)
  const placement = rate(client.canaryPlacement);
  const caps = inboxes.map((i) => `${i.email}: cap ${has(i.dailyCap) ? i.dailyCap : '—'}${has(i.canaryPlacement) ? ` · placement ${pct(rate(i.canaryPlacement))}` : ''}`);
  if (placement != null) out.push(sys('canary', placement >= 0.85 ? 'ok' : placement >= 0.7 ? 'waiting' : 'blocked', `Inbox placement ${pct(placement)}${client.canaryDay ? ` (${client.canaryDay})` : ''} · gate 85%`, caps));
  else out.push(sys('canary', warm.length ? 'working' : 'off', warm.length ? 'First placement test runs from Day −3' : 'Runs during warm-up', caps));

  // 9. Sending
  const sent = n(counters.sent);
  const bounces = n(counters.bounces);
  const bounceRate = sent && bounces != null ? bounces / sent : null;
  const sendLine = `${sent != null ? sent.toLocaleString('en-US') : '—'} sent · ${n(counters.sentD0) ?? '—'} first touches · bounces ${bounces ?? '—'}${bounceRate != null ? ` (${pct(bounceRate)})` : ''}`;
  if (client.legalHoldAt) out.push(sys('sending', 'blocked', 'Legal hold — a reply mentioned legal action; sending on this domain is stopped until you clear it', [sendLine]));
  else if (truthy(client.emergencyActive)) out.push(sys('sending', 'blocked', 'Emergency stop — deliverability problem; the machine is re-verifying and will resume on 3 green days', [sendLine]));
  else if (client.sendHold) out.push(sys('sending', 'blocked', `On hold: ${client.sendHold}`, [sendLine]));
  else if (st === 'paused') out.push(sys('sending', 'waiting', `Paused: ${client.pausedReason || 'by you'}`, [sendLine]));
  else if (['sending', 'extension', 'converted'].includes(st)) {
    const smoke = runState.smokeReachedAt && !runState.smokeClearedAt;
    out.push(sys('sending', smoke ? 'working' : 'ok', smoke ? `First-50 check: ${runState.smokeFailedAt ? 'bounce rate too high — emergency' : 'waiting for the bounce scan'}` : sendLine, smoke ? [sendLine] : [truthy(client.emergencyHalved) ? 'caps halved after an emergency' : null]));
  } else if (st === 'ready') out.push(sys('sending', 'waiting', `Ready — first send on ${trial.day1Date || 'the next US weekday'}`));
  else if (['deciding', 'not_now', 'retired', 'deleted'].includes(st)) out.push(sys('sending', 'off', `Finished · ${sendLine}`));
  else out.push(sys('sending', 'off', 'Starts on Day 1'));

  // 10. Replies
  const replies = n(counters.replies);
  const positive = n(counters.positive);
  const unansweredHot = Number(trial.unansweredHot) || 0;
  const openHot = hot.filter((h) => h && !h.answeredAt).length;
  const replyLine = `${replies ?? '—'} replies · ${positive ?? '—'} positive${sent ? ` (${pct((replies || 0) / sent)} reply rate)` : ''}`;
  if (replies == null && !past(st, 'ready')) out.push(sys('replies', 'off', 'Read every few minutes once sending starts'));
  else if (unansweredHot > 0) out.push(sys('replies', 'waiting', `${unansweredHot} hot lead${unansweredHot === 1 ? '' : 's'} unanswered by the client · ${replyLine}`, [`${openHot} hot lead(s) handed over and open`]));
  else out.push(sys('replies', 'ok', replyLine, [openHot ? `${openHot} hot lead(s) with the client` : null]));

  // 11. Calls
  const disputes = bookings.filter((b) => b.status === 'disputed' && !b.disputeResolvedAt && !b.disputeResolution);
  const untapped = bookings.filter((b) => !b.tapped && b.scheduledAt && Date.parse(b.scheduledAt) < now.getTime() - 3600e3 && ['booked', 'rebooked'].includes(b.status));
  const callLine = `${n(counters.booked) ?? '—'} booked · ${n(counters.held) ?? '—'} held · ${n(counters.qualified) ?? '—'} qualified · ${n(counters.noshows) ?? '—'} no-shows`;
  if (!past(st, 'ready') && !bookings.length) out.push(sys('calls', 'off', 'Watches the calendar once sending starts'));
  else if (disputes.length) out.push(sys('calls', 'waiting', `${disputes.length} dispute${disputes.length === 1 ? '' : 's'} for you to decide · ${callLine}`, disputes.map((d) => `${d.leadEmail}: ${d.disputeReason || 'no reason'}`)));
  else if (untapped.length) out.push(sys('calls', 'waiting', `${untapped.length} call${untapped.length === 1 ? '' : 's'} waiting for the client's tap · ${callLine}`));
  else out.push(sys('calls', 'ok', callLine));

  // 12. Reports & decision
  const fridays = reports.filter((r) => String(r.name).startsWith('friday')).length;
  const blockedReports = reports.filter((r) => r.blockedReason);
  const day29 = reports.find((r) => ['day29', 'trial_report', 'final'].includes(r.name));
  const bits = [`${fridays} Friday update${fridays === 1 ? '' : 's'}`];
  if (day29) bits.push(`Day 29 report ${day29.renderedAt ? 'sent' : 'blocked'}`);
  if (trial.decisionSentAt) bits.push(`decision page sent ${dateOf(trial.decisionSentAt)}`);
  if (trial.decision && trial.decision !== 'none') bits.push(`decision: ${trial.decision}`);
  if (invoice?.issuedAt) bits.push(invoice.paidAt ? `invoice paid ${dateOf(invoice.paidAt)}` : `invoice unpaid since ${dateOf(invoice.issuedAt)}`);
  if (blockedReports.length) out.push(sys('reports', 'blocked', `${blockedReports.length} report(s) blocked — a counter is missing`, blockedReports.map((r) => `${r.name}: ${r.blockedReason}`)));
  else if (!past(st, 'setup_check')) out.push(sys('reports', 'off', 'Friday updates start at Day −14'));
  else out.push(sys('reports', trial.talkRequestedAt ? 'waiting' : 'ok', bits.join(' · '), [trial.talkRequestedAt ? `Client pressed "Talk to someone" ${ago(trial.talkRequestedAt, now)}` : null]));

  // 13. Close-out
  if (['not_now', 'retired', 'deleted', 'converted', 'deciding'].includes(st) || trial.endedAt) {
    const lines = [];
    if (trial.retireAt && !domain.retiredAt) lines.push(`retires on ${trial.retireAt}`);
    if (domain.retiredAt) lines.push(`domain retired ${dateOf(domain.retiredAt)}`);
    if (domain.retiredAt && !trial.inboxesCancelledAt) lines.push('inboxes NOT cancelled yet');
    if (trial.inboxesCancelledAt) lines.push(`inboxes cancelled ${dateOf(trial.inboxesCancelledAt)}`);
    if (trial.reviewCapturedAt) lines.push('review captured');
    if (trial.exitReason) lines.push(`exit reason: "${String(trial.exitReason).slice(0, 80)}"`);
    if (trial.dataDeleteAt) lines.push(`data deleted on ${trial.dataDeleteAt}`);
    if (client.winbackAt || trial.winbackAt) lines.push(`win-back ${client.winbackAt || trial.winbackAt}`);
    if (st === 'converted') lines.unshift(`plan ${client.plan || ''}${client.paidAt ? ' · paid' : ' · unpaid'}`);
    const status = domain.retiredAt && !trial.inboxesCancelledAt ? 'waiting' : st === 'deciding' ? 'working' : 'ok';
    out.push(sys('closing', status, lines.join(' · ') || (st === 'deciding' ? 'Waiting for the client to decide' : 'Closing steps run on schedule')));
  } else if (ENDED.has(st)) out.push(sys('closing', 'off', 'Ended before the trial started'));
  else out.push(sys('closing', 'off', 'Runs after Day 30'));

  return SYSTEM_ORDER.map((k) => out.find((s) => s.key === k)).filter(Boolean);
}

// ─── the owner's to-do list ───────────────────────────────────────────────────

const api = (path, body, confirm = null) => ({ type: 'api', method: 'POST', path, body, ...(confirm ? { confirm } : {}) });
const view = (v, clientId, section = null) => ({ type: 'view', view: v, clientId, ...(section ? { section } : {}) });
const mc = (path) => ({ type: 'mc', path });

export function todosFor(ctx) {
  const { client, trial = {}, profile = {}, domain = {}, checks = {}, shopping = {}, approval = {}, bookings = [], invoice = null, promises = [], alerts = [], now } = ctx;
  const id = client.id;
  const st = client.state;
  const t = [];
  const push = (key, text, detail, urgent, since, action) => t.push({ id: `${key}:${id}`, clientId: id, clientName: client.name || id, text, detail: detail || '', urgent: Boolean(urgent), since: since || null, action });

  if (underReview(ctx)) {
    const a = ctx.application;
    const since = a.receivedAt || client.createdAt;
    push('review', `Review ${client.name || id}'s trial application`,
      `${a.source === 'website' ? 'From the website' : 'Application'} ${ago(since, now)}${ctx.fitScore ? ` · ${badgeText(ctx.fitScore)}` : ''}${a.fit?.summary ? ` · ${a.fit.summary.charAt(0).toLowerCase()}${a.fit.summary.slice(1)}` : ''}`,
      Boolean(since) && now.getTime() - Date.parse(since) > 12 * 3600e3, since, view('detail', id, 'application'));
  }
  // Onboarding call (docs/ONBOARD-CALL.md): a reply to answer, a booking gone overdue, a call to mark.
  const oc = ctx.onboardCall;
  if (oc) {
    const who = client.contactName || client.name || id;
    // A time they asked for on the booking page (docs/CALENDAR.md): the owner answers in the Calendar.
    if (oc.requestedFor && !oc.proposedFor) push('meeting-request', `Say yes to ${who}'s call time — ${ownerWhen(oc.requestedFor)} (your time)`, `They asked ${ago(oc.requestedAt, now)} on the booking page · Yes, Suggest another time or Decline in the Calendar`, true, oc.requestedAt, { type: 'view', view: 'calendar', clientId: id, ...(oc.meetingId ? { meetingId: oc.meetingId } : {}) });
    if (oc.needsReply) push('onboard-reply', `Answer ${who} — they replied about the onboarding call`, `Reply ${ago(oc.lastReplyAt, now)} · it goes from ${oc.fromInbox || 'the onboarding inbox'}, in the same thread`, true, oc.lastReplyAt, view('detail', id, 'onboardCall'));
    else if (oc.status === 'overdue') push('onboard-overdue', `Get ${who} to book the onboarding call — it's overdue`, `Should have been booked by ${ownerWhen(oc.dueBy)} (your time) · ${oc.remindersSent} reminder${oc.remindersSent === 1 ? '' : 's'} sent`, true, oc.dueBy, view('detail', id, 'onboardCall'));
    if (oc.status === 'booked' && oc.bookedFor && now.getTime() > Date.parse(oc.bookedFor) + (oc.callMinutes || 30) * 60e3) {
      push('onboard-mark', `Mark the onboarding call with ${who}: done or no-show`, `It was ${ownerWhen(oc.bookedFor)} (your time)`, true, oc.bookedFor, view('detail', id, 'onboardCall'));
    }
  }
  // A message of theirs with no answer yet, any state (docs/REPLYBOT-MEET.md §1) — the same rule as the
  // conversation's needsReply. While the onboarding call is in play its own to-do says it.
  if (needsReplyFor(client, ctx.callRaw) && !t.some((x) => x.id === `onboard-reply:${id}`)) {
    const since = client.msgWaitingAt || oc?.lastReplyAt || null;
    push('message-reply', `Answer ${firstOf(client.contactName) || client.contactName || client.name || id}'s message`, `They wrote ${ago(since, now)} · it goes from the onboarding inbox, in the same thread`, true, since, view('detail', id, 'conversation'));
  }
  const ab = ctx.autobuy || null;
  if (st === 'awaiting_purchase' && ab?.status === 'ready_to_buy') {
    // CheapInboxes is connected: he buys there; the machine finds the purchase and does the rest.
    const since = ab.buy?.builtAt || shopping.sentAt || client.stateChangedAt || null;
    push('buy', `Buy ${ab.buy?.domain || 'their domain'} and ${ab.buy?.mailboxes?.length || 2} inboxes on CheapInboxes`,
      ab.buy ? `${ab.buy.price != null ? `$${ab.buy.price} for the domain · ` : ''}the machine connects everything after you buy` : (ab.problem || 'The shopping list is being made'),
      Boolean(shopping.escalatedAt) || (since && now.getTime() - Date.parse(since) > 12 * 3600e3), since, view('detail', id, 'autobuy'));
  } else if (st === 'awaiting_purchase' && shopping.sentAt && !shopping.boughtAt) {
    push('buy', `Buy ${shopping.chosenDomain || 'the domain'} and 2 inboxes, then paste the logins`,
      `Shopping list sent ${ago(shopping.sentAt, now)}${has(shopping.total) ? ` · about $${shopping.total}` : ''}${shopping.escalatedAt ? ' · overdue' : ''}`,
      Boolean(shopping.escalatedAt) || (now.getTime() - Date.parse(shopping.sentAt)) > 12 * 3600e3, shopping.sentAt, view('purchase', id));
  }
  if (st === 'setup_check' && domain.setupPhase === 'failed') {
    for (const [name, c] of Object.entries(checks || {})) {
      if (c?.status !== 'fail') continue;
      push(`fix-${name}`, `Fix the ${name.toUpperCase()} check for ${domain.name || 'the domain'}`, String(c.detail || '').slice(0, 200), true, domain.setupFailedAt || c.checkedAt, view('purchase', id, 'setup'));
    }
  }
  if (Object.values(approval.sections || {}).some((s) => s?.status === 'change')) {
    const last = (approval.changes || []).slice(-1)[0];
    push('copy-change', 'Answer the client\'s copy change request', last ? `${last.section}: "${String(last.text || '').slice(0, 140)}"` : '', true, last?.at || approval.lastClickAt, mc(`/mc/clients/${id}/sequence`));
  }
  for (const b of bookings) {
    if (b.status === 'disputed' && !b.disputeResolvedAt && !b.disputeResolution) {
      push(`dispute-${b.id}`, `Decide the dispute on ${b.leadEmail || 'a call'}`, `Reason given: ${b.disputeReason || 'none'} · auto-upheld after 48 h`, false, b.disputedAt, view('detail', id, 'calls'));
    }
  }
  if (trial.talkRequestedAt && st === 'deciding') {
    push('talk', `Call ${client.contactName || client.name} — they pressed "Talk to someone"`, `${ago(trial.talkRequestedAt, now)} · ${client.contactEmail || ''}`, true, trial.talkRequestedAt, view('detail', id));
  }
  if (client.legalHoldAt) {
    push('legal', 'Read the legal reply, then clear the hold', String(client.legalHoldReply || '').slice(0, 160), true, client.legalHoldAt, api(`/api/mc/clients/${id}`, { action: 'clearLegalHold' }, 'Clear the legal hold and let this client send again?'));
  }
  if (client.sendHold) {
    push('sendhold', 'Clear the send hold once the DNS/blacklist problem is fixed', String(client.sendHold).slice(0, 160), true, client.sendHoldAt, api(`/api/mc/clients/${id}`, { action: 'clearSendHold' }, 'Clear the send hold?'));
  }
  if (invoice?.issuedAt && !invoice.paidAt) {
    push('invoice', `Mark the month-one invoice paid when the money lands (${invoice.number || 'invoice'})`, `Issued ${dateOf(invoice.issuedAt)}${has(invoice.amount) ? ` · $${Number(invoice.amount).toLocaleString('en-US')}` : ''}`, false, invoice.issuedAt, api(`/api/mc/clients/${id}`, { action: 'markPaid' }, 'Mark this invoice as paid?'));
  }
  if (domain.retiredAt && !trial.inboxesCancelledAt) {
    push('cancel-inboxes', 'Cancel the trial inboxes at the provider, then tick done', `Domain retired ${dateOf(domain.retiredAt)} · reminded daily until done`, true, domain.retiredAt, api(`/api/mc/clients/${id}`, { action: 'inboxesCancelled' }, 'Confirm the inboxes are cancelled at the provider?'));
  }
  for (const p of overduePromises(promises, now)) {
    push(`promise-${p.id}`, `Promise overdue: ${p.text}`, `Due ${String(p.dueAt).slice(0, 10)}`, false, p.dueAt, api(`/api/mc/clients/${id}`, { action: 'completePromise', promiseId: p.id }, 'Mark this promise done?'));
  }
  // The warm-up circle is under WARMUP.minPool while this trial warms (docs/WARMUP-HUB.md).
  if (ctx.warmup?.status === 'waiting_for_helpers') {
    const n = ctx.warmup.helpersNeeded || 1;
    push('warmup-helpers', `Add ${n} warm-up helper${n === 1 ? '' : 's'} — Settings › Warm-up`, ctx.warmup.problem || '', true, client.stateChangedAt || null, { type: 'view', view: 'settings', section: 'warmup' });
  }
  if (['warming', 'ready'].includes(st) && profile.bookingRequestSentAt && !truthy(profile.bookingTested)) {
    push('booking-test', 'Client has not done the 60-second booking test yet (Day 1 waits for it)', `Asked ${ago(profile.bookingRequestSentAt, now)} · reminded daily`, false, profile.bookingRequestSentAt, view('detail', id, 'setup'));
  }
  // Open urgent alerts: one to-do per kind (a daily repeat of the same problem is one thing to do,
  // not one more line a day), and none where a to-do above already says the same thing.
  const covered = {
    new_application: underReview(ctx), application_scored: underReview(ctx),
    legal_reply: Boolean(client.legalHoldAt),
    shopping_list: st === 'awaiting_purchase', purchase_reminder: st === 'awaiting_purchase',
  };
  const groups = new Map();
  for (const a of alerts) {
    if (!a.urgent || covered[a.key]) continue;
    if (!groups.has(a.key)) groups.set(a.key, []);
    groups.get(a.key).push(a);
  }
  for (const g of groups.values()) {
    const sorted = g.slice().sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
    const newest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    const many = sorted.length > 1;
    push(`alert-${newest.id}`, many ? `${newest.title} (${sorted.length} alerts)` : newest.title,
      many ? `Latest ${ago(newest.at, now)}, first ${ago(oldest.at, now)} · acknowledge them once handled` : `Alert ${ago(newest.at, now)} · acknowledge it once handled`,
      true, oldest.at, api('/api/mc/alerts', many ? { action: 'ack', ids: sorted.map((a) => a.id) } : { action: 'ack', id: newest.id }));
  }
  return t.sort((a, b) => Number(b.urgent) - Number(a.urgent) || String(a.since || '').localeCompare(String(b.since || '')));
}

// ─── the simple Trials list (docs/ONBOARD-CALL.md §5 `simple`) ───────────────

/**
 * The one status the simple Trials list shows: where the trial is (`step`),
 * one plain sentence (`label`), what happens next or what the owner must do
 * (`next`), and a red dot (`needsYou`) when he must act — a new application,
 * a reply to answer, an overdue booking, a call to mark, anything the to-do
 * list marks urgent. Pure: ctx (+ the row's to-dos) → data. Numbers are only
 * ever the stored ones; a missing counter is left out, never shown as 0.
 */
export function simpleFor(ctx, todos = todosFor(ctx)) {
  const out = simpleBase(ctx, todos);
  // Their last message has no answer yet (the conversation's needsReply, docs/REPLYBOT-MEET.md §1): the
  // hub shows "Sam wrote — answer them" in red. Outside the onboarding call it is also the next thing to do.
  const needsReply = needsReplyFor(ctx.client, ctx.callRaw) || Boolean(ctx.onboardCall?.needsReply);
  const msg = todos.find((t) => t.id === `message-reply:${ctx.client.id}`);
  return { ...out, ...(msg ? { next: msg.text } : {}), needsReply, needsYou: out.needsYou || needsReply };
}

function simpleBase(ctx, todos) {
  const { client, trial = {}, shopping = {}, domain = {}, counters = {} } = ctx;
  const st = client.state;
  const urgent = todos.some((t) => t.urgent);
  const since0 = client.stateChangedAt || client.createdAt || null;
  const r = (step, label, next, needsYou = false, since = since0, dayOf30 = null) => ({
    step, label, next, needsYou: Boolean(needsYou) || urgent, since: since || since0 || null,
    person: client.contactName || null, company: client.name || client.id, dayOf30,
  });
  const booked = n(counters.booked);
  const calls = booked != null ? `, ${booked} call${booked === 1 ? '' : 's'} booked` : '';
  const on = (dayKey) => (dayKey ? ` on ${formatDay(dayKey)}` : '');

  switch (st) {
    case 'applied':
      if (underReview(ctx)) return r('new', 'New application — read it and say yes or no', 'Open it and press “Say yes” or “Say no”', true, ctx.application.receivedAt);
      return r('new', 'New application — being checked', 'Nothing for you yet');
    case 'queued':
      return r('queued', 'In the queue — waiting for a free trial slot', `Nothing for you: they start when a slot opens${client.queueExpectedDate ? ` (about ${formatDay(client.queueExpectedDate)})` : ''}`, false, client.queuedAt);
    case 'onboarding':
      return onboardingSimple(ctx, r);
    case 'awaiting_purchase':
      if (ctx.autobuy && ctx.autobuy.status === 'ready_to_buy') {
        const b = ctx.autobuy.buy;
        return r('setting_up', `Buy their domain and ${b?.mailboxes?.length || 2} inboxes on CheapInboxes`, b ? `Open CheapInboxes and buy ${b.domain} with ${b.mailboxes?.length || 2} inboxes — the rest sets itself up` : (ctx.autobuy.problem || 'The shopping list is being made — it shows here in a minute'), true, b?.builtAt || shopping.sentAt);
      }
      if (ctx.autobuy && ctx.autobuy.domain) return autobuySimple(ctx, r);
      return r('setting_up', 'Setting up their emails — your turn to buy the domain', shopping.sentAt ? `Buy ${shopping.chosenDomain || 'the domain'} and 2 inboxes, then paste the logins` : 'The shopping list is on its way to you', Boolean(shopping.sentAt && !shopping.boughtAt), shopping.sentAt);
    case 'setup_check':
      if (ctx.autobuy && ctx.autobuy.domain && domain.setupPhase !== 'failed') return autobuySimple(ctx, r);
      if (domain.setupPhase === 'failed') return r('setting_up', 'Setting up their emails — a domain check failed', 'Fix the record named in the to-do; the checks run again every hour', true, domain.setupFailedAt);
      return r('setting_up', 'Setting up their emails — checking the new domain', 'Nothing for you: warm-up starts when the checks pass');
    case 'warming': {
      // The warm-up card's own sentence (docs/WARMUP-HUB.md) once the inboxes are in.
      const w = ctx.warmup;
      if (w && w.status === 'waiting_for_helpers') return r('warming_up', w.label, `Add ${w.helpersNeeded} warm-up helper${w.helpersNeeded === 1 ? '' : 's'} — Settings › Warm-up`, true);
      if (w && w.status !== 'paused') return r('warming_up', w.label, trial.day1Date ? `Nothing for you: first emails${on(trial.day1Date)}` : 'Nothing for you: the inboxes warm up for about 2 weeks');
      return r('warming_up', `Warming up their inboxes — first emails${on(trial.day1Date)}`, 'Nothing for you: the inboxes warm up for about 2 weeks');
    }
    case 'ready':
      return r('warming_up', `Ready — first emails${on(trial.day1Date)}`, 'Nothing for you');
    case 'sending':
      return heldSimple(ctx, r) || r('sending', `Sending — day ${ctx.day ?? '—'} of 30${calls}`, 'Nothing for you: replies and booked calls come to you as alerts', false, since0, ctx.day ?? null);
    case 'extension':
      return heldSimple(ctx, r) || r('sending', `Free extension — day ${ctx.day ?? '—'}${calls}`, 'Nothing for you: replies and booked calls come to you as alerts', false, since0, ctx.day ?? null);
    case 'paused':
      return r('sending', `Paused — ${client.pausedReason || 'by you'}`, 'No emails go out until it is cleared', false, since0, ctx.day ?? null);
    case 'deciding':
      return r('finished', 'Trial finished — waiting for their decision', trial.talkRequestedAt ? `Call ${client.contactName || 'them'} — they asked to talk` : 'Nothing for you: they choose on their decision page', Boolean(trial.talkRequestedAt));
    case 'converted':
      return r('finished', 'Finished — became a client', client.paidAt ? 'Nothing for you' : 'Mark the invoice paid when the money lands');
    case 'not_now': case 'retired': case 'deleted':
      return r('finished', 'Finished — not a client for now', 'Nothing for you');
    case 'declined':
      return r('declined', 'Declined', 'Nothing for you');
    case 'closed_silent':
      return r('declined', 'Closed — they never finished onboarding', 'Nothing for you');
    default:
      return r('new', STATE_LABELS[st] || st, 'Nothing for you yet');
  }
}

/**
 * Sending is held although the state still says sending: a legal reply (only he may clear it), a
 * DNS / blacklist send hold, or a deliverability emergency. The row must not read "Sending — day 12".
 */
function heldSimple(ctx, r) {
  const { client } = ctx;
  const day = ctx.day ?? null;
  if (client.legalHoldAt) return r('sending', 'Sending stopped — a prospect replied with a legal threat', 'Read the legal reply, then clear the hold', true, client.legalHoldAt, day);
  if (client.sendHold) return r('sending', `Sending on hold — ${client.sendHold}`, 'Clear the send hold once the DNS or blacklist problem is fixed', true, client.sendHoldAt || null, day);
  if (truthy(client.emergencyActive)) return r('sending', 'Sending paused — a deliverability problem the machine is fixing', 'Nothing for you: it re-checks the list and resumes at half volume by itself', false, client.pausedAt || null, day);
  return null;
}

/** `simple` while a CheapInboxes purchase sets itself up (docs/AUTO-BUY.md): nothing for him unless a problem says so. */
function autobuySimple(ctx, r) {
  const ab = ctx.autobuy;
  const since = ab.steps?.[0]?.at || null;
  if (ab.problem) return r('setting_up', 'Setting up their inboxes (about 2 days) — needs you', `Fix: ${ab.problem}`, true, since);
  return r('setting_up', 'Setting up their inboxes (about 2 days)', 'Nothing for you: the domain and inboxes connect by themselves, then warm-up starts', false, since);
}

/** `simple` while onboarding: the onboarding call first, then the signed page. */
function onboardingSimple(ctx, r) {
  const { trial = {}, now } = ctx;
  const oc = ctx.onboardCall || null;
  if (oc && oc.status === 'booked') {
    if (!oc.bookedFor) return r('call_booked', 'Call booked — check your calendar for the time', 'Take the call, then mark it done', oc.needsReply, oc.bookedAt);
    if (now.getTime() > Date.parse(oc.bookedFor) + (oc.callMinutes || 30) * 60e3) return r('call_booked', 'Call booked — did it happen? Mark it', "Press Call done or They didn't show", true, oc.bookedFor);
    return r('call_booked', `Call booked for ${ownerWhen(oc.bookedFor)} your time`, oc.needsReply ? 'They wrote again — answer them' : `Nothing for you until the call (${ownerDayWord(oc.bookedFor, now)})`, oc.needsReply, oc.bookedAt);
  }
  // A time they asked for on the booking page waits for the owner's yes in the Calendar (docs/CALENDAR.md).
  if (oc && oc.requestedFor && oc.status !== 'held') {
    if (oc.proposedFor) return r('accepted', `You suggested ${ownerWhen(oc.proposedFor)} your time — waiting for them`, 'Nothing for you: they have a one-click link to say yes', oc.needsReply, oc.requestedAt);
    return r('accepted', `They asked for ${ownerWhen(oc.requestedFor)} your time — say yes in the Calendar`, 'Open the Calendar: Yes, Suggest another time or Decline', true, oc.requestedAt);
  }
  if (trial.agreementAcceptedAt) return r('setting_up', 'Signed — checking the size of their market', 'Nothing for you yet', false, trial.agreementAcceptedAt);
  if (!oc) return r('accepted', 'Accepted — waiting for them to fill in the onboarding page', 'Nothing for you: we remind them', false, trial.onboardingSentAt);
  if (oc.status === 'held') return r('call_booked', 'Call done — waiting for them to finish the onboarding page', 'Nothing for you: we remind them about the page', false, oc.heldAt);
  if (oc.needsReply) return r('accepted', 'They replied — answer them', 'Read their reply and answer it in the conversation', true, oc.lastReplyAt);
  if (oc.status === 'no_show') return r('accepted', 'They missed the call — waiting for a new time', 'Write to them in the conversation, or mark the new time once it is booked', false, oc.noShowAt);
  if (oc.status === 'overdue') return r('accepted', 'Accepted — the call is still not booked (overdue)', 'Write to them in the conversation, or send the email again', true, oc.dueBy);
  if (oc.status === 'stopped') return r('accepted', 'Accepted — reminders stopped', 'Mark the call booked if you arrange it', false, oc.stoppedAt);
  if (oc.status === 'replied') {
    // Who answered last (the reply bot or him), and where a booking lands: his own link, or our booking page → the Calendar.
    const bot = Boolean(oc.lastBotReplyAt) && Date.parse(oc.lastBotReplyAt) >= (Date.parse(oc.lastOwnerReplyAt || '') || 0);
    const next = oc.bookingUrl ? 'Mark the call booked once they book with your link' : 'Nothing for you: the time they pick on your booking page comes to your Calendar';
    return r('accepted', bot ? 'Accepted — the reply bot answered, waiting for them to pick a time' : 'Accepted — you answered, waiting for them to book the call', next, false, (bot ? oc.lastBotReplyAt : oc.lastOwnerReplyAt) || oc.lastReplyAt);
  }
  const next = oc.nextReminderAt
    ? `Nothing for you: we remind them ${ownerDayWord(oc.nextReminderAt, now)}`
    : `Nothing for you: if it is not booked by ${ownerWhen(oc.dueBy)} (your time), you get an alert`;
  return r('accepted', `Accepted — waiting for them to book the call${oc.status === 'opened' ? ' (they opened the email)' : ''}`, next, false, oc.sentAt);
}

// ─── loading ──────────────────────────────────────────────────────────────────

const parseJson = (v, fallback) => { if (v == null || v === '') return fallback; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fallback; } };

export async function loadContext(client, { alerts = null, now = new Date(), onboard = null, autobuy = null, warm = null } = {}) {
  const id = client.id;
  const vnow = clientNow(client, now);
  // The onboarding call is read only for clients that were sent one (flag on the client hash).
  const callRaw = client.onboardCallSentAt ? (await kv.hgetall(K.onboardCall(id)).catch(() => null)) || {} : {};
  const onboardCall = client.onboardCallSentAt
    ? onboardCallView(callRaw, [], { now: vnow, settings: onboard || await onboardSettings(), clientState: client.state })
    : null;
  const [extras, profile, trial, domainRead, shopping, inboxesRaw, lf, approval, sequence, pacelog, runState, allAlerts] = await Promise.all([
    clientExtras(client, now),
    getProfile(id),
    getTrial(id),
    readChecks(id).catch(() => ({ domain: {}, checks: {} })),
    getShopping(id).catch(() => ({})),
    getInboxRecords(id).catch(() => []),
    leadfinderState(id).catch(() => ({})),
    getApproval(id).catch(() => ({})),
    kv.hgetall(K.sequence(id)).catch(() => ({})),
    getPaceLog(id, 50).catch(() => []),
    getRunState(id).catch(() => ({})),
    alerts ? Promise.resolve(alerts) : getAlertLog(500),
  ]);
  const domain = { ...(await getDomain(id)), ...(domainRead.domain || {}) };
  const checks = domainRead.checks || {};
  // CheapInboxes auto-buy (docs/AUTO-BUY.md): one read, only at the buying / setup / warm-up steps.
  let autobuyCtx = null;
  if (AUTOBUY_STATES.has(client.state) || String(client.autobuyOpen) === '1') {
    const a = autobuy || {};
    const [rec, connected, s] = await Promise.all([readAutobuy(id), a.connected ?? cheapInboxesConnected(), a.settings || autobuySettings()]);
    autobuyCtx = autobuyView({ client, rec, connected, domain, s });
  }
  const inboxes = inboxesRaw.map(publicInbox);
  // The warm-up card (docs/WARMUP-HUB.md): from the inbox records just read + what the board shares (rules, today's
  // sends, the circle — read once per board; the circle only matters while a trial warms).
  let warmup = null;
  if (id !== 'aviance' && WARMUP_VIEW_STATES.has(client.state) && inboxesRaw.some((r) => r.passwordEnc)) {
    const w = warm || await hubWarmupData({ now, circle: client.state === 'warming' }).catch(() => null);
    if (w) warmup = warmupView({ client, inboxes: inboxesRaw, now: vnow, circle: w.circle, dayStats: w.dayStats, s: w.settings });
  }
  const hot = Object.values((await kv.hgetall(K.hot(id)).catch(() => null)) || {});
  const application = applicationView(await kv.hgetall(K.application(id)).catch(() => null));
  const fitScore = application ? scoreBadge(await kv.hget(K.research(id), 'score').catch(() => null)) : null;
  const openAlerts = allAlerts.filter((a) => a.clientId === id && !a.acknowledged);
  return {
    client, trial: trial || {}, profile, domain, checks, shopping, inboxes,
    leads: extras.leadsByStatus || {}, lf, approval, sequence: sequence || {}, counters: extras.counters || {},
    bookings: extras.bookings || [], replies: extras.replies || [], repliesByKind: extras.repliesByKind || {}, hot,
    invoice: extras.invoice, promises: extras.promises || [], pacelog, reports: extras.reports || [], upcoming: extras.upcoming || [],
    runState, application, fitScore, alerts: openAlerts, day: extras.trialDay, health: extras.health, now: vnow, minMarket: await cfg(id, 'MIN_MARKET'),
    onboardCall, callRaw, autobuy: autobuyCtx, warmup,
  };
}

/** One board row (docs/HUB-API.md "Client row"). */
export async function hubRow(client, { alerts, now = new Date(), onboard = null, autobuy = null, warm = null } = {}) {
  const [base, ctx] = await Promise.all([clientRow(client, { alerts, now }), loadContext(client, { alerts, now, onboard, autobuy, warm })]);
  const next = ctx.upcoming[0] || null;
  const todo = todosFor(ctx);
  return {
    ...base,
    stateLabel: stateLabelFor(ctx),
    simple: simpleFor(ctx, todo),
    fitScore: ctx.fitScore || null,
    contactName: client.contactName || null, contactEmail: client.contactEmail || null, website: client.website || null,
    todo,
    systems: systemsFor(ctx),
    nextUp: next ? { date: next.date, what: next.what } : null,
    _ctx: ctx,
  };
}

export async function hubBoard({ now = new Date() } = {}) {
  const [board, clients, queue] = await Promise.all([boardData(now), getAllClients(), listQueue().catch(() => ({ rows: [] }))]);
  const alerts = await getAlertLog(500);
  // ONBOARDCALL settings once per board (one read), only when some trial has an onboarding call.
  const onboard = clients.some((c) => c.onboardCallSentAt) ? await onboardSettings().catch(() => null) : null;
  // Whether CheapInboxes is connected + its settings, once per board.
  const ciOn = await cheapInboxesConnected();
  const autobuy = clients.some((c) => AUTOBUY_STATES.has(c.state) || String(c.autobuyOpen) === '1') ? { connected: ciOn, settings: await autobuySettings() } : null;
  // The warm-up cards' shared reads, once per board; the circle only while a trial warms.
  const warm = clients.some((c) => c.id !== 'aviance' && WARMUP_VIEW_STATES.has(c.state))
    ? await hubWarmupData({ now, clients, circle: clients.some((c) => c.state === 'warming') }).catch(() => null)
    : null;
  const rows = await Promise.all(clients.map((c) => hubRow(c, { alerts, now, onboard, autobuy, warm })));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const strip = (r) => { const { _ctx, ...rest } = r; return rest; };
  const stages = STAGES.map((s) => ({ ...s, clients: board.clients.filter((c) => s.states.includes(c.state) && c.id !== 'aviance' && c.id !== '_test').map((c) => strip(byId.get(c.id))).filter(Boolean) }));
  const others = ['aviance', '_test'].map((id) => byId.get(id)).filter(Boolean).map(strip);
  const todos = oneHelpersTodo(rows.filter((r) => r.id !== '_test').flatMap((r) => r.todo));
  const inquiries = await inquirySummary().catch(() => null);
  for (const q of (inquiries?.latest || []).filter((x) => x.status === 'new')) {
    todos.push({ id: `inquiry:${q.id}`, clientId: null, clientName: q.company, text: `New plan inquiry from ${q.company} — call them back`,
      detail: `${q.name}${q.plan ? ` · ${q.plan[0].toUpperCase()}${q.plan.slice(1)}` : ''}${q.whenHost ? ` · booked for ${q.whenHost}` : ''}`,
      urgent: true, since: q.at, action: { type: 'view', view: 'inquiry', inquiryId: q.id } });
  }
  todos.push(...(await machineTodos(board, queue, { cheapInboxes: ciOn })));
  todos.sort((a, b) => Number(b.urgent) - Number(a.urgent) || String(a.since || '').localeCompare(String(b.since || '')));
  const migrations = (await kv.hgetall(K.migrations()).catch(() => ({}))) || {};
  return {
    machine: {
      ok: true,
      baseUrl: baseUrl(),
      heartbeat: board.heartbeat,
      activeTrials: board.activeTrials, maxActiveTrials: board.maxActiveTrials, extensions: board.extensions,
      openAlerts: board.openAlerts,
      usage: board.usage,
      setup: {
        migrated: Boolean(migrations.phase1),
        encKey: Boolean(process.env.ENC_KEY),
        cronSecret: Boolean(process.env.CRON_SECRET),
        telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        healthchecks: Boolean(process.env.HC_PING_URL),
        ownerInbox: Boolean(process.env.OWNER_INBOX) || (await loadAccounts().catch(() => [])).length > 0,
      },
      queue: (queue.rows || []).map((q, i) => ({ id: q.id, name: q.name, position: i + 1, expectedDate: q.expectedDate || null })),
      others,
    },
    stages,
    todos,
    inquiries,
    alerts: alerts.filter((a) => !a.acknowledged).slice(0, 50).map((a) => ({ id: a.id, at: a.at, key: a.key, clientId: a.clientId, title: a.title, urgent: a.urgent, delivered: a.delivered })),
  };
}

/** However many trials wait for the warm-up circle, the board shows one "Add N warm-up helpers" to-do. */
function oneHelpersTodo(todos) {
  const helpers = todos.filter((t) => t.id.startsWith('warmup-helpers:'));
  if (helpers.length < 2) return todos;
  const names = helpers.map((t) => t.clientName);
  const one = { ...helpers[0], id: 'warmup-helpers', clientId: null, clientName: 'Warm-up', detail: `${helpers[0].detail}${helpers[0].detail ? ' · ' : ''}waiting: ${names.join(', ')}`, since: helpers.map((t) => t.since).filter(Boolean).sort()[0] || null };
  return [...todos.filter((t) => !t.id.startsWith('warmup-helpers:')), one];
}

/** Machine-level to-dos (no client): setup still missing, first-time setup, queue with a free slot. */
async function machineTodos(board, queue, { cheapInboxes = false } = {}) {
  const t = [];
  // A CheapInboxes purchase no trial claims (docs/AUTO-BUY.md §3): he picks the trial in Settings.
  if (cheapInboxes) {
    for (const u of unmatchedOf(await readDomainIndex().catch(() => ({})))) {
      t.push({ id: `unmatched:${u.domain}`, clientId: null, clientName: 'CheapInboxes', text: `You bought ${u.domain} — which trial is it for? Pick in Settings`,
        detail: `${u.mailboxes != null ? `${u.mailboxes} inbox${u.mailboxes === 1 ? '' : 'es'} · ` : ''}bought ${u.boughtAt ? ago(u.boughtAt, new Date()) : 'recently'} · the machine connects it once you pick`,
        urgent: true, since: u.boughtAt, action: { type: 'view', view: 'settings', section: 'inboxes', domain: u.domain } });
    }
  }
  const missing = [];
  if (!process.env.ENC_KEY) missing.push('ENC_KEY');
  if (!process.env.CRON_SECRET) missing.push('CRON_SECRET');
  // Owner alerts fall back to the first aviance inbox, so OWNER_INBOX is only missing when that is empty too.
  if (!process.env.OWNER_INBOX && !(await loadAccounts().catch(() => [])).length) missing.push('OWNER_INBOX');
  if (!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)) missing.push('Telegram');
  if (!process.env.HC_PING_URL) missing.push('Healthchecks');
  if (missing.length) t.push({ id: 'machine-setup', clientId: null, clientName: 'Machine', text: `Finish the machine setup: ${missing.join(', ')}`, detail: 'Settings in Vercel — see docs/PROGRESS.md', urgent: false, since: null, action: { type: 'none' } });
  const migrations = (await kv.hgetall(K.migrations()).catch(() => ({}))) || {};
  if (!migrations.phase1) t.push({ id: 'machine-migrate', clientId: null, clientName: 'Machine', text: 'Run first-time setup (moves the Aviance inboxes into the database)', detail: '', urgent: false, since: null, action: api('/api/mc/setup', { action: 'migrate' }) });
  if (board.heartbeat.ageSec != null && board.heartbeat.ageSec > 900) t.push({ id: 'machine-heartbeat', clientId: null, clientName: 'Machine', text: `No heartbeat for ${Math.round(board.heartbeat.ageSec / 60)} minutes — check cron-job.org`, detail: '', urgent: true, since: board.heartbeat.lastTickAt, action: { type: 'none' } });
  if ((queue.rows || []).length && board.activeTrials < board.maxActiveTrials && !board.extensions) {
    const q = queue.rows[0];
    t.push({ id: `promote-${q.id}`, clientId: q.id, clientName: q.name || q.id, text: `A trial slot is free — promote ${q.name || q.id} from the queue`, detail: `Position 1 · expected ${q.expectedDate || '—'}`, urgent: false, since: q.queuedAt || null, action: api('/api/mc/queue', { action: 'promote', clientId: q.id }, `Start onboarding for ${q.name || q.id} now?`) });
  }
  return t;
}

/** One trial in full (docs/HUB-API.md "GET /api/mc/hub/[id]"). */
export async function hubClient(id, { now = new Date() } = {}) {
  const client = await getClient(id);
  if (!client) return null;
  const row = await hubRow(client, { now });
  const { _ctx: ctx, ...rowOut } = row;
  const last = jobRecords(client);
  const jobs = {};
  for (const j of JOBS.filter((x) => x.scope === 'client')) jobs[j.name] = last[j.name] || null;
  const events = await getEvents(id, 150);
  const profile = { ...ctx.profile };
  for (const [k, v] of Object.entries(profile)) if (typeof v === 'string' && /^\s*[\[{]/.test(v)) profile[k] = parseJson(v, v);
  const domain = { name: ctx.domain.name || null, setupPhase: ctx.domain.setupPhase || null, setupPassedAt: ctx.domain.setupPassedAt || null, setupFailedAt: ctx.domain.setupFailedAt || null, checks: ctx.checks, dmarcPassRate7d: rate(ctx.domain.dmarcPassRate7d), blacklist: ctx.domain.blacklist || null, retiredAt: ctx.domain.retiredAt || null };
  return {
    row: rowOut,
    profile,
    trial: ctx.trial,
    domain,
    shopping: ctx.shopping,
    inboxes: ctx.inboxes.map((i) => ({ ...i, inboxRate7d: rate(i.inboxRate7d), canaryPlacement: rate(i.canaryPlacement), health: i.disabledReason ? 'warning' : 'ok' })),
    leadsByStatus: ctx.leads,
    leadfinder: ctx.lf,
    sequence: { active: ctx.sequence.active || null, version: ctx.sequence.version || null, approvedAt: ctx.sequence.approvedAt || null, approvalMode: ctx.sequence.approvalMode || null, round: ctx.approval.round || 0, changes: ctx.approval.changes || [], sentAt: ctx.approval.sentAt || null },
    counters: ctx.counters,
    repliesByKind: ctx.repliesByKind,
    replies: ctx.replies,
    bookings: ctx.bookings,
    pacelog: ctx.pacelog,
    reports: ctx.reports,
    invoice: ctx.invoice,
    promises: ctx.promises,
    upcoming: ctx.upcoming,
    events,
    jobs,
    holds: { legalHoldAt: client.legalHoldAt || null, sendHold: client.sendHold || null, emergencyActive: truthy(client.emergencyActive), emergencyHalved: truthy(client.emergencyHalved), pausedReason: client.pausedReason || null },
    // Research is read only here (one Redis read per detail view), never on board rows.
    application: ctx.application ? { ...ctx.application, research: await researchView(id).catch(() => null) } : null,
    // The onboarding call with its whole conversation (docs/ONBOARD-CALL.md §5); null when no acceptance email went.
    onboardCall: client.onboardCallSentAt ? await onboardCallFor(id, { now, client }).catch(() => null) : null,
    // The CheapInboxes purchase (docs/AUTO-BUY.md "Status for the hub"); null outside the buying / setup / warm-up steps.
    autobuy: ctx.autobuy || null,
    // The warm-up card (docs/WARMUP-HUB.md); null before the inboxes are connected.
    warmup: ctx.warmup || null,
    // The client's one conversation, any state, with the reply bot's switch (docs/REPLYBOT-MEET.md §1).
    conversation: await conversationFor(id, { now, client }).catch(() => null),
    deliverability: await deliverabilityView(id).catch(() => null),
    leadQuality: await leadQualityView(id).catch(() => null),
    links: {},
    virtualNow: id === '_test' ? clientNow(client, now).toISOString() : null,
  };
}
