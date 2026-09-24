/**
 * Reply Handler + Speed Responder (SPEC §8.3), Wrong-Person Follower (§8.6),
 * Not-Now Date Reader (§8.7) and the hot-lead chaser. Evolved from
 * reply-checker.js (which keeps serving the aviance client).
 *
 * One trial inbox per run, round-robin (the `replies` job runs every tick in
 * US hours and every 20 minutes otherwise). For each new message since the
 * inbox's UID watermark:
 *
 *   own copy → skip · warm-up marker → skip · DSN → bounce
 *   from the client → hot-lead answered / exit interview / quote / activity
 *   matched to a lead (thread Message-ID or sender) → OOO hold, or classify
 *   and act per the §8.3 table within the same run
 *
 * Every reply is claimed (SET NX) before anything is done with it, so two
 * runs over the same message never double-act. Records go to
 * client:{id}:replies in the SPEC §3 shape.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { DEFAULTS } from '@/lib/config';
import { getClient, getProfile, getTrial } from '@/lib/db/client';
import { getAccounts } from '@/lib/db/inboxes';
import { getLead, saveLead, suppress, insertLeads, hostOf } from '@/lib/db/leads';
import { bump } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { recordImapResult } from '@/lib/inbox-health';
import { normId, stripQuotedReply, snippet, parseOooUntil, extractBouncedAddress, dsnSeverity, bounceReason } from '@/lib/mail-utils';
import { partsIn, ET, addDays, dayKeyIn } from '@/lib/time';
import { isWarmup } from '@/lib/systems/copycheck-adapter';
import { recordLearning } from '@/lib/systems/learning';
import { sendToProspect, notifyClientSafe, clientAddresses } from '@/lib/systems/outbound';
import { evaluateSmoke, loadPace } from '@/lib/systems/sender';
import {
  deps, alert, isTrialClient, lower, shortHash, configList, namedSlots, getRunState, patchRunState, claimOnce, nicheOf, ccfg } from '@/lib/systems/stagec-common';

// ─── Classifier (SPEC §8.3, ordered; first match wins) ───────────────────────

const LEGAL = ['lawyer', 'attorney', 'legal action', 'cease and desist', 'lawsuit', 'report you', 'ftc', 'can-spam', 'can spam', 'canspam', 'harass'];
const NO_PHRASES = ['no thanks', 'no thank you', 'not interested', 'unsubscribe', 'stop', 'remove', 'opt out', 'opt-out', "don't contact", 'dont contact', 'do not contact', 'pass'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const HOLIDAY_RE = "(thanksgiving|christmas|xmas|the holidays|new year'?s?|labor day|memorial day|july 4(?:th)?|4th of july|fourth of july|independence day|easter|halloween)";

/** Phrase match with word boundaries where the phrase starts/ends with a word character (`end: false` = prefix match). */
const has = (text, phrase, { end = true } = {}) => {
  const p = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pre = /^\w/.test(phrase) ? '\\b' : '';
  const post = end && /\w$/.test(phrase) ? '\\b' : '';
  return new RegExp(`${pre}${p}${post}`, 'i').test(text);
};
const words = (t) => String(t || '').split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

const WRONG_RES = [
  /not the right person/, /\bwrong person\b/, /\bi (?:don'?t|do not) handle\b/, /\bnot my area\b/,
  /\byou(?:'d| would)? want to (?:talk|speak|reach|contact|email|get in touch)\b/, /\byou want [a-z]+ [a-z]+ (?:at|who|on)\b/,
  /\breach out to (?!me\b|us\b)[a-z@]/, /\bcontact (?!me\b|us\b|you\b|him\b|her\b|them\b|info\b|form\b|page\b|the\b|our\b|my\b|your\b|his\b|their\b|with\b|sales\b|support\b)[a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+)?\s*(?:at|on|via|\(|<|,|\.|$)/m,
];
const NOTNOW_RES = [
  /\bnot now\b/, /\bnot right now\b/, /\bmaybe later\b/, /\bnext quarter\b/, /\bnext year\b/, /\bin q[1-4]\b/,
  new RegExp(`\\bafter ${MONTH_RE}\\b`), new RegExp(`\\bafter ${HOLIDAY_RE}`), /\bbusy until\b/, /\bcheck back\b/,
  /\bcircle back\b/, /\brevisit\b/, /\btouch base in\b/,
];
const INTERESTED_RES = [
  /(?<!not |no longer |not really |never )\binterested\b/, /\btell me more\b/, /\bhow does\b/, /\bwhat does (?:it|this|that) cost\b/, /\bpricing\b/,
  /\bsend (?:me )?(?:more|info|information|details|over)\b/, /\bsounds (?:good|great|interesting)\b/, /\blet'?s (?:talk|chat|do it|connect|set)/,
  /\b(?:book|set up|schedule) (?:a|the) (?:call|time|meeting|chat)\b/, /\bhappy to (?:chat|talk|hop on|jump on|connect)\b/,
  /\bworth a (?:chat|call|look)\b/, /^\s*(?:yes|yep|yeah|sure|ok(?:ay)?)\b/, /\bi'?m in\b/, /\bwhen are you (?:free|available)\b/,
];

/**
 * Classify a reply body (already stripped of quotes) → { kind, rule }.
 * Kinds: legal, angry, no, wrongperson, notnow, interested, question, unclear.
 * (bounce / ooo are decided from headers before this runs.)
 */
export function classifyReply(rawText, { angry = configList('angry') } = {}) {
  const text = stripQuotedReply(rawText || '').toLowerCase().replace(/[’‘]/g, "'").trim();
  if (!text) return { kind: 'unclear', rule: 'empty' };
  const legal = LEGAL.find((w) => has(text, w, { end: false }));
  if (legal) return { kind: 'legal', rule: legal };
  const mad = angry.find((w) => has(text, w, { end: false }));
  if (mad) return { kind: 'angry', rule: mad };
  if (words(text) <= 12) {
    const no = NO_PHRASES.find((w) => has(text, w));
    if (no) return { kind: 'no', rule: no };
  }
  const wrong = WRONG_RES.find((re) => re.test(text));
  if (wrong) return { kind: 'wrongperson', rule: wrong.source };
  const later = NOTNOW_RES.find((re) => re.test(text));
  if (later) return { kind: 'notnow', rule: later.source };
  const yes = INTERESTED_RES.find((re) => re.test(text));
  if (yes) return { kind: 'interested', rule: yes.source };
  if (text.includes('?')) return { kind: 'question', rule: '?' };
  return { kind: 'unclear', rule: 'no rule matched' };
}

// ─── Not-Now date reader (SPEC §8.7) ─────────────────────────────────────────

function monthIndex(s) { return MONTHS.findIndex((m) => m.startsWith(String(s).slice(0, 3).toLowerCase())); }
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** First day of month index `mi` strictly after today (dayKey). */
function nextMonthStart(today, mi) {
  const [y, m] = today.split('-').map(Number);
  const year = mi > m - 1 ? y : y + 1;
  return ymd(year, mi, 1);
}

function holidayDate(name, today) {
  const n = name.toLowerCase();
  const [y] = today.split('-').map(Number);
  const fixed = (mm, dd) => { const d = ymd(y, mm - 1, dd); return d > today ? d : ymd(y + 1, mm - 1, dd); };
  if (/christmas|xmas|holidays/.test(n)) return fixed(12, 25);
  if (/new year/.test(n)) return ymd(y + 1, 0, 1);
  if (/july|independence/.test(n)) return fixed(7, 4);
  if (/halloween/.test(n)) return fixed(10, 31);
  // Floating federal holidays come from config US_HOLIDAYS (month tells which).
  const month = /thanksgiving/.test(n) ? '11' : /labor/.test(n) ? '09' : /memorial/.test(n) ? '05' : null;
  if (month) {
    const pick = DEFAULTS.US_HOLIDAYS.filter((d) => d.slice(5, 7) === month && d > today && (month !== '11' || Number(d.slice(8)) >= 22));
    if (pick.length) return pick[0];
  }
  return null; // easter & unknown → default rule
}

/**
 * Parse a not-now reply to the day to follow up (ET day key).
 * explicit month → 1st of that month (next occurrence; "after <month>" → the
 * 1st of the month after); q1..q4 → first day of that quarter; next quarter →
 * +90 days; next year → Jan 1; after <holiday> → holiday + 3 days; none → +60.
 */
export function parseNotNowDate(rawText, now = new Date(), { defaultDays = 60, quarterDays = 90 } = {}) {
  const text = stripQuotedReply(rawText || '').toLowerCase();
  const today = dayKeyIn(ET, now);
  const [y, m] = today.split('-').map(Number);
  let mm;
  if ((mm = new RegExp(`\\bafter ${HOLIDAY_RE}`).exec(text))) {
    const d = holidayDate(mm[1], today);
    if (d) return { date: addDays(d, 3), rule: `after ${mm[1]}` };
  }
  if ((mm = /\b(?:in |by |during |until |after |early |late |mid-?)?q([1-4])\b/.exec(text))) {
    const q = Number(mm[1]);
    const startMonth = (q - 1) * 3;
    const year = startMonth > m - 1 ? y : y + 1;
    return { date: ymd(year, startMonth, 1), rule: `q${q}` };
  }
  if (/\bnext quarter\b/.test(text)) return { date: addDays(today, quarterDays), rule: 'next quarter' };
  if (/\bnext year\b/.test(text)) return { date: ymd(y + 1, 0, 1), rule: 'next year' };
  // "may" only counts as a month after a time preposition (it is also a verb).
  const monthRe = new RegExp(`\\b(after|until|in|by|around|early|mid|late|end of|beginning of|come|this|next)?\\s*${MONTH_RE}\\b`, 'g');
  let hit;
  while ((hit = monthRe.exec(text))) {
    const prep = hit[1];
    const name = hit[2];
    if (name === 'may' && !prep) continue;
    if (name === 'mar' && !prep) continue;
    const mi = monthIndex(name);
    if (mi < 0) continue;
    if (prep === 'after') {
      const start = nextMonthStart(today, mi);
      const [sy, sm] = start.split('-').map(Number);
      return { date: sm === 12 ? ymd(sy + 1, 0, 1) : ymd(sy, sm, 1), rule: `after ${name}` };
    }
    return { date: nextMonthStart(today, mi), rule: name };
  }
  return { date: addDays(today, defaultDays), rule: 'default' };
}

export function monthName(dayKey) {
  const m = Number(String(dayKey).slice(5, 7)) - 1;
  return MONTHS[m] ? MONTHS[m][0].toUpperCase() + MONTHS[m].slice(1) : null;
}

// ─── Wrong-Person Follower (SPEC §8.6) ───────────────────────────────────────

const NOT_NAMES = new Set(['me', 'us', 'you', 'him', 'her', 'them', 'our', 'the', 'my', 'your', 'info', 'sales', 'support', 'someone', 'somebody', 'that', 'this', 'a', 'an', 'at', 'on', 'hr', 'team', 'office']);

/**
 * Pull the referred person out of a wrong-person reply → { name, email } (either may be null).
 * The email is taken when present anywhere in the reply (excluding `exclude`).
 */
export function extractReferral(rawText, { exclude = [] } = {}) {
  const text = stripQuotedReply(rawText || '').replace(/[’]/g, "'");
  const ex = new Set(exclude.map(lower));
  const emails = [...text.matchAll(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi)].map((m) => m[1].toLowerCase()).filter((e) => !ex.has(e));
  const email = emails[0] || null;
  let name = null;
  const cue = /(?:contact|reach out to|you(?:'d| would)? want(?: to (?:talk|speak) (?:to|with))?|speak (?:to|with)|talk to|try|email|ask|that(?:'s| is| would be)|goes to|handled by|is handled by)\s+(?:our\s+\w+\s*,?\s*)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/g;
  let m;
  while ((m = cue.exec(text))) {
    const parts = m[1].split(/\s+/).filter((p) => !NOT_NAMES.has(p.toLowerCase()));
    if (parts.length) { name = parts.slice(0, 2).join(' '); break; }
  }
  if (!name && email) {
    const local = email.split('@')[0];
    const bits = local.split(/[._-]/).filter((b) => /^[a-z]{2,}$/.test(b));
    if (bits.length >= 1 && !NOT_NAMES.has(bits[0])) name = bits.slice(0, 2).map((b) => b[0].toUpperCase() + b.slice(1)).join(' ');
  }
  return { name, email };
}

/** Address guesses on the lead's host (SPEC §7.2 step 4 order). */
export function guessAddresses(name, host) {
  const [first, last] = String(name || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  if (!first || !host) return [];
  if (!last) return [`${first}@${host}`];
  return [`${first}@${host}`, `${first}.${last}@${host}`, `${first[0]}${last}@${host}`, `${first}${last[0]}@${host}`, `${first[0]}.${last}@${host}`];
}

async function followReferral(clientId, lead, reply) {
  if (lead.source === 'referral') return { created: false, reason: 'one hop only' };
  const own = [lead.email];
  const { name, email } = extractReferral(reply.text, { exclude: own });
  if (!name && !email) return { created: false, reason: 'nobody named' };
  const host = hostOf(lead.email);
  let address = email;
  let riskLevel = 'safe';
  if (!address) {
    // No address given: first guess on the same host that has a mail server.
    for (const g of guessAddresses(name, host).slice(0, 1)) {
      const v = await deps.verifyEmail(g);
      if (v && v.valid) { address = g; riskLevel = 'risky'; }
    }
  }
  if (!address) return { created: false, reason: 'no address found', name };
  const first = String(name || '').split(/\s+/)[0] || null;
  const res = await insertLeads(clientId, [{
    email: address, first_name: first, name: name || null, company: lead.company, website: lead.website, city: lead.city, state: lead.state, tz: lead.tz,
    sizeBand: lead.sizeBand, source: 'referral', referrerName: lead.first_name || lead.name || 'a colleague', referredFrom: lead.email,
    riskLevel, guessed: !email, sequenceVariant: lead.sentVariant || lead.sequenceVariant || 'A', score: (Number(lead.score) || 0) + 1,
  }]);
  await logEvent(clientId, 'replies', 'referral', { from: lead.email, to: address, name, guessed: !email, added: res.added });
  return { created: res.added > 0, email: address, name, skipped: res.skipped };
}

// ─── Records ─────────────────────────────────────────────────────────────────

export function replyIdOf(meta) {
  return `r${shortHash(normId(meta.messageId) || `${meta.inbox}|${meta.folder}|${meta.uid}`)}`;
}

async function saveReply(clientId, id, rec) {
  const existing = (await kv.hget(K.replies(clientId), id)) || {};
  await kv.hset(K.replies(clientId), { [id]: { ...existing, ...rec } });
}

async function patchLeadRec(clientId, email, patch) {
  const existing = await getLead(clientId, email);
  if (!existing) return null;
  return saveLead(clientId, { ...existing, ...patch }, existing.status);
}

function threadOf(meta) {
  return { subject: meta.subject, messageId: meta.messageId, references: meta.threadIds || [] };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function leadContext(lead) {
  const bits = [lead.company || lead.company_name, [lead.city, lead.state].filter(Boolean).join(', '), lead.website || hostOf(lead.email)].filter(Boolean);
  return bits.join(' — ');
}

async function sendHotLead(clientId, { lead, reply, id, kind, ctx, now = new Date() }) {
  const name = lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || reply.fromName || lead.email;
  const actionLine = kind === 'interested'
    ? 'I’ve offered two slots; if they book, the invite lands in your calendar. If they ask for you directly, reply today — response speed decides these.'
    : kind === 'question'
      ? 'Tagged: needs answer. I have not replied — please answer them today; response speed decides these.'
      : 'Tagged: unclear — your call. I have not replied.';
  const vars = {
    Company: lead.company || lead.company_name || hostOf(lead.email),
    Name: name,
    Title: lead.title || 'title not on file',
    size: lead.sizeBand || lead.size || 'size not on file',
    city: lead.city || 'city not on file',
    verbatim: String(reply.text || reply.snippet || '').trim().slice(0, 1500),
    actionLine,
    context: leadContext(lead) || lead.email,
  };
  const failBody = `A ${kind} reply for ${clientId} could not be forwarded to the client.\n\nFrom: ${name} <${lead.email}> (${vars.Company})\n“${vars.verbatim}”`;
  const to = [...new Set(clientAddresses(ctx.client, ctx.profile))];
  if (!to.length) {
    await alert('hot_lead_failed', { clientId, scope: `${clientId}:${id}`, vars: { clientId }, body: `${failBody}\n\nThe client has no contact email on file.`, did: 'Nothing was sent to the client.' });
    return { sent: false };
  }
  let first = null;
  for (const [i, addr] of to.entries()) {
    const r = await notifyClientSafe(clientId, 'hot_lead', vars, { to: addr, from: 'trial', dedupe: `hot_lead:${id}:${i}` }, { onFailAlert: 'hot_lead_failed', failBody });
    if (!first && r.sent) first = r;
  }
  const at = now.toISOString();
  await kv.hset(K.hot(clientId), {
    [id]: { replyId: id, leadEmail: lead.email, kind, sentAt: at, hotMessageId: first?.messageId || null, inbox: reply.inbox, prospectMessageId: reply.messageId || null, prospectSubject: reply.subject || null, prospectRefs: reply.threadIds || [] },
  });
  return { sent: Boolean(first), messageId: first?.messageId || null, at };
}

async function interestedReply(clientId, { lead, reply, id, pace, now = new Date() }) {
  const [s1, s2] = namedSlots(lead.tz || ET, now);
  const key = pace.softInterested ? 'reply_interested_soft' : 'reply_interested';
  const r = await sendToProspect(clientId, key, { lead, vars: { slot1: s1.label, slot2: s2.label }, thread: threadOf(reply), dedupe: `${key}:${id}` });
  if (r.sent && pace.softInterested) await patchLeadRec(clientId, lead.email, { softNudgeDueAt: new Date(now.getTime() + 2 * 864e5).toISOString() });
  return r;
}

/** Act on one classified human reply. Returns the action label. */
async function act(clientId, { kind, lead, reply, id, ctx, now }) {
  const nowIso = now.toISOString();
  const thread = threadOf(reply);
  switch (kind) {
    case 'interested': {
      const pr = await interestedReply(clientId, { lead, reply, id, pace: ctx.pace, now });
      const hot = await sendHotLead(clientId, { lead, reply, id, kind, ctx, now });
      await patchLeadRec(clientId, lead.email, { status: 'replied', positiveAt: lead.positiveAt || nowIso });
      return { action: `${pr.sent ? 'reply_interested sent' : `reply_interested not sent (${pr.error || pr.blocked || 'deduped'})`}; hot_lead ${hot.sent ? 'sent' : 'FAILED'}`, forwardedToClientAt: hot.sent ? hot.at : null };
    }
    case 'question':
    case 'unclear': {
      const hot = await sendHotLead(clientId, { lead, reply, id, kind, ctx, now });
      await patchLeadRec(clientId, lead.email, { status: 'replied', ...(kind === 'question' ? { positiveAt: lead.positiveAt || nowIso } : {}) });
      return { action: `hot_lead (${kind === 'question' ? 'needs answer' : 'unclear — your call'}) ${hot.sent ? 'sent' : 'FAILED'}`, forwardedToClientAt: hot.sent ? hot.at : null };
    }
    case 'notnow': {
      const count = Number(lead.notnowCount) || 0;
      const maxMoves = await ccfg(clientId, 'NOTNOW.maxMoves');
      if (count >= 1 + maxMoves) {
        await patchLeadRec(clientId, lead.email, { status: 'suppressed', notnowCount: count + 1, suppressReason: 'third not-now' });
        return { action: 'third not-now — suppressed' };
      }
      const parsed = parseNotNowDate(reply.text, now, { defaultDays: await ccfg(clientId, 'NOTNOW.defaultDays'), quarterDays: await ccfg(clientId, 'NOTNOW.quarterDays') });
      await patchLeadRec(clientId, lead.email, { status: 'notnow', notnowDate: parsed.date, notnowRule: parsed.rule, notnowCount: count + 1, notnowFollowups: Number(lead.notnowFollowups) || 0 });
      const pr = await sendToProspect(clientId, 'reply_notnow', { lead, vars: { month: monthName(parsed.date) }, thread, dedupe: `reply_notnow:${id}` });
      return { action: `${count ? 'not-now date moved' : 'not-now date set'} (${parsed.date}); reply_notnow ${pr.sent ? 'sent' : 'not sent'}`, notnowDate: parsed.date };
    }
    case 'no': {
      // Confirm first (the Compliance Guard refuses a suppressed recipient), then suppress.
      const pr = await sendToProspect(clientId, 'reply_no', { lead, thread, dedupe: `reply_no:${id}`, now });
      await suppress(lead.email, clientId, 'no');
      return { action: `suppressed; reply_no ${pr.sent ? 'sent' : 'not sent'}` };
    }
    case 'wrongperson': {
      const pr = await sendToProspect(clientId, 'reply_wrongperson_thanks', { lead, thread, dedupe: `reply_wrongperson_thanks:${id}` });
      const ref = await followReferral(clientId, lead, reply);
      await patchLeadRec(clientId, lead.email, { status: 'suppressed', suppressReason: 'wrong person', referredTo: ref.email || null });
      return { action: `thanks ${pr.sent ? 'sent' : 'not sent'}; referral ${ref.created ? `lead created (${ref.email})` : `not created (${ref.reason || 'duplicate'})`}` };
    }
    case 'angry': {
      await suppress(lead.email, clientId, 'angry');
      await alert('angry_reply', { clientId, scope: `${clientId}:${id}`, vars: { clientId }, body: `Angry reply from ${lead.email} (${lead.company || ''}):\n“${String(reply.text).slice(0, 800)}”`, did: 'Suppressed on every client (suppression:global). Nothing was sent back.' });
      return { action: 'suppressed; owner alerted' };
    }
    case 'legal': {
      await suppress(lead.email, clientId, 'legal');
      await kv.hset(K.client(clientId), { legalHoldAt: nowIso, legalHoldReply: id });
      await alert('legal_reply', { clientId, scope: `${clientId}:${id}`, vars: { clientId }, body: `LEGAL reply from ${lead.email} (${lead.company || ''}):\n“${String(reply.text).slice(0, 800)}”`, did: 'Suppressed everywhere and cold sending on this client is on hold until you clear it (Mission Control → client → Clear legal hold).' });
      return { action: 'suppressed; sending held (legal); owner alerted' };
    }
    default:
      return { action: 'none' };
  }
}

// ─── Message routing ─────────────────────────────────────────────────────────

async function handleBounce(clientId, meta, ctx, now) {
  const failed = extractBouncedAddress(meta.text || '', new Set(ctx.inboxEmails));
  const severity = dsnSeverity(meta.text || '', meta.subject);
  if (!failed || severity !== 'hard') return { skipped: 'dsn not hard or no address' };
  const lead = await getLead(clientId, failed);
  if (!lead) return { skipped: 'bounce for an address that is not this client’s lead' };
  const id = replyIdOf(meta);
  if (!(await claimOnce('reply', clientId, id, 60 * 86400))) return { skipped: 'already handled' };
  const at = now.toISOString();
  if (lead.status !== 'bounced') {
    await patchLeadRec(clientId, failed, { status: 'bounced', bouncedAt: at, bounceReason: bounceReason(meta.text), bounceSource: 'dsn' });
    await bump(clientId, 'bounces', 1, now);
    if (lead.account_used) await kv.hincrby(K.inboxSends(clientId, dayKeyIn(ET, now)), `${lower(lead.account_used)}:bounces`, 1);
  }
  await saveReply(clientId, id, { leadEmail: failed, inbox: meta.inbox, receivedAt: meta.date, subject: meta.subject, snippet: snippet(bounceReason(meta.text), 200), kind: 'bounce', handledAt: at, action: 'lead bounced', forwardedToClientAt: null, notnowDate: null });
  return { bounce: failed };
}

async function handleClientMessage(clientId, meta, ctx, now) {
  const at = now.toISOString();
  await kv.hset(K.trial(clientId), { lastClientActivityAt: meta.date > (ctx.trial.lastClientActivityAt || '') ? meta.date : ctx.trial.lastClientActivityAt });
  const ids = new Set((meta.threadIds || []).map(normId));
  const out = { client: true };

  // Hot-lead answered? (a reply in the hot-lead thread, or in the prospect's thread)
  const hot = (await kv.hgetall(K.hot(clientId))) || {};
  for (const [hid, h] of Object.entries(hot)) {
    if (!h || h.answeredAt) continue;
    const hit = (h.hotMessageId && ids.has(normId(h.hotMessageId))) || (h.prospectMessageId && ids.has(normId(h.prospectMessageId)));
    if (!hit) continue;
    await kv.hset(K.hot(clientId), { [hid]: { ...h, answeredAt: at } });
    if (h.holdingAt) await decrementUnanswered(clientId);
    out.answered = hid;
  }

  // Exit interview (Stage D sends it; we store the answer verbatim).
  const trial = ctx.trial;
  if (trial.exitInterviewSentAt && !trial.exitReason && meta.date >= trial.exitInterviewSentAt) {
    const onThread = trial.exitInterviewMessageId ? ids.has(normId(trial.exitInterviewMessageId)) : /^\s*re:/i.test(meta.subject);
    if (onThread) {
      const verbatim = stripQuotedReply(meta.text || '').slice(0, 2000);
      await kv.hset(K.trial(clientId), { exitReason: verbatim, exitReasonAt: at });
      const id = replyIdOf(meta);
      await saveReply(clientId, id, { leadEmail: null, inbox: meta.inbox, receivedAt: meta.date, subject: meta.subject, snippet: snippet(verbatim, 200), kind: 'exit', handledAt: at, action: 'stored in trial.exitReason', forwardedToClientAt: null, notnowDate: null });
      out.exit = true;
    }
  }

  // Quote for the first held call (quote_request thread).
  const bookings = (await kv.hgetall(K.bookings(clientId))) || {};
  for (const [bid, b] of Object.entries(bookings)) {
    if (!b || b.quote || !b.quoteRequestMessageId || !ids.has(normId(b.quoteRequestMessageId))) continue;
    await kv.hset(K.bookings(clientId), { [bid]: { ...b, quote: stripQuotedReply(meta.text || '').slice(0, 1000), quoteReceivedAt: at } });
    out.quote = bid;
  }
  return out;
}

async function decrementUnanswered(clientId) {
  const n = Number(await kv.hincrby(K.trial(clientId), 'unansweredHot', -1));
  if (n < 0) await kv.hset(K.trial(clientId), { unansweredHot: 0 });
}

async function matchLead(clientId, meta) {
  const ids = (meta.threadIds || []).map(normId).filter(Boolean);
  if (ids.length) {
    const res = (await kv.hmget(K.msgIndex(clientId), ...ids)) || {};
    for (const id of ids) {
      const email = Array.isArray(res) ? res[ids.indexOf(id)] : res[id];
      if (email) { const lead = await getLead(clientId, email); if (lead) return { lead, matchedBy: 'thread' }; }
    }
  }
  const lead = await getLead(clientId, meta.from);
  if (lead && lead.sent_at) return { lead, matchedBy: 'sender' };
  return { lead: null };
}

/** Route one scanned message. Exported for tests. */
export async function processMessage(clientId, meta, ctx, now = new Date()) {
  if (ctx.inboxEmails.includes(lower(meta.from))) return { skipped: 'own' };
  if (await isWarmup(meta.headers || {})) return { skipped: 'warm-up' };
  if (meta.kind === 'dsn') return handleBounce(clientId, meta, ctx, now);
  if (['mdn', 'bulk', 'auto_ack'].includes(meta.kind)) return { skipped: meta.kind };
  const fromHost = hostOf(meta.from);
  if (ctx.clientAddrs.includes(lower(meta.from)) || (ctx.clientHost && fromHost === ctx.clientHost)) return handleClientMessage(clientId, meta, ctx, now);

  const { lead, matchedBy } = await matchLead(clientId, meta);
  if (!lead) return { skipped: 'unmatched' };
  const id = replyIdOf(meta);
  if (!(await claimOnce('reply', clientId, id, 60 * 86400))) return { skipped: 'already handled' };
  const at = now.toISOString();
  const text = stripQuotedReply(meta.text || '') || snippet(meta.text || '', 600);

  if (meta.kind === 'ooo') {
    const until = parseOooUntil(meta.text || '', new Date(meta.date)) || new Date(now.getTime() + (await ccfg(clientId, 'OOO.defaultHoldDays')) * 864e5).toISOString();
    await patchLeadRec(clientId, lead.email, { holdUntil: until, oooAt: at });
    await saveReply(clientId, id, { leadEmail: lead.email, inbox: meta.inbox, receivedAt: meta.date, subject: meta.subject, snippet: snippet(text, 200), kind: 'ooo', handledAt: at, action: `held until ${until.slice(0, 10)}`, forwardedToClientAt: null, notnowDate: null });
    return { kind: 'ooo', until };
  }

  const { kind, rule } = classifyReply(text);
  const reply = { ...meta, text, snippet: snippet(text, 200) };
  const firstReply = !lead.replied_at;
  await patchLeadRec(clientId, lead.email, { replied_at: lead.replied_at || meta.date, last_replied_at: meta.date, reply_kind: kind, reply_count: (Number(lead.reply_count) || 0) + 1, reply_matched_by: matchedBy });
  await saveReply(clientId, id, { leadEmail: lead.email, inbox: meta.inbox, receivedAt: meta.date, subject: meta.subject, snippet: reply.snippet, text: text.slice(0, 2000), kind, rule, messageId: meta.messageId || null, handledAt: null, action: null, forwardedToClientAt: null, notnowDate: null });
  if (firstReply) {
    await bump(clientId, 'replies', 1, now);
    await recordLearning(clientId, 'replies', { lead, niche: ctx.niche, at: lead.sent_at });
    await patchRunState(clientId, { lastReplyAt: at });
  }
  if ((kind === 'interested' || kind === 'question') && !lead.positiveAt) {
    await bump(clientId, 'positive', 1, now);
    await recordLearning(clientId, 'positive', { lead, niche: ctx.niche, at: lead.sent_at });
  }
  const fresh = (await getLead(clientId, lead.email)) || lead;
  const result = await act(clientId, { kind, lead: fresh, reply, id, ctx, now });
  await saveReply(clientId, id, { handledAt: now.toISOString(), action: result.action, forwardedToClientAt: result.forwardedToClientAt || null, notnowDate: result.notnowDate || null });
  await logEvent(clientId, 'replies', 'reply', { lead: lead.email, kind, rule, action: result.action });
  return { kind, action: result.action };
}

// ─── Context + runs ──────────────────────────────────────────────────────────

async function buildContext(clientId) {
  const [client, profile, trial, pace, accounts] = await Promise.all([getClient(clientId), getProfile(clientId), getTrial(clientId), loadPace(clientId), getAccounts(clientId)]);
  const inboxEmails = accounts.map((a) => a.email);
  const clientHost = client?.mainDomain ? hostOf(client.mainDomain) : null;
  return { client: client || {}, profile, trial, pace, accounts, inboxEmails, clientAddrs: clientAddresses(client || {}, profile), clientHost, niche: nicheOf(client || {}, profile) };
}

function stateFor(saved, purpose, email) {
  const out = {};
  for (const [k, v] of Object.entries(saved || {})) {
    const [p, e, ...folder] = k.split('|');
    if (p === purpose && e === email) out[folder.join('|')] = v;
  }
  return out;
}

/**
 * Scan one inbox (round-robin) and handle what arrived. `purpose` keeps
 * separate watermarks for the reply scan and the bounce scan.
 */
export async function scanNextInbox(clientId, { purpose = 'replies', cursorField = 'replyCursor', now = new Date() } = {}) {
  const ctx = await buildContext(clientId);
  const accounts = ctx.accounts.filter((a) => a.appPassword || a.password);
  if (!accounts.length) return { skipped: 'no inbox with a password' };
  const st = await getRunState(clientId);
  const idx = (Number(st[cursorField]) || 0) % accounts.length;
  const account = accounts[idx];
  await patchRunState(clientId, { [cursorField]: idx + 1 });
  const saved = (await kv.hgetall(K.imapState(clientId))) || {};
  const max = await ccfg(clientId, 'REPLIES_C.maxMessagesPerRun');
  const firstScanDays = await ccfg(clientId, 'REPLIES_C.firstScanDays');
  const res = await deps.scanMailbox(account, { includeSpam: true, uidState: stateFor(saved, purpose, account.email), maxMessages: max, firstScanDays, wantBody: (m) => m.kind !== 'bulk', wantIcs: () => false });
  if (!res || !res.ok) {
    await recordImapResult(account.email, { ok: false, error: res?.error || 'scan failed' });
    throw new Error(`IMAP ${account.email}: ${res?.error || 'scan failed'}`);
  }
  const results = [];
  for (const meta of res.messages || []) {
    try { results.push(await processMessage(clientId, meta, ctx, now)); } catch (err) {
      results.push({ error: err.message });
      await logEvent(clientId, 'replies', 'message_error', { uid: meta.uid, error: err.message });
    }
  }
  const upd = {};
  for (const [folder, v] of Object.entries(res.uidState || {})) upd[`${purpose}|${account.email}|${folder}`] = v;
  if (Object.keys(upd).length) await kv.hset(K.imapState(clientId), upd);
  await recordImapResult(account.email, { ok: true, newMessages: (res.messages || []).length });
  return { inbox: account.email, index: idx, total: accounts.length, messages: (res.messages || []).length, results: results.map((r) => r.kind || r.skipped || (r.bounce ? 'bounce' : r.client ? 'client' : r.error ? 'error' : '?')) };
}

// ─── Hot-lead chaser ─────────────────────────────────────────────────────────

export async function runHotChaser(clientId, now = new Date()) {
  const hot = (await kv.hgetall(K.hot(clientId))) || {};
  const nudgeH = await ccfg(clientId, 'HOT.nudgeHours');
  const holdH = await ccfg(clientId, 'HOT.holdingHours');
  const out = { nudged: 0, holding: 0 };
  for (const [id, h] of Object.entries(hot)) {
    if (!h || h.answeredAt || !h.sentAt) continue;
    const age = (now.getTime() - Date.parse(h.sentAt)) / 3600e3;
    const lead = await getLead(clientId, h.leadEmail);
    if (!lead) continue;
    if (age >= nudgeH && !h.nudgedAt) {
      const verbatim = String((await kv.hget(K.replies(clientId), id))?.text || '').slice(0, 600) || '(see the earlier email)';
      const r = await notifyClientSafe(clientId, 'hot_lead_nudge', { Company: lead.company || hostOf(lead.email), Name: lead.name || lead.first_name || lead.email, hours: Math.floor(age), verbatim }, { from: 'trial', dedupe: `hot_nudge:${id}` });
      await kv.hset(K.hot(clientId), { [id]: { ...h, nudgedAt: now.toISOString(), nudgeSent: Boolean(r.sent) } });
      h.nudgedAt = now.toISOString();
      out.nudged++;
    }
    if (age >= holdH && !h.holdingAt) {
      const r = await sendToProspect(clientId, 'holding_reply', { lead, thread: { subject: h.prospectSubject || lead.original_subject, messageId: h.prospectMessageId, references: h.prospectRefs || [] }, dedupe: `holding:${id}` });
      await kv.hset(K.hot(clientId), { [id]: { ...h, holdingAt: now.toISOString(), holdingSent: Boolean(r.sent) } });
      await kv.hincrby(K.trial(clientId), 'unansweredHot', 1);
      out.holding++;
    }
  }
  // Pace Day 20: soft "worth a look?" nudge at +2 days for interested leads not booked.
  return out;
}

/** Soft-offer nudges (Pace Day 20 fix): leads with softNudgeDueAt passed and no booking. */
async function runSoftNudges(clientId, now) {
  const { getLeadsByStatus } = await import('@/lib/db/leads');
  const replied = await getLeadsByStatus(clientId, 'replied', 2000);
  let n = 0;
  for (const lead of replied) {
    if (!lead.softNudgeDueAt || lead.softNudgedAt || lead.bookedAt || Date.parse(lead.softNudgeDueAt) > now.getTime()) continue;
    const r = await sendToProspect(clientId, 'interested_nudge', { lead, dedupe: `interested_nudge:${lead.email}` });
    await patchLeadRec(clientId, lead.email, { softNudgedAt: now.toISOString(), softNudgeSent: Boolean(r.sent) });
    n++;
  }
  return n;
}

/** The `replies` job for one client: one inbox scan + the chaser. */
export async function runReplies(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const scan = await scanNextInbox(clientId, { purpose: 'replies', cursorField: 'replyCursor', now });
  const chaser = await runHotChaser(clientId, now);
  const soft = await runSoftNudges(clientId, now);
  return { scan, chaser, softNudges: soft };
}

/**
 * The `bounces` job: a full pass over every inbox (one per run) looking for
 * DSNs, requested after a send error, by the smoke test, and daily at 13:00
 * UTC. When the pass completes, bounceScanDoneAt is stamped and the smoke
 * test re-evaluated.
 */
export async function runBounceScan(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const client = (await getClient(clientId)) || {};
  const round = Number(client.bounceRoundLeft);
  const accounts = (await getAccounts(clientId)).filter((a) => a.appPassword || a.password);
  if (!accounts.length) {
    await kv.hset(K.client(clientId), { bounceScanWantedAt: '', bounceRoundLeft: '', bounceDailyDay: partsIn('UTC', now).dayKey });
    return { skipped: 'no inbox' };
  }
  const left = Number.isFinite(round) && round > 0 ? round : accounts.length;
  const scan = await scanNextInbox(clientId, { purpose: 'replies', cursorField: 'bounceCursor', now });
  if (left - 1 <= 0) {
    await kv.hset(K.client(clientId), { bounceRoundLeft: '', bounceScanWantedAt: '', bounceDailyDay: partsIn('UTC', now).dayKey });
    await patchRunState(clientId, { bounceScanDoneAt: now.toISOString() });
    const smoke = await evaluateSmoke(clientId, now);
    return { scan, done: true, smoke };
  }
  await kv.hset(K.client(clientId), { bounceRoundLeft: left - 1 });
  return { scan, done: false, left: left - 1 };
}

/** Not-Now follow-ups due today (daily 09:00 job). */
export async function runNotNow(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const { getLeadsByStatus } = await import('@/lib/db/leads');
  const today = dayKeyIn(ET, now);
  const leads = await getLeadsByStatus(clientId, 'notnow', 2000);
  let sent = 0;
  for (const lead of leads) {
    if (!lead.notnowDate || lead.notnowDate > today || lead.notnowFollowedUpFor === lead.notnowDate) continue;
    const r = await sendToProspect(clientId, 'notnow_followup', { lead, thread: { subject: lead.original_subject, messageId: lead.original_message_id, references: [lead.original_message_id].filter(Boolean) }, dedupe: `notnow_followup:${lead.email}:${lead.notnowDate}` });
    if (r.sent || r.deduped) {
      await patchLeadRec(clientId, lead.email, { notnowFollowups: (Number(lead.notnowFollowups) || 0) + (r.sent ? 1 : 0), notnowFollowedUpFor: lead.notnowDate, notnowFollowedUpAt: now.toISOString() });
      if (r.sent) sent++;
    }
  }
  return { due: leads.filter((l) => l.notnowDate && l.notnowDate <= today).length, sent };
}

