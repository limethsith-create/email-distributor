import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { findSmtpAccount } from '@/lib/smtp-accounts';
import { trackingPixelUrl, unsubscribeUrl } from '@/lib/tokens';

export { TRACKING_BASE_URL, buildTrackingToken, verifyTrackingToken, buildUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from '@/lib/tokens';

/**
 * Build the invisible 1x1 open-tracking pixel for a recipient + touch.
 * Returns '' when tracking can't be built (no recipient) so sends never break.
 */
function buildTrackingPixel(toEmail, touch) {
  try {
    if (!toEmail) return '';
    const src = trackingPixelUrl(toEmail, touch);
    return `<img src="${src}" alt="" width="1" height="1" border="0" style="display:block;width:1px;height:1px;max-width:1px;max-height:1px;overflow:hidden;opacity:0;border:0;outline:none;text-decoration:none;" />`;
  } catch {
    return '';
  }
}

/** Resolve the SMTP endpoint for an account (per-account provider config). */
function smtpConfigFor(account) {
  if (account && account.smtp && account.smtp.host) return account.smtp;
  const known = findSmtpAccount(account && account.email);
  if (known) return known.smtp;
  const port = parseInt(process.env.SMTP_PORT || '465', 10) || 465;
  return { host: process.env.SMTP_HOST || 'mail.privateemail.com', port, secure: port === 465 };
}

/**
 * Create a Nodemailer transporter for any SMTP account.
 * Optimized for serverless: no pooling (idle pooled sockets die between
 * invocations), every phase bounded by a timeout, TLS always required.
 */
export function createTransporter(email, password, accountOrConfig) {
  const smtp = accountOrConfig && accountOrConfig.host
    ? accountOrConfig
    : smtpConfigFor(accountOrConfig || { email });
  const domain = String(email).split('@')[1] || 'aviance.online';

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: Boolean(smtp.secure),
    // On STARTTLS ports never fall back to a plaintext AUTH.
    requireTLS: !smtp.secure,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    // Serverless has a hard wall-clock budget. Without these, nodemailer waits
    // up to 10 minutes on a stalled socket and the whole run dies mid-send.
    dnsTimeout: 5000,
    connectionTimeout: 10000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
    // Mail options can never be resolved from local paths or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
    // EHLO hostname — a host we control, else the sender's domain.
    name: process.env.EHLO_NAME || domain,
  });
}

/**
 * Test an SMTP connection (login + EHLO) without sending anything.
 * @returns {Promise<{success: boolean, ms: number, error?: string, code?: string}>}
 */
export async function testConnection(email, password, account) {
  const started = Date.now();
  let transporter;
  try {
    transporter = createTransporter(email, password, account);
    await transporter.verify();
    return { success: true, ms: Date.now() - started };
  } catch (error) {
    return { success: false, ms: Date.now() - started, error: error.message, code: error.code || null, responseCode: error.responseCode || null };
  } finally {
    try { transporter && transporter.close(); } catch {}
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

/** Normalise a references value (string or array) into a de-duplicated list. */
function normalizeReferences(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const bracketed = id.startsWith('<') ? id : `<${id.replace(/^<|>$/g, '')}>`;
    if (seen.has(bracketed)) continue;
    seen.add(bracketed);
    out.push(bracketed);
  }
  return out;
}

const TRANSIENT_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS', 'EAI_AGAIN']);

/**
 * Classify a nodemailer/SMTP error so callers can decide what to do:
 *  - auth:      credentials rejected → disable the inbox, alert
 *  - transient: connection/rate-limit (4xx) → retry later, keep the lead
 *  - recipient: 5xx at RCPT TO → the address is dead, mark bounced
 *  - content:   5xx at DATA → our message was refused (reputation signal)
 *  - other
 */
export function classifySmtpError(error) {
  const code = error && error.code ? String(error.code) : null;
  const responseCode = error && Number(error.responseCode) ? Number(error.responseCode) : null;
  const command = error && error.command ? String(error.command) : null;
  const message = String((error && error.message) || 'unknown error');
  let kind = 'other';
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) kind = 'auth';
  else if (TRANSIENT_CODES.has(code) || (responseCode && responseCode >= 400 && responseCode < 500)) kind = 'transient';
  else if (responseCode && responseCode >= 500 && /RCPT/i.test(command || '')) kind = 'recipient';
  else if (responseCode && responseCode >= 500 && /DATA/i.test(command || '')) kind = 'content';
  else if (code === 'EENVELOPE' || (error && Array.isArray(error.rejected) && error.rejected.length)) kind = 'recipient';
  return {
    kind,
    code,
    responseCode,
    command,
    message: message.slice(0, 400),
    response: error && error.response ? String(error.response).slice(0, 400) : null,
    // Only connection-phase failures are safe to retry: a timeout during DATA
    // may already have delivered the message.
    retryable: kind === 'transient' && (!command || /^(CONN|EHLO|HELO|STARTTLS|AUTH)/i.test(command)),
  };
}

/**
 * Send a single email with deliverability-optimized headers.
 * @param {object} account - { email, appPassword|password, displayName, smtp? }
 * @param {object} mailOptions - { to, subject, html, text, replyTo, inReplyTo,
 *   references, touch, noTrack, transactional, headers }
 *   transactional: true → a 1:1 reply (no List-Unsubscribe headers, no pixel).
 * @returns {Promise<object>} { success, messageId, accepted, rejected, response,
 *   envelopeTime, messageTime, messageSize, ms, attempts } or on failure
 *   { success: false, error, kind, code, responseCode, command, response, ms, attempts }
 */
export async function sendEmail(account, mailOptions) {
  const started = Date.now();
  const password = account.appPassword || account.password;
  const senderName = account.displayName || account.email.split('@')[0];
  const domain = account.email.split('@')[1] || 'aviance.online';
  const to = String(mailOptions.to || '').trim();
  const transactional = Boolean(mailOptions.transactional);

  // Open tracking is ON unless explicitly switched off (fail open, not shut:
  // when OPEN_TRACKING once went missing every email silently lost its pixel).
  const trackingDisabled = String(process.env.OPEN_TRACKING || '').toLowerCase() === 'off';
  const trackingPixel = (!trackingDisabled && !mailOptions.noTrack && !transactional)
    ? buildTrackingPixel(to, mailOptions.touch || 'd0')
    : '';
  const wrappedHtml = wrapInHtmlTemplate(mailOptions.html || '', trackingPixel);

  // Generate a proper Message-ID using the sender's domain (DKIM/SPF alignment).
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const references = normalizeReferences(mailOptions.references || mailOptions.inReplyTo);
  const inReplyTo = mailOptions.inReplyTo ? normalizeReferences(mailOptions.inReplyTo)[0] : null;

  const headers = { ...(mailOptions.headers || {}) };
  if (!transactional) {
    // List-Unsubscribe with an HTTPS one-click endpoint (RFC 8058) plus mailto.
    headers['List-Unsubscribe'] = `<${unsubscribeUrl(to)}>, <mailto:${account.email}?subject=unsubscribe>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const message = {
    from: `"${senderName}" <${account.email}>`,
    to,
    subject: mailOptions.subject,
    html: wrappedHtml,
    text: mailOptions.text,
    ...(mailOptions.replyTo && mailOptions.replyTo.toLowerCase() !== account.email ? { replyTo: mailOptions.replyTo } : {}),
    messageId,
    // Envelope ensures the SMTP MAIL FROM matches the header From (SPF alignment).
    envelope: { from: account.email, to },
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references: references.join(' ') } : {}),
    headers,
  };

  let attempts = 0;
  let lastError = null;
  while (attempts < 2) {
    attempts++;
    let transporter;
    try {
      transporter = createTransporter(account.email, password, account);
      const info = await transporter.sendMail(message);
      return {
        success: true,
        messageId: info.messageId || messageId,
        accepted: info.accepted || [],
        rejected: info.rejected || [],
        response: info.response ? String(info.response).slice(0, 300) : null,
        envelopeTime: info.envelopeTime || null,
        messageTime: info.messageTime || null,
        messageSize: info.messageSize || null,
        ms: Date.now() - started,
        attempts,
        tracked: Boolean(trackingPixel),
      };
    } catch (error) {
      lastError = classifySmtpError(error);
      if (!lastError.retryable || attempts >= 2) break;
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      try { transporter && transporter.close(); } catch {}
    }
  }

  return {
    success: false,
    error: lastError ? lastError.message : 'unknown error',
    kind: lastError ? lastError.kind : 'other',
    code: lastError ? lastError.code : null,
    responseCode: lastError ? lastError.responseCode : null,
    command: lastError ? lastError.command : null,
    response: lastError ? lastError.response : null,
    ms: Date.now() - started,
    attempts,
  };
}
