/**
 * Delivery monitoring (docs/IMPROVE-PASS.md C) — the owner's words: "The
 * invite email and the plan email should sound human and be well monitored."
 *
 * C.1 Every email that goes to the client's contact (any notifyClient
 * template) is tracked in client:{id}:mailtrack under its pixel key (16 hex
 * of the Message-ID made before the send): accepted (the SMTP server took
 * it), messageId, openedAt (the one open pixel — purpose `mail`, or the
 * onboarding / launch pixel carrying the same key), bouncedAt + bounceReason
 * (a DSN matched by the original Message-ID, else by the address and the
 * time — from the bounce checker and from the onboarding inbox's own scan),
 * repliedAt (a message from them whose In-Reply-To / References name it).
 * The hub's conversation entries carry it (deliveryView: status, statusAt,
 * statusText).
 *
 * C.2 The milestone emails (MILESTONES) are watched:
 *  - not sent (the SMTP send threw) → retried once after 10 minutes by the
 *    milestone's own sender (or the same email again), then the owner alert
 *    `client_email_failed`;
 *  - bounced → `client_email_bounced`;
 *  - not opened within 48 hours of US business days (weekends and US
 *    holidays do not count), and no sign they read it (a message from them,
 *    a booking or an approval after it) → the to-do "{firstName} hasn't
 *    opened the {what} email — call or text them?" (client hash
 *    `mailUnopened`, needsYou) and the quiet alert `client_email_unopened`.
 *    An open, a reply, a bounce or the owner's "done" clears it.
 * The watch runs inside the onboarding-call check (the `onboard-calls` job,
 * the hub's POST /api/mc/onboard-calls/check, Approve's after()); the client
 * hash's `mailWatchDueAt` says when a client next needs a look, so the job
 * costs nothing while no watch is due.
 *
 * Test Mode (`_test`: the "client" is the owner himself on a scaled clock)
 * is tracked but never gets the unopened to-do. No AI anywhere.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { getClient, getAllClients } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { ackAlerts } from '@/lib/notify';
import { normId, dsnSeverity, extractBouncedAddress, bounceReason, originalMessageId } from '@/lib/mail-utils';
import { io, asObject, firstNameOf } from '@/lib/systems/intake-io';
import { shortHash, lower, zonedToUtc, isBusinessDayKey } from '@/lib/systems/stagec-common';
import { partsIn, addDays, ET, OWNER_TZ } from '@/lib/time';

const SYSTEM = 'mailwatch';
const TEST_ID = '_test';

/** The watch's clock (minutes / hours): retry once after `retryMinutes`; look for a bounce `bounceLookMinutes` after the send; the to-do after `unopenedHours` of US business days. */
export const WATCH = { retryMinutes: 10, bounceLookMinutes: 20, unopenedHours: 48, keep: 200, pruneOver: 250 };

/**
 * The milestone emails (template key → how the owner names it: "{firstName}
 * hasn't opened the {what} email"). `report_day29` is trial_report(_zero),
 * `decision` is decision_link(_zero).
 */
export const MILESTONES = {
  accepted_call: { what: 'acceptance' },
  next_steps: { what: '“what happens now”' },
  launch_invite: { what: 'launch-call invite' },
  welcome_two_dates: { what: '“we start on”' },
  day1_moved: { what: 'new start date' },
  trial_report: { what: 'Day 29 report' },
  trial_report_zero: { what: 'Day 29 report' },
  decision_link: { what: 'decision' },
  decision_link_zero: { what: 'decision' },
};
export const isMilestone = (key) => Object.prototype.hasOwnProperty.call(MILESTONES, key);
export const whatOf = (key) => MILESTONES[key]?.what || String(key || 'last');

/** Templates that never carry the open pixel: the owner's own words and the reply bot's answers read as a person's reply. */
export const NO_PIXEL = new Set(['onboard_owner_reply', 'bot_reply']);

// ─── small helpers ───────────────────────────────────────────────────────────

const ms = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const isoOrNull = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const flag = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0' && v !== false && v !== 'false';

/** The pixel key of an email: 16 hex of its Message-ID as sent ('<…@…>'). */
export const trackKeyOf = (messageId) => shortHash(String(messageId || ''));
/** The conversation entry id every sender gives an outgoing email ('out-' + 16 hex of res.messageId). */
export const entryIdOf = (messageId) => `out-${shortHash(String(messageId || ''))}`;
const bracketId = (id) => (id ? `<${String(id).trim().replace(/^<|>$/g, '')}>` : null);

// ─── time (pure) ─────────────────────────────────────────────────────────────

/** Midnight US Eastern at the start of `dayKey` (ms). */
const etMidnight = (dayKey) => { const [y, m, d] = dayKey.split('-').map(Number); return zonedToUtc(y, m, d, 0, 0, 0, ET).getTime(); };

/**
 * `hours` later, counting only US business days (US Eastern; weekends and US
 * holidays do not count). Tue 10:00 + 48 → Thu 10:00; Fri 10:00 + 48 → Tue 10:00.
 */
export function businessHoursLater(from, hours = WATCH.unopenedHours) {
  let t = ms(from);
  if (t == null) return null;
  let left = hours * 3600e3;
  for (let i = 0; i < 90 && left > 0; i++) {
    const day = partsIn(ET, new Date(t)).dayKey;
    const next = etMidnight(addDays(day, 1));
    if (isBusinessDayKey(day)) {
      if (left <= next - t) return t + left;
      left -= next - t;
    }
    t = next;
  }
  return t;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let ownerFmt = null;
/** 'Tue 8:10 pm' in the owner's zone (the hub is read by him); older than 6 days: 'Tue 29 Sep, 8:10 pm'. */
export function ownerShort(v, now = new Date()) {
  const t = ms(v);
  if (t == null) return '';
  ownerFmt ||= new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const p = Object.fromEntries(ownerFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const clock = p.minute === '00' && p.hour === '12' ? (String(p.dayPeriod).toLowerCase() === 'am' ? 'midnight' : 'noon') : `${p.minute === '00' ? p.hour : `${p.hour}:${p.minute}`} ${String(p.dayPeriod).toLowerCase()}`;
  const recent = Math.abs(ms(now) - t) < 6 * 864e5;
  return recent ? `${p.weekday} ${clock}` : `${p.weekday} ${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${clock}`;
}

// ─── the status of one email (pure) ──────────────────────────────────────────

/** One state from the times: replied > bounced > opened > delivered (the SMTP server took it) > sent. */
export function statusOf(rec) {
  const r = asObject(rec) || {};
  if (flag(r.repliedAt)) return { status: 'replied', statusAt: isoOrNull(r.repliedAt) };
  if (flag(r.bouncedAt)) return { status: 'bounced', statusAt: isoOrNull(r.bouncedAt) };
  if (flag(r.openedAt)) return { status: 'opened', statusAt: isoOrNull(r.openedAt) };
  if (r.accepted === true || r.accepted === 'true') return { status: 'delivered', statusAt: isoOrNull(r.at) };
  return { status: 'sent', statusAt: isoOrNull(r.at) };
}

/**
 * What a conversation entry carries about its delivery (docs/HUB-API.md
 * "Conversation entries"), pure. `rec` = its tracking record (null for an
 * email from before tracking, and for their messages: `dir` 'in').
 */
export function deliveryView(rec, entry = {}, now = new Date()) {
  const none = { accepted: null, messageId: null, openedAt: null, bouncedAt: null, bounceReason: null, repliedAt: null, milestone: false, unopenedAt: null };
  if (entry.dir === 'in') return { ...none, status: null, statusAt: null, statusText: null };
  const r = asObject(rec);
  if (!r) {
    const at = isoOrNull(entry.at);
    return { ...none, status: 'sent', statusAt: at, statusText: at ? `sent ${ownerShort(at, now)}` : 'sent' };
  }
  const { status, statusAt } = statusOf(r);
  const when = ownerShort(statusAt, now);
  const statusText = {
    replied: `replied ${when}`,
    bounced: `bounced ${when}`,
    opened: `delivered · opened ${when}`,
    delivered: flag(r.pixel) ? 'delivered · not opened yet' : 'delivered',
    sent: `sent ${when}`,
  }[status];
  return {
    accepted: r.accepted === true || r.accepted === 'true',
    messageId: r.messageId || null,
    openedAt: isoOrNull(r.openedAt),
    bouncedAt: isoOrNull(r.bouncedAt),
    bounceReason: flag(r.bouncedAt) ? r.bounceReason || null : null,
    repliedAt: isoOrNull(r.repliedAt),
    milestone: Boolean(r.milestone),
    unopenedAt: isoOrNull(asObject(r.watch)?.unopenedAt),
    status, statusAt, statusText,
  };
}

/** Tracking records by conversation entry id (what entryView merges). */
export function recordsById(track) {
  const out = new Map();
  for (const v of Object.values(track || {})) { const r = asObject(v); if (r && r.id) out.set(r.id, r); }
  return out;
}

// ─── matching (pure) ─────────────────────────────────────────────────────────

/**
 * The email a DSN is about: the one whose Message-ID it names, else the
 * newest one to that address sent within 3 days before the bounce (5 minutes
 * of clock slack) that has not bounced yet.
 */
export function pickBounced(records, { email, messageId = null, at = null } = {}) {
  const list = (records || []).map(asObject).filter(Boolean);
  const id = normId(messageId);
  if (id) {
    const hit = list.find((r) => normId(r.messageId) === id);
    if (hit) return hit;
  }
  const to = lower(email);
  const t = ms(at) ?? Date.now();
  return list
    .filter((r) => lower(r.to) === to && !flag(r.bouncedAt) && ms(r.at) != null && ms(r.at) <= t + 5 * 60e3 && t - ms(r.at) <= 3 * 864e5)
    .sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
}

/** The email a reply answers: the first of its thread ids (In-Reply-To first, then References) that is one of ours. */
export function pickReplied(records, threadIds = []) {
  const byId = new Map((records || []).map(asObject).filter(Boolean).map((r) => [normId(r.messageId), r]));
  for (const x of threadIds || []) {
    const r = byId.get(normId(x));
    if (r) return r;
  }
  return null;
}

/**
 * Where one milestone email's watch stands at `now`, pure:
 *  { done: why } — opened, replied, bounced, no pixel to wait for, or a sign
 *    they read it (`theyWroteAt`: a message from them after it; `actedAt`: a
 *    booking, a time asked for or an approval after it);
 *  { wait: ms } — look again then (the bounce look, then the 48 h mark);
 *  { unopened: true } — the to-do.
 */
export function watchStep(rec, now, { theyWroteAt = null, actedAt = null } = {}) {
  const r = asObject(rec) || {};
  const w = asObject(r.watch) || {};
  if (flag(w.doneAt)) return { done: w.done || 'done' };
  if (flag(r.repliedAt)) return { done: 'replied' };
  if (flag(r.bouncedAt)) return { done: 'bounced' };
  if (flag(r.openedAt)) return { done: 'opened' };
  const t = ms(now);
  const look = ms(w.bounceLookAt);
  const due = ms(w.unopenedDueAt);
  const sent = ms(r.at) ?? 0;
  if (ms(theyWroteAt) > sent) return { done: 'they wrote' };
  if (ms(actedAt) > sent) return { done: 'they acted on it' };
  if (due == null) return look != null && t < look ? { wait: look } : { done: 'no open pixel' };
  if (t < due) return { wait: look != null && t < look ? look : due };
  return { unopened: true };
}

// ─── storage ─────────────────────────────────────────────────────────────────

/** The tracking records of one client (key → record). */
export async function readTrack(clientId) {
  const raw = (await kv.hgetall(K.mailTrack(clientId))) || {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, asObject(v)]).filter(([, v]) => v));
}

async function saveRec(clientId, rec) {
  await kv.hset(K.mailTrack(clientId), { [rec.key]: JSON.stringify(rec) });
}

/** The client needs a look at `t` (ms): the earliest wins. */
async function wakeAt(clientId, t) {
  if (t == null) return;
  const cur = ms(await kv.hget(K.client(clientId), 'mailWatchDueAt'));
  if (cur == null || t < cur) await kv.hset(K.client(clientId), { mailWatchDueAt: new Date(t).toISOString() });
}

/** Keep the newest WATCH.keep records once there are more than WATCH.pruneOver (one HLEN per email). */
async function prune(clientId) {
  const n = Number(await kv.hlen(K.mailTrack(clientId))) || 0;
  if (n <= WATCH.pruneOver) return;
  const old = Object.values(await readTrack(clientId)).sort((a, b) => (ms(a.at) || 0) - (ms(b.at) || 0)).slice(0, n - WATCH.keep).map((r) => r.key);
  if (old.length) await kv.hdel(K.mailTrack(clientId), ...old);
}

// ─── notifyClient's hooks ────────────────────────────────────────────────────

/**
 * An email went to the client's contact (notifyClient, after the SMTP
 * server took it). A milestone also starts its watch and clears a failed
 * send of the same template. Never throws — the email already went.
 */
export async function noteSent(clientId, template, res, { key, at = io.now(), pixel = false } = {}) {
  try {
    assertClientId(clientId);
    const sentAt = ms(at) ?? Date.now();
    const rec = {
      key: key || trackKeyOf(res?.messageId), id: entryIdOf(res?.messageId), messageId: bracketId(res?.messageId), template,
      to: lower(res?.to), from: res?.from || null, at: new Date(sentAt).toISOString(), accepted: res?.accepted !== false, pixel: Boolean(pixel),
      ...(Array.isArray(res?.rejected) && res.rejected.length ? { rejected: res.rejected.map(String).slice(0, 5) } : {}),
    };
    const milestone = isMilestone(template);
    if (milestone) {
      rec.milestone = true;
      rec.watch = {
        bounceLookAt: new Date(sentAt + WATCH.bounceLookMinutes * 60e3).toISOString(),
        // Only with a pixel can "not opened" mean anything; never for Test Mode (the contact is the owner).
        unopenedDueAt: pixel && clientId !== TEST_ID ? new Date(businessHoursLater(sentAt)).toISOString() : null,
      };
    }
    await saveRec(clientId, rec);
    if (milestone) {
      await kv.hdel(K.mailRetry(clientId), template);
      await wakeAt(clientId, ms(rec.watch.bounceLookAt));
    }
    await prune(clientId);
    return rec;
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'track_failed', { template, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    return null;
  }
}

/** What a retry needs to send the same email again (attachments are not kept: the report's retry renders it again). */
function retryOpts(opts = {}) {
  const keep = ['to', 'from', 'dedupe', 'pixel', 'linkify', 'inReplyTo', 'references', 'thread', 'icalEvent', 'moment', 'resend'];
  return Object.fromEntries(keep.filter((k) => opts[k] !== undefined && opts[k] !== null).map((k) => [k, opts[k]]));
}

/**
 * A milestone email could not be sent (notifyClient, before it throws): kept
 * for one retry after WATCH.retryMinutes. A failure during that retry only
 * records itself — the watch then alerts. Never throws.
 */
export async function noteFailed(clientId, template, { vars = {}, opts = {}, error = '', at = io.now() } = {}) {
  if (!isMilestone(template)) return null;
  try {
    assertClientId(clientId);
    const t = ms(at) ?? Date.now();
    const cur = asObject(await kv.hget(K.mailRetry(clientId), template));
    if (cur && cur.retrying) {
      await kv.hset(K.mailRetry(clientId), { [template]: JSON.stringify({ ...cur, error: String(error).slice(0, 300), failedAgainAt: new Date(t).toISOString() }) });
      return cur;
    }
    const spec = { key: template, vars, opts: retryOpts(opts), error: String(error).slice(0, 300), failedAt: new Date(t).toISOString(), retryAt: new Date(t + WATCH.retryMinutes * 60e3).toISOString() };
    await kv.hset(K.mailRetry(clientId), { [template]: JSON.stringify(spec) });
    await wakeAt(clientId, ms(spec.retryAt));
    await logEvent(clientId, SYSTEM, 'send_failed', { template, error: spec.error, retryAt: spec.retryAt });
    return spec;
  } catch (err) {
    console.error('[mailwatch] could not keep the failed send', clientId, template, err?.message);
    return null;
  }
}

// ─── opens, replies, bounces ─────────────────────────────────────────────────

/**
 * Their open of one email (the pixel route; scanners and prefetches are set
 * aside there): openedAt once, opens counted. → true on the first open.
 */
export async function markMailOpened(clientId, key, email, { now = new Date() } = {}) {
  try { assertClientId(clientId); } catch { return false; }
  if (!/^[0-9a-f]{16}$/.test(String(key || ''))) return false;
  const rec = asObject(await kv.hget(K.mailTrack(clientId), key));
  if (!rec || lower(rec.to) !== lower(email)) return false;
  const first = !flag(rec.openedAt);
  await saveRec(clientId, { ...rec, opens: (Number(rec.opens) || 0) + 1, ...(first ? { openedAt: now.toISOString() } : {}) });
  if (first) {
    await clearUnopened(clientId, { key, reason: 'opened', now });
    await logEvent(clientId, SYSTEM, 'opened', { template: rec.template });
  }
  return first;
}

/**
 * The "hasn't opened" to-do is done: they opened that email (`key`), wrote
 * after it was sent (`before`: their message's time), it bounced, or the
 * owner reached them. Its quiet alert is acknowledged with it.
 */
export async function clearUnopened(clientId, { key = null, before = null, reason = 'handled', now = new Date() } = {}) {
  const un = asObject(await kv.hget(K.client(clientId), 'mailUnopened'));
  if (!un) return false;
  if (key && un.key !== key) return false;
  if (before && !((ms(un.sentAt) || 0) <= (ms(before) || 0))) return false;
  await kv.hdel(K.client(clientId), 'mailUnopened');
  await ackAlerts(clientId, ['client_email_unopened'], { reason, now });
  await logEvent(clientId, SYSTEM, 'unopened_cleared', { template: un.template, reason });
  return true;
}

/** The owner's "done" on the to-do (POST /api/mc/clients/{id}/messages { action: 'unopenedDone' }). */
export async function unopenedDone(clientId, { now = io.now() } = {}) {
  assertClientId(clientId);
  return clearUnopened(clientId, { reason: 'you reached them', now });
}

/**
 * A message from them reached the onboarding inbox (onboardcall.recordReply):
 * the email it threads to is replied; a "hasn't opened" to-do for an email
 * sent before it is done (they are in touch). Never throws.
 */
export async function noteReply(clientId, { threadIds = [], at = null, now = io.now() } = {}) {
  try {
    const when = isoOrNull(at) || now.toISOString();
    const rec = pickReplied(Object.values(await readTrack(clientId)), threadIds);
    // A reply means they read it: openedAt is set then when no pixel came first (a later pixel is not the first open).
    if (rec && !flag(rec.repliedAt)) await saveRec(clientId, { ...rec, repliedAt: when, ...(flag(rec.openedAt) ? {} : { openedAt: when, openedBy: 'reply' }) });
    await clearUnopened(clientId, { before: when, reason: 'they wrote', now });
    return rec;
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'reply_track_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    return null;
  }
}

/** Owner alert that never throws. */
async function alert(key, opts) {
  try { return await io.alertOwner(key, opts); } catch (err) { console.error('[mailwatch] alert failed', key, err?.message); return { sent: false }; }
}
const personOf = (client) => firstNameOf(client?.contactName) || client?.contactName || client?.name || client?.id || 'They';

/**
 * A hard bounce of an email to this client's contact: marked on the email it
 * is about (pickBounced); a milestone raises `client_email_bounced`.
 * → the record, or null when nothing of ours matched.
 */
export async function noteBounce(clientId, { email, reason = 'undeliverable', messageId = null, at = null, source = null } = {}, { now = io.now(), client = null } = {}) {
  assertClientId(clientId);
  const rec = pickBounced(Object.values(await readTrack(clientId)), { email, messageId, at: at || now });
  if (!rec || flag(rec.bouncedAt)) return null;
  const bouncedAt = isoOrNull(at) || now.toISOString();
  const next = { ...rec, bouncedAt, bounceReason: String(reason || 'undeliverable').slice(0, 200) };
  await saveRec(clientId, next);
  await logEvent(clientId, SYSTEM, 'bounced', { template: rec.template, to: rec.to, reason: next.bounceReason, source });
  await clearUnopened(clientId, { key: rec.key, reason: 'bounced', now });
  if (rec.milestone) {
    const c = client || await getClient(clientId);
    const what = whatOf(rec.template);
    await alert('client_email_bounced', {
      clientId,
      scope: `${clientId}:bounce:${rec.key}`,
      vars: { person: personOf(c), what },
      body: `The ${what} email to ${c?.contactName || rec.to} (${rec.to}) bounced: ${next.bounceReason}.\nIt was sent ${ownerShort(rec.at, now)} (your time).`,
      did: 'Marked it bounced in their conversation. Nothing else goes to that address by itself until it is fixed — call or text them, check the address, and correct it on their trial.',
      url: `/#trial/${clientId}`,
    });
  }
  return next;
}

/** Client contact address → client ids (a DSN names only the address). */
function contactIndex(clients) {
  const idx = new Map();
  for (const c of clients || []) {
    if (!c || !c.contactEmail || c.state === 'deleted') continue;
    const e = lower(c.contactEmail);
    if (!idx.has(e)) idx.set(e, []);
    idx.get(e).push(c);
  }
  return idx;
}

/**
 * The bounce checker's hard bounces (api/cron/check-bounces): those whose
 * failed address is a client's contact are matched to that client's emails.
 * items: [{ email, reason, date, originalMessageId? }] → how many matched.
 */
export async function noteClientBounces(items = [], { now = io.now(), clients = null } = {}) {
  if (!items.length) return 0;
  const idx = contactIndex(clients || await getAllClients());
  let n = 0;
  for (const item of items) {
    for (const c of idx.get(lower(item.email)) || []) {
      try {
        if (await noteBounce(c.id, { email: item.email, reason: item.reason, messageId: item.originalMessageId || null, at: item.date || null, source: 'bounce-scan' }, { now, client: c })) n++;
      } catch (err) {
        await logEvent(c.id, SYSTEM, 'bounce_match_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
      }
    }
  }
  return n;
}

/**
 * One DSN found in the onboarding inbox's scan (onboardcall.scanInbox; its
 * text part was downloaded): a hard bounce naming a client's contact → that
 * client's email. `clients`: the clients the scan knows. → the record or null.
 */
export async function noteDsn(meta, clients, { now = io.now(), own = [] } = {}) {
  const text = String(meta?.text || '');
  if (!text || dsnSeverity(text, meta.subject) !== 'hard') return null;
  const failed = extractBouncedAddress(text, new Set((own || []).map(lower)));
  if (!failed) return null;
  let hit = null;
  for (const c of contactIndex(clients).get(lower(failed)) || []) {
    const r = await noteBounce(c.id, { email: failed, reason: bounceReason(text), messageId: originalMessageId(text, meta.messageId), at: meta.date || null, source: 'onboard-inbox' }, { now, client: c });
    hit = hit || r;
  }
  return hit;
}

// ─── the retry (C.2) ─────────────────────────────────────────────────────────

/**
 * The same email, once more, by the milestone's own sender where it has one
 * (it keeps its own records: the call's times, the trial's flags); `already`
 * = it went meanwhile, `later` = it waits for the daytime, `skipped` = it
 * cannot go by itself (the owner's alert says why).
 */
const RETRY = {
  async accepted_call(id, spec, now) {
    const c = await getClient(id);
    if (!c) return { skipped: 'the client is gone' };
    if (c.state === 'queued') { await (await import('@/lib/systems/gatekeeper')).startOnboarding(id, { now }); return { retried: true }; }
    if (c.state === 'onboarding') {
      const oc = await import('@/lib/systems/onboardcall');
      const raw = await oc.readCall(id);
      if (flag(raw.sentAt) && !spec.opts?.resend) return { already: true };
      if (!spec.vars?.onboardingLink) return { skipped: 'the onboarding link was not kept' };
      await oc.sendAcceptance(id, { onboardingLink: spec.vars.onboardingLink, now, resend: flag(raw.sentAt) });
      return { retried: true };
    }
    if (c.state === 'applied') return { skipped: 'the application is still waiting — press Approve again once the inbox works' };
    return { already: true };
  },
  async launch_invite(id, spec, now) {
    const r = await (await import('@/lib/systems/launchcall')).sendLaunchInvite(id, { now, resend: Boolean(spec.opts?.resend) });
    return r.already ? { already: true } : { retried: true };
  },
  async next_steps(id, spec, now) {
    const r = await (await import('@/lib/systems/launchcall')).sendNextSteps(id, { now, moment: spec.opts?.moment || 'call' });
    return r.already ? { already: true } : { retried: true };
  },
  async welcome_two_dates(id, spec, now) {
    const r = await (await import('@/lib/systems/startemail')).sendStartEmail(id, { now });
    if (r.sent) return { retried: true };
    if (r.already) return { already: true };
    if (r.waiting) return { later: r.waiting };
    return { skipped: r.skipped || 'Day 1 is not fixed' };
  },
  async trial_report(id, spec, now) {
    const r = await (await import('@/lib/systems/trialmanager')).sendTrialReport(id, now);
    return r.held ? { skipped: `the report is held (${r.held})` } : { retried: true };
  },
};
RETRY.trial_report_zero = RETRY.trial_report;

/** The same template with the same words, links and thread (the decision email, the Day 1 move). */
async function resendAsIs(id, spec, now) {
  const { notifyClient } = await import('@/lib/notify');
  const res = await notifyClient(id, spec.key, spec.vars || {}, { ...(spec.opts || {}), now });
  if (res?.deduped) return { already: true };
  if (res?.error) throw new Error(res.error);
  if (String(spec.key).startsWith('decision_link')) await kv.hset(K.trial(id), { decisionEmailAt: now.toISOString() });
  return { retried: true };
}

const FIX_HINT = {
  accepted_call: 'check the sending inbox in Settings, then press Approve again (or Send it again on their trial)',
  launch_invite: 'check the sending inbox in Settings, then press Send the invite again on their trial',
};

/** One retry: sent → nothing more; not sent → `client_email_failed`. */
async function retryOne(client, spec, now) {
  const id = client.id;
  await kv.hset(K.mailRetry(id), { [spec.key]: JSON.stringify({ ...spec, retrying: true, retriedAt: now.toISOString() }) });
  let outcome = null;
  let error = null;
  try {
    outcome = await (RETRY[spec.key] || resendAsIs)(id, spec, now);
  } catch (err) {
    error = String(err?.message || err).slice(0, 300);
  }
  const left = asObject(await kv.hget(K.mailRetry(id), spec.key));
  await kv.hdel(K.mailRetry(id), spec.key);
  if (!error && (!left || outcome?.retried || outcome?.already || outcome?.later)) {
    await logEvent(id, SYSTEM, 'retried', { template: spec.key, outcome: outcome ? Object.keys(outcome)[0] : 'sent' });
    return 'sent';
  }
  const what = whatOf(spec.key);
  const why = error || left?.error || outcome?.skipped || spec.error || 'the send failed';
  await alert('client_email_failed', {
    clientId: id,
    scope: `${id}:failed:${spec.key}:${spec.failedAt}`,
    vars: { person: personOf(client), what },
    body: `The ${what} email to ${client.contactName || client.contactEmail} (${client.contactEmail}) could not be sent — first at ${ownerShort(spec.failedAt, now)} (your time), and again 10 minutes later.\nWhy: ${why}`,
    did: `Tried twice; nothing more is tried by itself. ${FIX_HINT[spec.key] ? `To fix: ${FIX_HINT[spec.key]}.` : 'Check the sending inbox in Settings, then write to them from their trial (Messages) — or call them.'}`,
    url: `/#trial/${id}`,
  });
  await logEvent(id, SYSTEM, 'retry_failed', { template: spec.key, error: why });
  return 'failed';
}

// ─── the watch ───────────────────────────────────────────────────────────────

/**
 * Signs they read a milestone email without its pixel: their newest message;
 * for the two call emails also the call's own open (a reminder's pixel), a
 * booking, a time asked for, the call held, an approval on the page — or the
 * owner's Stop reminders (he took it over).
 */
async function evidenceFor(clientId, rec) {
  const out = { theyWroteAt: null, actedAt: null };
  try {
    out.theyWroteAt = (await kv.hget(K.convo(clientId), 'lastInAt')) || null;
    if (rec.template === 'accepted_call' || rec.template === 'launch_invite') {
      const raw = (await kv.hgetall(K.callHash(clientId, rec.template === 'launch_invite' ? 'launch' : 'onboarding'))) || {};
      const times = ['openedAt', 'firstReplyAt', 'lastReplyAt', 'bookedAt', 'firstRequestAt', 'requestedAt', 'heldAt', 'approvedOnPage', 'stoppedAt'].map((k) => ms(raw[k])).filter((t) => t != null);
      out.actedAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
    }
  } catch { /* no evidence: the rule decides on the pixel alone */ }
  return out;
}

/** Client states in which a "hasn't opened" to-do no longer matters (the trial is over). */
const TRIAL_OVER = new Set(['declined', 'closed_silent', 'deleted', 'retired', 'not_now', 'converted']);

/** One client's watch: retries due, milestone emails due, then when to look next. */
async function watchClient(client, now) {
  const id = client.id;
  const out = { retried: 0, failed: 0, unopened: 0 };
  const t = now.getTime();
  const retries = Object.values((await kv.hgetall(K.mailRetry(id))) || {}).map(asObject).filter(Boolean);
  for (const spec of retries) {
    if (spec.retrying || (ms(spec.retryAt) ?? 0) > t) continue;
    if ((await retryOne(client, spec, now)) === 'sent') out.retried++; else out.failed++;
  }
  const track = await readTrack(id);
  for (const rec of Object.values(track)) {
    if (!rec.milestone || !rec.watch || flag(rec.watch.doneAt)) continue;
    let step = watchStep(rec, now);
    if (step.unopened) step = TRIAL_OVER.has(client.state) ? { done: 'the trial is over' } : watchStep(rec, now, await evidenceFor(id, rec));
    if (step.wait) continue;
    const watch = { ...rec.watch, doneAt: now.toISOString(), done: step.unopened ? 'unopened' : step.done, ...(step.unopened ? { unopenedAt: now.toISOString() } : {}) };
    track[rec.key] = { ...rec, watch };
    await saveRec(id, track[rec.key]);
    if (!step.unopened) continue;
    out.unopened++;
    const what = whatOf(rec.template);
    await kv.hset(K.client(id), { mailUnopened: JSON.stringify({ key: rec.key, template: rec.template, what, sentAt: rec.at, since: now.toISOString() }) });
    await alert('client_email_unopened', {
      clientId: id,
      scope: `${id}:unopened:${rec.key}`,
      vars: { person: personOf(client), what },
      body: `${client.contactName || client.contactEmail} (${client.name || id}) has not opened the ${what} email sent ${ownerShort(rec.at, now)} (your time) — two business days ago — and has not written since.`,
      did: 'It is a to-do on their trial: call or text them, then press it when you have reached them. It clears itself if they open it or write.',
      url: `/#trial/${id}`,
    });
    await logEvent(id, SYSTEM, 'unopened', { template: rec.template, sentAt: rec.at });
  }
  // When to look next: the earliest retry still waiting, the earliest open watch's next step.
  const next = [];
  for (const spec of Object.values((await kv.hgetall(K.mailRetry(id))) || {}).map(asObject).filter(Boolean)) next.push(ms(spec.retryAt));
  for (const rec of Object.values(track)) {
    if (!rec.milestone || !rec.watch || flag(rec.watch.doneAt)) continue;
    const s = watchStep(rec, now);
    if (s.wait) next.push(s.wait);
  }
  const soon = next.filter((x) => x != null);
  if (soon.length) await kv.hset(K.client(id), { mailWatchDueAt: new Date(Math.max(Math.min(...soon), t + 60e3)).toISOString() });
  else await kv.hdel(K.client(id), 'mailWatchDueAt');
  return out;
}

/**
 * The delivery watch (run by checkOnboardCalls): every client whose
 * `mailWatchDueAt` has come. → { due, retried, failed, unopened }.
 */
export async function runMailWatch({ now = io.now(), clients = null } = {}) {
  const all = clients || await getAllClients();
  const due = (all || []).filter((c) => c && c.id !== 'aviance' && ms(c.mailWatchDueAt) != null && ms(c.mailWatchDueAt) <= now.getTime());
  const out = { due: due.length, retried: 0, failed: 0, unopened: 0 };
  for (const c of due) {
    try {
      const fresh = (await getClient(c.id)) || c;
      const r = await watchClient(fresh, now);
      out.retried += r.retried; out.failed += r.failed; out.unopened += r.unopened;
    } catch (err) {
      await logEvent(c.id, SYSTEM, 'watch_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    }
  }
  return out;
}
