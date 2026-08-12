/**
 * IMAP Reply Checker — Aviance MailDistro
 *
 * Connects to each SMTP account via IMAP, checks for replies
 * to outreach emails, and updates lead status in Vercel KV.
 *
 * IMAP settings (configurable via env):
 * - Host: IMAP_HOST (default: mail.privateemail.com)
 * - Port: 993
 * - SSL: true
 * - Auth: email + password (same one used for SMTP)
 */

import { ImapFlow } from 'imapflow';
import { kv } from '@vercel/kv';
import { getSmtpAccounts } from '@/lib/smtp-accounts';
import { maybeAutoReply } from '@/lib/auto-reply';

const LEADS_KEY = 'leads';
const REPLIES_KEY = 'replies'; // Hash: email -> { reply details }
const LAST_CHECK_KEY = 'reply_last_check'; // Hash: account -> ISO timestamp

const IMAP_HOST = process.env.IMAP_HOST || 'mail.privateemail.com';

/**
 * Connect to an IMAP account and fetch recent replies
 */
async function checkRepliesForAccount(account) {
  const results = { replies: [], errors: [] };

  let client;
  try {
    client = new ImapFlow({
      host: IMAP_HOST,
      port: 993,
      secure: true,
      auth: {
        user: account.email,
        pass: account.appPassword,
      },
      logger: false, // Suppress logs in production
    });

    await client.connect();

    // Get last check time for this account (default: 7 days ago)
    let lastCheck;
    try {
      const saved = await kv.hget(LAST_CHECK_KEY, account.email);
      lastCheck = saved ? new Date(saved) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } catch {
      lastCheck = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }

    // Open INBOX
    const mailbox = await client.getMailboxLock('INBOX');

    try {
      // Search for messages received since last check
      const messages = client.fetch(
        { since: lastCheck },
        {
          envelope: true,
          bodyStructure: true,
          source: { maxBytes: 2000 } // Just get first 2KB for preview
        }
      );

      for await (const msg of messages) {
        const envelope = msg.envelope;
        if (!envelope) continue;

        const fromEmail = envelope.from?.[0]?.address?.toLowerCase();
        const subject = envelope.subject || '';
        const date = envelope.date;
        const inReplyTo = envelope.inReplyTo;

        // Skip our own sent emails
        if (!fromEmail || fromEmail.includes('aviance') || fromEmail.includes(account.email)) {
          continue;
        }

        // Check if this is a reply to one of our outreach emails
        // Look for: Re: in subject, or sender matches a lead we emailed
        const isReply = subject.toLowerCase().startsWith('re:') || inReplyTo;

        if (isReply) {
          // Extract a text preview from the source if available
          let preview = '';
          if (msg.source) {
            const sourceText = msg.source.toString();
            // Simple extraction: get text after the last blank line (body start)
            const bodyStart = sourceText.indexOf('\r\n\r\n');
            if (bodyStart > -1) {
              preview = sourceText
                .substring(bodyStart + 4, bodyStart + 504)
                .replace(/<[^>]+>/g, '') // Strip HTML
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 200);
            }
          }

          results.replies.push({
            from: fromEmail,
            subject: subject,
            date: date ? date.toISOString() : new Date().toISOString(),
            account: account.email,
            preview: preview,
            messageId: envelope.messageId,
            inReplyTo: inReplyTo || null,
          });
        }
      }
    } finally {
      mailbox.release();
    }

    // Update last check time
    await kv.hset(LAST_CHECK_KEY, { [account.email]: new Date().toISOString() });

    await client.logout();
  } catch (err) {
    results.errors.push({ account: account.email, error: err.message });
    if (client) {
      try { await client.logout(); } catch {}
    }
  }

  return results;
}

/** Normalize a Message-ID for comparison: strip < >, whitespace, lowercase. */
function normId(x) {
  return String(x || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/**
 * Match a reply to a lead in the database and update status.
 *
 * STRICT: we only treat a message as a real reply when
 *   (a) the sender is a lead we actually emailed, AND
 *   (b) the message threads back to a Message-ID WE generated for that lead
 *       (In-Reply-To matches our day-0 / day-3 / day-7 / bot Message-ID).
 * This makes it impossible to ever "reply" to a warmup email, an out-of-pool
 * message, or any stray inbox mail — those never thread back to our sends.
 */
async function matchAndUpdateLead(reply) {
  try {
    const fromEmail = reply.from.toLowerCase();

    // (a) Sender must be a lead we actually emailed.
    const lead = await kv.hget(LEADS_KEY, fromEmail);
    if (!lead) return { matched: false, email: fromEmail, reason: 'not_a_lead' };
    const st = String(lead.status || '');
    const wasEmailed = Boolean(lead.account_used || lead.sent_at || st.startsWith('sent') || st === 'replied');
    if (!wasEmailed) return { matched: false, email: fromEmail, reason: 'lead_not_emailed' };

    // (b) Must thread back to an email WE sent this exact lead.
    const ourIds = [
      lead.original_message_id,
      lead.d3_message_id,
      lead.d7_message_id,
      lead.auto_reply_message_id,
    ].filter(Boolean).map(normId);
    const inReplyTo = normId(reply.inReplyTo);
    if (!inReplyTo || !ourIds.includes(inReplyTo)) {
      return { matched: false, email: fromEmail, reason: 'no_thread_match' };
    }

    {
      // Genuine reply from a real lead — update their status.
      const updated = {
        ...lead,
        status: 'replied',
        replied_at: reply.date,
        reply_subject: reply.subject,
        reply_preview: reply.preview,
        reply_account: reply.account,
        updatedAt: new Date().toISOString(),
      };

      await kv.hset(LEADS_KEY, { [fromEmail]: updated });

      // Also log the reply separately for the dashboard
      const replyKey = `${fromEmail}:${reply.date}`;
      await kv.hset(REPLIES_KEY, {
        [replyKey]: {
          from: fromEmail,
          company: lead.company || lead.company_name || 'Unknown',
          industry: lead.industry || 'Unknown',
          subject: reply.subject,
          preview: reply.preview,
          date: reply.date,
          account: reply.account,
          leadEmail: fromEmail,
        },
      });

      return { matched: true, email: fromEmail, company: lead.company || lead.company_name };
    }

    return { matched: false, email: fromEmail };
  } catch (err) {
    return { matched: false, email: reply.from, error: err.message };
  }
}

/**
 * Check all accounts for replies and update the database
 * This is the main function called by the API endpoint
 */
export async function checkAllReplies() {
  const accounts = getSmtpAccounts();
  if (!accounts.length) {
    return { error: 'No SMTP accounts configured', checked: 0 };
  }

  const summary = {
    checked: 0,
    totalReplies: 0,
    matchedLeads: 0,
    newReplies: [],
    autoReplies: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  for (const account of accounts) {
    summary.checked++;
    const result = await checkRepliesForAccount(account);

    if (result.errors.length > 0) {
      summary.errors.push(...result.errors);
    }

    for (const reply of result.replies) {
      summary.totalReplies++;
      const match = await matchAndUpdateLead(reply);

      if (match.matched) {
        summary.matchedLeads++;
        summary.newReplies.push({
          from: reply.from,
          company: match.company,
          subject: reply.subject,
          preview: reply.preview,
          date: reply.date,
        });

        // Auto-reply bot: send exactly one automatic reply per lead,
        // then a human takes over. Never throws.
        try {
          const updatedLead = await kv.hget(LEADS_KEY, reply.from.toLowerCase());
          if (updatedLead) {
            const autoResult = await maybeAutoReply(reply, updatedLead);
            summary.autoReplies.push({ to: reply.from, ...autoResult });
          }
        } catch (err) {
          summary.autoReplies.push({ to: reply.from, skipped: `error: ${err.message}` });
        }
      }
    }
  }

  // Update stats
  if (summary.matchedLeads > 0) {
    try {
      await kv.hincrby('stats', 'totalReplied', summary.matchedLeads);
    } catch {}
  }

  return summary;
}

/**
 * Get all replies from the database (for dashboard)
 */
export async function getAllReplies() {
  try {
    const replies = await kv.hgetall(REPLIES_KEY);
    if (!replies) return [];
    return Object.values(replies).sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch {
    return [];
  }
}
