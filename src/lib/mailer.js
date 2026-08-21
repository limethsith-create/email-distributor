import nodemailer from 'nodemailer';
import crypto from 'crypto';

/**
 * SMTP configuration — defaults to Namecheap Private Email.
 * Override via SMTP_HOST / SMTP_PORT env vars for other providers.
 */
const SMTP_HOST = process.env.SMTP_HOST || 'mail.privateemail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');

/**
 * Absolute base URL the open-tracking pixel points at. Must be publicly
 * reachable over HTTPS so mail clients can load it. Override with
 * TRACKING_BASE_URL if a dedicated tracking domain is set up later.
 */
const TRACKING_BASE_URL = (
  process.env.TRACKING_BASE_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  'https://email-distributor.vercel.app'
).replace(/\/+$/, '');

/**
 * Build the invisible 1x1 open-tracking pixel for a recipient. The recipient's
 * email is base64url-encoded so the raw address never appears in the URL.
 * Returns '' when tracking can't be built (no recipient) so sends never break.
 */
function buildTrackingPixel(toEmail) {
  try {
    if (!toEmail) return '';
    const token = Buffer.from(String(toEmail).trim().toLowerCase()).toString('base64url');
    const src = `${TRACKING_BASE_URL}/api/track/open?t=${token}`;
    return `<img src="${src}" alt="" width="1" height="1" border="0" style="display:block;width:1px;height:1px;max-width:1px;max-height:1px;overflow:hidden;opacity:0;border:0;outline:none;text-decoration:none;" />`;
  } catch {
    return '';
  }
}

/**
 * Create a Nodemailer transporter for any SMTP account
 * Optimized for serverless (no connection pooling)
 * @param {string} email - Email address (used as SMTP user)
 * @param {string} password - SMTP password
 * @returns {nodemailer.Transporter}
 */
export function createTransporter(email, password) {
  const domain = email.split('@')[1] || 'aviance.store';

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: email,
      pass: password,
    },
    // No pooling - better for serverless environments like Vercel
    tls: {
      rejectUnauthorized: true,
    },
    // Generate Message-IDs using the sender's domain for alignment
    name: domain,
  });
}

/**
 * Test an SMTP connection
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function testConnection(email, password) {
  try {
    const transporter = createTransporter(email, password);
    await transporter.verify();
    transporter.close();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Wrap HTML body in a minimal template that looks like a personal Gmail message.
 * Avoid centered tables, 600px wrappers, and newsletter-style structure —
 * those patterns are a strong spam signal for cold outreach.
 */
function wrapInHtmlTemplate(htmlContent, trackingPixel = '') {
  return `<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
</head>
<body style="margin:0;padding:0;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222222;">
    ${htmlContent}
  </div>
  ${trackingPixel}
</body>
</html>`;
}

/**
 * Send a single email with deliverability-optimized headers
 * @param {object} account - { email, appPassword, displayName }
 * @param {object} mailOptions - { to, subject, html, text, replyTo, inReplyTo, references }
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendEmail(account, mailOptions) {
  try {
    const transporter = createTransporter(account.email, account.appPassword || account.password);
    const senderName = account.displayName || account.email.split('@')[0];
    const domain = account.email.split('@')[1] || 'aviance.store';

    // Wrap HTML content in a minimal personal-style template, embedding an
    // invisible open-tracking pixel keyed to the recipient (unless disabled).
        const trackingPixel = (process.env.OPEN_TRACKING === 'on' && !mailOptions.noTrack) ? buildTrackingPixel(mailOptions.to) : '';
    const wrappedHtml = wrapInHtmlTemplate(mailOptions.html, trackingPixel);

    // Generate a proper Message-ID using the sender's domain
    // This aligns with DKIM/SPF and prevents nodemailer's random domain
    const messageId = `<${crypto.randomUUID()}@${domain}>`;

    const info = await transporter.sendMail({
      from: `"${senderName}" <${account.email}>`,
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: wrappedHtml,
      text: mailOptions.text,
      replyTo: mailOptions.replyTo || account.email,
      messageId,
      // Envelope ensures the SMTP MAIL FROM matches the header From
      // This is critical for SPF alignment
      envelope: {
        from: account.email,
        to: mailOptions.to,
      },
      // Threading headers — when provided, these tell email clients to
      // group the follow-up in the same conversation as the original
      ...(mailOptions.inReplyTo ? { inReplyTo: mailOptions.inReplyTo } : {}),
      ...(mailOptions.references ? { references: mailOptions.references } : {}),
      headers: {
        // List-Unsubscribe is REQUIRED by Gmail for bulk senders (Feb 2024 policy)
        // Using mailto: is the simplest approach that works with Gmail
        'List-Unsubscribe': `<mailto:${account.email}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    transporter.close();
    return { success: true, messageId: info.messageId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
