/**
 * Bounce Detection Cron Endpoint
 *
 * Connects to all Gmail accounts via IMAP, detects bounce-back
 * messages (from mailer-daemon, postmaster, etc.), extracts the
 * bounced recipient address, and updates lead status in Vercel KV.
 *
 * Trigger:
 * - GET /api/cron/check-bounces?token=CRON_SECRET
 * - n8n or external cron (every 1-2 hours)
 */

import { ImapFlow } from 'imapflow';
import { kv } from '@vercel/kv';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const LEADS_KEY = 'leads';
const BOUNCES_KEY = 'bounces'; // Hash: email -> { bounce details }
const LAST_CHECK_KEY = 'bounce_last_check'; // Hash: account -> ISO timestamp

const SMTP_IS_GOOGLE = /gmail|google/i.test(process.env.SMTP_HOST || ''); const IMAP_HOST = SMTP_IS_GOOGLE ? 'imap.gmail.com' : (process.env.IMAP_HOST || 'mail.privateemail.com');

/**
 * Sender addresses that indicate a bounce message
 */
const BOUNCE_SENDERS = ['mailer-daemon', 'postmaster'];

/**
 * Subject patterns that indicate a bounce message
 */
const BOUNCE_SUBJECT_PATTERNS = [
  'delivery status notification',
  'undeliverable',
  'mail delivery failed',
  'returned mail',
  'failure notice',
  'undelivered mail',
  'delivery failure',
  'delivery has failed',
  'message not delivered',
  'could not be delivered',
  'permanent failure',
];

/**
 * Get SMTP accounts from env vars (shared loader)
 */
function getAccounts() {
  return getSmtpAccounts();
}

/**
 * Check if a message is a bounce based on sender and subject
 */
function isBounceMessage(fromEmail, subject) {
  const from = (fromEmail || '').toLowerCase();
  const subj = (subject || '').toLowerCase();

  const isBounceFrom = BOUNCE_SENDERS.some(
    (sender) => from.startsWith(sender + '@') || from.includes(sender)
  );

  const isBounceSubject = BOUNCE_SUBJECT_PATTERNS.some((pattern) =>
    subj.includes(pattern)
  );

  return isBounceFrom || isBounceSubject;
}

/**
 * Extract the original bounced recipient email address from a bounce message body.
 * Bounce messages vary wildly in format, so we try multiple patterns.
 */
function extractBouncedEmail(bodyText) {
  if (!bodyText) return null;

  const patterns = [
    // RFC 3464 DSN: "Final-Recipient: rfc822; user@example.com"
    /Final-Recipient:\s*(?:rfc822|RFC822);\s*<?([^\s<>\r\n]+@[^\s<>\r\n]+)>?/i,
    // "Original-Recipient: rfc822; user@example.com"
    /Original-Recipient:\s*(?:rfc822|RFC822);\s*<?([^\s<>\r\n]+@[^\s<>\r\n]+)>?/i,
    // "was not delivered to: user@example.com"
    /not\s+delivered\s+to:?\s*<?([^\s<>\r\n]+@[^\s<>\r\n]+)>?/i,
    // "delivery to the following recipient failed" ... email on next line
    /following\s+recipient.*failed.*?<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/is,
    // "The email account that you tried to reach does not exist" + "to user@example.com"
    /tried\s+to\s+reach.*?<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/is,
    // "Action: failed" section often has "To: <email>"
    /(?:Action:\s*failed)[\s\S]*?(?:To|for):?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i,
    // Generic: "<user@example.com>" pattern near bounce keywords
    /(?:bounce|fail|reject|undeliver|return)[\s\S]{0,300}?<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i,
    // Last resort: "To: <email>" in headers of the original message
    /Original-.*To:?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i,
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match && match[1]) {
      const email = match[1].toLowerCase().trim();
      // Sanity check: skip known non-recipient addresses
      if (
        !email.startsWith('mailer-daemon@') &&
        !email.startsWith('postmaster@') &&
        email.includes('@') &&
        email.includes('.')
      ) {
        return email;
      }
    }
  }

  return null;
}

/**
 * Extract a human-readable bounce reason from the message body
 */
function extractBounceReason(bodyText) {
  if (!bodyText) return 'Unknown bounce reason';

  const reasonPatterns = [
    // Diagnostic-Code from DSN
    /Diagnostic-Code:\s*(?:smtp;\s*)?(.+?)(?:\r?\n(?!\s))/i,
    // Status code explanation
    /Status:\s*(\d\.\d+\.\d+)/i,
    // Common reason phrases
    /(user\s+(?:unknown|does\s+not\s+exist|not\s+found))/i,
    /(mailbox\s+(?:not\s+found|unavailable|full|disabled))/i,
    /(address\s+(?:rejected|not\s+found|does\s+not\s+exist))/i,
    /(account\s+(?:has\s+been\s+disabled|does\s+not\s+exist|is\s+(?:disabled|inactive)))/i,
    /(over\s+quota)/i,
    /(domain\s+(?:not\s+found|does\s+not\s+exist))/i,
    /(no\s+such\s+user)/i,
    /(rejected.*?spam)/i,
    /(blocked)/i,
  ];

  for (const pattern of reasonPatterns) {
    const match = bodyText.match(pattern);
    if (match && match[1]) {
      return match[1].trim().substring(0, 200);
    }
  }

  return 'Delivery failed (reason not parsed)';
}

/**
 * Connect to an IMAP account and check for bounce messages
 */
async function checkBouncesForAccount(account) {
  const results = { bounces: [], errors: [] };

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
      logger: false,
      connectionTimeout: 12000,
      greetingTimeout: 8000,
      socketTimeout: 25000,
    });

    await client.connect();

    // Get last check time for this account (default: 7 days ago)
    let lastCheck;
    try {
      const saved = await kv.hget(LAST_CHECK_KEY, account.email);
      lastCheck = saved
        ? new Date(saved)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } catch {
      lastCheck = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }

    // Open INBOX
    const mailbox = await client.getMailboxLock('INBOX');

    try {
      // Fetch messages since last check
      const messages = client.fetch(
        { since: lastCheck },
        {
          envelope: true,
          bodyStructure: true,
          source: { maxBytes: 8000 }, // Bounce messages need more body to parse recipient
        }
      );

      for await (const msg of messages) {
        const envelope = msg.envelope;
        if (!envelope) continue;

        const fromEmail = envelope.from?.[0]?.address?.toLowerCase() || '';
        const subject = envelope.subject || '';
        const date = envelope.date;

        if (!isBounceMessage(fromEmail, subject)) continue;

        // Parse the bounce body to find the original recipient
        let bodyText = '';
        if (msg.source) {
          bodyText = msg.source.toString();
        }

        const bouncedEmail = extractBouncedEmail(bodyText);
        if (!bouncedEmail) {
          // Could not determine who bounced — skip but log
          results.errors.push({
            account: account.email,
            error: `Bounce detected but could not extract recipient. Subject: "${subject}"`,
          });
          continue;
        }

        const reason = extractBounceReason(bodyText);

        results.bounces.push({
          email: bouncedEmail,
          bouncedAt: date ? date.toISOString() : new Date().toISOString(),
          reason,
          account: account.email,
          subject,
          messageId: envelope.messageId,
        });
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
      try {
        await client.logout();
      } catch {}
    }
  }

  return results;
}

/**
 * Update lead status to bounced and log the bounce in KV
 */
async function processDetectedBounce(bounce) {
  try {
    const email = bounce.email.toLowerCase();

    // Check if lead exists
    const lead = await kv.hget(LEADS_KEY, email);

    if (lead) {
      // Update lead status to bounced
      const updated = {
        ...lead,
        status: 'bounced',
        bounced_at: bounce.bouncedAt,
        bounce_reason: bounce.reason,
        bounce_account: bounce.account,
        updatedAt: new Date().toISOString(),
      };
      await kv.hset(LEADS_KEY, { [email]: updated });
    }

    // Log the bounce in the bounces hash regardless of lead existence
    await kv.hset(BOUNCES_KEY, {
      [email]: {
        email: bounce.email,
        bouncedAt: bounce.bouncedAt,
        reason: bounce.reason,
        account: bounce.account,
      },
    });

    return {
      processed: true,
      email,
      hadLead: !!lead,
      company: lead?.company || lead?.company_name || null,
    };
  } catch (err) {
    return { processed: false, email: bounce.email, error: err.message };
  }
}

/**
 * Main: check all accounts for bounces and update KV
 */
async function checkAllBounces() {
  const accounts = getAccounts();
  if (!accounts.length) {
    return { error: 'No SMTP accounts configured', checked: 0 };
  }

  const summary = {
    checked: 0,
    totalBounces: 0,
    matchedLeads: 0,
    detectedBounces: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  for (const account of accounts) {
    summary.checked++;
    const result = await checkBouncesForAccount(account);

    if (result.errors.length > 0) {
      summary.errors.push(...result.errors);
    }

    for (const bounce of result.bounces) {
      summary.totalBounces++;
      const processed = await processDetectedBounce(bounce);

      if (processed.processed) {
        summary.detectedBounces.push({
          email: bounce.email,
          reason: bounce.reason,
          account: bounce.account,
          company: processed.company,
          hadLead: processed.hadLead,
          bouncedAt: bounce.bouncedAt,
        });

        if (processed.hadLead) {
          summary.matchedLeads++;
        }
      }
    }
  }

  // Increment bounce counter in stats
  if (summary.totalBounces > 0) {
    try {
      await kv.hincrby('stats', 'totalBounced', summary.totalBounces);
    } catch {}
  }

  return summary;
}

export async function GET(request) {
  // Auth check (same pattern as check-replies)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    const authHeader = request.headers.get('authorization');

    if (authHeader !== `Bearer ${cronSecret}` && tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await checkAllBounces();

    return Response.json({
      success: true,
      ...result,
    });
  } catch (err) {
    return Response.json(
      {
        success: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
