/**
 * Prospect-facing messages outside the cold sequence (SPEC §11 "To
 * prospects"): Speed Responder replies, reminders, re-book emails, apologies.
 *
 * Every one is sent from the trial inbox that holds the thread (the lead's
 * `account_used`), as a reply in that thread, with the sequence footer
 * (sender name, postal address, reply-STOP line) and the one-click
 * unsubscribe headers, and only after the Compliance Guard passes. Each send
 * is claimed first (SET NX on `dedupe`) so a retried tick never sends twice.
 *
 * Client-facing messages go through `notifyClientSafe`, which wraps the
 * Notifier and turns any failure into an owner alert (rule 1).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getProfile } from '@/lib/db/client';
import { getAccounts } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { TEMPLATES as C_TEMPLATES } from '@/lib/templates/client/stage-c';
import { fill } from '@/lib/templates/render';
import { normId } from '@/lib/mail-utils';
import { guardOutbound, unsubscribeHeaders } from '@/lib/systems/compliance';
import { deps, alert, claimOnce, releaseOnce, lower, ccfg } from '@/lib/systems/stagec-common';

/** Render a Stage C template → { subject, text, from }. Throws TemplateError on a missing slot. */
export function renderTemplate(key, vars = {}) {
  const t = C_TEMPLATES[key];
  if (!t) throw new Error(`unknown template ${key}`);
  return { subject: t.subject ? fill(key, t.subject, vars) : '', text: fill(key, t.body, vars), from: t.from || 'owner' };
}

export const DEFAULT_FOOTER = '{SenderName}\n{postalAddress}\n\nNot the right fit? Just reply STOP and I will not email you again.';

/** Footer used on every prospect email: the client's sequence footer if stored, else the default. */
export async function footerFor(clientId, profile) {
  let footer = DEFAULT_FOOTER;
  try {
    const raw = await kv.hget(K.sequence(clientId), 'variantA');
    const seq = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (seq && typeof seq.footer === 'string' && seq.footer.trim()) footer = seq.footer;
  } catch {}
  const ownerAddress = await ccfg(clientId, 'OWNER.address');
  return fill('prospect:footer', footer, { SenderName: profile.senderName, postalAddress: profile.postalAddress || ownerAddress });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function textToHtml(body, note = '') {
  const paras = String(body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px 0;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const foot = note ? `<p style="margin-top:24px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">${esc(note)}</p>` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#222222;max-width:560px;">${paras}</div>${foot}`;
}

/** Pick the account for a lead: its thread inbox, else the first working inbox. */
export async function accountFor(clientId, inboxEmail) {
  const accounts = (await getAccounts(clientId)).filter((a) => a && a.email && (a.appPassword || a.password));
  const want = lower(inboxEmail);
  return accounts.find((a) => a.email === want) || accounts.find((a) => a.record?.enabled === '1') || accounts[0] || null;
}

/** Index a Message-ID we sent → lead email (so a reply to it matches). */
export async function indexMessageId(clientId, messageId, leadEmail) {
  const id = normId(messageId);
  if (!id || !leadEmail) return;
  try { await kv.hset(K.msgIndex(clientId), { [id]: lower(leadEmail) }); } catch {}
}

/**
 * Send one prospect template.
 * @param {object} o
 *   lead        lead record (email, first_name, account_used, …)
 *   vars        template slots (FirstName etc. are filled from the lead if absent)
 *   thread      { subject, messageId, references[] } to reply in-thread (optional)
 *   dedupe      claim id (default `${key}:${lead.email}`)
 * @returns {{sent, deduped?, blocked?, error?, messageId?, subject?}}
 */
export async function sendToProspect(clientId, key, { lead, vars = {}, thread = null, dedupe = null, now = new Date() } = {}) {
  const to = lower(lead?.email);
  if (!to) return { sent: false, error: 'no recipient' };
  const claimId = dedupe || `${key}:${to}`;
  if (!(await claimOnce('prospect', clientId, claimId))) return { sent: false, deduped: true };

  const fail = async (error, { release = true, alertOwnerToo = true } = {}) => {
    if (release) await releaseOnce('prospect', clientId, claimId);
    await logEvent(clientId, 'outbound', 'prospect_send_failed', { template: key, to, error });
    if (alertOwnerToo) {
      await alert('prospect_send_failed', {
        clientId, scope: `${clientId}:${key}`, vars: { clientId, template: key },
        body: `Could not send "${key}" to ${to} for ${clientId}: ${error}`,
        did: 'Nothing was sent to the prospect; the next run retries where the job allows it.',
      });
    }
    return { sent: false, error };
  };

  const [client, profile] = await Promise.all([getClient(clientId), getProfile(clientId)]);
  const firstName = vars.FirstName || lead.first_name || String(lead.name || '').trim().split(/\s+/)[0] || null;
  let msg;
  let footer;
  try {
    msg = renderTemplate(key, {
      FirstName: firstName,
      Greeting: firstName ? `Hi ${firstName},` : 'Hi there,',
      SenderName: profile.senderName,
      ClientCompany: client?.name,
      Company: lead.company || lead.company_name,
      calendarUrl: profile.calendarUrl,
      ...vars,
    });
    footer = await footerFor(clientId, profile);
  } catch (err) {
    return fail(`render: ${err.message}`);
  }

  const account = await accountFor(clientId, lead.account_used);
  if (!account) return fail('no trial inbox with a password');

  const baseSubject = thread?.subject || lead.original_subject || '';
  const subject = msg.subject || (baseSubject ? `Re: ${String(baseSubject).replace(/^\s*re:\s*/i, '').trim()}` : '');
  if (!subject) return fail('no subject: template has none and there is no thread');
  const text = `${msg.text}\n\n${footer}`;
  const note = footer.split(/\n\s*\n/).pop().trim();
  const headers = unsubscribeHeaders(to, account.email);
  const refs = [...(thread?.references || []), thread?.messageId].filter(Boolean);

  const inboxEmails = (await getAccounts(clientId)).map((a) => a.email);
  const guard = await guardOutbound(clientId, {
    to, fromName: account.displayName, fromAddress: account.email, subject, text, headers,
  }, { profile, inboxEmails, firstTouch: !thread && !lead.sent_at, now });
  if (!guard.ok) {
    await logEvent(clientId, 'outbound', 'prospect_blocked', { template: key, to, rule: guard.rule });
    // A compliance block is final for this message (no retry loop).
    return { sent: false, blocked: guard.rule };
  }

  const bodyOnly = footer ? `${msg.text}\n\n${footer.slice(0, footer.length - note.length).trim()}` : msg.text;
  let res;
  try {
    res = await deps.sendEmail(account, {
      to, subject, text, html: textToHtml(bodyOnly, note),
      ...(thread?.messageId ? { inReplyTo: thread.messageId, references: refs } : {}),
      headers, noTrack: true, touch: key,
    });
  } catch (err) {
    res = { success: false, error: err.message };
  }
  if (!res || !res.success) return fail(res?.error || 'send failed');
  await indexMessageId(clientId, res.messageId, to);
  await logEvent(clientId, 'outbound', 'prospect_sent', { template: key, to, inbox: account.email });
  return { sent: true, messageId: res.messageId, subject, inbox: account.email };
}

/**
 * Email the client through the Notifier. Never throws: a failure becomes an
 * owner alert (and, for hot leads, an urgent one carrying the reply itself).
 */
export async function notifyClientSafe(clientId, key, vars, opts = {}, { onFailAlert = 'report_blocked', failBody = null } = {}) {
  try {
    const res = await deps.notifyClient(clientId, key, vars, opts);
    if (res && (res.sent || res.deduped)) return res;
    throw new Error(res?.error || 'not sent');
  } catch (err) {
    await logEvent(clientId, 'notify', 'client_email_failed', { key, error: err.message });
    await alert(onFailAlert, {
      clientId, scope: `${clientId}:${key}:${opts.dedupe || ''}`,
      vars: { clientId, report: key },
      body: failBody || `Could not email "${key}" to ${clientId}: ${err.message}`,
      did: 'The client did not receive it. Forward it by hand if it matters today.',
    });
    return { sent: false, error: err.message };
  }
}

/** Addresses that belong to the client (contact, hot-lead alert address). */
export function clientAddresses(client = {}, profile = {}) {
  return [client.contactEmail, profile.hotLeadEmail, profile.alertEmail, profile.hotLeadAlertEmail]
    .map(lower).filter((x) => x && x.includes('@'));
}
