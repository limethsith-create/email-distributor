/**
 * Notifier (SPEC §10.2) — the only module that emails a human.
 *
 * Owner channel: email from OWNER_INBOX (format `email:app-password:Name`,
 * falling back to the first aviance sending inbox) to OWNER_EMAIL, plus
 * Telegram for urgent alerts. Every alert is deduped per day on
 * system:alerts:{date} and recorded in system:alerts:log and the event log.
 *
 * Rule 1 (no silent failure) ends here: if every channel fails, the failure
 * is written to events:global and the console so the Healthchecks/Mission
 * Control views still show it.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { sendEmail } from '@/lib/mailer';
import { parseAccount, getSmtpAccounts, loadAccounts, findSmtpAccount } from '@/lib/smtp-accounts';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import { dayKeyIn, partsIn, OWNER_TZ } from '@/lib/time';
import { pushToOwner } from '@/lib/push';
import { cfg } from '@/lib/config';

const DEFAULT_OWNER_EMAIL = 'limethsith@gmail.com';
const LOG_CAP = 1000;

export function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://email-distributor.vercel.app').replace(/\/+$/, '');
}

export function ownerEmail() {
  return (process.env.OWNER_EMAIL || process.env.DAILY_REPORT_TO || DEFAULT_OWNER_EMAIL).trim();
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

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: 'telegram not configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, error: res.ok ? null : `telegram ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function sendOwnerEmail(subject, text) {
  const account = await ownerSender();
  if (!account) return { ok: false, error: 'no owner inbox configured' };
  const res = await sendEmail(account, { to: ownerEmail(), subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${esc(text)}</pre>`, transactional: true, noTrack: true });
  return { ok: Boolean(res.success), error: res.success ? null : res.error };
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
 *   url   hub path the phone notification opens (default the trial or /#alerts)
 * @returns {{sent:boolean, deduped?:boolean, channels?:object}}
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

  // Titles are read by the owner (hub to-dos, phone, email subject): a trial's {clientId}
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
  const link = clientId ? `${baseUrl()}/mc/clients/${clientId}` : `${baseUrl()}/mc`;
  const text = [
    body || title,
    did ? `\nWhat the system already did: ${did}` : '',
    `\nMission Control: ${link}`,
  ].join('\n').trim();

  const channels = { email: await sendOwnerEmail(`[Aviance] ${title}`, text) };
  // Phone notification (hub home-screen app) for every alert — the owner's main channel.
  channels.push = await pushToOwner({
    title: spec.urgent ? `Urgent: ${title}` : title,
    body: String(body || title).replace(/\s+/g, ' ').slice(0, 180),
    url: url || (clientId ? `/#trial/${clientId}` : '/#alerts'),
    tag: `${key}:${dedupeScope}`,
    urgent: Boolean(spec.urgent),
    // A quiet alert (the reply bot's "auto-replied"): low push urgency, and the hub may show it without sound.
    ...(spec.quiet ? { quiet: true } : {}),
  });
  if (spec.urgent) channels.telegram = await sendTelegram(`${spec.urgent ? '🔴 ' : ''}${title}\n\n${text}`);
  const delivered = Object.values(channels).some((c) => c.ok);

  const record = { at: now.toISOString(), key, clientId, title, urgent: Boolean(spec.urgent), delivered, channels: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.ok ? 'ok' : v.error])), acknowledged: false, id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}` };
  try {
    const p = kv.pipeline();
    p.lpush(K.alertLog(), record);
    p.ltrim(K.alertLog(), 0, LOG_CAP - 1);
    await p.exec();
  } catch {}
  await logEvent(clientId, 'notify', delivered ? 'alert_sent' : 'alert_undelivered', { key, title, channels: record.channels });
  if (!delivered) {
    console.error('[notify] ALERT NOT DELIVERED on any channel:', key, title, record.channels);
    // Allow a retry on the next occurrence rather than swallowing it for the day.
    try { await kv.srem(K.alertsDay(day), dedupeKey); } catch {}
  }
  return { sent: delivered, channels: record.channels };
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
 * inbox. The onboarding-call emails also pass `pixelUrl` (their one open
 * pixel), `linkify` (clickable links in the HTML part) and `inReplyTo` /
 * `references` so the conversation threads. The result carries the
 * Message-ID and the sending address so replies can be matched. The
 * Calendar's emails pass `icalEvent` (an .ics invite or cancellation).
 *
 * Every email that goes to the client's contact is also an `out` entry in
 * their one conversation (docs/REPLYBOT-MEET.md §1, kind 'system' + the
 * template key). `thread: false` = the caller adds its own entry (the
 * onboarding-call, calendar and reply-bot emails, which carry their kind).
 */
export async function notifyClient(clientId, key, vars = {}, { to = null, from = null, dedupe = key, attachments = null, pixelUrl = null, linkify = false, inReplyTo = null, references = null, icalEvent = null, thread = true } = {}) {
  const { renderTemplate } = await import('@/lib/templates/client');
  const { getClient } = await import('@/lib/db/client');
  const client = await getClient(clientId);
  const recipient = to || client?.contactEmail;
  if (!recipient) throw new Error(`no contact email for ${clientId}`);
  if (dedupe) {
    const ok = await kv.set(`notified:${clientId}:${dedupe}`, Date.now(), { nx: true, ex: 400 * 86400 });
    if (ok !== 'OK') return { sent: false, deduped: true };
  }
  let msg;
  try {
    msg = renderTemplate(key, { clientName: client?.name, contactName: client?.contactName, ...vars });
  } catch (err) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    await alertOwner('report_blocked', { clientId, scope: `${clientId}:${key}`, vars: { report: key, clientId }, body: `Could not render "${key}" for ${clientId}: ${err.message}`, did: 'Nothing was sent to the client.' });
    return { sent: false, error: err.message };
  }
  const via = from || msg.from;
  let account;
  try {
    if (via === 'trial') {
      const { getAccounts } = await import('@/lib/db/inboxes');
      account = (await getAccounts(clientId))[0];
    } else if (via === 'onboard') {
      account = await onboardSender();
    } else {
      account = await ownerSender();
    }
  } catch (err) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    throw err;
  }
  if (!account) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    throw new Error(`no ${via} inbox to send ${key} for ${clientId}`);
  }
  const body = linkify ? linkUrls(esc(msg.text)) : esc(msg.text);
  // The only tracking on a client email is an explicit pixel (onboarding call); OPEN_TRACKING=off drops it too.
  const pixel = pixelUrl && String(process.env.OPEN_TRACKING || '').toLowerCase() !== 'off'
    ? `<img src="${esc(pixelUrl)}" alt="" width="1" height="1" border="0" style="display:block;width:1px;height:1px;border:0;opacity:0" />` : '';
  const res = await sendEmail(account, {
    to: recipient, subject: msg.subject, text: msg.text,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${body}</div>${pixel}`,
    transactional: true, noTrack: true,
    ...(attachments ? { attachments } : {}),
    ...(icalEvent ? { icalEvent } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references && references.length ? { references } : {}),
  });
  await logEvent(clientId, 'notify', res.success ? 'client_email_sent' : 'client_email_failed', { key, to: recipient, error: res.success ? undefined : res.error });
  if (!res.success) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    throw new Error(`send ${key} failed: ${res.error}`);
  }
  const out = { sent: true, messageId: res.messageId, from: account.email, to: recipient, subject: msg.subject, text: msg.text };
  if (thread !== false && client?.contactEmail && String(recipient).trim().toLowerCase() === String(client.contactEmail).trim().toLowerCase()) {
    try { await (await import('@/lib/systems/conversation')).logClientEmail(clientId, key, out); } catch {}
  }
  return out;
}

/** http(s) addresses in already-escaped text → links (the address stays the visible text). */
function linkUrls(escaped) {
  return String(escaped).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);
}
