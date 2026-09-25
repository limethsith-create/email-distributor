/**
 * Handover Pack (SPEC §9.7). Day 30 (or at the first qualified call when that
 * is later, and again at any early stop): three CSVs — leads, replies with
 * kind + snippet, bookings with status — plus the Market Report. Never inbox
 * access. Sets trial.handoverSentAt. One email per reason (deduped).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { getLeads } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { notifyClient } from '@/lib/notify';
import { renderReport } from '@/lib/systems/reports';
import { getReplies, getBookings, csv, patchTrial, ownerName, markReportRendered } from '@/lib/systems/dshared';

const LEAD_COLS = ['email', 'first_name', 'name', 'title', 'company', 'website', 'city', 'state', 'sizeBand', 'status', 'grade', 'score', 'verifyStatus', 'source', 'riskLevel', 'sent_at', 'replied_at', 'reply_kind', 'notnowDate'];
const REPLY_COLS = ['receivedAt', 'leadEmail', 'kind', 'subject', 'snippet', 'notnowDate'];
const BOOKING_COLS = ['scheduledAt', 'leadEmail', 'status', 'qualified', 'source', 'attendedTapAt', 'rebookAttempts', 'disputeReason'];

export async function buildHandover(clientId) {
  const [allLeads, replies, bookings] = await Promise.all([getLeads(clientId), getReplies(clientId), getBookings(clientId)]);
  // Leads the grader rejected (role addresses, invalid emails, out of area…) were never theirs to contact.
  const leads = allLeads.filter((l) => l.status !== 'rejected');
  return {
    leadCount: leads.length,
    files: [
      { filename: 'leads.csv', content: csv(leads, LEAD_COLS), contentType: 'text/csv' },
      { filename: 'replies.csv', content: csv(replies.filter((r) => r.kind !== 'bounce'), REPLY_COLS), contentType: 'text/csv' },
      { filename: 'bookings.csv', content: csv(bookings.map((b) => ({ ...b, qualified: b.qualified === true || b.qualified === 'true' ? 'yes' : 'no' })), BOOKING_COLS), contentType: 'text/csv' },
    ],
  };
}

/** reason: day30 | qualified | cap | early_stop */
export async function sendHandover(clientId, reason, { now = new Date() } = {}) {
  const client = await getClient(clientId);
  if (!client) return { skipped: 'no client' };
  const market = await renderReport('market', clientId, { now });
  if (!market.ok) return { held: market.blockedReason };
  const sig = await ownerName(clientId, 'The handover pack');
  if (!sig) return { held: 'OWNER.signerName' };
  const pack = await buildHandover(clientId);
  const slug = (client.name || clientId).replace(/[^A-Za-z0-9]+/g, '-');
  const attachments = [
    ...pack.files,
    { filename: `${slug}-market-report.html`, content: market.html, contentType: 'text/html' },
    { filename: `${slug}-market-report.csv`, content: market.text, contentType: 'text/csv' },
  ];
  const res = await notifyClient(clientId, 'handover', { leadCount: pack.leadCount, ownerName: sig }, { dedupe: `handover:${reason}`, attachments });
  if (res.sent || res.deduped) {
    await patchTrial(clientId, { handoverSentAt: now.toISOString(), handoverReason: reason });
    await kv.hset(K.report(clientId, 'handover'), { renderedAt: new Date().toISOString(), html: '', text: `leads ${pack.leadCount}; reason ${reason}`, blockedReason: '' });
    await markReportRendered(clientId, 'handover');
  }
  await logEvent(clientId, 'handover', 'handover_sent', { reason, leads: pack.leadCount, deduped: res.deduped || undefined });
  return { sent: Boolean(res.sent), reason };
}
