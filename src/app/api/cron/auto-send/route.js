/**
 * Autonomous Email Sender — Zero Claude Dependency
 *
 * This endpoint runs on a cron schedule (or external trigger) and:
 * 1. Checks how many emails each account has sent TODAY
 * 2. Picks unsent leads from KV (status = "pending" or "new")
 * 3. Sends up to 15 emails per account per day (scales with any number of accounts)
 * 4. Logs everything to KV for dashboard visibility
 * 5. Random delays between sends to look natural
 *
 * Trigger via:
 * - Vercel Cron (add to vercel.json)
 * - External cron: https://your-app.vercel.app/api/cron/auto-send?token=YOUR_SECRET
 * - cron-job.org (free, every 30 min)
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getEmailForSequenceDay } from '@/lib/personalize';
import { logSentEmail } from '@/lib/leads-db';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_PER_ACCOUNT_PER_DAY = 15;
const LEADS_KEY = 'leads';
const DAILY_SEND_KEY = 'daily_sends'; // Hash: "account:YYYY-MM-DD" -> count

function getGmailAccounts() {
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

function getTodayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function randomDelay(min = 3000, max = 15000) {
  return min + Math.random() * (max - min);
}

async function getDailySendCount(accountEmail) {
  const key = `${accountEmail}:${getTodayKey()}`;
  try {
    const count = await kv.hget(DAILY_SEND_KEY, key);
    return parseInt(count || '0');
  } catch {
    return 0;
  }
}

async function incrementDailySend(accountEmail) {
  const key = `${accountEmail}:${getTodayKey()}`;
  await kv.hincrby(DAILY_SEND_KEY, key, 1);
}

async function getUnsent(limit = 75) {
  try {
    const allLeads = await kv.hgetall(LEADS_KEY);
    if (!allLeads) return [];

    const unsent = Object.values(allLeads)
      .filter(lead => {
        const status = (lead.status || '').toLowerCase();
        return (status === 'pending' || status === 'new') && lead.email;
      });

    // Shuffle before slicing so each trigger gets different leads
    for (let i = unsent.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unsent[i], unsent[j]] = [unsent[j], unsent[i]];
    }

    return unsent.slice(0, limit);
  } catch {
    return [];
  }
}

async function markLeadAsSent(email, accountEmail, subject) {
  try {
    const existing = await kv.hget(LEADS_KEY, email.toLowerCase());
    const updated = {
      ...existing,
      email: email.toLowerCase(),
      status: 'sent-d0',
      account_used: accountEmail,
      sent_at: new Date().toISOString(),
      send_count: (existing?.send_count || 0) + 1,
      sequence_day: 0,
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(LEADS_KEY, { [email.toLowerCase()]: updated });
  } catch (err) {
    console.error('[auto-send] markLeadAsSent error:', err.message);
  }
}

export async function GET(request) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    if (authHeader !== `Bearer ${cronSecret}` && tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const accounts = getGmailAccounts();
  if (!accounts.length) {
    return Response.json({ error: 'No Gmail accounts configured' }, { status: 500 });
  }

  // Support batch_size param from external schedulers (n8n, cron-job.org, etc.)
  // e.g. ?token=SECRET&batch=10 sends max 10 emails this invocation
  const { searchParams: params } = new URL(request.url);
  const batchSize = parseInt(params.get('batch') || '0') || 0; // 0 = no limit (use daily max)

  // Check daily limits for each account
  const accountStatus = [];
  let totalRemaining = 0;

  for (const acc of accounts) {
    const sent = await getDailySendCount(acc.email);
    const remaining = Math.max(0, MAX_PER_ACCOUNT_PER_DAY - sent);
    accountStatus.push({ email: acc.email, sentToday: sent, remaining });
    totalRemaining += remaining;
  }

  if (totalRemaining === 0) {
    return Response.json({
      success: true,
      message: 'Daily limit reached for all accounts',
      timestamp: new Date().toISOString(),
      sent: 0,
      accountStatus,
    });
  }

  // Apply batch size limit if specified
  const effectiveLimit = batchSize > 0 ? Math.min(batchSize, totalRemaining) : totalRemaining;

  // Get unsent leads
  const unsent = await getUnsent(effectiveLimit);

  if (unsent.length === 0) {
    return Response.json({
      success: true,
      message: 'No unsent leads available',
      timestamp: new Date().toISOString(),
      sent: 0,
      accountStatus,
    });
  }

  // Send emails — round-robin across accounts respecting daily limits
  const results = { sent: 0, failed: 0, skipped: 0, details: [] };
  let accountIndex = 0;

  // Shuffle unsent leads for variety
  for (let i = unsent.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unsent[i], unsent[j]] = [unsent[j], unsent[i]];
  }

  for (const lead of unsent) {
    // Find next account with remaining quota
    let found = false;
    let attempts = 0;

    while (attempts < accounts.length) {
      const accStat = accountStatus[accountIndex % accounts.length];
      if (accStat.remaining > 0) {
        found = true;
        break;
      }
      accountIndex++;
      attempts++;
    }

    if (!found) break; // All accounts exhausted

    const accIdx = accountIndex % accounts.length;
    const account = accounts[accIdx];
    const accStat = accountStatus[accIdx];

    // Prepare lead for personalization
    const qualifiedLead = {
      ...lead,
      email: lead.email.toLowerCase().trim(),
      industry: lead.industry || 'business',
      company_name: lead.company || lead.company_name || 'your business',
      city: lead.city || 'Sri Lanka',
      first_name: lead.name?.split(/[\s,]/)[0] || null,
    };

    const emailContent = getEmailForSequenceDay(qualifiedLead, 0);

    // Convert plain text to HTML with proper signature formatting
    const bodyParts = emailContent.body.split('---');
    const mainBody = bodyParts[0];
    const unsubNote = bodyParts[1] || '';

    const htmlParagraphs = mainBody
      .split(/\n\n+/)
      .map(p => {
        let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        // Keep URLs as plain text in body — fewer links = better deliverability
        // Only the signature link is clickable
        return `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${escaped}</p>`;
      })
      .join('\n');

    const htmlSignature = `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#555;">
        Limethsith<br>
        Aviance — AI Growth Systems<br>
        071 870 2702 | <a href="https://www.aviance.online" style="color:#555;text-decoration:none;">aviance.online</a>
      </div>`;

    const htmlUnsubscribe = unsubNote
      ? `<p style="margin-top:24px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">${unsubNote.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
      : '';

    const htmlBody = htmlParagraphs + htmlSignature + htmlUnsubscribe;

    try {
      const sendResult = await sendEmail(account, {
        to: qualifiedLead.email,
        subject: emailContent.subject,
        html: htmlBody,
        text: emailContent.body,
      });

      if (sendResult.success) {
        results.sent++;
        accStat.remaining--;
        accStat.sentToday++;

        await incrementDailySend(account.email);
        await markLeadAsSent(qualifiedLead.email, account.email, emailContent.subject);

        try {
          await logSentEmail({
            to: qualifiedLead.email,
            from: account.email,
            company: qualifiedLead.company_name,
            industry: qualifiedLead.industry,
            subject: emailContent.subject,
            bodyPreview: emailContent.body.substring(0, 200),
            status: 'sent',
            messageId: sendResult.messageId,
            sequenceDay: 0,
            source: 'auto-send',
          });
        } catch (kvErr) {
          console.error('[auto-send] KV log error:', kvErr.message);
        }

        results.details.push({
          to: qualifiedLead.email,
          from: account.email,
          company: qualifiedLead.company_name,
          status: 'sent',
        });
      } else {
        results.failed++;
        results.details.push({
          to: qualifiedLead.email,
          from: account.email,
          status: 'failed',
          error: sendResult.error,
        });
      }
    } catch (err) {
      results.failed++;
      results.details.push({
        to: qualifiedLead.email,
        status: 'error',
        error: err.message,
      });
    }

    // Move to next account (round-robin)
    accountIndex++;

    // Random delay between sends
    if (results.sent + results.failed < unsent.length) {
      await new Promise(r => setTimeout(r, randomDelay()));
    }
  }

  // Update total sent stat
  if (results.sent > 0) {
    try {
      await kv.hincrby('stats', 'totalSent', results.sent);
    } catch {}
  }

  return Response.json({
    success: true,
    timestamp: new Date().toISOString(),
    today: getTodayKey(),
    ...results,
    accountStatus,
    unsentRemaining: unsent.length - results.sent - results.failed,
  });
}
