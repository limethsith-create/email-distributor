/**
 * Client intake (was the Trial Gatekeeper, SPEC §6.1). Every client is a
 * paying client on Starter, Growth or Scale; there is no free trial, no
 * waiting list and no trial cap. Two ways a client record is made:
 *
 *   - a website booking ("Book a call", systems/inquiries.js) with a website:
 *     a record in `applied` held for the sales call, researched and scored,
 *     never shown as a client and never emailed — the owner's Won on the
 *     booking starts onboarding (`approveApplication`), Lost closes it;
 *   - the owner's "Add a paying client" button: straight to onboarding.
 *
 * Also runs the daily onboarding nudge (reminders, then closed_silent).
 * Order inside a step is always: email first, state second — so any failure
 * leaves the client where it was and raises gatekeeper_error.
 */

import { kv } from '@vercel/kv';
import { K, slugify } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { createClient, getClient, setState, updateClient, getTrial } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { addPromise } from '@/lib/db/promises';
import { mintToken, pageUrl, rememberLink, TTL } from '@/lib/pagetokens';
import { dayKeyIn, daysBetween, addDays, ET } from '@/lib/time';
import { io, truthy, asArray, firstNameOf, ownerName, sendClient, formatDay, nextUsBusinessDay } from '@/lib/systems/intake-io';
import { sendAcceptance, readCall, onboardPageClock } from '@/lib/systems/onboardcall';
import { ackAlerts } from '@/lib/notify';
import { outreachOffer } from '@/lib/systems/fitscore';

const SYSTEM = 'gatekeeper';
/** Earlier records in these states do not block a new application (no trial was ever run). */
/** Ids that are never real trial clients. */
/** Ids no client may take (the owner's own record and the old Test Mode client). */
const RESERVED_IDS = new Set(['aviance', '_test']);
/** The paid plans (config PLANS). A client on one came from a paid-plan request, not a trial application. */
export const PAID_PLANS = new Set(['starter', 'growth', 'scale']);
export const isPaidPlan = (plan) => PAID_PLANS.has(String(plan || '').toLowerCase());

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

// ── agency detection (the research fit score reads it) ──────────────────────

const SELF_NAMING = /\b(agency|agencies|as a service|as-a-service|setters|software|platform|tool|database)\b/;
/** Words before a hit that turn it around ("we tried lead gen agencies", "not an outbound agency"). */
const NEGATED_BEFORE = /\b(?:tried|used|using|hired|worked with|burned by|than|unlike|not|no|never|instead of|replac\w*|other|previous|bad experience with|without)\b[^.\n|]{0,30}$/;

/**
 * First agency keyword in `text` that shows they SELL outreach, else null.
 * A keyword that names an agency or product ("SDR agency", "cold email platform") counts
 * where it stands (unless negated: "we tried an SDR agency"); a bare trade word ("lead
 * generation", "appointment setting") counts only as their offer — "lead generation agency",
 * "B2B lead generation services", a line that opens with it — never inside a feature list
 * ("scheduling, invoicing and lead generation for HVAC contractors").
 */
export function detectAgency(text, keywords) {
  const raw = String(text || '').toLowerCase().replace(/[ \t]+/g, ' ');
  const t = ` ${raw} `;
  const offer = outreachOffer(raw);
  for (const k of keywords) {
    const kw = String(k).toLowerCase();
    const re = new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'g');
    let m;
    while ((m = re.exec(t))) {
      const at = m.index + m[1].length;
      if (NEGATED_BEFORE.test(t.slice(Math.max(0, at - 40), at))) continue;
      if (SELF_NAMING.test(kw)) return k;
      if (offer && offer.includes(kw)) return k;
    }
  }
  return null;
}

/** { ok, rule, reason } — the first failing rule, in table order. */
async function allocateId(mainDomain, companyName) {
  let base = slugify(mainDomain) || slugify(companyName) || 'client';
  if (RESERVED_IDS.has(base) || base === 'new' || !/^[a-z0-9]/.test(base)) base = `c-${base}`.slice(0, 36).replace(/-+$/, '');
  base = base.slice(0, 36).replace(/-+$/, '');
  return [base, ...Array.from({ length: 30 }, (_, i) => `${base}-${i + 2}`)];
}

async function answeredPromise(clientId, now) {
  const due = nextUsBusinessDay(addDays(dayKeyIn(ET, now), 1));
  await addPromise(clientId, 'Answer the client within 1 business day', `${due}T23:59:00Z`, { done: true }).catch(() => {});
}

/**
 * Start onboarding: mint the onboarding token (14 days), send ONE email —
 * `accepted_call`, "you're in, book your onboarding call", with the
 * one-page onboarding link inside (systems/onboardcall.js, docs/ONBOARD-CALL.md)
 * — and move to `onboarding`. Used for Won on a booking and the owner's Add.
 */
export async function startOnboarding(clientId, { now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  if (client.state !== 'applied') throw new Error(`cannot start onboarding from ${client.state}`);
  const token = await mintToken(clientId, 'onboarding', { ttl: TTL.long });
  await sendAcceptance(clientId, { onboardingLink: pageUrl(token, 'onboard'), now });
  await setState(clientId, 'onboarding', 'won');
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
 * Make a client record (POST from the owner's Add button, or a website booking).
 * `plan` is starter | growth | scale (starter when missing or unknown).
 * `review` holds the record in `applied` for the sales call (a booking);
 * without it the client goes straight to onboarding (the owner's Add).
 * @returns {{ok, clientId?, outcome?, errors?, duplicate?}}
 */
export async function addClient(raw, { source = 'owner', now = io.now(), review = null, plan = 'starter' } = {}) {
  const app = normaliseApplication(raw);
  const errors = validateApplication(app);
  if (Object.keys(errors).length) return { ok: false, errors };
  const thePlan = isPaidPlan(plan) ? String(plan).toLowerCase() : 'starter';

  const claimTtl = await cfg(null, 'INTAKE.applyClaimSeconds');
  const claimed = await kv.set(K.applyClaim(app.mainDomain), now.toISOString(), { nx: true, ex: claimTtl });
  if (claimed !== 'OK') return { ok: true, duplicate: true, outcome: 'received' };

  let clientId = null;
  try {
    for (const id of await allocateId(app.mainDomain, app.companyName)) {
      try {
        await createClient(id, {
          name: app.companyName, contactName: app.contactName, contactEmail: app.contactEmail,
          website: app.website, mainDomain: app.mainDomain, plan: thePlan, state: 'applied', source,
        });
        clientId = id;
        break;
      } catch (err) {
        if (!/already exists/.test(err.message)) throw err;
      }
    }
    if (!clientId) throw new Error('no free client id');
    const stored = Object.fromEntries(Object.entries({ ...app, dreamCustomers: JSON.stringify(app.dreamCustomers), receivedAt: now.toISOString(), source })
      .filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'yes' : 'no') : v]));
    await kv.hset(K.application(clientId), stored);
    await kv.hset(K.mainDomainIndex(), { [app.mainDomain]: clientId });
    await logEvent(clientId, SYSTEM, 'applied', { source, mainDomain: app.mainDomain });
  } catch (err) {
    await gatekeeperError(clientId, app.contactEmail, err, 'saving the client');
    return { ok: true, clientId, outcome: 'manual' };
  }

  await queueResearch(clientId, now);
  try {
    if (review) return { ok: true, clientId, ...(await holdForReview(clientId, app, review, now)) };
    return { ok: true, clientId, ...(await startOnboarding(clientId, { now })) };
  } catch (err) {
    await gatekeeperError(clientId, app.contactEmail, err, review ? 'holding the booking for the sales call' : 'starting onboarding');
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

// ── a booking held for the sales call (systems/inquiries.js) ───────────────

/**
 * Keep the record in `applied` while the sales call is ahead: store the
 * booking's answers and run the research inline (bounded), so the hub can
 * show "What we found" before the call. No alert (the booking's own
 * new_inquiry alert covers it) and nothing goes to the person.
 */
async function holdForReview(clientId, app, { answers = [], fit = null, extras = {} }, now) {
  await kv.hset(K.application(clientId), {
    review: 'pending', reviewSince: now.toISOString(), alertedAt: now.toISOString(), // the booking's new_inquiry alert
    answers: JSON.stringify(answers), fit: JSON.stringify(fit || {}),
    ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [`web_${k}`, String(v)])),
  });
  await updateClient(clientId, { intakeStep: 'review' });
  await logEvent(clientId, SYSTEM, 'held_for_review', { verdict: fit?.verdict || null });
  try {
    const { runResearch } = await import('@/lib/systems/research');
    const ms = await cfg(clientId, 'RESEARCH.inRequestMs');
    await runResearch(clientId, { now, deadline: Date.now() + ms, alertOnFail: false });
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'research_inline_failed', { error: String(err?.message || err).slice(0, 200) });
  }
  return { outcome: 'review' };
}

async function pendingApplication(clientId) {
  const client = await getClient(clientId);
  if (!client) throw new Error(`no client ${clientId}`);
  const application = (await kv.hgetall(K.application(clientId))) || {};
  if (client.state !== 'applied' || application.review !== 'pending') throw new Error('this booking is not waiting for its sales call');
  return { client, application };
}

/**
 * The owner marked the booking Won: they become a paying client and onboarding
 * starts (the one `accepted_call` email). If the email cannot go, the record
 * goes back to waiting so Won can simply be pressed again.
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
  await kv.hset(K.application(clientId), { review: 'approved', decision: 'won', decidedAt: now.toISOString() });
  await logEvent(clientId, SYSTEM, 'won', {});
  try {
    const out = await startOnboarding(clientId, { now });
    await ackAlerts(clientId, ['new_application', 'application_scored'], { reason: 'won', now });
    return out;
  } catch (err) {
    // Email first, state second: nothing changed for them, so the record waits again.
    if ((await getClient(clientId))?.state === 'applied') {
      await kv.hset(K.application(clientId), { review: 'pending' });
      await kv.hdel(K.application(clientId), 'decision', 'decidedAt');
      await logEvent(clientId, SYSTEM, 'won_failed', { error: String(err?.message || err).slice(0, 200) });
    }
    throw err;
  }
}

/** The owner marked the booking Lost: the record closes. Nothing is emailed to them. */
export async function declineApplication(clientId, reason = '', { now = io.now() } = {}) {
  await pendingApplication(clientId);
  const text = String(reason || '').trim().slice(0, 500);
  await kv.hset(K.application(clientId), { review: 'declined', decision: 'lost', ...(text ? { declineReason: text } : {}), decidedAt: now.toISOString() });
  await setState(clientId, 'declined', 'lost');
  await updateClient(clientId, { declineReason: 'lost', intakeStep: '' });
  await logEvent(clientId, SYSTEM, 'lost', {});
  await ackAlerts(clientId, ['new_application', 'application_scored'], { reason: 'lost', now });
  return { outcome: 'declined', reason: 'lost' };
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
  const callRaw = await readCall(clientId);
  const clock = onboardPageClock(callRaw, sentAt, now);
  // They told the reply bot "not now" (its `later` rule): the slot is held until the check-back
  // date it gave them, and the close counts from that date after it.
  const laterUntil = Date.parse(callRaw.laterUntil || '');
  if (Number.isFinite(laterUntil)) {
    if (laterUntil > now.getTime()) clock.hold = clock.hold || `they asked to wait — you check back on ${formatDay(dayKeyIn(ET, new Date(laterUntil)))}`;
    else if (laterUntil > Date.parse(clock.from)) clock.from = new Date(laterUntil).toISOString();
  }
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
    return { closed: true };
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
