/**
 * Plan inquiries: people who want a paid plan (Starter / Growth / Scale)
 * without a trial. The website's "Book a call" form (aviance.online) posts
 * here; each inquiry lands in the hub's Inquiries section and pops up on the
 * owner's phone. The owner moves it along: new → contacted → won / lost, can
 * add notes, or turn it into a trial (runs the Gatekeeper, pre-approved).
 *
 * Stages (the owner's pipeline, in order): new = Booked (the call is on the
 * calendar) → held = Call done / no_show = No-show → contacted = Following up →
 * proposal = Proposal sent → won / lost. Moving one to Call done / No-show
 * marks its Calendar meeting too, and the Calendar's buttons move it back here.
 *
 * Storage: `inquiries` hash (id → record) + `inquiries:order` list (newest
 * first, capped). An inquiry with a time also becomes a confirmed sales call in
 * the Calendar and gets a confirmation email + reminders (systems/salescall.js).
 *
 * A request with a website also becomes a paid application (inquiryToApplication): a client on
 * the plan they picked, researched and scored like a trial application, answered in the hub's
 * Paying clients tab. "Say yes" there is what emails them.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';

export const STATUSES = ['new', 'held', 'no_show', 'contacted', 'proposal', 'won', 'lost'];
/** The owner's words for each stage (the hub shows these). */
export const STAGE_WORDS = { new: 'Booked', held: 'Call done', no_show: 'No-show', contacted: 'Following up', proposal: 'Proposal sent', won: 'Won', lost: 'Lost' };
/** Stages still in play (not won or lost). */
export const OPEN_STAGES = ['new', 'held', 'no_show', 'contacted', 'proposal'];
const CAP = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLANS = ['starter', 'growth', 'scale'];

const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);

/**
 * The plan behind a request: the plan card they came from, else the calls a month they said they could
 * take ("Around 10" → growth). The website's confirmation page and email already read it this way, so the
 * hub, the application and the email all name the same plan. Null when neither says.
 */
export function inferPlan(inq = {}) {
  if (inq.plan && PLANS.includes(inq.plan)) return inq.plan;
  const c = String(inq.capacity || '').toLowerCase();
  return /15/.test(c) ? 'scale' : /10/.test(c) ? 'growth' : /\b5\b/.test(c) ? 'starter' : null;
}

/**
 * Their quick answers in the application's own fields, so the fit score reads them instead of listing
 * them as "not checked". Only what an answer really says: a deal-size band gives its lower bound; inbound,
 * their own outbound or an agency means they already win strangers; referrals / "not consistently" stay
 * unknown (a question for the call, never a dealbreaker).
 */
export function applicationExtras(inq = {}) {
  const out = {};
  if (inq.sells) out.web_sellsTo = inq.sells;
  const d = String(inq.dealSize || '');
  if (d) out.web_valueBand = d;
  if (!/^under/i.test(d)) {
    const lo = d.match(/\$\s*([\d,]+)/);
    if (lo) out.dealValue = Number(lo[1].replace(/,/g, ''));
  }
  if (/inbound|own outbound|agency/i.test(String(inq.channel || ''))) out.soldToStrangers = 'yes';
  return out;
}
const isoOrNull = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** Website body → inquiry fields, or { errors }. */
export function normaliseInquiry(raw = {}) {
  const inq = {
    name: s(raw.name, 120),
    email: s(raw.email, 200).toLowerCase(),
    company: s(raw.company, 160),
    website: s(raw.website, 300),
    sells: s(raw.sells ?? raw.what_you_sell ?? raw.what, 800),
    plan: PLANS.includes(s(raw.plan).toLowerCase()) ? s(raw.plan).toLowerCase() : null,
    slotStart: isoOrNull(raw.slotStart),
    slotEnd: isoOrNull(raw.slotEnd),
    theirTz: s(raw.theirTz, 60) || null,
    whenTheirs: s(raw.whenTheirs, 120) || null,
    whenHost: s(raw.whenHost, 120) || null,
    page: s(raw.page, 200) || null,
    // The website's five quick questions (any may be missing on an older form).
    role: s(raw.role, 80) || null,
    dealSize: s(raw.dealSize ?? raw.deal_size, 80) || null,
    channel: s(raw.channel, 80) || null,
    capacity: s(raw.capacity, 80) || null,
    timing: s(raw.timing, 80) || null,
    // Two more quick answers from the booking form: outbound tried before, and what they want from the call.
    tried: s(raw.tried, 80) || null,
    goal: s(raw.goal, 300) || null,
  };
  const errors = {};
  if (!inq.name) errors.name = 'Your name is required.';
  if (!EMAIL_RE.test(inq.email)) errors.email = 'A valid email address is required.';
  if (!inq.company) errors.company = 'Company name is required.';
  if (!inq.sells) errors.sells = 'Tell us what you sell.';
  return Object.keys(errors).length ? { errors } : { inquiry: inq };
}

const newId = (now) => `q${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Save a website inquiry, alert the owner (phone + email). Duplicate submits within 10 minutes are merged. */
export async function saveInquiry(raw, { source = 'website', now = new Date() } = {}) {
  const r = normaliseInquiry(raw);
  if (r.errors) return { ok: false, errors: r.errors };
  const inq = r.inquiry;
  const dupKey = `inquiry:dup:${inq.email}:${inq.slotStart || 'noslot'}`;
  const first = await kv.set(dupKey, '1', { nx: true, ex: 600 });
  if (first !== 'OK') return { ok: true, duplicate: true };

  const id = newId(now);
  const rec = { id, at: now.toISOString(), source, status: 'new', statusAt: now.toISOString(), notes: [], ...inq };
  const p = kv.pipeline();
  p.hset(K.inquiries(), { [id]: rec });
  p.lpush(K.inquiryOrder(), id);
  p.ltrim(K.inquiryOrder(), 0, CAP - 1);
  await p.exec();
  await logEvent(null, 'inquiries', 'received', { id, company: inq.company, plan: inq.plan, slotStart: inq.slotStart });

  // A time was picked: it goes in the Calendar as a confirmed sales call and they get the confirmation email.
  let booked = null;
  if (inq.slotStart) {
    try { booked = await (await import('@/lib/systems/salescall')).bookAndConfirm(rec, { now }); } catch { booked = null; }
  }
  const bookedLine = !inq.slotStart ? '' : booked?.emailed
    ? `\n\nIn your Calendar as a sales call. They were sent a confirmation email with a calendar invite; reminders go the day before and an hour before.${booked.clash ? `\nHeads up: it overlaps "${booked.clash.title}".` : ''}`
    : `\n\n${booked?.meeting ? 'In your Calendar as a sales call, but the' : 'The'} confirmation email did NOT go: ${booked?.error || 'unknown error'}. Write to them yourself.`;

  // With a website, the request becomes a paid application the owner answers in the hub's Paying
  // clients tab: the same research and fit score as a trial application, held until "Say yes"
  // (which emails them the onboarding call) or "Say no". That application's alert replaces the one below.
  const app = await inquiryToApplication(id, rec, { now });
  if (app?.clientId) {
    if (booked?.meeting) { try { await (await import('@/lib/systems/calendar')).patchMeeting(booked.meeting.id, { linkedClientId: app.clientId }, { now }); } catch {} }
    return { ok: true, id, clientId: app.clientId, emailed: !inq.slotStart ? null : Boolean(booked?.emailed) };
  }

  const when = inq.whenHost ? `${inq.whenHost} (your time)` : 'no time picked';
  await alertOwner('new_inquiry', {
    scope: id,
    url: `/#inquiry/${id}`,
    vars: { company: inq.company, when },
    body: `${inq.name} <${inq.email}> from ${inq.company}${inq.plan ? ` asked about ${inq.plan[0].toUpperCase()}${inq.plan.slice(1)}` : ' asked about a plan'}.\nCall: ${when}${inq.whenTheirs ? ` — their time ${inq.whenTheirs}` : ''}\nThey sell: ${inq.sells}${inq.website ? `\nWebsite: ${inq.website}` : ''}${answersText(inq)}${bookedLine}`,
    did: booked?.emailed ? 'Saved under Inquiries in the hub (stage: Booked) and sent them the confirmation.' : 'Saved under Inquiries in the hub (stage: Booked).',
  }).catch(() => {});
  return { ok: true, id, emailed: !inq.slotStart ? null : Boolean(booked?.emailed) };
}

/** Their five answers as alert lines ('' when the form had none). */
export function answersText(inq) {
  const rows = [['Role', inq.role], ['Deal size', inq.dealSize], ['Wins customers today', inq.channel], ['Calls a month they can take', inq.capacity], ['Wants to start', inq.timing], ['Tried outbound before', inq.tried], ['Wants from the call', inq.goal]].filter(([, v]) => v);
  return rows.length ? `\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}` : '';
}

/** The questions a paid request answers, as the application shows them. */
export function inquiryAnswers(inq) {
  const p = inferPlan(inq);
  const plan = !p ? 'Not picked (Starter assumed)' : `${p[0].toUpperCase()}${p.slice(1)}${inq.plan ? '' : ` (from “${inq.capacity}” calls a month)`}`;
  return [
    { q: 'Plan they asked for', a: plan },
    { q: 'What they sell', a: inq.sells || '—' },
    { q: 'Website', a: inq.website || '—' },
    { q: 'Call they booked', a: inq.whenTheirs ? `${inq.whenTheirs}${inq.theirTz ? ` (${inq.theirTz})` : ''}` : inq.whenHost || 'No time picked' },
    ...(inq.role ? [{ q: 'Their role', a: inq.role }] : []),
    ...(inq.dealSize ? [{ q: 'Average deal size', a: inq.dealSize }] : []),
    ...(inq.channel ? [{ q: 'How they win customers today', a: inq.channel }] : []),
    ...(inq.capacity ? [{ q: 'Sales calls a month they can take', a: inq.capacity }] : []),
    ...(inq.timing ? [{ q: 'When they want to start', a: inq.timing }] : []),
    ...(inq.tried ? [{ q: 'Cold email or an outbound agency before', a: inq.tried }] : []),
    ...(inq.goal ? [{ q: 'What they want from the call', a: inq.goal }] : []),
  ];
}

/**
 * A paid request with a website → a client on that plan in `applied`, held for the owner's review
 * (systems/gatekeeper.js applyForTrial with `plan` + `review`). Never throws: the inquiry stays
 * saved either way, and without a website (or on any error) it is a plain inquiry as before.
 */
export async function inquiryToApplication(id, inq, { now = new Date() } = {}) {
  if (!inq.website) return null;
  try {
    const { applyForTrial } = await import('@/lib/systems/gatekeeper');
    const r = await applyForTrial(
      { companyName: inq.company, contactName: inq.name, contactEmail: inq.email, website: inq.website, notes: inq.sells },
      { source: 'inquiry', plan: inferPlan(inq) || 'starter', now, review: { answers: inquiryAnswers(inq), fit: { verdict: 'unknown', summary: 'A paid-plan request: read the fit score and the research, then say yes or no.', lines: [] } } },
    );
    if (!r.ok || !r.clientId) return null;
    const extras = applicationExtras(inq);
    if (!r.duplicate && Object.keys(extras).length) { try { await kv.hset(K.application(r.clientId), extras); } catch { /* the score just asks instead */ } }
    await patch(id, { clientId: r.clientId, trialOutcome: r.outcome || null, paid: true });
    await logEvent(null, 'inquiries', 'to_application', { id, clientId: r.clientId, outcome: r.outcome });
    return r;
  } catch (err) {
    await logEvent(null, 'inquiries', 'to_application_failed', { id, error: String(err?.message || err).slice(0, 200) });
    return null;
  }
}

export async function getInquiry(id) {
  const rec = await kv.hget(K.inquiries(), String(id));
  return rec && typeof rec === 'object' ? rec : null;
}

/** Newest first, with counts per status. */
export async function listInquiries({ limit = 200 } = {}) {
  const ids = (await kv.lrange(K.inquiryOrder(), 0, Math.max(0, limit - 1))) || [];
  const all = ids.length ? await kv.hmget(K.inquiries(), ...ids) : {};
  const rows = ids.map((id) => (all && all[id]) || null).filter(Boolean);
  const counts = Object.fromEntries(STATUSES.map((x) => [x, 0]));
  for (const r of rows) if (counts[r.status] !== undefined) counts[r.status]++;
  return { inquiries: rows, counts };
}

/** Change a few fields of an inquiry (the sales-call system writes what it sent). */
export async function patchInquiry(id, fields) { return patch(id, fields); }

async function patch(id, fields) {
  const cur = await getInquiry(id);
  if (!cur) throw new Error('inquiry not found');
  const next = { ...cur, ...fields };
  await kv.hset(K.inquiries(), { [id]: next });
  return next;
}

export async function setInquiryStatus(id, status, note = '', { now = new Date(), fromCalendar = false } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const cur = await getInquiry(id);
  if (!cur) throw new Error('inquiry not found');
  const notes = note ? [...(cur.notes || []), { at: now.toISOString(), text: s(note, 1000) }] : cur.notes || [];
  const rec = await patch(id, { status, statusAt: now.toISOString(), notes, stageHistory: [...(cur.stageHistory || []), { at: now.toISOString(), from: cur.status, to: status }].slice(-30) });
  await logEvent(null, 'inquiries', 'status', { id, status });
  // Call done / No-show here marks the sales call in the Calendar too (the Calendar's own buttons came the other way).
  if (!fromCalendar && (status === 'held' || status === 'no_show') && rec.meetingId) {
    try { await (await import('@/lib/systems/salescall')).meetingForStage(rec, status, { now }); } catch {}
  }
  return rec;
}

export async function addInquiryNote(id, text, { now = new Date() } = {}) {
  const t = s(text, 1000);
  if (!t) throw new Error('the note is empty');
  const cur = await getInquiry(id);
  if (!cur) throw new Error('inquiry not found');
  return patch(id, { notes: [...(cur.notes || []), { at: now.toISOString(), text: t }] });
}

/** Turn an inquiry into a trial (pre-approved): the Gatekeeper sends the onboarding link or queues it. */
export async function inquiryToTrial(id) {
  const cur = await getInquiry(id);
  if (!cur) throw new Error('inquiry not found');
  if (cur.clientId) return { ok: true, clientId: cur.clientId, already: true };
  const { applyForTrial } = await import('@/lib/systems/gatekeeper');
  const r = await applyForTrial({ companyName: cur.company, contactName: cur.name, contactEmail: cur.email, website: cur.website }, { preApproved: true, source: 'inquiry' });
  if (!r.ok) return r;
  await patch(id, { clientId: r.clientId || null, trialOutcome: r.outcome || null });
  await logEvent(null, 'inquiries', 'to_trial', { id, clientId: r.clientId, outcome: r.outcome });
  return r;
}

/** Board summary for the hub: counts + the newest open ones. */
export async function inquirySummary() {
  const { inquiries, counts } = await listInquiries({ limit: 100 });
  const open = inquiries.filter((q) => OPEN_STAGES.includes(q.status));
  return { counts, open: open.length, latest: open.slice(0, 5).map((q) => ({ id: q.id, at: q.at, name: q.name, company: q.company, plan: q.plan, status: q.status, slotStart: q.slotStart, whenHost: q.whenHost, clientId: q.clientId || null })) };
}

/**
 * The website request behind a paid application moves with it, so the Inquiries list never shows it as
 * "new" after the owner answered it: Say yes → contacted, the plan agreement signed → won, Say no → lost.
 * Only forward (a won or lost request stays as it is). Never throws.
 */
export async function settleInquiryFor(clientId, status, note = '', { now = new Date() } = {}) {
  try {
    const { inquiries } = await listInquiries({ limit: 500 });
    const q = inquiries.find((x) => x.clientId === clientId);
    if (!q || q.status === status || ['won', 'lost'].includes(q.status)) return null;
    return await setInquiryStatus(q.id, status, note, { now });
  } catch { return null; }
}
