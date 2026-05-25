/**
 * Lead Database — Simple JSON-based CRM stored in Vercel KV (Redis)
 * Falls back to in-memory storage for local dev
 *
 * Schema per lead:
 * {
 *   email, company_name, industry, city, phone, website,
 *   ai_score, status, source, contact_name,
 *   sent_at, replied_at, last_followup_at,
 *   send_count, sequence_day, account_used,
 *   scraped_at, notes
 * }
 *
 * Status values: 'new', 'qualified', 'scheduled', 'sent-d0', 'sent-d3', 'sent-d7-complete',
 *                'replied', 'unsubscribed', 'bounced', 'skipped'
 */

// In-memory fallback for environments without KV
let memoryStore = {
  leads: {},          // email -> lead object
  sendQueue: [],      // Array of { email, scheduledAt, sequenceDay, accountEmail }
  stats: { totalScraped: 0, totalSent: 0, totalReplied: 0, totalBounced: 0 },
  lastScrapeAt: null,
  suppressionList: new Set(), // emails that should never be contacted
};

// Try to use Vercel KV if available
let kv = null;
async function getKV() {
  if (kv) return kv;
  try {
    const { kv: vercelKV } = await import('@vercel/kv');
    kv = vercelKV;
    return kv;
  } catch {
    return null; // Use memory fallback
  }
}

/**
 * Get all leads from the database
 */
export async function getAllLeads() {
  const store = await getKV();
  if (store) {
    const leads = await store.get('outreach:leads') || {};
    return Object.values(leads);
  }
  return Object.values(memoryStore.leads);
}

/**
 * Get lead by email
 */
export async function getLead(email) {
  const store = await getKV();
  if (store) {
    const leads = await store.get('outreach:leads') || {};
    return leads[email.toLowerCase()] || null;
  }
  return memoryStore.leads[email.toLowerCase()] || null;
}

/**
 * Add or update a lead
 */
export async function upsertLead(lead) {
  const email = lead.email.toLowerCase().trim();
  const store = await getKV();

  if (store) {
    const leads = await store.get('outreach:leads') || {};
    leads[email] = { ...leads[email], ...lead, email, updatedAt: new Date().toISOString() };
    await store.set('outreach:leads', leads);
    return leads[email];
  }

  memoryStore.leads[email] = {
    ...memoryStore.leads[email],
    ...lead,
    email,
    updatedAt: new Date().toISOString(),
  };
  return memoryStore.leads[email];
}

/**
 * Bulk upsert leads (from scraper)
 */
export async function bulkUpsertLeads(leads) {
  const store = await getKV();
  let added = 0;
  let skipped = 0;

  if (store) {
    const existing = await store.get('outreach:leads') || {};
    const suppressed = await store.get('outreach:suppression') || [];
    const suppressionSet = new Set(suppressed);

    for (const lead of leads) {
      const email = lead.email.toLowerCase().trim();
      if (suppressionSet.has(email)) { skipped++; continue; }
      if (existing[email]) { skipped++; continue; }

      existing[email] = {
        ...lead,
        email,
        status: 'new',
        send_count: 0,
        sequence_day: -1,
        createdAt: new Date().toISOString(),
      };
      added++;
    }

    await store.set('outreach:leads', existing);
  } else {
    for (const lead of leads) {
      const email = lead.email.toLowerCase().trim();
      if (memoryStore.suppressionList.has(email)) { skipped++; continue; }
      if (memoryStore.leads[email]) { skipped++; continue; }

      memoryStore.leads[email] = {
        ...lead,
        email,
        status: 'new',
        send_count: 0,
        sequence_day: -1,
        createdAt: new Date().toISOString(),
      };
      added++;
    }
  }

  return { added, skipped, total: added + skipped };
}

/**
 * Check if an email exists in the database
 */
export async function isDuplicate(email) {
  const store = await getKV();
  if (store) {
    const leads = await store.get('outreach:leads') || {};
    return !!leads[email.toLowerCase()];
  }
  return !!memoryStore.leads[email.toLowerCase()];
}

/**
 * Get leads ready for sending (status = 'qualified' or follow-up ready)
 * @param {number} limit - Max leads to return
 */
export async function getLeadsToSend(limit = 30) {
  const allLeads = await getAllLeads();
  const now = new Date();

  const readyLeads = allLeads.filter(lead => {
    // New qualified leads ready for first email
    if (lead.status === 'qualified') return true;

    // Day 3 follow-up
    if (lead.status === 'sent-d0' && lead.sent_at) {
      const sentDate = new Date(lead.sent_at);
      const daysSince = (now - sentDate) / (1000 * 60 * 60 * 24);
      if (daysSince >= 3) return true;
    }

    // Day 7 follow-up
    if (lead.status === 'sent-d3' && lead.last_followup_at) {
      const lastFollowup = new Date(lead.last_followup_at);
      const daysSince = (now - lastFollowup) / (1000 * 60 * 60 * 24);
      if (daysSince >= 4) return true;
    }

    return false;
  });

  // Sort by AI score (highest first)
  readyLeads.sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));

  return readyLeads.slice(0, limit);
}

/**
 * Mark a lead as sent
 */
export async function markAsSent(email, accountEmail, sequenceDay = 0) {
  const statusMap = { 0: 'sent-d0', 3: 'sent-d3', 7: 'sent-d7-complete' };
  const status = statusMap[sequenceDay] || 'sent-d0';

  return upsertLead({
    email,
    status,
    account_used: accountEmail,
    send_count: (await getLead(email))?.send_count + 1 || 1,
    sequence_day: sequenceDay,
    ...(sequenceDay === 0 ? { sent_at: new Date().toISOString() } : {}),
    last_followup_at: sequenceDay > 0 ? new Date().toISOString() : undefined,
  });
}

/**
 * Mark a lead as replied (stops follow-ups)
 */
export async function markAsReplied(email) {
  return upsertLead({
    email,
    status: 'replied',
    replied_at: new Date().toISOString(),
  });
}

/**
 * Add email to suppression list (unsubscribe)
 */
export async function addToSuppression(email) {
  const store = await getKV();
  const emailLower = email.toLowerCase().trim();

  if (store) {
    const suppressed = await store.get('outreach:suppression') || [];
    if (!suppressed.includes(emailLower)) {
      suppressed.push(emailLower);
      await store.set('outreach:suppression', suppressed);
    }
  } else {
    memoryStore.suppressionList.add(emailLower);
  }

  return upsertLead({ email: emailLower, status: 'unsubscribed' });
}

/**
 * Get campaign stats
 */
export async function getStats() {
  const allLeads = await getAllLeads();

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

/**
 * Get the send queue (scheduled sends)
 */
export async function getSendQueue() {
  const store = await getKV();
  if (store) {
    return await store.get('outreach:queue') || [];
  }
  return memoryStore.sendQueue;
}

/**
 * Save the send queue
 */
export async function saveSendQueue(queue) {
  const store = await getKV();
  if (store) {
    await store.set('outreach:queue', queue);
  } else {
    memoryStore.sendQueue = queue;
  }
}

/**
 * Clear old completed items from queue
 */
export async function cleanQueue() {
  const queue = await getSendQueue();
  const now = Date.now();
  // Keep items scheduled for the future + items from last 24h for logging
  const cleaned = queue.filter(item =>
    item.scheduledAt > now - (24 * 60 * 60 * 1000)
  );
  await saveSendQueue(cleaned);
  return cleaned.length;
}
