import nodemailer from 'nodemailer';

/**
 * Create a Nodemailer transporter for a Gmail account
 * Optimized for serverless (no connection pooling)
 * @param {string} email - Gmail address
 * @param {string} appPassword - Gmail App Password (16 chars)
 * @returns {nodemailer.Transporter}
 */
export function createTransporter(email, appPassword) {
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
 * Wrap plain text body in a proper HTML email template
 * Proper HTML structure helps avoid spam filters
 */
function wrapInHtmlTemplate(htmlContent, senderName, senderEmail) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title>Email</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;">
    <tr>
      <td align="center" style="padding:20px 0;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding:30px 40px;font-size:15px;line-height:1.6;color:#333333;">
              ${htmlContent}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #eeeeee;font-size:12px;color:#999999;line-height:1.5;">
              Sent by ${senderName} &lt;${senderEmail}&gt;
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send a single email with deliverability-optimized headers
 * @param {object} account - { email, appPassword, displayName }
 * @param {object} mailOptions - { to, subject, html, text, replyTo }
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendEmail(account, mailOptions) {
  try {
    const transporter = createTransporter(account.email, account.appPassword);
    const senderName = account.displayName || account.email.split('@')[0];

    // Wrap HTML content in a proper email template
    const wrappedHtml = wrapInHtmlTemplate(
      mailOptions.html,
      senderName,
      account.email
    );

    const info = await transporter.sendMail({
      from: `"${senderName}" <${account.email}>`,
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: wrappedHtml,
      text: mailOptions.text,
      replyTo: mailOptions.replyTo || account.email,
      headers: {
        'X-Mailer': 'MailDistro/1.0',
        'X-Priority': '3',
        'Importance': 'normal',
        'MIME-Version': '1.0',
      },
    });
    transporter.close();
    return { success: true, messageId: info.messageId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
