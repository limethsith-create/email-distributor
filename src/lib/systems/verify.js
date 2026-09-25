/**
 * Email verification waterfall (Leads v2). Every lead the Lead Finder posts
 * arrives `verifyStatus: pending` and is not sendable until this has checked
 * it. For one address:
 *
 *   1 syntax → 2 throwaway domain → 3 MX (cached per domain)
 *   4 domain already known catch-all (verify:domains, 30 days) → catch-all, no credit spent
 *   5 the free-tier APIs in VERIFY.order (daily allowances first — they do
 *     not roll over — then monthly, then one-time packs), each with its own
 *     budget counted in usage:verify:{day} / usage:verify:{month} (global,
 *     one vendor account for all clients), skipping any whose key is not set
 *     or whose budget is spent; a definite answer stops the waterfall, an
 *     "unknown" moves on to the next service
 *   6 a catch-all verdict may go to the catch-all resolver (Anymailfinder's
 *     one-time credits) for a real answer
 *
 * Result: valid | risky | catchall | invalid | unknown (+ verifiedBy, verifiedAt),
 * or `pending` when every configured service is out of budget for today.
 * With no key at all only the MX level runs and the answer is `risky`
 * (verifiedBy 'mx'): not sendable, and re-queued when a key appears.
 *
 * The `lead-verify` job (joblist/stage-c.js) works through the client's queue
 * client:{id}:verifyq best-score first, a few leads per run, re-keys a guessed
 * address to the next candidate when it proves invalid, regrades the lead and
 * refreshes the lead-quality rollup.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getLead, saveLead, isBlocked } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { deps, alert } from '@/lib/systems/stagec-common';
import { gradeContext, gradePatch, worthVerifying, maybeRollup } from '@/lib/systems/grader';
import { ET, dayKeyIn, partsIn } from '@/lib/time';
import { syntaxOk, isDisposable } from '@/lib/leadquality/rules.mjs';
import * as quickemail from '@/lib/ext/quickemail';
import * as verifalia from '@/lib/ext/verifalia';
import * as reoon from '@/lib/ext/reoon';
import * as mailboxvalidator from '@/lib/ext/mailboxvalidator';
import * as zerobounce from '@/lib/ext/zerobounce';
import * as hunter from '@/lib/ext/hunter';
import * as tomba from '@/lib/ext/tomba';
import * as proofy from '@/lib/ext/proofy';
import * as anymailfinder from '@/lib/ext/anymailfinder';

export const ADAPTERS = { quickemail, verifalia, reoon, mailboxvalidator, zerobounce, hunter, tomba, proofy, anymailfinder };
export const STATUSES = ['valid', 'risky', 'catchall', 'invalid', 'unknown', 'pending'];
const VERIFY_STATES = new Set(['warming', 'ready', 'sending', 'paused', 'extension', 'converted']);

const monthOf = (now) => partsIn('UTC', now).monthKey;
const dayOf = (now) => dayKeyIn(ET, now);
const riskOf = (status) => (status === 'valid' ? 'safe' : status === 'catchall' ? 'catchall' : 'risky');

// ── budgets ──────────────────────────────────────────────────────────────────

async function serviceCfg(name) {
  const services = (await cfg(null, 'VERIFY.services')) || {};
  return services[name] || {};
}

/** Services in waterfall order that have a key set (and a config entry). */
export async function configuredServices() {
  const order = (await cfg(null, 'VERIFY.order')) || [];
  const services = (await cfg(null, 'VERIFY.services')) || {};
  return order.filter((n) => ADAPTERS[n] && services[n] && services[n].enabled !== false && ADAPTERS[n].configured());
}

/**
 * Take one credit of `name` for today/this month, or false when its budget
 * is spent. Counts first (hincrby), gives the credit back when over.
 */
export async function reserve(name, now = new Date()) {
  const sc = await serviceCfg(name);
  const dKey = K.usage('verify', dayOf(now));
  const mKey = K.usage('verify', monthOf(now));
  const tKey = K.usage('verify', 'total');
  if (await kv.hget(dKey, `${name}:out`)) return false; // the service said "out of credits" today
  const checks = [[sc.daily, dKey, 3 * 86400], [sc.monthly, mKey, 40 * 86400], [sc.total, tKey, null]];
  const taken = [];
  for (const [limit, key, ttl] of checks) {
    const n = await kv.hincrby(key, name, 1);
    if (ttl && n === 1) await kv.expire(key, ttl);
    taken.push(key);
    if (limit !== null && limit !== undefined && Number.isFinite(Number(limit)) && n > Number(limit)) {
      for (const k of taken) await kv.hincrby(k, name, -1);
      return false;
    }
  }
  return true;
}

async function giveBack(name, now) {
  for (const key of [K.usage('verify', dayOf(now)), K.usage('verify', monthOf(now)), K.usage('verify', 'total')]) await kv.hincrby(key, name, -1);
}

/** A service said it is out of credits: mark today's (or the month's) budget as spent. */
async function markExhausted(name, now) {
  const sc = await serviceCfg(name);
  if (sc.daily) await kv.hset(K.usage('verify', dayOf(now)), { [name]: Number(sc.daily) });
  else if (sc.monthly) await kv.hset(K.usage('verify', monthOf(now)), { [name]: Number(sc.monthly) });
  await kv.hset(K.usage('verify', dayOf(now)), { [`${name}:out`]: '1' });
}

/** Checks left today across configured services: { total, by: {service: n|null} } (null = no fixed limit). */
export async function budgetLeftToday({ now = new Date() } = {}) {
  const names = await configuredServices();
  const [day, month, total] = await Promise.all([K.usage('verify', dayOf(now)), K.usage('verify', monthOf(now)), K.usage('verify', 'total')].map((k) => kv.hgetall(k).then((h) => h || {})));
  const services = (await cfg(null, 'VERIFY.services')) || {};
  const by = {};
  let sum = 0;
  for (const n of names) {
    const sc = services[n] || {};
    if (day[`${n}:out`]) { by[n] = 0; continue; }
    const left = [
      sc.daily != null ? Number(sc.daily) - (Number(day[n]) || 0) : null,
      sc.monthly != null ? Number(sc.monthly) - (Number(month[n]) || 0) : null,
      sc.total != null ? Number(sc.total) - (Number(total[n]) || 0) : null,
    ].filter((x) => x !== null);
    by[n] = left.length ? Math.max(0, Math.min(...left)) : null;
    if (by[n] !== null) sum += by[n];
  }
  return { total: sum, by };
}

async function noteServiceError(name, error, now) {
  const key = K.usage('verify', dayOf(now));
  const streak = await kv.hincrby(key, `${name}:errstreak`, 1);
  const limit = await cfg(null, 'VERIFY.failAlertStreak');
  if (streak === Number(limit)) {
    await alert('verify_failing', { scope: `verify:${name}`, vars: { service: name }, body: `The ${name} email verifier failed ${streak} times in a row today (last error: ${error}).`, did: 'The waterfall skips it and uses the next verifier; nothing is sent to an unverified address.' });
  }
}

// ── one address ──────────────────────────────────────────────────────────────

async function domainFact(host) {
  const raw = await kv.hget(K.verifyDomains(), host);
  if (!raw) return null;
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return v;
}

async function rememberCatchall(host, by, now) {
  await kv.hset(K.verifyDomains(), { [host]: JSON.stringify({ catchall: true, by, at: now.toISOString() }) });
}

/**
 * Verify one address through the waterfall. Never throws.
 * → { status, by, detail, at, spent: [services called] }
 */
export async function verifyAddress(email, { now = new Date(), services = null } = {}) {
  const at = now.toISOString();
  const e = String(email || '').trim().toLowerCase();
  const host = e.split('@')[1] || '';
  if (!syntaxOk(e)) return { status: 'invalid', by: 'syntax', detail: 'syntax', at, spent: [] };
  if (isDisposable(e)) return { status: 'invalid', by: 'disposable', detail: 'disposable', at, spent: [] };
  let mx;
  try { mx = await deps.verifyEmail(e); } catch { mx = { valid: true, reason: 'dns_timeout' }; }
  if (mx && mx.valid === false) return { status: 'invalid', by: 'mx', detail: mx.reason === 'invalid_format' ? 'syntax' : 'no_mx', at, spent: [] };
  const mxTimeout = mx?.reason === 'dns_timeout';

  const cacheDays = await cfg(null, 'VERIFY.catchallCacheDays');
  const fact = await domainFact(host).catch(() => null);
  const knownCatchall = fact?.catchall && Date.parse(fact.at) > now.getTime() - cacheDays * 86400e3;

  const names = services || await configuredServices();
  if (!names.length) {
    return mxTimeout ? { status: 'unknown', by: 'mx', detail: 'dns timeout', at, spent: [] } : { status: 'risky', by: 'mx', detail: 'no verifier key set — mail server only', at, spent: [] };
  }
  const timeoutMs = await cfg(null, 'VERIFY.timeoutMs');
  const spent = [];
  let last = null;
  let outOfBudget = 0;
  let verdict = knownCatchall ? { status: 'catchall', by: `cache:${fact.by}`, detail: 'domain accepts every address' } : null;
  if (!verdict) {
    for (const name of names) {
      if (name === 'mailboxvalidator' && mailboxvalidator.unsupported(e)) continue;
      if (!(await reserve(name, now))) { outOfBudget++; continue; }
      const r = await ADAPTERS[name].verify(e, { timeoutMs });
      spent.push(name);
      if (r.error === 'skip' || r.error === 'nokey') { await giveBack(name, now); continue; }
      if (r.error === 'quota') { await giveBack(name, now); await markExhausted(name, now); outOfBudget++; continue; }
      if (r.error === 'auth' || r.error === 'http' || r.error === 'timeout') {
        await noteServiceError(name, `${r.error}: ${r.raw}`, now);
        last = { status: 'unknown', by: name, detail: `${r.error}: ${String(r.raw).slice(0, 80)}` };
        continue;
      }
      await kv.hset(K.usage('verify', dayOf(now)), { [`${name}:errstreak`]: 0 });
      if (r.status === 'unknown') { last = { status: 'unknown', by: name, detail: String(r.raw).slice(0, 80) }; continue; }
      verdict = { status: r.status, by: name, detail: String(r.raw || '').slice(0, 80) };
      if (r.status === 'catchall') await rememberCatchall(host, name, now);
      break;
    }
  }
  // A catch-all verdict: ask the resolver for a real answer when it has credits.
  if (verdict?.status === 'catchall') {
    const resolver = await cfg(null, 'VERIFY.catchallResolver');
    if (resolver && ADAPTERS[resolver]?.configured() && (await reserve(resolver, now))) {
      const r = await ADAPTERS[resolver].verify(e, { timeoutMs });
      spent.push(resolver);
      if (r.error === 'quota') { await giveBack(resolver, now); await markExhausted(resolver, now); }
      else if (!r.error && (r.status === 'valid' || r.status === 'invalid')) verdict = { status: r.status, by: resolver, detail: `catch-all domain resolved: ${r.raw}` };
    }
  }
  if (verdict) return { ...verdict, at, spent };
  if (last) return { ...last, at, spent };
  if (outOfBudget) return { status: 'pending', by: null, detail: 'free verification credits used up for today', at, spent };
  return { status: 'unknown', by: null, detail: 'no verifier answered', at, spent };
}

// ── leads ────────────────────────────────────────────────────────────────────

/** Add leads to the client's verification queue (only those worth a credit). Returns how many were queued. */
export async function queueLeads(clientId, leads, ctx) {
  let n = 0;
  for (const l of leads) {
    if (!l || !l.email) continue;
    if (!['pending', undefined, null, ''].includes(l.verifyStatus) && !(l.verifyStatus === 'risky' && l.verifiedBy === 'mx')) continue;
    if (ctx && !worthVerifying(l, ctx)) continue;
    await kv.zadd(K.verifyQueue(clientId), { score: -(Number(l.score) || 0), member: l.email });
    n++;
  }
  if (n) await kv.hset(K.client(clientId), { verifyPending: '1', verifyNextDueAt: '' });
  return n;
}

async function rekeyLead(clientId, lead, next) {
  const p = kv.pipeline();
  p.hdel(K.leads(clientId), lead.email);
  p.srem(K.leadIndex(clientId, lead.status || 'unsent'), lead.email);
  await p.exec();
  const { emailCandidates = [], ...rest } = lead;
  return saveLead(clientId, { ...rest, email: next, emailCandidates: emailCandidates.filter((x) => x !== next), status: lead.status || 'unsent' });
}

/**
 * Apply a verification result to a stored lead: status fields, re-key to the
 * next guessed candidate on `invalid`, regrade. Returns the saved lead.
 */
export async function applyResult(clientId, lead, r, ctx) {
  let cur = lead;
  const log = [...(Array.isArray(lead.verifyLog) ? lead.verifyLog : []), { email: lead.email, status: r.status, by: r.by, at: r.at }].slice(-6);
  if (r.status === 'invalid' && lead.status === 'unsent') {
    const cands = (lead.emailCandidates || []).filter((x) => x && x !== lead.email);
    for (const next of cands) {
      const exists = await getLead(clientId, next);
      if (exists || (await isBlocked(clientId, next))) continue;
      cur = await rekeyLead(clientId, { ...lead, verifyLog: log }, next);
      cur = { ...cur, verifyStatus: 'pending', verifiedBy: null, verifyDetail: `previous guess ${lead.email} invalid`, verifyLog: log };
      const g = gradePatch(cur, ctx);
      const saved = await saveLead(clientId, { ...cur, ...g }, cur.status);
      await kv.zadd(K.verifyQueue(clientId), { score: -(Number(g.score) || 0), member: next });
      return { lead: saved, requeued: true };
    }
  }
  const attempts = (Number(lead.verifyAttempts) || 0) + 1;
  const next = {
    ...cur,
    verifyStatus: r.status,
    verifiedBy: r.by,
    verifiedAt: r.at,
    verifyDetail: r.detail || '',
    verifyAttempts: attempts,
    verifyLog: log,
    riskLevel: riskOf(r.status),
  };
  const g = gradePatch(next, ctx);
  const status = cur.status === 'unsent' && g.grade === 'rejected' ? 'rejected' : cur.status;
  const saved = await saveLead(clientId, { ...next, ...g, status }, cur.status);
  return { lead: saved, requeued: false };
}

function nextDayAt(now) {
  // 00:05 ET tomorrow (daily budgets renew with the ET day; Verifalia's at 00:00 GMT is earlier).
  const p = partsIn(ET, now);
  const minsLeft = 24 * 60 - p.minuteOfDay + 5;
  return new Date(now.getTime() + minsLeft * 60_000).toISOString();
}

/**
 * One run of the lead-verify job for a client: up to VERIFY.perRun leads from
 * the queue, best first, until the tick deadline.
 */
export async function runVerify(clientId, { now = new Date(), deadline = Date.now() + 15_000, client = null } = {}) {
  const everyMin = await cfg(clientId, 'VERIFY.everyMin');
  const soon = () => new Date(now.getTime() + everyMin * 60_000).toISOString();
  if (client && !VERIFY_STATES.has(client.state)) return { skipped: `state ${client.state}`, _clientFields: { verifyPending: '0' } };
  const perRun = await cfg(clientId, 'VERIFY.perRun');
  const batch = (await kv.zrange(K.verifyQueue(clientId), 0, perRun + 5)) || [];
  if (!batch.length) return { done: true, _clientFields: { verifyPending: '0', verifyNextDueAt: '' } };
  const names = await configuredServices();
  const ctx = await gradeContext(clientId, { now });
  const out = { checked: 0, byStatus: {}, rekeyed: 0 };
  let budgetOut = false;
  // Queued deliberately: never checked, "unknown" retries, MX-only once a key exists.
  const needs = (l) => !l.verifyStatus || l.verifyStatus === 'pending' || l.verifyStatus === 'unknown' || (l.verifyStatus === 'risky' && l.verifiedBy === 'mx' && names.length > 0);
  for (const email of batch) {
    if (out.checked >= perRun || Date.now() > deadline - 4000) break;
    const lead = await getLead(clientId, email);
    if (!lead || lead.status !== 'unsent' || !needs(lead)) {
      await kv.zrem(K.verifyQueue(clientId), email);
      continue;
    }
    const r = await verifyAddress(email, { now, services: names });
    if (r.status === 'pending') { budgetOut = true; break; }
    await kv.zrem(K.verifyQueue(clientId), email);
    const res = await applyResult(clientId, lead, r, ctx);
    out.checked++;
    out.byStatus[r.status] = (out.byStatus[r.status] || 0) + 1;
    if (res.requeued) out.rekeyed++;
  }
  const left = await kv.zrange(K.verifyQueue(clientId), 0, 0);
  if (out.checked) {
    await logEvent(clientId, 'verify', 'checked', { ...out, services: names });
    await maybeRollup(clientId, { now, ctx });
  }
  if (!names.length && out.checked) {
    await alert('verify_no_keys', { clientId, scope: `${clientId}:verify-keys`, vars: { clientId }, body: `No email verifier API key is set, so ${clientId}'s leads can only be MX-checked and none of them is sendable. Add at least one free key in the Vercel environment: QUICKEMAILVERIFICATION_API_KEY (100/day), VERIFALIA_USERNAME + VERIFALIA_PASSWORD (25/day), REOON_API_KEY (20/day), MAILBOXVALIDATOR_API_KEY (300/month), ZEROBOUNCE_API_KEY (100/month), HUNTER_API_KEY (100 checks/month).`, did: 'The leads are marked risky (MX only) and will be re-checked automatically the day a key appears.' });
  }
  if (budgetOut) {
    const pending = (await kv.zrange(K.verifyQueue(clientId), 0, -1)).length;
    await alert('verify_budget_out', { scope: `verify-budget`, vars: { pending: String(pending) }, body: `Every configured verifier has used today's free credits. ${pending} leads for ${clientId} wait for tomorrow's allowance.`, did: 'Nothing unverified is sent; the queue continues at 00:05 ET. A one-time pack (Reoon $11.90 / 10,000, Proofy $5 / 5,000) would clear it faster.' });
    return { ...out, budgetOut: true, _clientFields: { verifyPending: '1', verifyNextDueAt: nextDayAt(now) } };
  }
  return { ...out, _clientFields: { verifyPending: left.length ? '1' : '0', verifyNextDueAt: left.length ? soon() : '' } };
}

/**
 * Daily housekeeping (lead-verify-daily): re-queue MX-only leads once a key
 * exists, "unknown" answers older than VERIFY.unknownRetryHours (max
 * VERIFY.maxAttempts), and any pending lead that fell out of the queue;
 * regrade everything when the week-one rule changes; rebuild the rollup.
 */
export async function runVerifyDaily(clientId, { now = new Date() } = {}) {
  const { getLeadsByStatus } = await import('@/lib/db/leads');
  const leads = await getLeadsByStatus(clientId, 'unsent', 5000);
  const ctx = await gradeContext(clientId, { now });
  const names = await configuredServices();
  const retryH = await cfg(clientId, 'VERIFY.unknownRetryHours');
  const maxAttempts = await cfg(clientId, 'VERIFY.maxAttempts');
  const again = [];
  let regraded = 0;
  for (const l of leads) {
    const v = l.verifyStatus;
    if (v === 'pending' || (v === 'risky' && l.verifiedBy === 'mx' && names.length)) again.push(l);
    // A v1-style record with a guessed address (e.g. a Wrong-Person referral): verify it once a key exists.
    else if (!v && String(l.riskLevel || '').toLowerCase() === 'risky' && names.length) again.push({ ...l, verifyStatus: 'pending' });
    else if (v === 'unknown' && (Number(l.verifyAttempts) || 0) < maxAttempts && Date.parse(l.verifiedAt || 0) < now.getTime() - retryH * 3600e3) again.push({ ...l, verifyStatus: 'pending' });
    if (l.grade) {
      const g = gradePatch(l, ctx);
      if (g.grade !== l.grade || g.score !== l.score) {
        await saveLead(clientId, { ...l, ...g, status: g.grade === 'rejected' ? 'rejected' : l.status }, l.status);
        regraded++;
      }
    }
  }
  // Catch-all leads rejected in week one come back once SEND.allowRiskyAfterDay allows them.
  const { riskyAllowed } = await import('@/lib/systems/grader');
  if (riskyAllowed(ctx)) {
    for (const l of await getLeadsByStatus(clientId, 'rejected', 5000)) {
      if (l.rejectReason !== 'catchall') continue;
      const g = gradePatch(l, ctx);
      if (g.grade !== 'rejected') { await saveLead(clientId, { ...l, ...g, status: 'unsent' }, 'rejected'); regraded++; }
    }
  }
  const queued = await queueLeads(clientId, again.map((l) => ({ ...l, verifyStatus: l.verifyStatus === 'risky' ? 'pending' : l.verifyStatus })), ctx);
  await maybeRollup(clientId, { now, ctx, force: true });
  return { queued, regraded };
}
