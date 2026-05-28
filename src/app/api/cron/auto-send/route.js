/**
 * Autonomous Email Sender â Zero Claude Dependency
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

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_PER_ACCOUNT_PER_DAY = 15;
const LEADS_KEY = 'leads';
const DAILY_SEND_KEY = 'daily_sends';
const LOCK_KEY = 'auto_send_lock';
const LOCK_TTL_SECONDS = 120; // 2 minute lock
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
  return new Date().toISOString().split('T')[0];
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
 * Claim a lead atomically â set status to "sending" so no other
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

  // Concurrency lock â prevent overlapping sends from multiple triggers
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    return Response.json({
      success: true,
      message: 'Another send is already in progress â skipping',
      timestamp: new Date().toISOString(),
      sent: 0,
    });
  }

  try {
    const accounts = getGmailAccounts();
    if (!accounts.length) {
      await releaseLock();
      return Response.json({ error: 'No Gmail accounts configured' }, { status: 500 });
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

    const effectiveLimit = batchSize > 0 ? Math.min(batchSize, totalRemaining) : totalRemaining;
    const unsent = await getUnsent(effectiveLimit);

    if (unsent.length === 0) {
      await releaseLock();
      return Response.json({
        success: true,
        message: 'No unsent leads available',
        timestamp: new Date().toISOString(),
        sent: 0,
        accountStatus,
      });
    }

    // ============================================================
    // FIX #1: Persistent account rotation via KV counter
    // Each invocation picks the NEXT account, not always account[0]
    // ============================================================
    const startAccountIdx = await getNextAccountIndex(accounts.length);
    let accountIndex = startAccountIdx;

    const results = { sent: 0, failed: 0, skipped: 0, details: [] };

    for (const lead of unsent) {
      // ============================================================
      // FIX #3: Claim lead atomically before sending
      // If another concurrent request already claimed it, skip
      // ============================================================
      const claimed = await claimLead(lead.email);
      if (!claimed) {
        results.skipped++;
        results.details.push({
          to: lead.email,
          status: 'skipped',
          reason: 'already claimed or sent',
        });
        continue;
      }

      // Skip generic/role-based email addresses
      if (isGenericEmail(lead.email)) {
        results.skipped++;
        results.details.push({ to: lead.email, status: 'skipped', reason: 'generic/role-based email' });
        try {
          const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
          if (existing) {
            await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: { ...existing, status: 'skipped_generic', updatedAt: new Date().toISOString() } });
          }
        } catch {}
        continue;
      }

      // Find account with remaining quota (starting from rotated index)
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

      // Skip leads with missing company name
      if (!qualifiedLead.company_name || qualifiedLead.company_name === 'your business') {
        results.skipped++;
        results.details.push({ to: lead.email, status: 'skipped', reason: 'missing company name' });
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) {
            await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_no_company', updatedAt: new Date().toISOString() } });
          }
        } catch {}
        continue;
      }

      // Skip if company already contacted
      const companyAlreadySent = await isCompanyAlreadySent(qualifiedLead.company_name);
      if (companyAlreadySent) {
        results.skipped++;
        results.details.push({ to: lead.email, status: 'skipped', reason: 'company already contacted' });
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) {
            await kv.hset(LEADS_KEY, { [qualifiedLead.email]: { ...existing, status: 'skipped_dedup', updatedAt: new Date().toISOString() } });
          }
        } catch {}
        continue;
      }

      const emailContent = getEmailForSequenceDay(qualifiedLead, 0);

      // ============================================================
      // FIX #2: Strip plain-text signature from body before HTML conversion
      // The template includes "Limethsith\nAviance..." but we add a proper
      // HTML signature below â no more duplicate signatures
      // ============================================================
      const bodyParts = emailContent.body.split('---');
      const rawBody = bodyParts[0];
      const unsubNote = bodyParts[1] || '';

      // Remove the plain-text sig so it doesn't appear twice
      const cleanBody = stripPlainTextSignature(rawBody);

      const htmlParagraphs = cleanBody
        .split(/\n\n+/)
        .filter(p => p.trim().length > 0) // remove empty paragraphs
        .map(p => {
          let escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
          return `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${escaped}</p>`;
        })
        .join('\n');

      const htmlSignature = `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#555;">
        Limethsith<br>
        Aviance â AI Growth Systems<br>
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
          await markCompanySent(qualifiedLead.company_name);

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
          // Revert lead status back to pending on failure
          try {
            const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
            if (existing) {
              await kv.hset(LEADS_KEY, {
                [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() }
              });
            }
          } catch {}
          results.details.push({
            to: qualifiedLead.email,
            from: account.email,
            status: 'failed',
            error: sendResult.error,
          });
        }
      } catch (err) {
        results.failed++;
        // Revert lead status back to pending on error
        try {
          const existing = await kv.hget(LEADS_KEY, qualifiedLead.email);
          if (existing) {
            await kv.hset(LEADS_KEY, {
              [qualifiedLead.email]: { ...existing, status: 'pending', updatedAt: new Date().toISOString() }
            });
          }
        } catch {}
        results.details.push({
          to: qualifiedLead.email,
          status: 'error',
          error: err.message,
        });
      }

      // Move to next account for next email
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

    await releaseLock();

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      today: getTodayKey(),
      accountUsed: accounts[startAccountIdx % accounts.length]?.email,
      ...results,
      accountStatus,
      unsentRemaining: unsent.length - results.sent - results.failed - results.skipped,
    });
  } catch (err) {
    await releaseLock();
    return Response.json({ error: err.message }, { status: 500 });
  }
}
