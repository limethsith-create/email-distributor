/**
 * Shared definitions — US-Eastern dates, campaigns, lead-state predicates and
 * the metric rules every API derives its numbers from.
 *
 * Dependency-free (no KV, no network) so both server routes and libs can import
 * it. The dashboard keeps its own copy of the same rules; the point of this
 * module is that every API (stats, campaigns, daily log, export) agrees with
 * the dashboard instead of each one inventing its own definition of
 * "contacted", "opened" and "replied".
 */

export const SEND_TZ = 'America/New_York';

export const CAMPAIGNS = ['free-leads', 'offer'];

/** Only leads Scout scored at least this high are ever sent. */
export const SEND_SCORE_THRESHOLD = 8;

/** Hard daily maximum per inbox. */
export const SEND_CAP = 25;

/** Fresh start: only touches recorded on/after this instant count. */
export const CAMPAIGN_START = '2026-08-01T09:30:00Z';

/**
 * Open-tracking blackout: emails sent in this window shipped without a pixel,
 * so they are excluded from the open-RATE denominator (never from "sent").
 */
export const TRACKING_GAP_START = '2026-08-21T00:00:00Z';
export const TRACKING_GAP_END = '2026-08-26T04:20:00Z';

// ─── Dates (US Eastern, DST-aware) ────────────────────────────────────────

/** 'YYYY-MM-DD' for `date` in US Eastern. */
export function getTodayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SEND_TZ }).format(date);
}

/** The last `n` ET day keys, today first. */
export function dayKeys(n = 7, now = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(getTodayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  return out;
}

/** ET wall-clock parts for an instant. */
export function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_TZ, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = parseInt(map.hour, 10) % 24;
  const minute = parseInt(map.minute, 10);
  return {
    weekday: map.weekday,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    dayKey: `${map.year}-${map.month}-${map.day}`,
  };
}

// ─── Campaign / lead helpers ─────────────────────────────────────────────────

export function campaignOf(lead) {
  return String(lead?.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer';
}

export function normalizeCampaign(value, fallback = 'offer') {
  const c = String(value || '').toLowerCase();
  return CAMPAIGNS.includes(c) ? c : fallback;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().replace(/^mailto:/, '');
}

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

export function isValidEmail(value) {
  const e = normalizeEmail(value);
  return e.length <= 254 && EMAIL_RE.test(e);
}

/** Generic / role mailboxes that are never worth a personal cold email. */
const ROLE_LOCALS = new Set([
  'info', 'contact', 'sales', 'admin', 'support', 'hello', 'reservations', 'marketing',
  'hr', 'careers', 'jobs', 'billing', 'accounts', 'enquiries', 'enquiry', 'inquiries',
  'reception', 'office', 'general', 'noreply', 'no-reply', 'webmaster', 'help', 'team',
  'press', 'media', 'legal', 'privacy', 'abuse', 'postmaster', 'mailer-daemon',
  'newsletter', 'news', 'orders', 'service', 'customerservice', 'customer.service',
  'donotreply', 'do-not-reply', 'unsubscribe', 'security', 'compliance', 'finance',
  'accounting', 'payroll', 'invoices', 'ap', 'ar',
]);

export function isRoleEmail(email) {
  const e = normalizeEmail(email);
  const local = e.split('@')[0] || '';
  if (!local) return true;
  if (ROLE_LOCALS.has(local)) return true;
  // "info-us", "sales.team", "support+1" — role word followed by a separator.
  const head = local.split(/[.\-_+]/)[0];
  return head.length >= 4 && ROLE_LOCALS.has(head);
}

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com',
  'zoho.com', 'yandex.com', 'yandex.ru', 'comcast.net', 'verizon.net', 'att.net',
  'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
]);

export function isFreeMailDomain(email) {
  const d = normalizeEmail(email).split('@')[1] || '';
  return FREE_MAIL_DOMAINS.has(d);
}

/** Company name normalised for cross-lead dedupe. */
export function normalizeCompanyName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(pvt|ltd|plc|llc|llp|inc|co|corp|corporation|company|incorporated|limited|private|gmbh|sa|srl|bv|pty)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Score the sender honours (Scout's quality_score, else an import's ai_score). */
export function leadScore(lead) {
  return Number(lead?.quality_score) || Number(lead?.ai_score) || 0;
}

/** Target-industry gate (the lead list is already requalified to US targets). */
export function isTargetIndustry(lead) {
  const ind = String(lead?.industry || '').trim();
  if (/^\s*usa\s*-/i.test(ind)) return true;
  return /(marketing|advert|agenc|consult|professional\s*service|technolog|software|saas|\bit\b|it\s*service|managed\s*service|\bmsp\b|finance|financial|fintech|\bb2b\b|logistic|revenue|growth|outbound|lead\s*gen)/i.test(ind);
}

export const UNSENT_STATUSES = new Set(['', 'new', 'pending', 'qualified']);

/** True when the sender would pick this lead up (status, score, industry). */
export function isSendable(lead) {
  if (!lead || !lead.email) return false;
  const st = String(lead.status || '').toLowerCase();
  if (!UNSENT_STATUSES.has(st)) return false;
  if (lead.sent_at || lead.account_used) return false;
  return leadScore(lead) >= SEND_SCORE_THRESHOLD && isTargetIndustry(lead);
}

// ─── Metric predicates (identical to the dashboard's) ─────────────────────────

export function afterStart(ts) {
  return Boolean(ts) && String(ts) >= CAMPAIGN_START;
}

export function isReal(lead) {
  const s = String(lead?.status || '');
  return !s.startsWith('skipped') && s !== 'bounced';
}

export function isSent(lead) {
  return afterStart(lead?.sent_at);
}

export function isTrackable(lead) {
  const t = lead?.sent_at;
  if (!afterStart(t)) return false;
  const ts = String(t);
  return !(ts >= TRACKING_GAP_START && ts < TRACKING_GAP_END);
}

export function isOpened(lead) {
  return afterStart(lead?.opened_at);
}

export function isReplied(lead) {
  return afterStart(lead?.replied_at);
}

/** Every touch that went out for a lead, in order. */
export function touchesOf(lead) {
  const out = [];
  if (afterStart(lead?.sent_at)) out.push({ touch: 'd0', at: lead.sent_at });
  if (afterStart(lead?.d3_sent_at)) out.push({ touch: 'd3', at: lead.d3_sent_at });
  if (afterStart(lead?.d7_sent_at)) out.push({ touch: 'd7', at: lead.d7_sent_at });
  return out;
}

export function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * Merge the open-tracking store into a lead's projection. The pixel route
 * records opens ONLY in `email_opens` (never rewriting the lead record), so
 * every reader must merge. `firstHumanAt` (non-bot opens) is preferred for
 * `opened_at`; the raw first open is exposed as `opened_any_at`.
 */
export function mergeOpens(lead, opensMap) {
  const o = (opensMap && opensMap[normalizeEmail(lead?.email)]) || null;
  const isClassified = Boolean(o) && Object.prototype.hasOwnProperty.call(o, 'firstHumanAt');
  const anyAt = (o && (o.firstAt || o.openedAt)) || lead?.opened_at || null;
  // Classified records: only a human (non-scanner) open counts as "opened".
  // Legacy records (pre-classification) and legacy lead fields count as-is.
  let openedAt = null;
  if (isClassified) openedAt = o.firstHumanAt || null;
  else if (o) openedAt = o.openedAt || o.firstAt || null;
  if (!openedAt && !isClassified) openedAt = lead?.opened_at || null;
  return {
    opened_at: openedAt,
    opened_any_at: anyAt,
    last_opened_at: (o && (o.lastAt || o.lastOpenedAt)) || lead?.last_opened_at || null,
    open_count: (o && Number(o.count)) || Number(lead?.open_count) || 0,
    human_open_count: isClassified ? Number(o.humanCount) || 0 : ((o && Number(o.count)) || Number(lead?.open_count) || 0),
    open_class: (o && o.lastClass) || null,
    open_country: (o && o.country) || null,
    open_touches: (o && o.touches) || null,
  };
}

/** Compute the campaign/overall figures the dashboard and Campaigns page show. */
export function summarizeLeads(leads, opensMap) {
  const real = leads.filter(isReal);
  const merged = real.map((l) => ({ ...l, ...mergeOpens(l, opensMap) }));
  const sent = merged.filter(isSent);
  const trackable = sent.filter(isTrackable);
  const opened = trackable.filter(isOpened);
  const replied = sent.filter(isReplied);
  const humanReplied = sent.filter((l) => isReplied(l) && (!l.reply_kind || l.reply_kind === 'human'));
  const positive = sent.filter((l) => isReplied(l) && /^(interested|send_it|question|referral|meeting)$/.test(String(l.reply_intent || '')));
  const touches = sent.reduce((n, l) => n + touchesOf(l).length, 0);
  return {
    total: leads.length,
    real: real.length,
    queued: merged.filter((l) => UNSENT_STATUSES.has(String(l.status || '').toLowerCase()) && !l.sent_at).length,
    sendable: merged.filter(isSendable).length,
    contacted: sent.length,
    touches,
    trackable: trackable.length,
    untracked: sent.length - trackable.length,
    opened: opened.length,
    replied: replied.length,
    humanReplied: humanReplied.length,
    positiveReplied: positive.length,
    bounced: leads.filter((l) => l.status === 'bounced').length,
    skipped: leads.filter((l) => String(l.status || '').startsWith('skipped')).length,
    unsubscribed: leads.filter((l) => l.status === 'unsubscribed').length,
    openRate: pct(opened.length, trackable.length),
    replyRate: pct(replied.length, sent.length),
    positiveReplyRate: pct(positive.length, sent.length),
  };
}
