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
import { parseAccount, getSmtpAccounts, loadAccounts } from '@/lib/smtp-accounts';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import { dayKeyIn, partsIn, OWNER_TZ } from '@/lib/time';
import { pushToOwner } from '@/lib/push';

const DEFAULT_OWNER_EMAIL = 'limethsith@gmail.com';
const LOG_CAP = 1000;

export function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://email-distributor.vercel.app').replace(/\/+$/, '');
}

export function ownerEmail() {
  return (process.env.OWNER_EMAIL || process.env.DAILY_REPORT_TO || DEFAULT_OWNER_EMAIL).trim();
}

async function ownerSender() {
  const own = parseAccount(process.env.OWNER_INBOX || '');
  if (own) return own;
  await loadAccounts();
  return getSmtpAccounts()[0] || null;
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

  let title;
  try {
    title = fill(`alert:${key}`, spec.title, { clientId, ...vars });
  } catch {
    title = `${key}${clientId ? ` (${clientId})` : ''}`;
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
 * Email a client (SPEC §10.2). Onboarding / report / decision mail comes from
 * OWNER_INBOX so the client always has one human address; anything a
 * prospect could see comes from the client's trial inbox. `to` defaults to
 * the client's contactEmail. Missing slot → report_blocked alert, never a
 * blank. Deduped per (key, dedupe) forever via a claim unless `dedupe` null.
 */
export async function notifyClient(clientId, key, vars = {}, { to = null, from = null, dedupe = key, attachments = null } = {}) {
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
  if (via === 'trial') {
    const { getAccounts } = await import('@/lib/db/inboxes');
    account = (await getAccounts(clientId))[0];
  } else {
    account = await ownerSender();
  }
  if (!account) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    throw new Error(`no ${via} inbox to send ${key} for ${clientId}`);
  }
  const res = await sendEmail(account, { to: recipient, subject: msg.subject, text: msg.text, html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(msg.text)}</div>`, transactional: true, noTrack: true, ...(attachments ? { attachments } : {}) });
  await logEvent(clientId, 'notify', res.success ? 'client_email_sent' : 'client_email_failed', { key, to: recipient, error: res.success ? undefined : res.error });
  if (!res.success) {
    if (dedupe) await kv.del(`notified:${clientId}:${dedupe}`);
    throw new Error(`send ${key} failed: ${res.error}`);
  }
  return { sent: true, messageId: res.messageId };
}
