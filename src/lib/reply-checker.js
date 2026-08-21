/**
 * IMAP Reply Checker — Aviance MailDistro (v2, hardened)
 *
 * Connects to each SMTP account via IMAP, checks for replies to outreach
 * emails, and updates lead status in Vercel KV.
 *
 * v2 hardening — no reply can fall through the cracks:
 *  1. Scans BOTH the inbox and the spam folder of every sending account
 *     (a lead's reply that gets spam-filtered is still a reply).
 *  2. Re-scans a 48h overlap window behind the last-check watermark, so a
 *     partially-failed run can never permanently skip messages. All updates
 *     are idempotent, and stats are only incremented for NEW replies.
 *  3. Message-ID fallback matching: if a reply comes from a DIFFERENT address
 *     than the lead we emailed (forwarding, alias, "new email address"
 *     auto-responders), we still credit it by matching In-Reply-To against
 *     every Message-ID we ever generated.
 */

import { ImapFlow } from 'imapflow';
import { kv } from '@vercel/kv';
import { getSmtpAccounts } from '@/lib/smtp-accounts';
import { maybeAutoReply } from '@/lib/auto-reply';

const LEADS_KEY = 'leads';
const REPLIES_KEY = 'replies_v2'; // Hash: leadEmail:date -> reply details (old 'replies' key has a wrong redis type; writes to it silently failed)
const LAST_CHECK_KEY = 'reply_last_check'; // Hash: account -> ISO timestamp

// How far behind the watermark we re-scan on every run (crash insurance).
const OVERLAP_MS = 48 * 60 * 60 * 1000;
// First-ever scan window.
const FIRST_SCAN_MS = 7 * 24 * 60 * 60 * 1000;

// IMAP host for reading replies. This MUST match where the mailboxes actually
// live. When we SEND via Gmail (Google Workspace), replies live in Gmail and we
// must READ via Gmail's IMAP — otherwise the reply scan connects to the wrong
// server and silently finds nothing (the original zero-replies bug).
const SMTP_IS_GOOGLE = /gmail|google/i.test(process.env.SMTP_HOST || '');
const IMAP_HOST = SMTP_IS_GOOGLE
  ? 'imap.gmail.com'
  : (process.env.IMAP_HOST || 'mail.privateemail.com');

// Folders to scan per account. Spam names vary by provider; we try each and
// silently skip the ones that don't exist.
const SCAN_FOLDERS = SMTP_IS_GOOGLE
  ? ['INBOX', '[Gmail]/Spam']
  : ['INBOX', 'Junk', 'Spam'];

/** Normalize a Message-ID for comparison: strip < >, whitespace, lowercase. */
function normId(x) {
  return String(x || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/**
 * Scan one folder of one account for reply-like messages.
 */
async function scanFolder(client, folder, sinceDate, account) {
  const found = [];
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
  } catch {
    return found; // folder doesn't exist on this server — fine
  }
  try {
    const messages = client.fetch(
      { since: sinceDate },
      { envelope: true, bodyStructure: true, source: { maxBytes: 2000 } }
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

      const isReply = subject.toLowerCase().startsWith('re:') || inReplyTo;
      if (!isReply) continue;

      let preview = '';
      if (msg.source) {
        const sourceText = msg.source.toString();
        const bodyStart = sourceText.indexOf('\r\n\r\n');
        if (bodyStart > -1) {
          preview = sourceText
            .substring(bodyStart + 4, bodyStart + 504)
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 200);
        }
      }

      found.push({
        from: fromEmail,
        subject,
        date: date ? date.toISOString() : new Date().toISOString(),
        account: account.email,
        folder,
        preview,
        messageId: envelope.messageId,
        inReplyTo: inReplyTo || null,
      });
    }
  } finally {
    lock.release();
  }
  return found;
}

/**
 * Connect to an IMAP account and fetch recent reply-like messages from
 * every folder in SCAN_FOLDERS.
 */
async function checkRepliesForAccount(account) {
  const results = { replies: [], errors: [] };

  let client;
  try {
    client = new ImapFlow({
      host: IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: account.email, pass: account.appPassword },
      logger: false,
    });

    await client.connect();

    // Watermark with 48h overlap: a failed/partial run can never lose mail.
    let lastCheck;
    try {
      const saved = await kv.hget(LAST_CHECK_KEY, account.email);
      lastCheck = saved ? new Date(new Date(saved).getTime() - OVERLAP_MS) : new Date(Date.now() - FIRST_SCAN_MS);
    } catch {
      lastCheck = new Date(Date.now() - FIRST_SCAN_MS);
    }

    for (const folder of SCAN_FOLDERS) {
      try {
        const found = await scanFolder(client, folder, lastCheck, account);
        results.replies.push(...found);
      } catch (err) {
        results.errors.push({ account: account.email, folder, error: err.message });
      }
    }

    // Only advance the watermark after every folder was attempted.
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

/**
 * Build a lookup of every Message-ID we ever generated -> lead email.
 * Lets us credit replies that arrive from a different address than the lead.
 */
function buildMessageIdIndex(allLeads) {
  const index = {};
  for (const [email, lead] of Object.entries(allLeads || {})) {
    if (!lead) continue;
    for (const id of [lead.original_message_id, lead.d3_message_id, lead.d7_message_id, lead.auto_reply_message_id]) {
      const n = normId(id);
      if (n) index[n] = email.toLowerCase();
    }
  }
  return index;
}

/**
 * Match a reply to a lead and update status. Idempotent: replying twice, or
 * re-scanning the same message in an overlap window, never double-counts.
 *
 * Match paths (strict -> fallback):
 *  (a) sender IS a lead we emailed, and the message threads back to one of
 *      our Message-IDs or is a "Re:" — the classic case.
 *  (b) sender is NOT a known lead, but In-Reply-To matches a Message-ID we
 *      generated for some lead — forwarded/alias/new-address replies.
 */
async function matchAndUpdateLead(reply, ctx) {
  try {
    const fromEmail = reply.from.toLowerCase();
    const inReplyTo = normId(reply.inReplyTo);

    let leadEmail = null;
    let lead = ctx.leads[fromEmail] || null;
    let viaFallback = false;

    if (lead) {
      const st = String(lead.status || '');
      const wasEmailed = Boolean(lead.account_used || lead.sent_at || st.startsWith('sent') || st === 'replied');
      if (wasEmailed) {
        const ourIds = [lead.original_message_id, lead.d3_message_id, lead.d7_message_id, lead.auto_reply_message_id]
          .filter(Boolean).map(normId);
        const threadMatched = Boolean(inReplyTo && ourIds.includes(inReplyTo));
        const looksLikeReply = /^\s*re\s*:/i.test(String(reply.subject || ''));
        if (threadMatched || looksLikeReply) leadEmail = fromEmail;
      }
    }

    // Fallback: thread-match against ALL our Message-IDs regardless of sender.
    if (!leadEmail && inReplyTo && ctx.idIndex[inReplyTo]) {
      leadEmail = ctx.idIndex[inReplyTo];
      lead = ctx.leads[leadEmail] || null;
      viaFallback = true;
    }

    if (!leadEmail || !lead) return { matched: false, email: fromEmail, reason: 'no_match' };

    const alreadyReplied = String(lead.status || '') === 'replied';

    const updated = {
      ...lead,
      status: 'replied',
      replied_at: reply.date,
      reply_subject: reply.subject,
      reply_preview: reply.preview,
      reply_account: reply.account,
      reply_folder: reply.folder || 'INBOX',
      ...(viaFallback ? { reply_from_address: fromEmail } : {}),
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(LEADS_KEY, { [leadEmail]: updated });
    ctx.leads[leadEmail] = updated;

    const replyKey = `${leadEmail}:${reply.date}`;
    await kv.hset(REPLIES_KEY, {
      [replyKey]: {
        from: fromEmail,
        company: lead.company || lead.company_name || 'Unknown',
        industry: lead.industry || 'Unknown',
        subject: reply.subject,
        preview: reply.preview,
        date: reply.date,
        account: reply.account,
        folder: reply.folder || 'INBOX',
        leadEmail,
      },
    });

    return { matched: true, isNew: !alreadyReplied, email: leadEmail, company: lead.company || lead.company_name };
  } catch (err) {
    return { matched: false, email: reply.from, error: err.message };
  }
}

/**
 * Check all accounts for replies and update the database.
 * Main function called by the cron endpoint.
 */
export async function checkAllReplies() {
  const accounts = getSmtpAccounts();
  if (!accounts.length) {
    console.log('[diag] NO SMTP accounts configured — env SMTP_ACCOUNT_1.. missing');
    return { error: 'No SMTP accounts configured', checked: 0 };
  }

  console.log(`[diag] reply-scan using imap=${IMAP_HOST}:993 accounts=${accounts.length} folders=${SCAN_FOLDERS.join(',')}`);

  // Load all leads ONCE per run; build the Message-ID fallback index.
  let allLeads = {};
  try { allLeads = (await kv.hgetall(LEADS_KEY)) || {}; } catch {}
  const ctx = { leads: allLeads, idIndex: buildMessageIdIndex(allLeads) };

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
      console.log(`[diag] IMAP ERR ${account.email} via ${IMAP_HOST} :: ${result.errors[0].error}`);
      summary.errors.push(...result.errors);
    } else {
      console.log(`[diag] IMAP ok  ${account.email} via ${IMAP_HOST} — reply-like msgs=${result.replies.length}`);
    }

    for (const reply of result.replies) {
      summary.totalReplies++;
      const match = await matchAndUpdateLead(reply, ctx);

      if (match.matched && match.isNew) {
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
          const updatedLead = await kv.hget(LEADS_KEY, match.email);
          if (updatedLead) {
            const autoResult = await maybeAutoReply(reply, updatedLead);
            summary.autoReplies.push({ to: match.email, ...autoResult });
          }
        } catch (err) {
          summary.autoReplies.push({ to: match.email, skipped: `error: ${err.message}` });
        }
      }
    }
  }

  // Update stats — only NEW replies are ever counted.
  if (summary.matchedLeads > 0) {
    try {
      await kv.hincrby('stats', 'totalReplied', summary.matchedLeads);
    } catch {}
  }

  console.log(`[diag] reply-scan done checked=${summary.checked} replyLikeSeen=${summary.totalReplies} newMatched=${summary.matchedLeads} errors=${summary.errors.length}`);

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
