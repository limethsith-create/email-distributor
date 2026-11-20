/**
 * Notifier (SPEC §10.2) — the only module that emails a human.
 *
 * Owner alerts appear only inside the hub (the bell and the alert list): there
 * is no email, phone push or Telegram to the owner. Every alert is deduped per
 * day on system:alerts:{date} and recorded in system:alerts:log and the event log.
 * Client emails (notifyClient below) are unchanged: they go from OWNER_INBOX
 * (format `email:app-password:Name`, falling back to the first aviance sending inbox).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { sendEmail, newMessageId } from '@/lib/mailer';
import { parseAccount, getSmtpAccounts, loadAccounts, findSmtpAccount } from '@/lib/smtp-accounts';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import { dayKeyIn, partsIn, OWNER_TZ } from '@/lib/time';
import { cfg } from '@/lib/config';
import { onboardPixelUrl, mailPixelUrl } from '@/lib/tokens';

/** The plan's name for an email: Starter, Growth or Scale (anything else — an old 'trial' record — reads as Starter). */
export function planNameOf(plan) {
  const p = String(plan || '').toLowerCase();
  return p === 'growth' ? 'Growth' : p === 'scale' ? 'Scale' : 'Starter';
}

const LOG_CAP = 1000;

export function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://email-distributor.vercel.app').replace(/\/+$/, '');
}

export async function ownerSender() {
  const own = parseAccount(process.env.OWNER_INBOX || '');
  if (own) return own;
  await loadAccounts();
  return getSmtpAccounts()[0] || null;
}

/**
 * The ONE inbox that sends the onboarding-call emails and receives the
 * replies (docs/ONBOARD-CALL.md): ONBOARDCALL.inbox, else the owner sender.
 * A set address the machine cannot log into is an error, never a silent
 * switch to another inbox (the applicant would reply to the wrong place).
 */
export async function onboardSender() {
  let wanted = await cfg(null, 'ONBOARDCALL.inbox');
  if (!wanted) wanted = (await cfg(null, 'ONBOARDCALL'))?.inbox || null;
  wanted = String(wanted || '').trim().toLowerCase();
  const owner = await ownerSender();
  if (!wanted || (owner && owner.email === wanted)) return owner;
  await loadAccounts();
  const found = findSmtpAccount(wanted);
  if (found) return found;
  throw new Error(`ONBOARDCALL.inbox ${wanted} is not an inbox the machine can log into — add it (with its password) as an Aviance inbox, or clear the setting`);
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Raise an owner alert.
 * @param {string} key      catalogue key (templates/owner.js)
 * @param {object} opts     { clientId, vars, body, did, scope, force }
 *   vars  fill the catalogue title
 *   body  what happened (plain text)
 *   did   what the system already did (one line)
 *   scope dedupe scope (default clientId or 'global')
 *   url   (unused, kept so callers need no change)
 * @returns {{sent:boolean, deduped?:boolean, id?:string}}
 */
export async function alertOwner(key, { clientId = null, vars = {}, body = '', did = '', scope = null, force = false, url = null } = {}) {
  const spec = ALERTS[key];
  if (!spec) throw new Error(`unknown alert ${key}`);
  const now = new Date();
  const day = dayKeyIn(OWNER_TZ, now);
  const dedupeScope = scope || clientId || 'global';
  const period = spec.everyHour ? `${day}T${String(partsIn(OWNER_TZ, now).hour).padStart(2, '0')}` : day;
  const dedupeKey = `${key}:${dedupeScope}:${period}`;

  if (!force) {
    try {
      const added = await kv.sadd(K.alertsDay(day), dedupeKey);
      await kv.expire(K.alertsDay(day), 3 * 86400);
      if (!added) return { sent: false, deduped: true };
    } catch {
      // KV down: better a duplicate alert than a missing one.
    }
  }

  // Titles are read by the owner (hub to-dos and the alert list): a trial's {clientId}
  // shows as its name ("Ridgeline IT"), not the id slug ("ridgelineit"). The record keeps the id.
  let shown = null;
  if (clientId && (vars.clientId === undefined || vars.clientId === clientId)) {
    try { shown = (await kv.hget(K.client(clientId), 'name')) || null; } catch { shown = null; }
  }
  let title;
  try {
    title = fill(`alert:${key}`, spec.title, { clientId, ...vars, ...(shown ? { clientId: String(shown) } : {}) });
  } catch {
    title = `${key}${clientId ? ` (${shown || clientId})` : ''}`;
  }
  // Recorded for the hub: the bell and the alert list read system:alerts:log.
  const record = { at: now.toISOString(), key, clientId, title, urgent: Boolean(spec.urgent), body: String(body || '').slice(0, 2000), did: String(did || '').slice(0, 500), delivered: true, acknowledged: false, id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}` };
  // The hub is the only place an alert shows, so a failed write must not look like a sent alert: try twice, and if it
  // still fails, free the day's dedupe slot (the next run raises it again) and say so.
  let written = false;
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    try {
      const p = kv.pipeline();
      p.lpush(K.alertLog(), record);
      p.ltrim(K.alertLog(), 0, LOG_CAP - 1);
      await p.exec();
      written = true;
    } catch (err) {
      if (attempt === 1) console.error(`[alert] ${key} could not be saved: ${err?.message || err}`);
    }
  }
  if (!written) {
    if (!force) { try { await kv.srem(K.alertsDay(day), dedupeKey); } catch { /* the next run is deduped for today */ } }
    return { sent: false, failed: true };
  }
  await logEvent(clientId, 'notify', 'alert_sent', { key, title });
  return { sent: true, id: record.id };
}

export async function getAlertLog(limit = 200) {
  try { return (await kv.lrange(K.alertLog(), 0, limit - 1)) || []; } catch { return []; }
}

/**
 * Acknowledge open alerts in the log (the hub's to-do for an urgent alert goes
 * with it). `match(alert)` picks them; each is re-read at its index right
 * before the write, so an alert pushed in between (the list shifts) is never
 * overwritten — it is simply left for the owner. → how many were acknowledged.
 */
export async function ackMatching(match, { by = 'owner', reason = null, now = new Date() } = {}) {
  let list;
  try { list = await getAlertLog(LOG_CAP); } catch { return 0; }
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || a.acknowledged || !match(a)) continue;
    try {
      const [cur] = (await kv.lrange(K.alertLog(), i, i)) || [];
      if (!cur || cur.id !== a.id) continue;
      await kv.lset(K.alertLog(), i, { ...cur, acknowledged: true, acknowledgedAt: now.toISOString(), acknowledgedBy: by, ...(reason ? { ackReason: String(reason).slice(0, 120) } : {}) });
      n++;
    } catch { /* leave it open: the owner can still acknowledge it */ }
  }
  return n;
}

/**
 * The machine handled what a trial's alerts were about (the application was
 * decided, the legal hold cleared, DNS passes again …): acknowledge that
 * client's open alerts of these keys, so an urgent one does not linger as a
 * to-do — and a red dot — after the thing is done.
 */
export async function ackAlerts(clientId, keys, { reason = 'handled', now = new Date() } = {}) {
  if (!clientId) return 0;
  const want = new Set([].concat(keys || []));
  return ackMatching((a) => a.clientId === clientId && want.has(a.key), { by: 'machine', reason, now });
}

/**
 * Email a client (SPEC §10.2). Onboarding / report / decision mail comes from
 * OWNER_INBOX so the client always has one human address; anything a
 * prospect could see comes from the client's trial inbox. `to` defaults to
 * the client's contactEmail. Missing slot → report_blocked alert, never a
 * blank. Deduped per (key, dedupe) forever via a claim unless `dedupe` null.
 *
 * `from: 'onboard'` (or a template marked so) sends from the onboarding-call
 * inbox. The onboarding-call emails also pass `linkify` (clickable links in
 * the HTML part) and `inReplyTo` / `references` so the conversation threads.
 * The result carries the Message-ID and the sending address so replies can
 * be matched. The Calendar's emails pass `icalEvent` (an .ics invite or
 * cancellation).
 *
 * Every email that goes to the client's contact is also an `out` entry in
 * their one conversation (docs/REPLYBOT-MEET.md §1, kind 'system' + the
 * template key). `thread: false` = the caller adds its own entry (the
 * onboarding-call, calendar and reply-bot emails, which carry their kind).
 *
 * Delivery monitoring (docs/IMPROVE-PASS.md C, systems/mailwatch.js): every
 * email to the client's contact carries one open pixel — `pixel: 'onboard'`
 * / `'launch'` for the two call emails (their call's pixel), else `'mail'`
 * (never on the owner's own replies or the reply bot's answers; `pixel:
 * false` or OPEN_TRACKING=off for none; a legacy `pixelUrl` is used as
 * given) — and is tracked (accepted, Message-ID, opened, bounced, replied).
 * A milestone email that cannot be sent is kept for one retry 10 minutes
 * later before this throws. `now` = the send's time (the caller's clock).
 */
export async function notifyClient(clientId, key, vars = {}, opts = {}) {
  const { to = null, from = null, dedupe = key, attachments = null, pixelUrl = null, pixel = 'mail', linkify = false, inReplyTo = null, references = null, icalEvent = null, thread = true, now = null } = opts || {};
  const { renderTemplate } = await import('@/lib/templates/client');
  const { getClient } = await import('@/lib/db/client');
  const client = await getClient(clientId);
  // Every client is on a plan (Starter / Growth / Scale): {planName} is there for the emails ("the Growth plan").
  // A record from before plans were required (plan 'trial' or none) reads as Starter.
  if (!vars.planName) vars = { ...vars, planName: planNameOf(client?.plan) };
  const recipient = to || client?.contactEmail;
  if (!recipient) throw new Error(`no contact email for ${clientId}`);
  if (dedupe) {
    const ok = await kv.set(`notified:${clientId}:${dedupe}`, Date.now(), { nx: true, ex: 400 * 86400 });
    if (ok !== 'OK') return { sent: false, deduped: true };
  }
  let msg;
  try {
    // Every client template may greet them by first name ("Hi Dana,"); the full name stays for where a name is signed.
    const firstName = String(client?.contactName || '').trim().split(/\s+/)[0] || 'there';
    msg = renderTemplate(key, { clientName: client?.name, contactName: client?.contactName, firstName, ...vars });
  } catch (err) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    await alertOwner('report_blocked', { clientId, scope: `${clientId}:${key}`, vars: { report: key, clientId }, body: `Could not render "${key}" for ${clientId}: ${err.message}`, did: 'Nothing was sent to the client.' });
    return { sent: false, error: err.message };
  }
  // An email to the client's contact is tracked (and gets the open pixel); prospects' emails are not.
  const toContact = Boolean(client?.contactEmail) && String(recipient).trim().toLowerCase() === String(client.contactEmail).trim().toLowerCase();
  const watch = toContact ? await import('@/lib/systems/mailwatch') : null;
  const at = now ? new Date(now) : (await import('@/lib/systems/intake-io')).io.now();
  const failed = async (error) => {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    if (watch) await watch.noteFailed(clientId, key, { vars, opts, error, at });
  };
  const via = from || msg.from;
  let account;
  try {
    if (via === 'sender' || via === 'trial') { // the client's own sending inbox ('trial': retries queued before the rename)
      const { getAccounts } = await import('@/lib/db/inboxes');
      account = (await getAccounts(clientId))[0];
    } else if (via === 'onboard') {
      account = await onboardSender();
    } else {
      account = await ownerSender();
    }
  } catch (err) {
    await failed(err?.message || String(err));
    throw err;
  }
  if (!account) {
    await failed(`no ${via} inbox`);
    throw new Error(`no ${via} inbox to send ${key} for ${clientId}`);
  }
  const body = linkify ? linkUrls(esc(msg.text)) : esc(msg.text);
  // The Message-ID is made first, so the open pixel can name this email (its tracking key).
  const messageId = newMessageId(account.email);
  const trackKey = watch ? watch.trackKeyOf(messageId) : null;
  let src = pixelUrl;
  if (!src && watch && pixel && !watch.NO_PIXEL.has(key)) {
    src = pixel === 'onboard' || pixel === 'launch'
      ? onboardPixelUrl(recipient, clientId, at.getTime(), pixel, trackKey)
      : mailPixelUrl(recipient, clientId, trackKey, at.getTime());
  }
  // OPEN_TRACKING=off drops every pixel.
  const img = src && String(process.env.OPEN_TRACKING || '').toLowerCase() !== 'off'
    ? `<img src="${esc(src)}" alt="" width="1" height="1" border="0" style="display:block;width:1px;height:1px;border:0;opacity:0" />` : '';
  const res = await sendEmail(account, {
    to: recipient, subject: msg.subject, text: msg.text,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${body}</div>${img}`,
    transactional: true, noTrack: true, messageId,
    ...(attachments ? { attachments } : {}),
    ...(icalEvent ? { icalEvent } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references && references.length ? { references } : {}),
  });
  await logEvent(clientId, 'notify', res.success ? 'client_email_sent' : 'client_email_failed', { key, to: recipient, error: res.success ? undefined : res.error });
  if (!res.success) {
    await failed(res.error);
    throw new Error(`send ${key} failed: ${res.error}`);
  }
  // Accepted: the SMTP server took it for this address (a success always did unless it listed the address as rejected).
  const rejected = (res.rejected || []).map((x) => String(x?.address || x).toLowerCase());
  const out = { sent: true, messageId: res.messageId, from: account.email, to: recipient, subject: msg.subject, text: msg.text, accepted: !rejected.includes(String(recipient).trim().toLowerCase()) };
  if (watch) await watch.noteSent(clientId, key, { ...out, rejected }, { key: trackKey, at, pixel: Boolean(img) });
  if (thread !== false && toContact) {
    try { await (await import('@/lib/systems/conversation')).logClientEmail(clientId, key, out); } catch {}
  }
  return out;
}

/** http(s) addresses in already-escaped text → links (the address stays the visible text). */
function linkUrls(escaped) {
  return String(escaped).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);
}
