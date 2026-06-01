import nodemailer from 'nodemailer';
import crypto from 'crypto';

/**
 * Create a Nodemailer transporter for a Gmail account
 * Optimized for serverless (no connection pooling)
 * @param {string} email - Gmail address
 * @param {string} appPassword - Gmail App Password (16 chars)
 * @returns {nodemailer.Transporter}
 */
export function createTransporter(email, appPassword) {
  const domain = email.split('@')[1] || 'gmail.com';

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: email,
      pass: appPassword,
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
 * Test a Gmail connection
 * @param {string} email
 * @param {string} appPassword
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function testConnection(email, appPassword) {
  try {
    const transporter = createTransporter(email, appPassword);
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
function wrapInHtmlTemplate(htmlContent) {
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
    const transporter = createTransporter(account.email, account.appPassword);
    const senderName = account.displayName || account.email.split('@')[0];
    const domain = account.email.split('@')[1] || 'gmail.com';

    // Wrap HTML content in a minimal personal-style template
    const wrappedHtml = wrapInHtmlTemplate(mailOptions.html);

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
