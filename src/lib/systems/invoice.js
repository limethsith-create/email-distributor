/**
 * Invoice Maker (SPEC §9.8). When the plan agreement is signed: render
 * `invoice_plan_start` (plan price, PayPal.me / Wise details from config, due
 * today) and email it; reminders on INVOICE.reminderDays while unpaid; the
 * owner's "Mark paid" in Mission Control closes it.
 *
 * No payment details in config → the invoice is held (status `blocked`), the
 * owner gets `config_missing`, and the daily invoice job retries. Nothing is
 * ever sent with a made-up payment line.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, isUsHoliday } from '@/lib/config';
import { getClient, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { notifyClient, alertOwner } from '@/lib/notify';
import { daysBetween, dayKeyIn, partsIn, isWeekday, ET } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { money, PLAN_NAMES, ownerName, fmtDay, cfgTree } from '@/lib/systems/dshared';

export async function getInvoice(clientId) {
  try { return (await kv.hgetall(K.invoice(clientId))) || null; } catch { return null; }
}

/**
 * The stored invoice → the hub's shape (docs/HUB-API.md `invoice`): `number`,
 * `amount`, `issuedAt`, `paidAt`, `dueDate` (the invoice says "due today"),
 * `remindersSent` as a count, plus plan, calls, status, sentAt and
 * blockedReason. null when there is no invoice.
 */
export function invoiceView(raw) {
  if (!raw || !Object.keys(raw).length) return null;
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  let reminders = [];
  try { reminders = typeof raw.remindersSent === 'string' ? JSON.parse(raw.remindersSent || '[]') : raw.remindersSent || []; } catch { reminders = []; }
  return {
    number: raw.invoiceNo || null,
    plan: raw.plan || null,
    amount: num(raw.amount),
    calls: num(raw.calls),
    status: raw.status || null,
    issuedAt: raw.issuedAt || null,
    sentAt: raw.sentAt || null,
    paidAt: raw.paidAt || null,
    dueDate: raw.issuedAt ? dayKeyIn(ET, new Date(raw.issuedAt)) : null,
    remindersSent: Array.isArray(reminders) ? reminders.length : 0,
    blockedReason: raw.blockedReason || null,
  };
}

/** Payment lines from config, or null when neither PayPal.me nor Wise is set. */
export async function paymentLines(clientId, amount) {
  const pay = (await cfgTree(clientId, 'PAYMENT')) || {};
  const lines = [];
  if (pay.paypalMe) lines.push(`PayPal: ${String(pay.paypalMe).replace(/\/+$/, '')}/${amount}USD`);
  if (pay.wiseDetails) lines.push(`Wise (bank transfer): ${pay.wiseDetails}`);
  return lines.length ? lines.join('\n') : null;
}

/**
 * Create (or retry) the month-one invoice. Idempotent: an invoice already
 * sent is never sent again.
 */
export async function createInvoice(clientId, plan, { now = new Date() } = {}) {
  const existing = await getInvoice(clientId);
  if (existing && existing.status && existing.status !== 'blocked') return { status: existing.status, invoice: existing };
  const plans = await cfgTree(clientId, 'PLANS');
  const p = plans?.[plan];
  if (!p) throw new Error(`unknown plan ${plan}`);
  const base = {
    plan, amount: p.price, calls: p.calls,
    invoiceNo: existing?.invoiceNo || `AV-${dayKeyIn(ET, now).replace(/-/g, '').slice(0, 6)}-${clientId}`,
    issuedAt: existing?.issuedAt || now.toISOString(),
  };
  const lines = await paymentLines(clientId, p.price);
  if (!lines) {
    await kv.hset(K.invoice(clientId), { ...base, status: 'blocked', blockedReason: 'PAYMENT.paypalMe / PAYMENT.wiseDetails not set' });
    await alertOwner('config_missing', {
      clientId, scope: 'cfg:PAYMENT', vars: { key: 'PAYMENT.paypalMe / PAYMENT.wiseDetails' },
      body: `${clientId} chose ${PLAN_NAMES[plan]} but the invoice cannot go out: no PayPal.me link or Wise details are set.`,
      did: 'Invoice held. It is sent automatically on the next daily run after a payment method is filled in at Mission Control → Config.',
    });
    await logEvent(clientId, 'invoice', 'invoice_blocked', { reason: 'payment config missing' });
    return { status: 'blocked' };
  }
  const sig = await ownerName(clientId, 'The month-one invoice');
  if (!sig) {
    await kv.hset(K.invoice(clientId), { ...base, status: 'blocked', blockedReason: 'OWNER.signerName not set' });
    return { status: 'blocked' };
  }
  const vars = {
    planName: PLAN_NAMES[plan], invoiceNo: base.invoiceNo, issuedDate: fmtDay(dayKeyIn(ET, now)),
    priceText: money(p.price), calls: p.calls, paymentLines: lines, ownerName: sig,
  };
  const res = await notifyClient(clientId, 'invoice_plan_start', vars, { dedupe: 'invoice_month1' });
  await kv.hset(K.invoice(clientId), { ...base, status: 'sent', sentAt: now.toISOString(), remindersSent: '[]', blockedReason: '' });
  await logEvent(clientId, 'invoice', 'invoice_sent', { invoiceNo: base.invoiceNo, amount: p.price, deduped: res.deduped || undefined });
  return { status: 'sent', invoiceNo: base.invoiceNo };
}

/** Daily: retry a blocked invoice; send reminders at +3 / +7 days unpaid. */
export async function runInvoiceJob(clientId, { now: realNow = new Date() } = {}) {
  const client = await getClient(clientId);
  const now = clientNow(client, realNow);
  const inv = await getInvoice(clientId);
  if (!inv || !inv.plan) return { skipped: 'no invoice' };
  if (inv.status === 'blocked') return createInvoice(clientId, inv.plan, { now });
  if (inv.status !== 'sent' || inv.paidAt) return { skipped: inv.status };
  const days = daysBetween(dayKeyIn(ET, new Date(inv.issuedAt)), dayKeyIn(ET, now));
  const reminderDays = await cfg(clientId, 'INVOICE.reminderDays');
  let sent = [];
  try { sent = typeof inv.remindersSent === 'string' ? JSON.parse(inv.remindersSent) : inv.remindersSent || []; } catch { sent = []; }
  const due = reminderDays.filter((d) => days >= d && !sent.includes(d));
  if (!due.length) return { days, reminder: null };
  // A payment reminder to a new client goes on a US business day (a Day +3 on a Sunday waits for Monday).
  const p = partsIn(ET, now);
  if (!isWeekday(p.weekday) || isUsHoliday(p.dayKey)) return { days, reminder: null, waiting: 'business day' };
  const d = Math.max(...due);
  const sig = await ownerName(clientId, 'The invoice reminder');
  if (!sig) return { held: 'OWNER.signerName' };
  const lines = await paymentLines(clientId, inv.amount);
  if (!lines) return { held: 'PAYMENT' };
  await notifyClient(clientId, 'invoice_reminder', { invoiceNo: inv.invoiceNo, priceText: money(inv.amount), planName: PLAN_NAMES[inv.plan], paymentLines: lines, ownerName: sig }, { dedupe: `invoice_reminder:${d}` });
  const allSent = [...new Set([...sent, ...due])];
  await kv.hset(K.invoice(clientId), { remindersSent: JSON.stringify(allSent) });
  await logEvent(clientId, 'invoice', 'invoice_reminder_sent', { day: d });
  if (d === Math.max(...reminderDays)) {
    await alertOwner('invoice_unpaid', { clientId, vars: { days }, body: `Invoice ${inv.invoiceNo} (${money(inv.amount)}) is ${days} days unpaid.`, did: `Sent the day-${d} reminder to the client.` });
  }
  return { days, reminder: d };
}

/**
 * Frequent check (runs inside the 15-minute heartbeat job): an invoice that went out 24+ hours ago and is
 * still unpaid gets ONE polite reminder email to the client and ONE "not paid yet" alert in the hub's
 * alert list. Keyed off the invoice's own sent time (sentAt, else issuedAt — it is stored when missing)
 * and unpaid status, so it works whatever created the invoice. `remindedAt` on the invoice makes it once.
 */
export const CHASE_AFTER_MS = 24 * 3600e3;

export async function chaseUnpaidInvoice(clientId, { now = new Date() } = {}) {
  const inv = await getInvoice(clientId);
  if (!inv || !inv.plan || inv.paidAt || inv.remindedAt) return { skipped: 'nothing to chase' };
  if (inv.status && inv.status !== 'sent') return { skipped: inv.status };
  const sentAt = inv.sentAt || inv.issuedAt;
  const sentMs = Date.parse(sentAt || '');
  if (!Number.isFinite(sentMs)) return { skipped: 'no sent time' };
  if (!inv.sentAt) await kv.hset(K.invoice(clientId), { sentAt });
  if (now.getTime() - sentMs < CHASE_AFTER_MS) return { skipped: 'not 24 hours yet' };
  const sig = await ownerName(clientId, 'The invoice reminder');
  if (!sig) return { held: 'OWNER.signerName' };
  const lines = await paymentLines(clientId, inv.amount);
  if (!lines) return { held: 'PAYMENT' };
  const res = await notifyClient(clientId, 'invoice_chase', { invoiceNo: inv.invoiceNo, priceText: money(inv.amount), planName: PLAN_NAMES[inv.plan], paymentLines: lines, ownerName: sig }, { dedupe: `invoice_chase:${inv.invoiceNo}`, now });
  await kv.hset(K.invoice(clientId), { remindedAt: now.toISOString() });
  await logEvent(clientId, 'invoice', 'invoice_chase_sent', { invoiceNo: inv.invoiceNo, deduped: res.deduped || undefined });
  if (!res.deduped) {
    await alertOwner('invoice_not_paid_yet', { clientId, scope: `invoice_chase:${inv.invoiceNo}`, body: `Invoice ${inv.invoiceNo} (${money(inv.amount)}) has not been paid 24 hours after it was sent.`, did: 'Sent the client one polite reminder email. Nothing more is sent automatically until the day-3 reminder.' });
  }
  return { reminded: true };
}

/** Every client with an unpaid invoice. Never throws; one client failing does not stop the rest. */
export async function chaseUnpaidInvoices({ clients = [], now = new Date() } = {}) {
  let reminded = 0; let held = 0;
  for (const c of clients) {
    if (!c || c.id === 'aviance' || c.paidAt || ['declined', 'closed_silent', 'deleted'].includes(c.state)) continue;
    try {
      const r = await chaseUnpaidInvoice(c.id, { now: clientNow(c, now) });
      if (r.reminded) reminded++; else if (r.held) held++;
    } catch (err) {
      await logEvent(c.id, 'invoice', 'invoice_chase_failed', { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    }
  }
  return { reminded, held };
}


/**
 * A payment is in: the ONE place "paid" is handled. Whoever marks it (the owner's "Mark paid" now, a PayPal
 * hook later) calls this with the client id (an invoice is stored per client). The first time only: it closes
 * the invoice, puts a plain-words "paid" alert in the owner's hub list and moves the booking to Won.
 * Calling it again changes nothing and raises no second alert. → { paid, first, invoice }
 */
export async function invoicePaid(invoiceId, { now = new Date() } = {}) {
  const clientId = invoiceId;
  const inv = await getInvoice(clientId);
  if (!inv || !inv.plan) throw new Error('no invoice for this client');
  if (inv.paidAt) return { paid: true, first: false, invoice: inv };
  await kv.hset(K.invoice(clientId), { paidAt: now.toISOString(), status: 'paid' });
  await updateClient(clientId, { paidAt: now.toISOString() });
  await logEvent(clientId, 'invoice', 'invoice_paid', { invoiceNo: inv.invoiceNo, amount: inv.amount });
  const client = (await getClient(clientId)) || {};
  const who = [client.contactName, client.name].filter(Boolean).join(' from ') || clientId;
  const sentence = `${who} paid the ${PLAN_NAMES[inv.plan] || inv.plan} invoice — ${money(inv.amount)}`;
  await alertOwner('client_paid', { clientId, vars: { text: sentence }, body: `${sentence}.`, did: 'Marked the invoice paid and moved their booking to Won.' });
  try { await (await import('@/lib/systems/inquiries')).settleInquiryFor(clientId, 'won', 'Invoice paid', { now }); } catch { /* the payment still counts */ }
  // >>> ONBOARDING AFTER PAYMENT goes here: call the "start onboarding" function (another task adds it) with clientId. <<<
  return { paid: true, first: true, invoice: { ...inv, paidAt: now.toISOString(), status: 'paid' } };
}

/** Owner's "Mark paid". Returns the plan-mode shopping list (SPEC §9.8). */
export async function markPaid(clientId, now = new Date()) {
  await invoicePaid(clientId, { now });
  const inv = await getInvoice(clientId);
  const shopping = (await cfgTree(clientId, 'PLAN_SHOPPING'))?.[inv.plan] || null;
  return { paid: true, plan: inv.plan, shopping: shopping || { note: `No plan-mode shopping list is set for ${PLAN_NAMES[inv.plan]} in the cost model (PLAN_SHOPPING.${inv.plan}).` } };
}
