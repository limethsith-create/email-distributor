/**
 * Compose Send Endpoint — streams progress back to the client via SSE.
 *
 * POST body:
 * {
 *   recipients: [{ email, name?, company? }],
 *   subject: string,
 *   body: string,
 *   delayMs: number
 * }
 */

import { sendEmail } from '@/lib/mailer';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { recipients, subject, body: emailBody, delayMs = 2000 } = await request.json();

  if (!recipients?.length || !subject || !emailBody) {
    return Response.json({ error: 'Missing recipients, subject, or body' }, { status: 400 });
  }

  const smtpAccounts = getSmtpAccounts();
  if (!smtpAccounts.length) {
    return Response.json({ error: 'No SMTP accounts configured' }, { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        const account = smtpAccounts[i % smtpAccounts.length];

        const personalizedSubject = personalizeText(subject, recipient);
        const personalizedBody = personalizeText(emailBody, recipient);

        const htmlBody = personalizedBody
          .split(/\n\n+/)
          .map(p => {
            const escaped = p
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
            return `<p style="margin:0 0 16px 0;">${escaped}</p>`;
          })
          .join('\n');

        let result;
        try {
          const sendResult = await sendEmail(account, {
            to: recipient.email,
            subject: personalizedSubject,
            html: htmlBody,
            text: personalizedBody,
          });

          result = {
            to: recipient.email,
            from: account.email,
            status: sendResult.success ? 'sent' : 'failed',
            error: sendResult.error || null,
          };
        } catch (err) {
          result = {
            to: recipient.email,
            from: account.email,
            status: 'failed',
            error: err.message,
          };
        }

        const progressEvent = `data: ${JSON.stringify({ type: 'progress', current: i + 1, total: recipients.length, result })}\n\n`;
        controller.enqueue(encoder.encode(progressEvent));

        if (i < recipients.length - 1 && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'complete' })}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function personalizeText(text, recipient) {
  return text
    .replace(/\{\{name\}\}/gi, recipient.name || recipient.email.split('@')[0])
    .replace(/\{\{email\}\}/gi, recipient.email)
    .replace(/\{\{company\}\}/gi, recipient.company || '')
    .replace(/\{\{city\}\}/gi, recipient.city || '')
    .replace(/\{\{industry\}\}/gi, recipient.industry || '');
}
