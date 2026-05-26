/**
 * Lead Database — Vercel KV (Upstash Redis) for persistent storage
 * All leads, sent emails, and stats persist across requests.
 */

import { kv } from '@vercel/kv';

const LEADS_KEY = 'leads';
const SENT_LOG_KEY = 'sent_log';
const STATS_KEY = 'stats';
const SUPPRESSION_KEY = 'suppression';

export async function getAllLeads() {
  try {
    const leads = await kv.hgetall(LEADS_KEY);
    if (!leads) return [];
    return Object.values(leads);
  } catch { return []; }
}

export async function getLead(email) {
  try { return await kv.hget(LEADS_KEY, email.toLowerCase()); }
  catch { return null; }
}

export async function upsertLead(lead) {
  const email = lead.email.toLowerCase().trim();
  const existing = await getLead(email);
  const updated = { ...existing, ...lead, email, updatedAt: new Date().toISOString() };
  await kv.hset(LEADS_KEY, { [email]: updated });
  return updated;
}

export async function bulkUpsertLeads(leads) {
  let added = 0, skipped = 0;
  for (const lead of leads) {
    const email = lead.email.toLowerCase().trim();
    const suppressed = await kv.sismember(SUPPRESSION_KEY, email);
    if (suppressed) { skipped++; continue; }
    const existing = await kv.hget(LEADS_KEY, email);
    if (existing) { skipped++; continue; }
    await kv.hset(LEADS_KEY, { [email]: {
      ...lead, email, status: lead.status || 'new',
      send_count: 0, sequence_day: -1, createdAt: new Date().toISOString(),
    }});
    added++;
  }
  await kv.hincrby(STATS_KEY, 'totalScraped', added);
  return { added, skipped, total: added + skipped };
}

export async function isDuplicate(email) {
  return (await kv.hexists(LEADS_KEY, email.toLowerCase())) === 1;
}

export async function getLeadsToSend(limit = 30) {
  const allLeads = await getAllLeads();
  const now = new Date();
  const ready = allLeads.filter(lead => {
    if (lead.status === 'qualified') return true;
    if (lead.status === 'sent-d0' && lead.sent_at) {
      if ((now - new Date(lead.sent_at)) / 86400000 >= 3) return true;
    }
    if (lead.status === 'sent-d3' && lead.last_followup_at) {
      if ((now - new Date(lead.last_followup_at)) / 86400000 >= 4) return true;
    }
    return false;
  });
  ready.sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));
  return ready.slice(0, limit);
}

export async function markAsSent(email, accountEmail, sequenceDay = 0) {
  const statusMap = { 0: 'sent-d0', 3: 'sent-d3', 7: 'sent-d7-complete' };
  const existing = await getLead(email.toLowerCase());
  return upsertLead({
    email, status: statusMap[sequenceDay] || 'sent-d0',
    account_used: accountEmail,
    send_count: (existing?.send_count || 0) + 1,
    sequence_day: sequenceDay,
    ...(sequenceDay === 0 ? { sent_at: new Date().toISOString() } : {}),
    last_followup_at: sequenceDay > 0 ? new Date().toISOString() : undefined,
  });
}

export async function markAsReplied(email) {
  return upsertLead({ email, status: 'replied', replied_at: new Date().toISOString() });
}

export async function addToSuppression(email) {
  const e = email.toLowerCase().trim();
  await kv.sadd(SUPPRESSION_KEY, e);
  return upsertLead({ email: e, status: 'unsubscribed' });
}

export async function logSentEmail(entry) {
  const logEntry = { ...entry, timestamp: entry.timestamp || new Date().toISOString() };
  await kv.lpush(SENT_LOG_KEY, logEntry);
  await kv.ltrim(SENT_LOG_KEY, 0, 499);
  if (entry.status === 'sent') await kv.hincrby(STATS_KEY, 'totalSent', 1);
  else await kv.hincrby(STATS_KEY, 'totalFailed', 1);
  return logEntry;
}

export async function getSentLog(limit = 100) {
  try { return (await kv.lrange(SENT_LOG_KEY, 0, limit - 1)) || []; }
  catch { return []; }
}

export async function getStats() {
  try {
    const allLeads = await getAllLeads();
    const gs = (await kv.hgetall(STATS_KEY)) || {};
    return {
      totalLeads: allLeads.length,
      new: allLeads.filter(l => l.status === 'new').length,
      qualified: allLeads.filter(l => l.status === 'qualified').length,
      sentD0: allLeads.filter(l => l.status === 'sent-d0').length,
      sentD3: allLeads.filter(l => l.status === 'sent-d3').length,
      completed: allLeads.filter(l => l.status === 'sent-d7-complete').length,
      replied: allLeads.filter(l => l.status === 'replied').length,
      unsubscribed: allLeads.filter(l => l.status === 'unsubscribed').length,
      bounced: allLeads.filter(l => l.status === 'bounced').length,
      skipped: allLeads.filter(l => l.status === 'skipped').length,
      totalSent: parseInt(gs.totalSent || 0),
      totalFailed: parseInt(gs.totalFailed || 0),
      totalScraped: parseInt(gs.totalScraped || 0),
    };
  } catch { return { totalLeads: 0, totalSent: 0, totalFailed: 0 }; }
}

export async function getSendQueue() { return []; }
export async function saveSendQueue() {}
export async function cleanQueue() { return 0; }/**
 * Lead Database — In-memory store for the current serverless invocation
 *
 * For persistent storage across requests on Vercel, the scheduled Claude task
 * handles the data — it scrapes leads and sends them via /api/outreach/blast
 * in a single request. No cross-request persistence needed.
 */

// In-memory store (persists within a single request lifecycle on Vercel)
let memoryStore = {
  leads: {},
  sendQueue: [],
  stats: { totalScraped: 0, totalSent: 0, totalReplied: 0, totalBounced: 0 },
  lastScrapeAt: null,
  suppressionList: new Set(),
};

export async function getAllLeads() {
  return Object.values(memoryStore.leads);
}

export async function getLead(email) {
  return memoryStore.leads[email.toLowerCase()] || null;
}

export async function upsertLead(lead) {
  const email = lead.email.toLowerCase().trim();
  memoryStore.leads[email] = {
    ...memoryStore.leads[email],
    ...lead,
    email,
    updatedAt: new Date().toISOString(),
  };
  return memoryStore.leads[email];
}

export async function bulkUpsertLeads(leads) {
  let added = 0;
  let skipped = 0;
  for (const lead of leads) {
    const email = lead.email.toLowerCase().trim();
    if (memoryStore.suppressionList.has(email)) { skipped++; continue; }
    if (memoryStore.leads[email]) { skipped++; continue; }
    memoryStore.leads[email] = {
      ...lead, email,
      status: lead.status || 'new',
      send_count: 0,
      sequence_day: -1,
      createdAt: new Date().toISOString(),
    };
    added++;
  }
  return { added, skipped, total: added + skipped };
}

export async function isDuplicate(email) {
  return !!memoryStore.leads[email.toLowerCase()];
}

export async function getLeadsToSend(limit = 30) {
  const allLeads = Object.values(memoryStore.leads);
  const now = new Date();
  const readyLeads = allLeads.filter(lead => {
    if (lead.status === 'qualified') return true;
    if (lead.status === 'sent-d0' && lead.sent_at) {
      const daysSince = (now - new Date(lead.sent_at)) / (1000 * 60 * 60 * 24);
      if (daysSince >= 3) return true;
    }
    if (lead.status === 'sent-d3' && lead.last_followup_at) {
      const daysSince = (now - new Date(lead.last_followup_at)) / (1000 * 60 * 60 * 24);
      if (daysSince >= 4) return true;
    }
    return false;
  });
  readyLeads.sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));
  return readyLeads.slice(0, limit);
}

export async function markAsSent(email, accountEmail, sequenceDay = 0) {
  const statusMap = { 0: 'sent-d0', 3: 'sent-d3', 7: 'sent-d7-complete' };
  const status = statusMap[sequenceDay] || 'sent-d0';
  return upsertLead({
    email, status,
    account_used: accountEmail,
    send_count: (memoryStore.leads[email.toLowerCase()]?.send_count || 0) + 1,
    sequence_day: sequenceDay,
    ...(sequenceDay === 0 ? { sent_at: new Date().toISOString() } : {}),
    last_followup_at: sequenceDay > 0 ? new Date().toISOString() : undefined,
  });
}

export async function markAsReplied(email) {
  return upsertLead({ email, status: 'replied', replied_at: new Date().toISOString() });
}

export async function addToSuppression(email) {
  const emailLower = email.toLowerCase().trim();
  memoryStore.suppressionList.add(emailLower);
  return upsertLead({ email: emailLower, status: 'unsubscribed' });
}

export async function getStats() {
  const allLeads = Object.values(memoryStore.leads);
  return {
    totalLeads: allLeads.length,
    new: allLeads.filter(l => l.status === 'new').length,
    qualified: allLeads.filter(l => l.status === 'qualified').length,
    sentD0: allLeads.filter(l => l.status === 'sent-d0').length,
    sentD3: allLeads.filter(l => l.status === 'sent-d3').length,
    completed: allLeads.filter(l => l.status === 'sent-d7-complete').length,
    replied: allLeads.filter(l => l.status === 'replied').length,
    unsubscribed: allLeads.filter(l => l.status === 'unsubscribed').length,
    bounced: allLeads.filter(l => l.status === 'bounced').length,
    skipped: allLeads.filter(l => l.status === 'skipped').length,
  };
}

export async function getSendQueue() {
  return memoryStore.sendQueue;
}

export async function saveSendQueue(queue) {
  memoryStore.sendQueue = queue;
}

export async function cleanQueue() {
  const now = Date.now();
  memoryStore.sendQueue = memoryStore.sendQueue.filter(item =>
    item.scheduledAt > now - (24 * 60 * 60 * 1000)
  );
  return memoryStore.sendQueue.length;
}
