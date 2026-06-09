/**
 * Autonomous Email Sender — Zero Claude Dependency
 *
 * FIXES applied:
 * - Persistent account rotation (KV counter, not resetting to 0)
 * - Lead claiming with atomic status check (no duplicate sends)
 * - Clean HTML body (strip plain-text sig before adding HTML sig)
 * - Concurrency lock to prevent overlapping triggers
 *
 * Trigger via n8n every hour with ?batch=1
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getEmailForSequenceDay } from '@/lib/personalize';
import { logSentEmail } from '@/lib/leads-db';
import { verifyEmail } from '@/lib/email-verify';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_PER_ACCOUNT_PER_DAY = 12;
const LEADS_KEY = 'leads';
const DAILY_SEND_KEY = 'daily_sends';
const LOCK_KEY = 'auto_send_lock';
const LOCK_TTL_SECONDS = 300; // 5 minute lock — matches maxDuration
const COMPANY_SENT_KEY = 'company_sent';

function isGenericEmail(email) {
  const genericPrefixes = [
    'info@', 'contact@', 'sales@', 'admin@', 'support@', 'hello@',
    'reservations@', 'marketing@', 'hr@', 'careers@', 'jobs@',
    'billing@', 'accounts@', 'enquiries@', 'enquiry@', 'reception@',
    'office@', 'general@', 'noreply@', 'no-reply@', 'webmaster@',
  ];
  const genericDomains = ['ac.lk', 'edu.lk', 'gov.lk', 'mrt.ac.lk', 'cmb.ac.lk'];
  const lower = email.toLowerCase();
  if (genericPrefixes.some(p => lower.startsWith(p))) return true;
  if (genericDomains.some(d => lower.endsWith(d))) return true;
  return false;
}

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase().trim()
    .replace(/\s*(pvt\.?\s*ltd\.?|ltd\.?|plc|llc|inc\.?|private\s+limited|limited)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

async function isCompanyAlreadySent(companyName) {
  if (!companyName) return false;
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return false;
  try {
    return await kv.sismember(COMPANY_SENT_KEY, normalized);
  } catch { return false; }
}

async function markCompanySent(companyName) {
  if (!companyName) return;
  const normalized = normalizeCompanyName(companyName);
  if (normalized) {
    try { await kv.sadd(COMPANY_SENT_KEY, normalized); } catch {}
  }
}

// ============================================================
// Per-account randomized scheduling — removes Claude dependency
// Each account gets its own "next send time" stored in Redis.
// GitHub Actions pings every 30 min; this code decides who's ready.
// ============================================================
const ACCOUNT_SCHEDULE_KEY = 'account_next_send';

async function isAccountReady(accountEmail) {
  try {
    const nextSendTime = await kv.hget(ACCOUNT_SCHEDULE_KEY, accountEmail);
    if (!nextSendTime) return true; // First time — ready immediately
    return Date.now() >= new Date(nextSendTime).getTime();
  } catch {
    return true;
  }
}

async function scheduleNextSend(accountEmail) {
  // Random delay: 35 to 55 minutes from now (~12 sends in 9 hours with jitter)
  const delayMinutes = 35 + Math.floor(Math.random() * 21);
  const nextTime = new Date(Date.now() + delayMinutes * 60 * 1000);
  try {
    await kv.hset(ACCOUNT_SCHEDULE_KEY, { [accountEmail]: nextTime.toISOString() });
  } catch {}
}

/**
 * Business hours check — only send 7 AM to 11 PM Sri Lanka time (UTC+5:30)
 * This gives a 16-hour window to fit sends per account.
 */
function isWithinSendingHours() {
  const now = new Date();
  // Sri Lanka is UTC+5:30
  const sriLankaOffset = 5.5 * 60; // minutes
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const slMinutes = (utcMinutes + sriLankaOffset) % (24 * 60);
  const slHour = Math.floor(slMinutes / 60);
  return slHour >= 7 && slHour < 23; // 7 AM to 11 PM
}

async function getAccountScheduleStatus(accounts) {
  const status = [];
  for (const acc of accounts) {
    try {
      const nextTime = await kv.hget(ACCOUNT_SCHEDULE_KEY, acc.email);
      status.push({
        email: acc.email,
        nextSendAt: nextTime || 'ready now',
        ready: !nextTime || Date.now() >= new Date(nextTime).getTime(),
      });
    } catch {
      status.push({ email: acc.email, nextSendAt: 'unknown', ready: true });
    }
  }
  return status;
}

// Account loading delegated to shared smtp-accounts lib
const getAccounts = getSmtpAccounts;

function getTodayKey() {
  const now = new Date();
  const slTime = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return slTime.toISOString().split('T')[0];
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

/**
 * Get the next account index using a persistent KV counter.
 * Each invocation increments and gets the next account in rotation.
 */
async function getNextAccountIndex(numAccounts) {
  try {
    const counter = await kv.hincrby('stats', 'rotationIndex', 1);
    return (counter - 1) % numAccounts; // -1 because hincrby returns AFTER increment
  } catch {
    return 0;
  }
}

/**
 * Acquire a simple distributed lock to prevent concurrent sends.
 * Returns true if lock acquired, false if another invocation is running.
 */
async function acquireLock() {
  try {
    // SET NX = only set if not exists, EX = expire after TTL
    const result = await kv.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock() {
  try {
    await kv.del(LOCK_KEY);
  } catch {}
}

/**
 * Claim a lead atomically — set status to "sending" so no other
 * concurrent request can pick it up. Returns true if claimed.
 */
async function claimLead(email) {
  try {
    const existing = await kv.hget(LEADS_KEY, email.toLowerCase());
    if (!existing) return false;
    const status = (existing.status || '').toLowerCase();
    // Only claim if still pending/new
    if (status !== 'pending' && status !== 'new') return false;
    // Mark as "sending" immediately
    await kv.hset(LEADS_KEY, {
      [email.toLowerCase()]: { ...existing, status: 'sending', updatedAt: new Date().toISOString() }
    });
    return true;
  } catch {
    return false;
  }
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

    // Shuffle for variety
    for (let i = unsent.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unsent[i], unsent[j]] = [unsent[j], unsent[i]];
    }

    return unsent.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get leads due for follow-up emails (Day 3 or Day 7)
 * - sent-d0 leads that were sent 3+ days ago → Day 3 follow-up
 * - sent-d3 leads that were sent 3+ days after d3 (6+ days total) → Day 7 follow-up
 * Excludes leads that have replied or bounced
 */
async function getFollowUpLeads(limit = 10) {
  try {
    const allLeads = await kv.hgetall(LEADS_KEY);
    if (!allLeads) return [];

    const now = Date.now();
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    const followUps = [];

    for (const lead of Object.values(allLeads)) {
      if (!lead.email || !lead.sent_at) continue;
      const status = (lead.status || '').toLowerCase();
      const sentAt = new Date(lead.sent_at).getTime();
      const daysSinceSent = now - sentAt;

      // Day 3 follow-up: sent-d0, 3+ days ago, not replied/bounced
      if (status === 'sent-d0' && daysSinceSent >= THREE_DAYS) {
        followUps.push({ ...lead, nextSequenceDay: 3 });
      }
      // Day 7 follow-up: sent-d3, 3+ days after d3 send
      else if (status === 'sent-d3') {
        const d3SentAt = lead.d3_sent_at ? new Date(lead.d3_sent_at).getTime() : sentAt + THREE_DAYS;
        if (now - d3SentAt >= THREE_DAYS) {
          followUps.push({ ...lead, nextSequenceDay: 7 });
        }
      }
    }

    // Shuffle and limit
    for (let i = followUps.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [followUps[i], followUps[j]] = [followUps[j], followUps[i]];
    }

    return followUps.slice(0, limit);
  } catch {
    return [];
  }
}

async function markFollowUpSent(email, sequenceDay, messageId) {
  try {
    const existing = await kv.hget(LEADS_KEY, email.toLowerCase());
    if (!existing) return;
    const updated = {
      ...existing,
      status: `sent-d${sequenceDay}`,
      sequence_day: sequenceDay,
      [`d${sequenceDay}_sent_at`]: new Date().toISOString(),
      [`d${sequenceDay}_message_id`]: messageId || null,
      send_count: (existing.send_count || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    // Mark as completed after Day 7
    if (sequenceDay === 7) {
      updated.status = 'sequence_complete';
    }
    await kv.hset(LEADS_KEY, { [email.toLowerCase()]: updated });
  } catch {}
}

async function markLeadAsSent(email, accountEmail, subject, messageId) {
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
      original_subject: subject,
      original_message_id: messageId || null,
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(LEADS_KEY, { [email.toLowerCase()]: updated });
  } catch (err) {
    console.error('[auto-send] markLeadAsSent error:', err.message);
  }
}

/**
 * Strip the plain-text signature block from the email body.
 * The personalize templates include "Limethsith\nAviance..." in the body,
 * but we add a proper HTML signature separately, so remove it to avoid duplication.
 */
function stripPlainTextSignature(body) {
  // Remove lines starting from the standalone "Limethsith" line through the sig
  const lines = body.split('\n');
  let cutIndex = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === 'Limethsith') {
      cutIndex = i;
      break;
    }
  }
  // Remove trailing empty lines before the signature
  let end = cutIndex;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end).join('\n');
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

  // Business hours check — only send 7 AM to 11 PM Sri Lanka time
  if (!isWithinSendingHours()) {
    return Response.json({
      success: true,
      message: 'Outside sending hours (7 AM - 11 PM Sri Lanka time)',
      timestamp: new Date().toISOString(),
      sent: 0,
    });
  }

  // Concurrency lock — prevent overlapping sends from multiple triggers
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    return Response.json({
      success: true,
      message: 'Another send is already in progress — skipping',
      timestamp: new Date().toISOString(),
      sent: 0,
    });
  }

  try {
    const accounts = getAccounts();
    if (!accounts.length) {
      await releaseLock();
      return Response.json({ error: 'No SMTP accounts configured' }, { status: 500 });
    }

    const { searchParams: params } = new URL(request.url);
    const batchSize = parseInt(params.get('batch') || '0') || 0;

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
      await releaseLock();
      return Response.json({
        success: true,
        message: 'Daily limit reached for all accounts',
        timestamp: new Date().toISOString(),
        sent: 0,
        accountStatus,
      });
    }

    // ============================================================
    // SCHEDULED MODE (default): 1 email per ready account
    // GitHub Actions pings every 30 min; each account sends when
    // its randomized timer expires (~1/hour with jitter)
    // ============================================================
    if (batchSize === 0) {
      const readyAccounts = [];
      const scheduleStatus = await getAccountScheduleStatus(accounts);

      for (let i = 0; i < accounts.length; i++) {
        if (accountStatus[i].remaining <= 0) continue;
        const ready = await isAccountReady(accounts[i].email);
        if (ready) {
          readyAccounts.push({ account: accounts[i], stat: accountStatus[i] });
        }
      }

      if (readyAccounts.length === 0) {
        await releaseLock();
        return Response.json({
          success: true,
          mode: 'scheduled',
          message: 'No accounts ready to send right now',
          timestamp: new Date().toISOString(),
          sent: 0,
          accountStatus,
          scheduleStatus,
        });
      }

      const unsent = await getUnsent(readyAccounts.length * 5);
      if (unsent.length === 0) {
        await releaseLock();
        return Response.json({
          success: true,
          mode: 'scheduled',
          message: 'No unsent leads available',
          timestamp: new Date().toISOString(),
          sent: 0,
          accountStatus,
          scheduleStatus,
        });
      }

      const results = { sent: 0, failed: 0, skipped: 0, details: [] };
      let leadIdx = 0;

      for (const { account, stat } of readyAccounts) {
        let sentFromThisAccount = false;

        while (leadIdx < unsent.length && !sentFromThisAccount) {
          const lead = unsent[leadIdx++];

          const claimed = await claimLead(lead.email);
          if (!claimed) { results.skipped++; continue; }

          if (isGenericEmail(lead.email)) {
            results.skipped++;
            try {
              const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
              if (existing) await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: { ...existing, status: 'skipped_generic', updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          const qualifiedLead = {
            ...lead,
            email: lead.email.toLowerCase().trim(),
            industry: lead.industry || 'business',
            company_name: lead.company || lead.company_name || null,
            city: lead.city || 'Sri Lanka',
            first_name: lead.name?.split(/[\s,]/)[0] || null,
          };

          if (!qualifiedLead.company_name || qualifiedLead.company_name === 'your business') {
            results.skipped++;
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_no_company', updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          const companyAlreadySent = await isCompanyAlreadySent(qualifiedLead.company_name);
          if (companyAlreadySent) {
            results.skipped++;
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_dedup', updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          // Email verification — MX + SMTP check before sending
          const verification = await verifyEmail(qualifiedLead.email);
          if (!verification.valid) {
            results.skipped++;
            results.details.push({ to: qualifiedLead.email, status: 'skipped', reason: `verification failed: ${verification.reason}` });
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_unverified', verify_reason: verification.reason, updatedAt: new Date().toISOString() } });
            } catch {}
            continue;
          }

          const emailContent = getEmailForSequenceDay(qualifiedLead, 0);
          const bodyParts = emailContent.body.split('---');
          const rawBody = bodyParts[0];
          const unsubNote = bodyParts[1] || '';
          const cleanBody = stripPlainTextSignature(rawBody);

          const htmlParagraphs = cleanBody
            .split(/\n\n+/)
            .filter(p => p.trim().length > 0)
            .map(p => {
              let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
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
              stat.remaining--;
              stat.sentToday++;
              sentFromThisAccount = true;

              await incrementDailySend(account.email);
              await markLeadAsSent(qualifiedLead.email, account.email, emailContent.subject, sendResult.messageId);
              await markCompanySent(qualifiedLead.company_name);
              await scheduleNextSend(account.email);

              try {
                await logSentEmail({
                  to: qualifiedLead.email, from: account.email,
                  company: qualifiedLead.company_name, industry: qualifiedLead.industry,
                  subject: emailContent.subject, bodyPreview: emailContent.body.substring(0, 200),
                  status: 'sent', messageId: sendResult.messageId,
                  sequenceDay: 0, source: 'auto-send-scheduled',
                });
              } catch {}

              results.details.push({ to: qualifiedLead.email, from: account.email, company: qualifiedLead.company_name, status: 'sent' });
            } else {
              results.failed++;
              try {
                const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
                if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
              } catch {}
              results.details.push({ to: qualifiedLead.email, from: account.email, status: 'failed', error: sendResult.error });
            }
          } catch (err) {
            results.failed++;
            try {
              const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
              if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
            } catch {}
            results.details.push({ to: qualifiedLead.email, status: 'error', error: err.message });
          }

          // Random delay between account sends (5-20 seconds)
          if (sentFromThisAccount) {
            await new Promise(r => setTimeout(r, randomDelay(5000, 20000)));
          }
        }
      }

      // ============================================================
      // FOLLOW-UP SENDING: Send Day 3 and Day 7 follow-ups
      // Uses the SAME account that sent the original email
      // ============================================================
      const followUpLeads = await getFollowUpLeads(6);
      let followUpsSent = 0;

      for (const fuLead of followUpLeads) {
        // Use the same account that sent the original
        const originalAccount = accounts.find(a => a.email === fuLead.account_used);
        if (!originalAccount) continue;

        // Check daily limit for this account
        const fuSent = await getDailySendCount(originalAccount.email);
        if (fuSent >= MAX_PER_ACCOUNT_PER_DAY) continue;

        const qualifiedLead = {
          ...fuLead,
          email: fuLead.email.toLowerCase().trim(),
          industry: fuLead.industry || 'business',
          company_name: fuLead.company || fuLead.company_name || 'your company',
          city: fuLead.city || 'Sri Lanka',
          first_name: fuLead.name?.split(/[\s,]/)[0] || fuLead.first_name || null,
        };

        const emailContent = getEmailForSequenceDay(qualifiedLead, fuLead.nextSequenceDay);
        const cleanBody = stripPlainTextSignature(emailContent.body);

        const htmlParagraphs = cleanBody
          .split(/\n\n+/)
          .filter(p => p.trim().length > 0)
          .map(p => {
            let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            return `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${escaped}</p>`;
          })
          .join('\n');

        const htmlSignature = `
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#555;">
          Limethsith<br>
          Aviance — AI Growth Systems<br>
          071 870 2702 | <a href="https://www.aviance.online" style="color:#555;text-decoration:none;">aviance.online</a>
        </div>`;

        const htmlBody = htmlParagraphs + htmlSignature;

        // Build threading headers from the stored original messageId
        // For Day 3: reference the original (d0) messageId
        // For Day 7: reference the original + d3 messageId for full thread chain
        const threadingHeaders = {};
        const originalMsgId = fuLead.original_message_id;
        if (originalMsgId) {
          if (fuLead.nextSequenceDay === 3) {
            threadingHeaders.inReplyTo = originalMsgId;
            threadingHeaders.references = originalMsgId;
          } else if (fuLead.nextSequenceDay === 7) {
            const d3MsgId = fuLead.d3_message_id;
            threadingHeaders.inReplyTo = d3MsgId || originalMsgId;
            threadingHeaders.references = d3MsgId
              ? `${originalMsgId} ${d3MsgId}`
              : originalMsgId;
          }
        }

        try {
          const sendResult = await sendEmail(originalAccount, {
            to: qualifiedLead.email,
            subject: emailContent.subject,
            html: htmlBody,
            text: emailContent.body,
            ...threadingHeaders,
          });

          if (sendResult.success) {
            followUpsSent++;
            await incrementDailySend(originalAccount.email);
            await markFollowUpSent(qualifiedLead.email, fuLead.nextSequenceDay, sendResult.messageId);
            try {
              await logSentEmail({
                to: qualifiedLead.email, from: originalAccount.email,
                company: qualifiedLead.company_name, industry: qualifiedLead.industry,
                subject: emailContent.subject, bodyPreview: emailContent.body.substring(0, 200),
                status: 'sent', messageId: sendResult.messageId,
                sequenceDay: fuLead.nextSequenceDay,
                source: `follow-up-d${fuLead.nextSequenceDay}`,
              });
            } catch {}
            results.details.push({ to: qualifiedLead.email, from: originalAccount.email, status: 'follow-up-sent', day: fuLead.nextSequenceDay });
            await new Promise(r => setTimeout(r, randomDelay(5000, 15000)));
          }
        } catch {}
      }

      // NOTE: totalSent is already incremented by logSentEmail() — no hincrby here

      await releaseLock();
      return Response.json({
        success: true,
        mode: 'scheduled',
        timestamp: new Date().toISOString(),
        today: getTodayKey(),
        ...results,
        followUpsSent,
        accountStatus,
        scheduleStatus,
      });
    }

    // ============================================================
    // BATCH MODE: Original behavior when ?batch=N is specified
    // ============================================================
    const effectiveLimit = Math.min(batchSize, totalRemaining);
    const unsent = await getUnsent(effectiveLimit);

    if (unsent.length === 0) {
      await releaseLock();
      return Response.json({
        success: true,
        mode: 'batch',
        message: 'No unsent leads available',
        timestamp: new Date().toISOString(),
        sent: 0,
        accountStatus,
      });
    }

    const startAccountIdx = await getNextAccountIndex(accounts.length);
    let accountIndex = startAccountIdx;
    const results = { sent: 0, failed: 0, skipped: 0, details: [] };

    for (const lead of unsent) {
      const claimed = await claimLead(lead.email);
      if (!claimed) {
        results.skipped++;
        results.details.push({ to: lead.email, status: 'skipped', reason: 'already claimed or sent' });
        continue;
      }

      if (isGenericEmail(lead.email)) {
        results.skipped++;
        try {
          const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
          if (existing) await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: { ...existing, status: 'skipped_generic', updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      let found = false;
      let attempts = 0;
      while (attempts < accounts.length) {
        const accStat = accountStatus[accountIndex % accounts.length];
        if (accStat.remaining > 0) { found = true; break; }
        accountIndex++;
        attempts++;
      }
      if (!found) break;

      const accIdx = accountIndex % accounts.length;
      const account = accounts[accIdx];
      const accStat = accountStatus[accIdx];

      const qualifiedLead = {
        ...lead,
        email: lead.email.toLowerCase().trim(),
        industry: lead.industry || 'business',
        company_name: lead.company || lead.company_name || null,
        city: lead.city || 'Sri Lanka',
        first_name: lead.name?.split(/[\s,]/)[0] || null,
      };

      if (!qualifiedLead.company_name || qualifiedLead.company_name === 'your business') {
        results.skipped++;
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_no_company', updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      const companyAlreadySent = await isCompanyAlreadySent(qualifiedLead.company_name);
      if (companyAlreadySent) {
        results.skipped++;
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_dedup', updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      // Email verification — MX + SMTP check before sending
      const verification = await verifyEmail(qualifiedLead.email);
      if (!verification.valid) {
        results.skipped++;
        results.details.push({ to: qualifiedLead.email, status: 'skipped', reason: `verification failed: ${verification.reason}` });
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_unverified', verify_reason: verification.reason, updatedAt: new Date().toISOString() } });
        } catch {}
        continue;
      }

      const emailContent = getEmailForSequenceDay(qualifiedLead, 0);
      const bodyParts = emailContent.body.split('---');
      const rawBody = bodyParts[0];
      const unsubNote = bodyParts[1] || '';
      const cleanBody = stripPlainTextSignature(rawBody);

      const htmlParagraphs = cleanBody
        .split(/\n\n+/)
        .filter(p => p.trim().length > 0)
        .map(p => {
          let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
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
          await markLeadAsSent(qualifiedLead.email, account.email, emailContent.subject, sendResult.messageId);
          await markCompanySent(qualifiedLead.company_name);
          try {
            await logSentEmail({
              to: qualifiedLead.email, from: account.email,
              company: qualifiedLead.company_name, industry: qualifiedLead.industry,
              subject: emailContent.subject, bodyPreview: emailContent.body.substring(0, 200),
              status: 'sent', messageId: sendResult.messageId,
              sequenceDay: 0, source: 'auto-send-batch',
            });
          } catch {}
          results.details.push({ to: qualifiedLead.email, from: account.email, company: qualifiedLead.company_name, status: 'sent' });
        } else {
          results.failed++;
          try {
            const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
            if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
          } catch {}
          results.details.push({ to: qualifiedLead.email, from: account.email, status: 'failed', error: sendResult.error });
        }
      } catch (err) {
        results.failed++;
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() } });
        } catch {}
        results.details.push({ to: qualifiedLead.email, status: 'error', error: err.message });
      }

      accountIndex++;
      if (results.sent + results.failed < unsent.length) {
        await new Promise(r => setTimeout(r, randomDelay()));
      }
    }

    // NOTE: totalSent is already incremented by logSentEmail() — no hincrby here

    await releaseLock();
    return Response.json({
      success: true,
      mode: 'batch',
      timestamp: new Date().toISOString(),
      today: getTodayKey(),
      accountUsed: accounts[startAccountIdx % accounts.length]?.email,
      ...results,
      accountStatus,
    });
  } catch (err) {
    await releaseLock();
    return Response.json({ error: err.message }, { status: 500 });
  }
}
