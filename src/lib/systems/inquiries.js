/**
 * Website bookings ("Book a call" on aviance.online): the only way a new
 * client comes in. Each booking lands in the hub's Plan call requests,
 * goes in the Calendar as a sales call with a confirmation email and
 * reminders (systems/salescall.js), and pops up on the owner's phone.
 *
 * Stages (the owner's pipeline, in order): new = Booked (the call is on the
 * calendar) → held = Call done / no_show = No-show → contacted = Following up →
 * proposal = Proposal sent → won / lost. Moving one to Call done / No-show
 * marks its Calendar meeting too, and the Calendar's buttons move it back here.
 *
 * A booking with a website also gets a client record held for the sales call
 * (holdForSalesCall): researched and scored so the owner sees "What we found"
 * before the call, but not a client yet and never emailed. **Won** makes them
 * a paying client and starts onboarding; **Lost** closes the record.
 *
 * Storage: `inquiries` hash (id → record) + `inquiries:order` list (newest
 * first, capped).
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
/** A phone number as typed, kept only if it looks like one: digits, spaces, + ( ) - . and an "ext". Null otherwise. */
export function normalisePhone(v) {
  const t = String(v ?? '').trim().slice(0, 30).replace(/\s+/g, ' ');
  if (!t || !/^[+\d\s().\-]+(\s*(?:ext|x)\.?\s*\d{1,6})?$/i.test(t)) return null;
  const digits = t.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 20 ? t : null;
}

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
/**
 * Their website as a link: "acme.com" → "https://acme.com". Only http(s); anything that isn't a
 * plausible host (no dot, spaces, other schemes) is dropped rather than stored, so research never
 * gets junk. Empty stays empty: older pages and "I don't have one yet" still send none.
 */
export function normaliseWebsite(v) {
  let w = s(v, 300).replace(/^[<"']+|[>"']+$/g, '');
  if (!w) return '';
  if (/^\/\//.test(w)) w = `https:${w}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(w)) w = `https://${w}`;
  try {
    const u = new URL(w);
    if (!/^https?:$/.test(u.protocol) || !/^[^.\s]+(\.[^.\s]+)+$/.test(u.hostname)) return '';
    return u.href.replace(/\/$/, '').slice(0, 300);
  } catch { return ''; }
}

/** Friendly words for where a lead came from (utm_source / ref). Unknown values pass through as sent. */
const SOURCE_WORDS = {
  cold_call: 'Cold call', coldcall: 'Cold call', call: 'Cold call', phone: 'Cold call',
  linkedin: 'LinkedIn', li: 'LinkedIn',
  email: 'Email', cold_email: 'Email', newsletter: 'Email',
  google: 'Google', facebook: 'Facebook', fb: 'Facebook', instagram: 'Instagram', ig: 'Instagram', x: 'X (Twitter)', twitter: 'X (Twitter)',
  referral: 'Referral', website: 'Website',
};
/** Clean one tracking value: a short plain string or null (no control characters, no markup). */
const tag = (v, n = 100) => {
  const t = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
  return t || null;
};
export function sourceWords(v) {
  const t = tag(v);
  if (!t) return null;
  return SOURCE_WORDS[t.toLowerCase().replace(/[\s-]+/g, '_')] || t;
}

/**
 * Where they came from, from the booking link (…/book?utm_source=cold_call or ?ref=…). Accepts a
 * `utm` object or flat utm_* fields. Null when the link had nothing.
 */
export function normaliseSource(raw = {}) {
  const u = raw.utm && typeof raw.utm === 'object' ? raw.utm : {};
  const utm = {
    source: tag(u.source ?? raw.utm_source),
    medium: tag(u.medium ?? raw.utm_medium),
    campaign: tag(u.campaign ?? raw.utm_campaign),
    content: tag(u.content ?? raw.utm_content),
  };
  const ref = tag(raw.ref, 100);
  const hasUtm = Object.values(utm).some(Boolean);
  if (!hasUtm && !ref) return { utm: null, ref: null, cameFrom: null };
  return { utm: hasUtm ? utm : null, ref, cameFrom: cameFromText({ utm, ref }) };
}

/** "Cold call", or "LinkedIn (campaign: q4-founders)"; null when unknown. */
export function cameFromText(inq = {}) {
  const u = inq.utm || {};
  const main = sourceWords(u.source) || sourceWords(inq.ref) || sourceWords(u.medium);
  if (!main) return null;
  const bits = [];
  if (u.medium && sourceWords(u.medium) !== main) bits.push(`via ${u.medium}`);
  if (u.campaign) bits.push(`campaign: ${u.campaign}`);
  if (u.content) bits.push(`content: ${u.content}`);
  if (inq.ref && sourceWords(inq.ref) !== main) bits.push(`ref: ${inq.ref}`);
  return bits.length ? `${main} (${bits.join(', ')})` : main;
}

const isoOrNull = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** Website body → inquiry fields, or { errors }. */
export function normaliseInquiry(raw = {}) {
  const inq = {
    name: s(raw.name, 120),
    email: s(raw.email, 200).toLowerCase(),
    company: s(raw.company, 160),
    website: normaliseWebsite(raw.website),
    // They ticked "I don't have one yet" on the booking form (so an empty website is on purpose).
    noWebsite: !normaliseWebsite(raw.website) && (raw.noWebsite === true || raw.noWebsite === 'true'),
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
    // Optional: so the owner can ring or text them if they are late for the call.
    phone: normalisePhone(raw.phone),
    // Where they came from: the booking link's utm_* / ref (e.g. ?utm_source=cold_call after a call).
    ...normaliseSource(raw),
  };
  const errors = {};
  if (!inq.name) errors.name = 'Your name is required.';
  if (!EMAIL_RE.test(inq.email)) errors.email = 'A valid email address is required.';
  if (!inq.company) errors.company = 'Company name is required.';
  if (!inq.sells) errors.sells = 'Tell us what you sell.';
  return Object.keys(errors).length ? { errors } : { inquiry: inq };
}

const newId = (now) => `q${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Save a website inquiry, alert the owner (phone + email). Duplicate submits within 10 minutes are merged.
 *
 * With a time: the time is held in the Calendar FIRST (under the calendar lock, systems/calendar.js
 * bookSalesCall strict), so a time outside the call hours or one someone else already holds is refused
 * with `{ ok: false, code: 'slot_taken' | 'outside_hours' | 'slot_in_past', error }` and nothing is saved.
 * Then the inquiry is saved and the confirmation email goes (its result is `emailed`).
 *
 * The slow rest (the paid application with its research and fit score, the owner's alerts) runs in
 * `defer(job)` when given (the route passes Next's `after`, so the visitor is answered as soon as the
 * booking is saved and emailed); without it, it runs here before returning, as before.
 */
export async function saveInquiry(raw, { source = 'website', now = new Date(), defer = null } = {}) {
  const r = normaliseInquiry(raw);
  if (r.errors) return { ok: false, errors: r.errors };
  const inq = r.inquiry;
  const dupKey = `inquiry:dup:${inq.email}:${inq.slotStart || 'noslot'}`;
  const first = await kv.set(dupKey, '1', { nx: true, ex: 600 });
  if (first !== 'OK') return { ok: true, duplicate: true };

  const id = newId(now);
  if (inq.slotStart) {
    const refused = await holdSlot(id, inq, now);
    if (refused) {
      await kv.del(dupKey).catch(() => {});
      await logEvent(null, 'inquiries', 'slot_refused', { code: refused.code, slotStart: inq.slotStart }).catch(() => {});
      return { ok: false, code: refused.code, error: refused.message };
    }
  }

  const rec = { id, at: now.toISOString(), source, status: 'new', statusAt: now.toISOString(), notes: [], ...inq };
  const p = kv.pipeline();
  p.hset(K.inquiries(), { [id]: rec });
  p.lpush(K.inquiryOrder(), id);
  p.ltrim(K.inquiryOrder(), 0, CAP - 1);
  await p.exec();
  await logEvent(null, 'inquiries', 'received', { id, company: inq.company, plan: inq.plan, slotStart: inq.slotStart });

  // A time was picked: it is in the Calendar as a confirmed sales call; they get the confirmation email now.
  let booked = null;
  if (inq.slotStart) {
    try { booked = await (await import('@/lib/systems/salescall')).bookAndConfirm(rec, { now }); } catch { booked = null; }
  }
  const emailed = !inq.slotStart ? null : Boolean(booked?.emailed);
  const rest = () => afterSaved(id, rec, booked, { now });
  if (typeof defer === 'function') {
    try { await defer(rest); return { ok: true, id, emailed, deferred: true }; } catch { /* could not defer: do it now */ }
  }
  const done = await rest();
  return { ok: true, id, ...(done?.clientId ? { clientId: done.clientId } : {}), emailed };
}

/**
 * Hold the picked time in the Calendar before anything else (strict: call hours, no overlap, under the lock).
 * → { code, message } when the time cannot be had; null when it is held — or when the Calendar itself failed,
 * in which case bookAndConfirm tries again and writes the error on the inquiry, as before.
 */
async function holdSlot(id, inq, now) {
  const minutes = inq.slotEnd ? Math.round((Date.parse(inq.slotEnd) - Date.parse(inq.slotStart)) / 60e3) : 15;
  try {
    const cal = await import('@/lib/systems/calendar');
    await cal.bookSalesCall({
      inquiryId: id, company: inq.company, person: inq.name, email: inq.email, start: inq.slotStart, minutes,
      theirZone: inq.theirTz, note: inq.sells, linkedClientId: null,
    }, { now, strict: true });
    return null;
  } catch (err) {
    return err?.code ? { code: err.code, message: err.message } : null;
  }
}

/**
 * Everything after the visitor's answer: with a website, a client record held for the sales call (research +
 * fit score); then the owner's new_inquiry alert. Never throws. → { clientId } | {}
 */
async function afterSaved(id, rec, booked, { now = new Date() } = {}) {
  const inq = rec;
  try {
    const bookedLine = !inq.slotStart ? '' : booked?.emailed
      ? `\n\nIn your Calendar as a sales call. They were sent a confirmation email with a calendar invite; reminders go the day before and an hour before.${booked.clash ? `\nHeads up: it overlaps "${booked.clash.title}".` : ''}`
      : `\n\n${booked?.meeting ? 'In your Calendar as a sales call, but the' : 'The'} confirmation email did NOT go: ${booked?.error || 'unknown error'}. Write to them yourself.`;

    // With a website: a client record held for the sales call (research + fit score for the hub; nothing
    // goes to them). The owner's alert below is the one alert either way.
    const app = await holdForSalesCall(id, rec, { now });
    if (app?.clientId && booked?.meeting) { try { await (await import('@/lib/systems/calendar')).patchMeeting(booked.meeting.id, { linkedClientId: app.clientId }, { now }); } catch {} }

    const when = inq.whenHost ? `${inq.whenHost} (your time)` : 'no time picked';
    // Where they came from goes near the top, so it survives the phone's short preview too.
    const came = inq.cameFrom || cameFromText(inq);
    await alertOwner('new_inquiry', {
      scope: id,
      url: `/#inquiry/${id}`,
      vars: { company: inq.company, when },
      body: `${inq.name} <${inq.email}> from ${inq.company}${inq.plan ? ` asked about ${inq.plan[0].toUpperCase()}${inq.plan.slice(1)}` : ' asked about a plan'}.${came ? `\nCame from: ${came}` : ''}\nCall: ${when}${inq.whenTheirs ? ` — their time ${inq.whenTheirs}` : ''}\nThey sell: ${inq.sells}${inq.website ? `\nWebsite: ${inq.website}` : inq.noWebsite ? '\nWebsite: does not have one yet' : ''}${answersText(inq)}${bookedLine}`,
      did: booked?.emailed ? 'Saved under Plan call requests in the hub (stage: Booked) and sent them the confirmation. Press Won after the call to start onboarding.' : 'Saved under Plan call requests in the hub (stage: Booked). Press Won after the call to start onboarding.',
    }).catch(() => {});
    return app?.clientId ? { clientId: app.clientId } : {};
  } catch (err) {
    await logEvent(null, 'inquiries', 'after_save_failed', { id, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
  }
  return {};
}

/** Their five answers as alert lines ('' when the form had none). */
export function answersText(inq) {
  const rows = [['Phone', inq.phone], ['Role', inq.role], ['Deal size', inq.dealSize], ['Wins customers today', inq.channel], ['Calls a month they can take', inq.capacity], ['Wants to start', inq.timing], ['Tried outbound before', inq.tried], ['Wants from the call', inq.goal]].filter(([, v]) => v);
  return rows.length ? `\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}` : '';
}

/** The questions a paid request answers, as the application shows them. */
export function inquiryAnswers(inq) {
  const p = inferPlan(inq);
  const plan = !p ? 'Not picked (Starter assumed)' : `${p[0].toUpperCase()}${p.slice(1)}${inq.plan ? '' : ` (from “${inq.capacity}” calls a month)`}`;
  return [
    { q: 'Plan they asked for', a: plan },
    { q: 'What they sell', a: inq.sells || '—' },
    { q: 'Website', a: inq.website || (inq.noWebsite ? 'Does not have one yet' : '—') },
    ...(inq.phone ? [{ q: 'Phone', a: inq.phone }] : []),
    ...((inq.cameFrom || cameFromText(inq)) ? [{ q: 'Came from', a: inq.cameFrom || cameFromText(inq) }] : []),
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
 * A booking with a website → a client record on the plan they asked about, in `applied`, held for the sales
 * call (systems/gatekeeper.js addClient with `review`). Never throws: the booking stays saved either way, and
 * without a website (or on any error) it is a plain booking.
 */
export async function holdForSalesCall(id, inq, { now = new Date() } = {}) {
  if (!inq.website) return null;
  try {
    const { addClient } = await import('@/lib/systems/gatekeeper');
    const r = await addClient(
      { companyName: inq.company, contactName: inq.name, contactEmail: inq.email, website: inq.website, notes: inq.sells },
      { source: 'inquiry', plan: inferPlan(inq) || 'starter', now, review: { answers: inquiryAnswers(inq), fit: { verdict: 'unknown', summary: 'A booked sales call: read the fit score and the research before the call. Press Won on the booking to start onboarding.', lines: [] } } },
    );
    if (!r.ok || !r.clientId) return null;
    const extras = applicationExtras(inq);
    if (!r.duplicate && Object.keys(extras).length) { try { await kv.hset(K.application(r.clientId), extras); } catch { /* the score just asks instead */ } }
    await patch(id, { clientId: r.clientId, paid: true });
    await logEvent(null, 'inquiries', 'held_for_call', { id, clientId: r.clientId, outcome: r.outcome });
    return r;
  } catch (err) {
    await logEvent(null, 'inquiries', 'hold_failed', { id, error: String(err?.message || err).slice(0, 200) });
    return null;
  }
}

/**
 * Won: they become a paying client and onboarding starts (the one accepted_call email). The record held for
 * the call is used when there is one; otherwise one is made from the booking (it needs their website).
 * Throws when it cannot start — the booking then stays where it was. → { clientId, outcome, already? }
 */
export async function startClientFrom(inq, { now = new Date() } = {}) {
  const gk = await import('@/lib/systems/gatekeeper');
  if (inq.clientId) {
    const { getClient } = await import('@/lib/db/client');
    const c = await getClient(inq.clientId);
    if (c && c.state !== 'applied') return { clientId: inq.clientId, outcome: c.state, already: true };
    if (c) return { clientId: inq.clientId, ...(await gk.approveApplication(inq.clientId, { now })) };
  }
  if (!inq.website) throw new Error('This booking has no website. Add them with “Add a paying client” instead, with their website.');
  const r = await gk.addClient({ companyName: inq.company, contactName: inq.name, contactEmail: inq.email, website: inq.website, notes: inq.sells }, { source: 'inquiry', plan: inferPlan(inq) || 'starter', now });
  if (!r.ok) throw new Error(Object.values(r.errors || {})[0] || 'the client could not be made');
  if (r.duplicate) throw new Error('A client for this website was just made — reload and try again.');
  if (r.outcome === 'manual') throw new Error('The client was saved but onboarding did not start — see the alert.');
  return { clientId: r.clientId, outcome: r.outcome };
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
  // Won starts their onboarding first: if that fails, the booking stays where it was and the error goes back.
  let started = null;
  if (status === 'won' && cur.status !== 'won') started = await startClientFrom(cur, { now });
  if (status === 'lost' && cur.status !== 'lost' && cur.clientId) {
    try {
      const { getClient } = await import('@/lib/db/client');
      if ((await getClient(cur.clientId))?.state === 'applied') await (await import('@/lib/systems/gatekeeper')).declineApplication(cur.clientId, note, { now });
    } catch { /* the record stays; the booking still moves */ }
  }
  const notes = note ? [...(cur.notes || []), { at: now.toISOString(), text: s(note, 1000) }] : cur.notes || [];
  const rec = await patch(id, { ...(started?.clientId ? { clientId: started.clientId } : {}), status, statusAt: now.toISOString(), notes, stageHistory: [...(cur.stageHistory || []), { at: now.toISOString(), from: cur.status, to: status }].slice(-30) });
  await logEvent(null, 'inquiries', 'status', { id, status });
  // Call done / No-show here marks the sales call in the Calendar too (the Calendar's own buttons came the other way).
  if (!fromCalendar && (status === 'held' || status === 'no_show') && rec.meetingId) {
    try { await (await import('@/lib/systems/salescall')).meetingForStage(rec, status, { now }); } catch {}
  }
  // Won: the sales call clearly happened — a call still "confirmed" in the Calendar is marked done, so it never asks.
  if (!fromCalendar && status === 'won' && rec.meetingId) {
    try {
      const sc = await import('@/lib/systems/salescall');
      const m = await (await import('@/lib/systems/calendar')).getMeeting(rec.meetingId);
      if (m && m.kind === 'sales' && m.status === 'confirmed' && Date.parse(m.start) <= now.getTime()) await sc.meetingForStage(rec, 'held', { now });
    } catch {}
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

/** Board summary for the hub: counts + the newest open ones. */
export async function inquirySummary() {
  const { inquiries, counts } = await listInquiries({ limit: 100 });
  const open = inquiries.filter((q) => OPEN_STAGES.includes(q.status));
  return { counts, open: open.length, latest: open.slice(0, 5).map((q) => ({ id: q.id, at: q.at, name: q.name, company: q.company, plan: q.plan, status: q.status, slotStart: q.slotStart, whenHost: q.whenHost, clientId: q.clientId || null })) };
}

/**
 * The booking behind a client moves with it (a client added by hand from a booking's email, say): the plan
 * agreement signed → won. Only forward (a won or lost booking stays as it is); never starts anything. Never throws.
 */
export async function settleInquiryFor(clientId, status, note = '', { now = new Date() } = {}) {
  try {
    const { inquiries } = await listInquiries({ limit: 500 });
    const q = inquiries.find((x) => x.clientId === clientId);
    if (!q || q.status === status || ['won', 'lost'].includes(q.status)) return null;
    return await setInquiryStatus(q.id, status, note, { now });
  } catch { return null; }
}
