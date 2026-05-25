/**
 * 24/7 Email Scheduler
 * Distributes emails across the day with random delays
 * 30 emails per account per day = 150 total across 5 accounts
 * Random gaps of 5-30 minutes between sends
 */

import { getLeadsToSend, markAsSent, saveSendQueue, getSendQueue } from './leads-db';
import { getEmailForSequenceDay, enhanceWithAI } from './personalize';
import { sendEmail, createTransporter } from './mailer';

/**
 * Parse Gmail accounts from environment variables
 * Format: email:appPassword:displayName
 */
export function getGmailAccounts() {
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    const envVar = process.env[`GMAIL_ACCOUNT_${i}`];
    if (!envVar) continue;

    const parts = envVar.split(':');
    if (parts.length >= 2) {
      accounts.push({
        email: parts[0],
        appPassword: parts[1],
        displayName: parts[2] || parts[0].split('@')[0],
      });
    }
  }
  return accounts;
}

/**
 * Generate random delay between min and max minutes
 * @param {number} minMinutes - Minimum delay in minutes (default 5)
 * @param {number} maxMinutes - Maximum delay in minutes (default 30)
 * @returns {number} Delay in milliseconds
 */
function randomDelay(minMinutes = 5, maxMinutes = 30) {
  const minutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
  return Math.floor(minutes * 60 * 1000);
}

/**
 * Generate a daily send schedule
 * Creates timestamps spread across 24 hours with random gaps
 * @param {number} emailsPerAccount - Emails per account per day (default 30)
 * @param {number} numAccounts - Number of accounts (default 5)
 * @returns {Array} Array of { scheduledAt, accountIndex } sorted by time
 */
export function generateDailySchedule(emailsPerAccount = 30, numAccounts = 5) {
  const schedule = [];
  const now = Date.now();

  // Spread emails across 24 hours starting from now
  // Total emails = emailsPerAccount * numAccounts = 150
  const totalEmails = emailsPerAccount * numAccounts;

  // Start from the next minute
  let currentTime = now + 60 * 1000;

  for (let i = 0; i < totalEmails; i++) {
    const accountIndex = i % numAccounts; // Round-robin across accounts

    schedule.push({
      scheduledAt: currentTime,
      accountIndex,
      index: i,
    });

    // Add random delay (5-30 min) before next email
    // This creates natural, human-like sending patterns
    currentTime += randomDelay(5, 30);
  }

  // Shuffle slightly to avoid perfect round-robin pattern
  // (swap adjacent pairs randomly)
  for (let i = 0; i < schedule.length - 1; i++) {
    if (Math.random() > 0.7) {
      const tempTime = schedule[i].scheduledAt;
      schedule[i].scheduledAt = schedule[i + 1].scheduledAt;
      schedule[i + 1].scheduledAt = tempTime;
    }
  }

  // Sort by scheduled time
  schedule.sort((a, b) => a.scheduledAt - b.scheduledAt);

  return schedule;
}

/**
 * Build the full send queue for a day
 * Matches leads with schedule slots and accounts
 * @param {Array} leads - Qualified leads to send to
 * @param {Array} accounts - Gmail accounts
 * @param {number} emailsPerAccount - Max emails per account (default 30)
 * @returns {Array} Queue items ready for sending
 */
export function buildSendQueue(leads, accounts, emailsPerAccount = 30) {
  if (!leads.length || !accounts.length) return [];

  const totalPerDay = emailsPerAccount * accounts.length;
  const leadsToProcess = leads.slice(0, totalPerDay);
  const schedule = generateDailySchedule(emailsPerAccount, accounts.length);

  const queue = [];
  for (let i = 0; i < leadsToProcess.length; i++) {
    const lead = leadsToProcess[i];
    const slot = schedule[i];
    if (!slot) break;

    const account = accounts[slot.accountIndex];

    // Determine sequence day
    let sequenceDay = 0;
    if (lead.status === 'sent-d0') sequenceDay = 3;
    if (lead.status === 'sent-d3') sequenceDay = 7;

    queue.push({
      email: lead.email,
      company_name: lead.company_name,
      industry: lead.industry,
      accountEmail: account.email,
      accountIndex: slot.accountIndex,
      scheduledAt: slot.scheduledAt,
      sequenceDay,
      status: 'pending',
      lead, // Full lead data for personalization
    });
  }

  return queue;
}

/**
 * Process the send queue — sends emails that are due
 * Called by the cron job every 5 minutes
 * @param {object} options
 * @returns {object} { sent, failed, remaining }
 */
export async function processSendQueue(options = {}) {
  const { dryRun = false, maxPerRun = 10 } = options;

  const accounts = getGmailAccounts();
  if (!accounts.length) {
    return { error: 'No Gmail accounts configured', sent: 0, failed: 0, remaining: 0 };
  }

  let queue = await getSendQueue();
  const now = Date.now();
  const results = { sent: 0, failed: 0, remaining: 0, details: [] };

  // Filter to items that are due now and still pending
  const dueItems = queue
    .filter(item => item.status === 'pending' && item.scheduledAt <= now)
    .slice(0, maxPerRun); // Process max N per cron run (Vercel timeout)

  for (const item of dueItems) {
    const account = accounts.find(a => a.email === item.accountEmail) || accounts[item.accountIndex];
    if (!account) {
      item.status = 'failed';
      item.error = 'Account not found';
      results.failed++;
      continue;
    }

    // Generate personalized email
    const emailContent = getEmailForSequenceDay(item.lead, item.sequenceDay);

    // Optional AI enhancement
    const finalEmail = await enhanceWithAI(item.lead, emailContent);

    // Convert body to HTML paragraphs
    const htmlBody = finalEmail.body
      .split(/\n\n+/)
      .map(paragraph => {
        const escaped = paragraph
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');
        return `<p style="margin:0 0 16px 0;">${escaped}</p>`;
      })
      .join('\n');

    if (dryRun) {
      console.log(`[scheduler] DRY RUN: Would send to ${item.email} from ${account.email}`);
      item.status = 'sent';
      results.sent++;
      continue;
    }

    try {
      const sendResult = await sendEmail(account, {
        to: item.email,
        subject: finalEmail.subject,
        html: htmlBody,
        text: finalEmail.body,
      });

      if (sendResult.success) {
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        item.messageId = sendResult.messageId;
        await markAsSent(item.email, account.email, item.sequenceDay);
        results.sent++;
        results.details.push({
          to: item.email,
          from: account.email,
          status: 'sent',
          messageId: sendResult.messageId,
        });
      } else {
        item.status = 'failed';
        item.error = sendResult.error;
        results.failed++;
        results.details.push({
          to: item.email,
          from: account.email,
          status: 'failed',
          error: sendResult.error,
        });
      }
    } catch (err) {
      item.status = 'failed';
      item.error = err.message;
      results.failed++;
    }

    // Random delay between sends (2-8 seconds) to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 6000));
  }

  // Count remaining
  results.remaining = queue.filter(item => item.status === 'pending').length;

  // Save updated queue
  await saveSendQueue(queue);

  return results;
}

/**
 * Create a new daily queue — called by the daily scrape cron
 * Fetches leads, builds schedule, saves to queue
 */
export async function createDailyQueue() {
  const accounts = getGmailAccounts();
  if (!accounts.length) {
    return { error: 'No Gmail accounts configured' };
  }

  const emailsPerAccount = parseInt(process.env.EMAILS_PER_ACCOUNT || '30', 10);
  const totalNeeded = emailsPerAccount * accounts.length;

  // Get leads ready to send (qualified + follow-up ready)
  const leads = await getLeadsToSend(totalNeeded);

  if (!leads.length) {
    return { message: 'No leads ready to send', leadsAvailable: 0 };
  }

  // Build the send queue with randomized schedule
  const queue = buildSendQueue(leads, accounts, emailsPerAccount);

  // Save queue
  await saveSendQueue(queue);

  const firstSend = new Date(queue[0]?.scheduledAt).toISOString();
  const lastSend = new Date(queue[queue.length - 1]?.scheduledAt).toISOString();

  return {
    message: 'Daily queue created',
    totalQueued: queue.length,
    accounts: accounts.length,
    emailsPerAccount,
    firstSendAt: firstSend,
    lastSendAt: lastSend,
    schedule: queue.map(q => ({
      to: q.email,
      from: q.accountEmail,
      at: new Date(q.scheduledAt).toISOString(),
      day: q.sequenceDay,
    })),
  };
}
