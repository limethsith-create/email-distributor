/**
 * Trial Gatekeeper (SPEC §6.1). Decides within one business day whether an
 * applicant gets a trial, a queue place, or a no with a reason; enforces one
 * trial per company, ever, and the MAX_ACTIVE_TRIALS cap (plus "no new
 * trials while an extension runs"). Also runs the daily onboarding nudge
 * (Day +2/+4 reminders, Day +7 closed_silent) and pops the queue.
 *
 * Order inside a decision is always: email first, state second — so any
 * failure leaves the client in `applied`/`queued` and raises
 * gatekeeper_error with the applicant's email for a same-day manual answer.
 */

import { kv } from '@vercel/kv';
import { K, slugify } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { createClient, getClient, getAllClients, setState, updateClient, getTrial, ACTIVE_TRIAL_STATES } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { addPromise } from '@/lib/db/promises';
import { mintToken, pageUrl, rememberLink, TTL } from '@/lib/pagetokens';
import { dayKeyIn, daysBetween, addDays, ET } from '@/lib/time';
import { io, truthy, asArray, firstNameOf, ownerName, sendClient, formatDay, nextUsBusinessDay, isPublicUrl } from '@/lib/systems/intake-io';
import { sendAcceptance, readCall, onboardPageClock } from '@/lib/systems/onboardcall';
import { ackAlerts } from '@/lib/notify';

const SYSTEM = 'gatekeeper';
/** Earlier records in these states do not block a new application (no trial was ever run). */
const NON_BLOCKING = new Set(['declined', 'closed_silent']);
/** Ids that are never real trial clients. */
const NOT_TRIALS = new Set(['aviance', '_test']);

// ── normalising the application ─────────────────────────────────────────────

/** 'https://www.Acme.com/about' | 'bob@acme.com' → 'acme.com', else null. */
export function normaliseDomain(website) {
  let s = String(website || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].split(':')[0].replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(s) ? s : null;
}

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const yesNo = (v) => (v === undefined || v === null || v === '' ? null : truthy(v));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Raw form/JSON body → application object (SPEC §6.1 inputs, trial doc §2). */
export function normaliseApplication(raw = {}) {
  let dream = raw.dreamCustomers;
  if (!Array.isArray(dream)) dream = [raw.dreamCustomer1, raw.dreamCustomer2, raw.dreamCustomer3].some(Boolean) ? [raw.dreamCustomer1, raw.dreamCustomer2, raw.dreamCustomer3] : asArray(dream);
  return {
    companyName: String(raw.companyName || '').trim().slice(0, 120),
    contactName: String(raw.contactName || '').trim().slice(0, 120),
    contactEmail: String(raw.contactEmail || '').trim().toLowerCase().slice(0, 200),
    website: String(raw.website || '').trim().slice(0, 300),
    mainDomain: normaliseDomain(raw.website),
    usBased: yesNo(raw.usBased),
    employees: num(raw.employees),
    dealValue: num(raw.dealValue),
    soldToStrangers: yesNo(raw.soldToStrangers),
    dreamCustomers: dream.map((d) => String(d || '').trim().slice(0, 200)).filter(Boolean).slice(0, 3),
    meetWithin5Days: yesNo(raw.meetWithin5Days),
    slotsPerWeek: num(raw.slotsPerWeek),
    nobodyElseEmailing: yesNo(raw.nobodyElseEmailing),
    reviewAgreed: yesNo(raw.reviewAgreed),
    notes: String(raw.notes || '').trim().slice(0, 2000),
  };
}

/** Field errors that make an application unusable (not fit failures). */
export function validateApplication(app) {
  const errors = {};
  if (!app.companyName) errors.companyName = 'Company name is required.';
  if (!app.contactName) errors.contactName = 'Your name is required.';
  if (!EMAIL_RE.test(app.contactEmail)) errors.contactEmail = 'A valid email address is required.';
  if (!app.mainDomain) errors.website = 'A valid company website is required.';
  return errors;
}

// ── fit rules (SPEC §6.1 step 2, trial doc §2) ──────────────────────────────

/** Each rule: id, test(app, fit) → bool, reason(app, fit) → one plain sentence for decline_fit. */
export const FIT_RULES = [
  { id: 'us_based', test: (a) => a.usBased === true, reason: () => 'the trial is only for US-based companies right now.' },
  {
    id: 'employees',
    test: (a, f) => a.employees !== null && a.employees >= f.employeesMin && a.employees <= f.employeesMax,
    reason: (a, f) => (a.employees === null ? `the trial is built for companies with ${f.employeesMin} to ${f.employeesMax} people, and I didn't get a headcount from you.` : `the trial is built for companies with ${f.employeesMin} to ${f.employeesMax} people, and you told me you have ${a.employees}.`),
  },
  {
    id: 'deal_value',
    test: (a, f) => a.dealValue !== null && a.dealValue >= f.dealValueMin,
    reason: (a, f) => `a new customer needs to be worth at least $${f.dealValueMin.toLocaleString('en-US')} in year one for the plans behind the trial to make sense for you.`,
  },
  { id: 'sold_to_strangers', test: (a) => a.soldToStrangers === true, reason: () => "if nobody outside your network has bought yet, cold email is not the test you need first." },
  { id: 'dream_customers', test: (a) => a.dreamCustomers.length >= 3, reason: () => "I need three companies you'd call perfect customers — a buyer we can't describe is a buyer we can't find." },
  { id: 'meet_within_5_days', test: (a) => a.meetWithin5Days === true, reason: () => 'the trial needs you to take a booked meeting within five business days; slow calendars lose the replies we win.' },
  {
    id: 'slots_per_week',
    test: (a, f) => a.slotsPerWeek !== null && a.slotsPerWeek >= f.slotsPerWeekMin,
    reason: (a, f) => `the trial needs at least ${f.slotsPerWeekMin} open calendar slots a week.`,
  },
  { id: 'nobody_else_emailing', test: (a) => a.nobodyElseEmailing === true, reason: () => 'someone else is already cold-emailing on your behalf, and two senders on one list spoil both.' },
  { id: 'review_agreed', test: (a) => a.reviewAgreed === true, reason: () => 'the honest review at the end is the one price of the trial, and without it I can\'t run one.' },
  {
    id: 'not_agency',
    test: (a, f, ctx) => !ctx.agencyHit,
    reason: () => "the trial isn't open to lead-generation, outbound or SDR agencies.",
  },
];

/** First matching agency keyword in `text`, else null. */
export function detectAgency(text, keywords) {
  const t = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  for (const k of keywords) {
    const re = new RegExp(`(^|[^a-z])${String(k).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
    if (re.test(t)) return k;
  }
  return null;
}

/** { ok, rule, reason } — the first failing rule, in table order. */
export function evaluateFit(app, fit, ctx = {}) {
  for (const rule of FIT_RULES) {
    if (!rule.test(app, fit, ctx)) return { ok: false, rule: rule.id, reason: rule.reason(app, fit, ctx) };
  }
  return { ok: true };
}

/** Website <title> + meta description, for the agency keyword check. Never throws. */
export async function fetchSiteText(domain) {
  if (!isPublicUrl(`https://${domain}`)) return '';
  try {
    const res = await io.fetchExt(`https://${domain}`, { timeoutMs: 6000, retry: false, redirect: 'follow', publicOnly: true, headers: { 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' } });
    const html = (await res.text()).slice(0, 200_000);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '';
    return `${title} ${desc}`.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// ── lookups ─────────────────────────────────────────────────────────────────

/** An earlier client with this mainDomain that blocks a new trial, else null. */
export async function findRepeat(mainDomain, { excludeId = null } = {}) {
  const clients = await getAllClients();
  const matches = clients.filter((c) => c.id !== excludeId && !NOT_TRIALS.has(c.id) && String(c.mainDomain || '').toLowerCase() === mainDomain);
  const indexed = await kv.hget(K.mainDomainIndex(), mainDomain).catch(() => null);
  if (indexed && indexed !== excludeId && !matches.some((c) => c.id === indexed)) {
    const c = await getClient(indexed).catch(() => null);
    if (c) matches.push(c);
  }
  return matches.find((c) => !NON_BLOCKING.has(c.state)) || null;
}

/** Active trial count, whether any extension runs, and their day-30 dates. */
export async function capacity({ excludeId = null } = {}) {
  const clients = (await getAllClients()).filter((c) => c.id !== excludeId && !NOT_TRIALS.has(c.id) && (c.plan || 'trial') === 'trial');
  const active = clients.filter((c) => ACTIVE_TRIAL_STATES.has(c.state));
  const day30 = [];
  for (const c of active) {
    const t = await getTrial(c.id);
    if (t.day30Date) day30.push(t.day30Date);
  }
  return {
    active: active.length,
    activeIds: active.map((c) => c.id),
    inExtension: clients.some((c) => c.state === 'extension'),
    day30Dates: day30.sort(),
    max: await cfg(null, 'MAX_ACTIVE_TRIALS'),
  };
}

/** Expected date for queue position n: n-th earliest active day30Date + QUEUE.expectedExtraDays. */
export async function expectedDate(position, cap) {
  const extra = await cfg(null, 'QUEUE.expectedExtraDays');
  const d = cap.day30Dates[position - 1];
  return d ? addDays(d, extra) : null;
}

async function allocateId(mainDomain, companyName) {
  let base = slugify(mainDomain) || slugify(companyName) || 'client';
  if (NOT_TRIALS.has(base) || base === 'new' || !/^[a-z0-9]/.test(base)) base = `c-${base}`.slice(0, 36).replace(/-+$/, '');
  base = base.slice(0, 36).replace(/-+$/, '');
  return [base, ...Array.from({ length: 30 }, (_, i) => `${base}-${i + 2}`)];
}

async function answeredPromise(clientId, now) {
  const due = nextUsBusinessDay(addDays(dayKeyIn(ET, now), 1));
  await addPromise(clientId, 'Answer the trial application within 1 business day', `${due}T23:59:00Z`, { done: true }).catch(() => {});
}

// ── outcomes ────────────────────────────────────────────────────────────────

async function decline(clientId, reasonCode, template, vars, now) {
  const client = await getClient(clientId);
  await sendClient(clientId, template, { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId), ...vars }, { dedupe: template });
  await setState(clientId, 'declined', reasonCode);
  await updateClient(clientId, { declineReason: reasonCode, intakeStep: '' });
  await answeredPromise(clientId, now);
  await logEvent(clientId, SYSTEM, 'declined', { reason: reasonCode });
  return { outcome: 'declined', reason: reasonCode };
}

async function enqueue(clientId, cap, now) {
  const client = await getClient(clientId);
  const list = (await kv.lrange(K.queueTrial(), 0, -1)) || [];
  if (!list.includes(clientId)) await kv.rpush(K.queueTrial(), clientId);
  const position = ((await kv.lrange(K.queueTrial(), 0, -1)) || []).indexOf(clientId) + 1;
  const date = await expectedDate(position, cap);
  const expectedLine = date
    ? `The earliest your slot is likely to open is ${formatDay(date)}; I'll email you the day it does.`
    : "I don't have a firm date yet; I'll email you the day a slot opens.";
  try {
    await sendClient(clientId, 'queued_position', { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId), position, expectedLine }, { dedupe: 'queued_position' });
  } catch (err) {
    await kv.lrem(K.queueTrial(), 0, clientId);
    throw err;
  }
  await setState(clientId, 'queued', cap.inExtension ? 'extension running' : 'trials full');
  await updateClient(clientId, { queuedAt: now.toISOString(), queueExpectedDate: date || '' });
  await answeredPromise(clientId, now);
  await logEvent(clientId, SYSTEM, 'queued', { position, expectedDate: date, reason: cap.inExtension ? 'extension' : 'cap' });
  return { outcome: 'queued', position, expectedDate: date };
}

/**
 * Open the trial: mint the onboarding token (14 days), send ONE email —
 * `accepted_call`, "you're in, book your onboarding call", with the
 * one-page onboarding link inside (systems/onboardcall.js, docs/ONBOARD-CALL.md)
 * — and move to `onboarding`. Used for Approve, fit-passes, the owner's New
 * client and queue promotions.
 */
export async function startOnboarding(clientId, { now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  if (!['applied', 'queued'].includes(client.state)) throw new Error(`cannot start onboarding from ${client.state}`);
  const token = await mintToken(clientId, 'onboarding', { ttl: TTL.long });
  await sendAcceptance(clientId, { onboardingLink: pageUrl(token, 'onboard'), now });
  await setState(clientId, 'onboarding', client.state === 'queued' ? 'slot opened' : 'fit passed');
  await kv.hset(K.trial(clientId), { onboardingSentAt: now.toISOString() });
  await updateClient(clientId, { intakeStep: '' });
  await answeredPromise(clientId, now);
  await logEvent(clientId, SYSTEM, 'onboarding_sent', {});
  return { outcome: 'onboarding' };
}

async function gatekeeperError(clientId, email, err, stage) {
  await logEvent(clientId || null, SYSTEM, 'error', { stage, error: String(err?.message || err).slice(0, 300) });
  await io.alertOwner('gatekeeper_error', {
    clientId: clientId || null,
    scope: `${clientId || email}:${stage}`,
    vars: { email: email || 'unknown' },
    body: `The Gatekeeper could not finish ${stage} for ${email || 'an applicant'}${clientId ? ` (${clientId})` : ''}.\nError: ${String(err?.message || err).slice(0, 300)}`,
    did: 'The application is saved and left in its current state. Answer the applicant by hand today.',
  });
}

/**
 * Decide an application already stored as `applied`. `preApproved` skips the
 * fit rules (owner's "New client" button); the repeat rule, the cap and the
 * extension rule still apply unless `override` is set.
 */
export async function decide(clientId, app, { preApproved = false, override = false, now = io.now() } = {}) {
  const repeat = await findRepeat(app.mainDomain, { excludeId: clientId });
  if (repeat && !override) return decline(clientId, 'one_trial_ever', 'decline_repeat', { mainDomain: app.mainDomain, previousClient: repeat.id }, now);

  if (!preApproved) {
    const fit = await cfg(clientId, 'FIT');
    const keywords = await cfg(clientId, 'INTAKE.agencyKeywords');
    const siteText = await fetchSiteText(app.mainDomain);
    const agencyHit = detectAgency(`${siteText} ${app.companyName} ${app.notes}`, keywords);
    const verdict = evaluateFit(app, fit, { agencyHit });
    await logEvent(clientId, SYSTEM, 'fit_checked', { ok: verdict.ok, rule: verdict.rule || null, agencyHit });
    if (!verdict.ok) return decline(clientId, `fit:${verdict.rule}`, 'decline_fit', { reason: verdict.reason }, now);
  }

  const cap = await capacity({ excludeId: clientId });
  if (!override && (cap.active >= cap.max || cap.inExtension)) return enqueue(clientId, cap, now);
  return startOnboarding(clientId, { now });
}

/**
 * Entry point for POST /api/apply and the owner's New client button.
 * @returns {{ok, clientId?, outcome?, errors?, duplicate?}}
 */
export async function applyForTrial(raw, { preApproved = false, override = false, source = 'form', now = io.now(), review = null } = {}) {
  const app = normaliseApplication(raw);
  const errors = validateApplication(app);
  if (Object.keys(errors).length) return { ok: false, errors };

  const claimTtl = await cfg(null, 'INTAKE.applyClaimSeconds');
  const claimed = await kv.set(K.applyClaim(app.mainDomain), now.toISOString(), { nx: true, ex: claimTtl });
  if (claimed !== 'OK') return { ok: true, duplicate: true, outcome: 'received' };

  let clientId = null;
  try {
    for (const id of await allocateId(app.mainDomain, app.companyName)) {
      try {
        await createClient(id, {
          name: app.companyName, contactName: app.contactName, contactEmail: app.contactEmail,
          website: app.website, mainDomain: app.mainDomain, plan: 'trial', state: 'applied', source,
        });
        clientId = id;
        break;
      } catch (err) {
        if (!/already exists/.test(err.message)) throw err;
      }
    }
    if (!clientId) throw new Error('no free client id');
    const stored = Object.fromEntries(Object.entries({ ...app, dreamCustomers: JSON.stringify(app.dreamCustomers), receivedAt: now.toISOString(), source, preApproved: preApproved ? '1' : '0' })
      .filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'yes' : 'no') : v]));
    await kv.hset(K.application(clientId), stored);
    await kv.hset(K.mainDomainIndex(), { [app.mainDomain]: clientId });
    await logEvent(clientId, SYSTEM, 'applied', { source, preApproved, mainDomain: app.mainDomain });
  } catch (err) {
    await gatekeeperError(clientId, app.contactEmail, err, 'saving the application');
    return { ok: true, clientId, outcome: 'manual' };
  }

  if (review) {
    await queueResearch(clientId, now);
    try {
      return { ok: true, clientId, ...(await holdForReview(clientId, app, review, now)) };
    } catch (err) {
      await gatekeeperError(clientId, app.contactEmail, err, 'holding the application for review');
      return { ok: true, clientId, outcome: 'manual' };
    }
  }

  try {
    const result = await decide(clientId, app, { preApproved, override, now });
    if (result.outcome !== 'declined') await queueResearch(clientId, now);
    return { ok: true, clientId, ...result };
  } catch (err) {
    await gatekeeperError(clientId, app.contactEmail, err, 'the decision');
    await queueResearch(clientId, now);
    return { ok: true, clientId, outcome: 'manual' };
  }
}

/**
 * Applicant research (Intake v2) for every application that is not declined
 * on the spot — website (held for review), form, the owner's New client. It
 * never blocks or changes a decision: a failure here is logged and the
 * application goes on as before.
 */
async function queueResearch(clientId, now) {
  try {
    const { startResearch } = await import('@/lib/systems/research');
    await startResearch(clientId, { now });
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'research_not_started', { error: String(err?.message || err).slice(0, 200) });
  }
}

// ── owner review (website applications, see systems/webapply.js) ────────────

/**
 * Keep the application in `applied` for the owner: store the answers and the
 * fit verdict, and tell the owner. Nothing is sent to the applicant yet.
 */
async function holdForReview(clientId, app, { answers = [], fit = null, extras = {} }, now) {
  await kv.hset(K.application(clientId), {
    review: 'pending', reviewSince: now.toISOString(),
    answers: JSON.stringify(answers), fit: JSON.stringify(fit || {}),
    ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [`web_${k}`, String(v)])),
  });
  await updateClient(clientId, { intakeStep: 'review' });
  await logEvent(clientId, SYSTEM, 'held_for_review', { verdict: fit?.verdict || null, summary: fit?.summary || null });
  const lines = (answers || []).map((a) => `${a.q}\n  ${a.a}`).join('\n');
  // Research gets a short, bounded head start so the alert can carry its
  // summary; if it is not done in time the alert goes without it (the
  // `research` job finishes it and the hub shows it — no second alert).
  let researchText = '';
  try {
    const { runResearch, researchView, researchLine } = await import('@/lib/systems/research');
    const ms = await cfg(clientId, 'RESEARCH.inRequestMs');
    await runResearch(clientId, { now, deadline: Date.now() + ms, alertOnFail: false });
    researchText = researchLine(await researchView(clientId));
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'research_inline_failed', { error: String(err?.message || err).slice(0, 200) });
  }
  await io.alertOwner('new_application', {
    clientId,
    vars: { company: app.companyName || app.mainDomain || clientId },
    body: `${app.contactName} <${app.contactEmail}> applied for a trial from the website.\n\n${fit?.summary || ''}${researchText ? `\n\n${researchText}` : ''}\n\n${lines}`,
    did: 'Saved it and held it for you. Open it in Trials and press “Say yes” or “Say no”; they hear nothing until you do.',
  });
  // Research still running: its fit score follows in one application_scored alert (research.js finish).
  await kv.hset(K.application(clientId), { alertedAt: io.now().toISOString() });
  return { outcome: 'review' };
}

async function pendingApplication(clientId) {
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  const application = (await kv.hgetall(K.application(clientId))) || {};
  if (client.state !== 'applied' || application.review !== 'pending') throw new Error('this application is not waiting for a review');
  return { client, application };
}

/**
 * Owner pressed Approve: the repeat rule and the cap still apply (→ onboarding
 * with the one `accepted_call` email, or the queue). If the email cannot go,
 * the application goes back to waiting so Approve can simply be pressed again.
 */
export async function approveApplication(clientId, { now = io.now() } = {}) {
  const { application } = await pendingApplication(clientId);
  if (application.web_sellsTo) await kv.hset(K.profile(clientId), { sellsTo: application.web_sellsTo });
  if (application.web_city) {
    // Their own city first, then the US places their website names (research), five at most.
    let places = [];
    try {
      const { researchView } = await import('@/lib/systems/research');
      places = (await researchView(clientId))?.website?.locations || [];
    } catch {}
    const cities = [application.web_city, ...places].filter((c, i, all) => all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i).slice(0, 5);
    await kv.hset(K.profile(clientId), { cities: JSON.stringify(cities) });
  }
  await kv.hset(K.application(clientId), { review: 'approved', decision: 'approve', decidedAt: now.toISOString() });
  await logEvent(clientId, SYSTEM, 'review_approved', {});
  try {
    const out = await decide(clientId, { mainDomain: application.mainDomain }, { preApproved: true, now });
    // Decided: the new_application alert (urgent) is handled — no to-do or red dot lingers after the yes.
    await ackAlerts(clientId, ['new_application', 'application_scored'], { reason: 'application approved', now });
    return out;
  } catch (err) {
    // Email first, state second: nothing changed for the applicant, so the application waits again.
    if ((await getClient(clientId))?.state === 'applied') {
      await kv.hset(K.application(clientId), { review: 'pending' });
      await kv.hdel(K.application(clientId), 'decision', 'decidedAt');
      await logEvent(clientId, SYSTEM, 'review_approve_failed', { error: String(err?.message || err).slice(0, 200) });
    }
    throw err;
  }
}

/** Owner pressed Decline: the reason goes to the applicant in decline_fit. */
export async function declineApplication(clientId, reason, { now = io.now() } = {}) {
  const text = String(reason || '').trim();
  if (!text) throw new Error('a reason is required — it goes to the applicant');
  await pendingApplication(clientId);
  await kv.hset(K.application(clientId), { review: 'declined', decision: 'decline', declineReason: text.slice(0, 500), decidedAt: now.toISOString() });
  await logEvent(clientId, SYSTEM, 'review_declined', {});
  const out = await decline(clientId, 'owner', 'decline_fit', { reason: text }, now);
  await ackAlerts(clientId, ['new_application', 'application_scored'], { reason: 'application declined', now });
  return out;
}

// ── queue ───────────────────────────────────────────────────────────────────

/** Waiting applicants in order with their expected dates. */
export async function listQueue() {
  const ids = (await kv.lrange(K.queueTrial(), 0, -1)) || [];
  const cap = await capacity();
  const rows = [];
  for (const id of ids) {
    const c = await getClient(id).catch(() => null);
    if (!c) continue;
    rows.push({ id, name: c.name, contactName: c.contactName, contactEmail: c.contactEmail, mainDomain: c.mainDomain, state: c.state, queuedAt: c.queuedAt || null, expectedDate: await expectedDate(rows.length + 1, cap) });
  }
  return { rows, capacity: cap };
}

/**
 * Pop queued applicants into onboarding while a slot is free and no
 * extension runs. With `clientId` (owner's Promote button) that one client is
 * promoted even over the cap.
 */
export async function promoteFromQueue({ now = io.now(), clientId = null } = {}) {
  const promoted = [];
  if (clientId) {
    const c = await getClient(clientId);
    if (!c || c.state !== 'queued') throw new Error(`${clientId} is not queued`);
    await startOnboarding(clientId, { now });
    await kv.lrem(K.queueTrial(), 0, clientId);
    await logEvent(clientId, SYSTEM, 'promoted', { by: 'owner' });
    return { promoted: [clientId] };
  }
  for (let i = 0; i < 10; i++) {
    const cap = await capacity();
    if (cap.active >= cap.max || cap.inExtension) break;
    const id = await kv.lpop(K.queueTrial());
    if (!id) break;
    const c = await getClient(id).catch(() => null);
    if (!c || c.state !== 'queued') continue;
    try {
      await startOnboarding(id, { now });
      promoted.push(id);
      await logEvent(id, SYSTEM, 'promoted', { by: 'queue' });
    } catch (err) {
      await kv.lpush(K.queueTrial(), id);
      await gatekeeperError(id, c.contactEmail, err, 'promotion from the queue');
      break;
    }
  }
  return { promoted };
}

/** Owner's Decline button on /mc/queue. */
export async function declineQueued(clientId, reasonText, { now = io.now() } = {}) {
  const c = await getClient(clientId);
  if (!c || c.state !== 'queued') throw new Error(`${clientId} is not queued`);
  if (!String(reasonText || '').trim()) throw new Error('a reason is required');
  const r = await decline(clientId, 'owner', 'decline_fit', { reason: String(reasonText).trim() }, now);
  await kv.lrem(K.queueTrial(), 0, clientId);
  return r;
}

// ── daily onboarding nudge (SPEC §6.1 step 6) ───────────────────────────────

/**
 * Day +2 / +4 reminders and the Day +7 close, counted in ET calendar days
 * from onboardingSentAt. A client who has accepted the agreement is waiting
 * on the Market Counter, not silent, and is never closed here.
 *
 * An applicant who got the onboarding-call email (onboardcall.onboardPageClock):
 * one reminder track — the call's own reminders until the call is done, the
 * page reminders only after it — and the close is extended, never early: it
 * counts from their last sign of life (a reply, a time they asked for, the
 * booked call, the call itself) and waits while a time they asked for is
 * unanswered or a booked call is still ahead.
 */
export async function runOnboardingNudge({ clientId, now = io.now() }) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'onboarding') return { skipped: 'state' };
  const trial = await getTrial(clientId);
  if (trial.agreementAcceptedAt) return { skipped: 'accepted' };
  const sentAt = trial.onboardingSentAt || client.stateChangedAt || client.createdAt;
  const clock = onboardPageClock(await readCall(clientId), sentAt, now);
  const since = clock.from;
  const moved = Date.parse(since) !== Date.parse(sentAt);
  const day = daysBetween(dayKeyIn(ET, new Date(since)), dayKeyIn(ET, now));
  const { reminderDays, closeDay } = await cfg(clientId, 'ONBOARD');

  if (moved || clock.hold) {
    // Tell the hub (and the log, once per new date) that the close moved.
    const closesOn = clock.hold ? 'held' : addDays(dayKeyIn(ET, new Date(since)), closeDay);
    if (trial.onboardingClosesOn !== closesOn) {
      await kv.hset(K.trial(clientId), { onboardingClosesOn: closesOn });
      await logEvent(clientId, SYSTEM, 'close_extended', { from: since, closesOn, why: clock.hold || 'they were in touch' });
    }
  }
  if (clock.hold) return { day, sent: null, extended: true, hold: clock.hold };

  if (day >= closeDay) {
    await sendClient(clientId, 'closed_silent', { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId) }, { dedupe: 'closed_silent' });
    await setState(clientId, 'closed_silent', `no onboarding form by day ${closeDay}`);
    await logEvent(clientId, SYSTEM, 'closed_silent', { day });
    const q = await promoteFromQueue({ now });
    return { closed: true, promoted: q.promoted };
  }

  // One reminder track: the onboarding call's reminders own the time before the call.
  if (!clock.reminders) return { day, sent: null, ...(moved ? { extended: true } : {}) };
  const due = reminderDays.filter((d) => day >= d).sort((a, b) => b - a)[0];
  if (due === undefined) return { day, sent: null };
  const sent = asArray(trial.onboardingRemindersSent).map(Number);
  if (sent.includes(due)) return { day, sent: null };
  const token = await mintToken(clientId, `onboarding:r${due}`, { ttl: TTL.long });
  const closeDate = formatDay(addDays(dayKeyIn(ET, new Date(since)), closeDay));
  const link = pageUrl(token, 'onboard');
  await sendClient(clientId, 'onboarding_reminder', { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId), link, closeDate }, { dedupe: `onboarding_reminder:${due}` });
  await rememberLink(clientId, 'onboarding', link, { now });
  const all = [...new Set([...sent, ...reminderDays.filter((d) => d <= due)])];
  await kv.hset(K.trial(clientId), { onboardingRemindersSent: JSON.stringify(all) });
  await logEvent(clientId, SYSTEM, 'onboarding_reminder', { day, reminder: due });
  return { day, sent: due };
}
