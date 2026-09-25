/**
 * Plan inquiries: people who want a paid plan (Starter / Growth / Scale)
 * without a trial. The website's "Book a call" form (aviance.online) posts
 * here; each inquiry lands in the hub's Inquiries section and pops up on the
 * owner's phone. The owner moves it along: new → contacted → won / lost, can
 * add notes, or turn it into a trial (runs the Gatekeeper, pre-approved).
 *
 * Storage: `inquiries` hash (id → record) + `inquiries:order` list (newest
 * first, capped). Nothing here emails the enquirer.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';

export const STATUSES = ['new', 'contacted', 'won', 'lost'];
const CAP = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLANS = ['starter', 'growth', 'scale'];

const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);
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

  const when = inq.whenHost ? `${inq.whenHost} (your time)` : 'no time picked';
  await alertOwner('new_inquiry', {
    scope: id,
    url: `/#inquiry/${id}`,
    vars: { company: inq.company, when },
    body: `${inq.name} <${inq.email}> from ${inq.company}${inq.plan ? ` asked about ${inq.plan[0].toUpperCase()}${inq.plan.slice(1)}` : ' asked about a plan'}.\nCall: ${when}${inq.whenTheirs ? ` — their time ${inq.whenTheirs}` : ''}\nThey sell: ${inq.sells}${inq.website ? `\nWebsite: ${inq.website}` : ''}`,
    did: 'Saved under Inquiries in the hub. Nothing was sent to them.',
  }).catch(() => {});
  return { ok: true, id };
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

async function patch(id, fields) {
  const cur = await getInquiry(id);
  if (!cur) throw new Error('inquiry not found');
  const next = { ...cur, ...fields };
  await kv.hset(K.inquiries(), { [id]: next });
  return next;
}

export async function setInquiryStatus(id, status, note = '', { now = new Date() } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const cur = await getInquiry(id);
  if (!cur) throw new Error('inquiry not found');
  const notes = note ? [...(cur.notes || []), { at: now.toISOString(), text: s(note, 1000) }] : cur.notes || [];
  const rec = await patch(id, { status, statusAt: now.toISOString(), notes });
  await logEvent(null, 'inquiries', 'status', { id, status });
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
  const open = inquiries.filter((q) => q.status === 'new' || q.status === 'contacted');
  return { counts, open: open.length, latest: open.slice(0, 5).map((q) => ({ id: q.id, at: q.at, name: q.name, company: q.company, plan: q.plan, status: q.status, slotStart: q.slotStart, whenHost: q.whenHost })) };
}
