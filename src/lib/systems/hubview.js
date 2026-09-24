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
import { getInboxRecords } from '@/lib/db/inboxes';
import { getEvents } from '@/lib/db/events';
import { getAlertLog, baseUrl } from '@/lib/notify';
import { clientNow } from '@/lib/testclock';
import { boardData, clientRow } from '@/lib/systems/boarddata';
import { clientExtras } from '@/lib/systems/clientview';
import { readChecks } from '@/lib/systems/setupcheck';
import { getShopping } from '@/lib/systems/pricescout';
import { getState as leadfinderState } from '@/lib/systems/leadfinder';
import { getApproval } from '@/lib/systems/approval';
import { getPaceLog } from '@/lib/systems/pace';
import { getRunState } from '@/lib/systems/stagec-common';
import { listQueue } from '@/lib/systems/gatekeeper';
import { overduePromises } from '@/lib/systems/health';
import { jobRecords } from '@/lib/scheduler';
import { loadAccounts } from '@/lib/smtp-accounts';
import { JOBS } from '@/lib/jobs';

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

// ─── state label ──────────────────────────────────────────────────────────────

export function stateLabelFor(ctx) {
  const { client, trial = {}, day, shopping = {}, now } = ctx;
  const base = STATE_LABELS[client.state] || client.state;
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
  if (st === 'applied') out.push(sys('intake', 'working', 'Application received · fit check running'));
  else if (st === 'queued') out.push(sys('intake', 'waiting', `In the queue${client.queueExpectedDate ? ` · expected ${client.queueExpectedDate}` : ''}`));
  else if (st === 'declined') out.push(sys('intake', 'off', `Declined${client.declineReason ? ` · ${client.declineReason}` : ''}`));
  else if (st === 'closed_silent') out.push(sys('intake', 'off', 'Never finished onboarding'));
  else if (st === 'onboarding') out.push(sys('intake', 'waiting', `Onboarding link sent ${ago(trial.onboardingSentAt, now) || '—'} · waiting for the form and agreement`, [trial.onboardingRemindersSent ? `${trial.onboardingRemindersSent} reminder(s) sent` : null]));
  else out.push(sys('intake', 'ok', `Agreement accepted ${dateOf(trial.agreementAcceptedAt) || ''}${trial.agreementName ? ` by ${trial.agreementName}` : ''}`.trim()));

  // 2. Market count
  const est = n(profile.marketEstimate);
  if (client.declineReason === 'market_small') out.push(sys('market', 'blocked', `Market too small${est != null ? `: ${est.toLocaleString('en-US')} (minimum ${minMarket.toLocaleString('en-US')})` : ''}`, ['Override it from the Setup tab if you disagree']));
  else if (client.intakeStep === 'market_wait') out.push(sys('market', 'working', 'Counting matching companies…'));
  else if (est != null) out.push(sys('market', 'ok', `${est.toLocaleString('en-US')} matching companies (minimum ${minMarket.toLocaleString('en-US')})${profile.marketSource === 'override' ? ' · overridden by you' : ''}`, [profile.marketCheckedAt ? `checked ${dateOf(profile.marketCheckedAt)}` : null]));
  else out.push(sys('market', 'off', 'Runs when the agreement is accepted'));

  // 3. Domain & inboxes (Price Scout + purchase)
  if (shopping.boughtAt) out.push(sys('purchase', 'ok', `Bought ${dateOf(shopping.boughtAt)} · ${domain.name || shopping.chosenDomain || ''} · ${inboxes.length} inbox${inboxes.length === 1 ? '' : 'es'}`));
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
    const status = disabled.length ? 'blocked' : ready ? 'ok' : 'working';
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

  if (st === 'awaiting_purchase' && shopping.sentAt && !shopping.boughtAt) {
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
  if (['warming', 'ready'].includes(st) && profile.bookingRequestSentAt && !truthy(profile.bookingTested)) {
    push('booking-test', 'Client has not done the 60-second booking test yet (Day 1 waits for it)', `Asked ${ago(profile.bookingRequestSentAt, now)} · reminded daily`, false, profile.bookingRequestSentAt, view('detail', id, 'setup'));
  }
  for (const a of alerts) {
    if (!a.urgent) continue;
    push(`alert-${a.id}`, a.title, `Alert ${ago(a.at, now)} · acknowledge it once handled`, true, a.at, api('/api/mc/alerts', { action: 'ack', id: a.id }));
  }
  return t.sort((a, b) => Number(b.urgent) - Number(a.urgent) || String(a.since || '').localeCompare(String(b.since || '')));
}

// ─── loading ──────────────────────────────────────────────────────────────────

const parseJson = (v, fallback) => { if (v == null || v === '') return fallback; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fallback; } };

export async function loadContext(client, { alerts = null, now = new Date() } = {}) {
  const id = client.id;
  const vnow = clientNow(client, now);
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
  const inboxes = inboxesRaw.map(({ passwordEnc, ...r }) => ({ ...r, hasPassword: Boolean(passwordEnc) }));
  const hot = Object.values((await kv.hgetall(K.hot(id)).catch(() => null)) || {});
  const openAlerts = allAlerts.filter((a) => a.clientId === id && !a.acknowledged);
  return {
    client, trial: trial || {}, profile, domain, checks, shopping, inboxes,
    leads: extras.leadsByStatus || {}, lf, approval, sequence: sequence || {}, counters: extras.counters || {},
    bookings: extras.bookings || [], replies: extras.replies || [], repliesByKind: extras.repliesByKind || {}, hot,
    invoice: extras.invoice, promises: extras.promises || [], pacelog, reports: extras.reports || [], upcoming: extras.upcoming || [],
    runState, alerts: openAlerts, day: extras.trialDay, health: extras.health, now: vnow, minMarket: await cfg(id, 'MIN_MARKET'),
  };
}

/** One board row (docs/HUB-API.md "Client row"). */
export async function hubRow(client, { alerts, now = new Date() } = {}) {
  const [base, ctx] = await Promise.all([clientRow(client, { alerts, now }), loadContext(client, { alerts, now })]);
  const next = ctx.upcoming[0] || null;
  return {
    ...base,
    stateLabel: stateLabelFor(ctx),
    contactName: client.contactName || null, contactEmail: client.contactEmail || null, website: client.website || null,
    todo: todosFor(ctx),
    systems: systemsFor(ctx),
    nextUp: next ? { date: next.date, what: next.what } : null,
    _ctx: ctx,
  };
}

export async function hubBoard({ now = new Date() } = {}) {
  const [board, clients, queue] = await Promise.all([boardData(now), getAllClients(), listQueue().catch(() => ({ rows: [] }))]);
  const alerts = await getAlertLog(500);
  const rows = await Promise.all(clients.map((c) => hubRow(c, { alerts, now })));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const strip = (r) => { const { _ctx, ...rest } = r; return rest; };
  const stages = STAGES.map((s) => ({ ...s, clients: board.clients.filter((c) => s.states.includes(c.state) && c.id !== 'aviance' && c.id !== '_test').map((c) => strip(byId.get(c.id))).filter(Boolean) }));
  const others = ['aviance', '_test'].map((id) => byId.get(id)).filter(Boolean).map(strip);
  const todos = rows.filter((r) => r.id !== '_test').flatMap((r) => r.todo);
  todos.push(...(await machineTodos(board, queue)));
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
    alerts: alerts.filter((a) => !a.acknowledged).slice(0, 50).map((a) => ({ id: a.id, at: a.at, key: a.key, clientId: a.clientId, title: a.title, urgent: a.urgent, delivered: a.delivered })),
  };
}

/** Machine-level to-dos (no client): setup still missing, first-time setup, queue with a free slot. */
async function machineTodos(board, queue) {
  const t = [];
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
    links: {},
    virtualNow: id === '_test' ? clientNow(client, now).toISOString() : null,
  };
}
