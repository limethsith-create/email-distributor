/**
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
