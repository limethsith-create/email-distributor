import nodemailer from 'nodemailer';

/**
 * SMTP configuration — defaults to Namecheap Private Email.
 * Override via SMTP_HOST / SMTP_PORT env vars for other providers.
 */
const SMTP_HOST = process.env.SMTP_HOST || 'mail.privateemail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');

/**
 * Create a Nodemailer transporter for any SMTP account.
 * Kept for connection-testing only (see testConnection). No mail is sent
 * from this system — warmup and cold sending are handled by an external tool.
 */
export function createTransporter(email, password) {
  const domain = email.split('@')[1] || 'aviance.store';
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: true },
    name: domain,
  });
}

/**
 * Test an SMTP connection (used by the Inboxes health check).
 * This only verifies login — it does NOT send any email.
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
 * Sending is DISABLED in this system by design.
 * All warmup + cold sending is done through a separate tool (AutoMailer, etc.).
 * This app only stores leads and records what was sent — it never transmits mail.
 * sendEmail is a hard no-op that refuses to send.
 */
export async function sendEmail() {
  return { success: false, error: 'Sending is disabled in this system. Emails are sent from an external tool.' };
}
