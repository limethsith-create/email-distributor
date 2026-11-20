/**
 * Agreement and invoice, sent the moment the owner says yes after a sales call.
 *
 * The order (owner's words): discovery call → agreement + invoice → payment →
 * onboarding call.
 *
 *  - sendAgreementAndInvoice(inq): writes the service agreement for the plan
 *    (templates/agreement.js renderServiceAgreement, price and calls from config
 *    PLANS) and the month-one invoice (number as systems/invoice.js makes it,
 *    payment lines from config PAYMENT), and emails both straight away from the
 *    onboarding-call inbox — the same sending path as the sales-call emails
 *    (salesIo). The agreement goes in the email and as an attached page.
 *    Nothing is sent when a setting is missing (signer name, PayPal / Wise): it
 *    throws in plain words and the booking stays where it was. Each email goes
 *    once (deduped); a retry only sends what did not go. Writes `agreement` and
 *    `invoice` on the booking.
 *  - startOnboardingAfterPayment(inquiryId): the payment came in → they become
 *    a paying client and onboarding starts (the old Won behaviour: the one
 *    accepted_call email), and the booking's invoice is stored on the client
 *    as paid (so the onboarding page never sends a second month-one invoice).
 *
 * Called by setInquiryStatus(id, 'agreement_sent') (systems/inquiries.js).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { renderTemplate } from '@/lib/templates/client';
import { renderServiceAgreement, serviceAgreementHtml, agreementHash, SERVICE_AGREEMENT_VERSION } from '@/lib/templates/agreement';
import { newMessageId } from '@/lib/mailer';
import { salesIo } from '@/lib/systems/salescall';
import { firstNameOf } from '@/lib/systems/intake-io';
import { cfgTree, money, PLAN_NAMES, ownerName, fmtDay } from '@/lib/systems/dshared';
import { paymentLines } from '@/lib/systems/invoice';
import { dayKeyIn, ET } from '@/lib/time';

const SYSTEM = 'agreement';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One email to the person who booked, deduped per booking + key. → { sent, deduped?, messageId? } */
async function sendOnce(inq, key, vars, { attachments = null, now }) {
  const dk = `agreement:mail:${inq.id}:${key}`;
  if ((await kv.set(dk, now.toISOString(), { nx: true, ex: 400 * 86400 })) !== 'OK') return { sent: false, deduped: true };
  try {
    const account = await salesIo.sender();
    if (!account) throw new Error('no inbox to send from — set the onboarding inbox in Settings');
    const msg = renderTemplate(key, vars);
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(msg.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`;
    const res = await salesIo.send(account, {
      to: inq.email, subject: msg.subject, text: msg.text, html,
      transactional: true, noTrack: true, messageId: newMessageId(account.email),
      ...(attachments ? { attachments } : {}),
    });
    if (!res || !res.success) throw new Error(res?.error || 'the inbox did not take it');
    await logEvent(null, SYSTEM, 'email_sent', { inquiryId: inq.id, key, to: inq.email });
    return { sent: true, messageId: res.messageId || null };
  } catch (err) {
    await kv.del(dk);
    await logEvent(null, SYSTEM, 'email_failed', { inquiryId: inq.id, key, error: String(err?.message || err).slice(0, 200) });
    throw err;
  }
}

/**
 * The yes: write the agreement and the invoice and email both now. Throws (nothing sent) when a setting
 * is missing; throws after the agreement when the invoice could not go (a retry sends only the invoice).
 * → { agreement, invoice } as written on the booking.
 */
export async function sendAgreementAndInvoice(inq, { now = new Date() } = {}) {
  if (!inq?.id) throw new Error('inquiry not found');
  if (!inq.email) throw new Error('This booking has no email address, so the agreement and invoice cannot go.');
  const { patchInquiry, inferPlan } = await import('@/lib/systems/inquiries');
  const plan = inferPlan(inq) || 'starter';
  const p = (await cfgTree(null, 'PLANS'))?.[plan];
  if (!p) throw new Error(`unknown plan ${plan}`);
  const signer = await ownerName(null, 'The agreement and invoice');
  if (!signer) throw new Error('Your name for signing is not set (Settings → Your details), so the agreement cannot go yet.');
  const lines = await paymentLines(null, p.price);
  if (!lines) throw new Error('No payment method is set (a PayPal.me link or Wise details in Settings), so the invoice cannot go yet.');

  const month = dayKeyIn(ET, now).replace(/-/g, '').slice(0, 6);
  const issuedDate = fmtDay(dayKeyIn(ET, now));
  const planName = PLAN_NAMES[plan];
  const agreementNo = inq.agreement?.number || `AG-${month}-${inq.id}`;
  const invoiceNo = inq.invoice?.number || `AV-${month}-${inq.id}`;
  const base = { firstName: firstNameOf(inq.name) || 'there', ownerName: signer, company: inq.company || 'your business', planName, calls: p.calls, priceText: money(p.price) };

  // 1. The agreement (in the email, and attached as a page they can keep or print).
  let agreement = inq.agreement && inq.agreement.sentAt ? inq.agreement : null;
  if (!agreement) {
    const text = renderServiceAgreement({
      company: inq.company || inq.name, contactName: inq.name || inq.email, contactEmail: inq.email,
      agreementNo, issuedDate, signerName: signer, plan: { name: planName, price: p.price, calls: p.calls },
    });
    await sendOnce(inq, 'service_agreement', { ...base, agreementText: text }, {
      now, attachments: [{ filename: `Aviance-Service-Agreement-${agreementNo}.html`, content: serviceAgreementHtml(text), contentType: 'text/html; charset=utf-8' }],
    });
    agreement = { number: agreementNo, version: SERVICE_AGREEMENT_VERSION, hash: agreementHash(text), plan, sentAt: now.toISOString() };
    await patchInquiry(inq.id, { agreement });
  }

  // 2. The month-one invoice.
  let invoice = inq.invoice && inq.invoice.sentAt ? inq.invoice : null;
  if (!invoice) {
    await sendOnce(inq, 'agreement_invoice', { ...base, invoiceNo, issuedDate, paymentLines: lines }, { now });
    invoice = { number: invoiceNo, plan, amount: p.price, calls: p.calls, status: 'sent', issuedAt: now.toISOString(), sentAt: now.toISOString(), paidAt: null };
    await patchInquiry(inq.id, { invoice });
  }
  await logEvent(null, 'inquiries', 'agreement_and_invoice_sent', { id: inq.id, plan, agreementNo, invoiceNo });
  return { agreement, invoice };
}

/**
 * Payment received for a booking's invoice → onboarding starts (they become a paying client; the one
 * accepted_call email) and the booking moves to Won. The paid invoice is stored on the client too.
 * Throws when onboarding cannot start (no website, say) — nothing is marked then. Safe to call twice.
 * → { clientId, outcome, already?, inquiry }
 */
export async function startOnboardingAfterPayment(inquiryId, { now = new Date() } = {}) {
  const { getInquiry, setInquiryStatus, patchInquiry, startClientFrom } = await import('@/lib/systems/inquiries');
  const inq = await getInquiry(String(inquiryId));
  if (!inq) throw new Error('inquiry not found');
  let rec = inq;
  let started;
  if (inq.status === 'won') started = await startClientFrom(inq, { now });
  else {
    rec = await setInquiryStatus(inq.id, 'won', 'Paid: onboarding started', { now });
    started = { clientId: rec.clientId, outcome: 'onboarding' };
  }
  const clientId = rec.clientId || started.clientId;
  const paidAt = inq.invoice?.paidAt || now.toISOString();
  if (inq.invoice && !inq.invoice.paidAt) rec = await patchInquiry(inq.id, { invoice: { ...inq.invoice, status: 'paid', paidAt } });
  if (clientId && inq.invoice) {
    const existing = await kv.hgetall(K.invoice(clientId)).catch(() => null);
    if (!existing || !existing.status || existing.status === 'blocked') {
      const v = inq.invoice;
      await kv.hset(K.invoice(clientId), { plan: v.plan, amount: v.amount, calls: v.calls, invoiceNo: v.number, issuedAt: v.issuedAt, sentAt: v.sentAt, status: 'paid', paidAt, remindersSent: '[]', blockedReason: '' });
    }
    try { await (await import('@/lib/db/client')).updateClient(clientId, { paidAt }); } catch { /* the invoice says it */ }
    await logEvent(clientId, 'invoice', 'invoice_paid', { invoiceNo: inq.invoice.number, amount: inq.invoice.amount, inquiryId: inq.id });
  }
  return { clientId, outcome: started.outcome, ...(started.already ? { already: true } : {}), inquiry: rec };
}

export const BOOKING_CHASE_AFTER_MS = 24 * 3600e3;

/**
 * 24 hours after the agreement and invoice went out and still not paid: ONE polite reminder to the
 * person who booked (from the onboarding inbox) and ONE "not paid yet" alert in the hub. Once per booking
 * (`invoice.remindedAt`). Never throws; one booking failing does not stop the rest. → { reminded, held }
 */
export async function chaseBookingInvoices({ now = new Date() } = {}) {
  const { listInquiries, patchInquiry } = await import('@/lib/systems/inquiries');
  const { io } = await import('@/lib/systems/intake-io');
  const { inquiries } = await listInquiries({ limit: 500 });
  let reminded = 0; let held = 0;
  for (const inq of inquiries) {
    const v = inq.invoice;
    if (inq.status !== 'agreement_sent' || !v || !v.sentAt || v.paidAt || v.remindedAt) continue;
    if (now.getTime() - Date.parse(v.sentAt) < BOOKING_CHASE_AFTER_MS) continue;
    try {
      const signer = await ownerName(null, 'The invoice reminder');
      const lines = signer && (await paymentLines(null, v.amount));
      if (!signer || !lines) { held++; continue; }
      const r = await sendOnce(inq, 'agreement_invoice_chase', {
        firstName: firstNameOf(inq.name) || 'there', ownerName: signer, invoiceNo: v.number,
        priceText: money(v.amount), planName: PLAN_NAMES[v.plan] || v.plan, paymentLines: lines,
      }, { now });
      await patchInquiry(inq.id, { invoice: { ...v, remindedAt: now.toISOString() } });
      if (!r.deduped) {
        const who = [inq.name, inq.company].filter(Boolean).join(' from ') || inq.email;
        await io.alertOwner('invoice_not_paid_yet', { scope: `booking_chase:${inq.id}`, vars: { clientId: who }, body: `Invoice ${v.number} (${money(v.amount)}) has not been paid 24 hours after the agreement went out.`, did: 'Sent them one reminder email.' });
      }
      reminded++;
    } catch (err) {
      await logEvent(null, SYSTEM, 'chase_failed', { inquiryId: inq.id, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    }
  }
  return { reminded, held };
}

/**
 * The owner (or, later, a PayPal check) says a booking's invoice is paid: ONE "paid" alert in the hub,
 * then onboarding starts and the booking moves to Won. Again → nothing new. → { paid, first, inquiry }
 */
export async function bookingPaid(inquiryId, { now = new Date() } = {}) {
  const { getInquiry } = await import('@/lib/systems/inquiries');
  const inq = await getInquiry(String(inquiryId));
  if (!inq) throw new Error('inquiry not found');
  if (!inq.invoice) throw new Error('No invoice has gone to this booking yet.');
  if (inq.invoice.paidAt && inq.status === 'won') return { paid: true, first: false, inquiry: inq };
  const res = await startOnboardingAfterPayment(inq.id, { now });
  const v = inq.invoice;
  const who = [inq.name, inq.company].filter(Boolean).join(' from ') || inq.email;
  const sentence = `${who} paid the ${PLAN_NAMES[v.plan] || v.plan} invoice — ${money(v.amount)}`;
  const { io } = await import('@/lib/systems/intake-io');
  await io.alertOwner('client_paid', { clientId: res?.clientId || null, scope: `booking_paid:${inq.id}`, vars: { text: sentence }, body: `${sentence}.`, did: 'Moved their booking to Won and sent the onboarding email.' });
  return { paid: true, first: true, inquiry: (await getInquiry(inq.id)) || inq };
}
