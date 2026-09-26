/**
 * Invoice Maker (SPEC §9.8). On Start {plan}: render `invoice_month1` (plan
 * price, month-one bonus line, PayPal.me / Wise details from config, due
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
 * `remindersSent` as a count, plus plan, calls, bonus, status, sentAt and
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
    bonus: raw.bonus === '1' || raw.bonus === true,
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

async function bonusLine(clientId, plan, bonus) {
  const b = (await cfgTree(clientId, 'BONUS'))?.[plan];
  if (!b) return 'Month-one bonus: none for this plan';
  return bonus ? `Month-one bonus: ${b[0]} calls for the price of ${b[1]}` : 'Month-one bonus: not applied (the 24-hour window had closed)';
}

/**
 * Create (or retry) the month-one invoice. Idempotent: an invoice already
 * sent is never sent again.
 */
export async function createInvoice(clientId, plan, { bonus = false, now = new Date() } = {}) {
  const existing = await getInvoice(clientId);
  if (existing && existing.status && existing.status !== 'blocked') return { status: existing.status, invoice: existing };
  const plans = await cfgTree(clientId, 'PLANS');
  const p = plans?.[plan];
  if (!p) throw new Error(`unknown plan ${plan}`);
  const base = {
    plan, amount: p.price, calls: p.calls, bonus: bonus ? '1' : '0',
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
    priceText: money(p.price), calls: p.calls, bonusLine: await bonusLine(clientId, plan, bonus), paymentLines: lines, ownerName: sig,
  };
  const res = await notifyClient(clientId, 'invoice_month1', vars, { dedupe: 'invoice_month1' });
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
  if (inv.status === 'blocked') return createInvoice(clientId, inv.plan, { bonus: inv.bonus === '1', now });
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

/** Owner's "Mark paid". Returns the plan-mode shopping list (SPEC §9.8). */
export async function markPaid(clientId, now = new Date()) {
  const inv = await getInvoice(clientId);
  if (!inv || !inv.plan) throw new Error('no invoice for this client');
  if (!inv.paidAt) {
    await kv.hset(K.invoice(clientId), { paidAt: now.toISOString(), status: 'paid' });
    await updateClient(clientId, { paidAt: now.toISOString() });
    await logEvent(clientId, 'invoice', 'invoice_paid', { invoiceNo: inv.invoiceNo, amount: inv.amount });
  }
  const shopping = (await cfgTree(clientId, 'PLAN_SHOPPING'))?.[inv.plan] || null;
  return { paid: true, plan: inv.plan, shopping: shopping || { note: `No plan-mode shopping list is set for ${PLAN_NAMES[inv.plan]} in the cost model (PLAN_SHOPPING.${inv.plan}).` } };
}
