import { sendEmail } from '@/lib/mailer';
import { processTemplate } from '@/lib/distributor';

export const maxDuration = 60; // Vercel function timeout

export async function POST(request) {
  try {
    const { accounts, recipients, subject, body, delayMs = 2000 } = await request.json();

    // Validation
    if (!accounts || accounts.length === 0) {
      return Response.json({ error: 'No accounts provided' }, { status: 400 });
    }
    if (!recipients || recipients.length === 0) {
      return Response.json({ error: 'No recipients provided' }, { status: 400 });
    }
    if (!subject || !body) {
      return Response.json({ error: 'Subject and body are required' }, { status: 400 });
    }

    // Create a readable stream for SSE (Server-Sent Events)
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const results = [];

        for (let i = 0; i < recipients.length; i++) {
          const recipient = recipients[i];
          const account = accounts[i % accounts.length]; // Round-robin

          // Find the email field (case-insensitive)
          const emailKey = Object.keys(recipient).find(k => k.toLowerCase() === 'email');
          const toEmail = recipient[emailKey];

          if (!toEmail) {
            const result = {
              to: 'unknown',
              from: account.email,
              status: 'failed',
              error: 'No email address found',
              index: i,
            };
            results.push(result);

            const data = JSON.stringify({ type: 'progress', current: i + 1, total: recipients.length, result });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            continue;
          }

          // Process template variables
          const processedSubject = processTemplate(subject, recipient);
          const processedBody = processTemplate(body, recipient);

          // Convert plain text body to clean HTML paragraphs
          // Using <p> tags instead of <br> improves spam score
          const htmlBody = processedBody
            .split(/\n\n+/)
            .map(paragraph => {
              const escaped = paragraph
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>');
              return `<p style="margin:0 0 16px 0;">${escaped}</p>`;
            })
            .join('\n');

          try {
            const sendResult = await sendEmail(account, {
              to: toEmail,
              subject: processedSubject,
              html: htmlBody,
              text: processedBody,
            });

            const result = {
              to: toEmail,
              from: account.email,
              status: sendResult.success ? 'sent' : 'failed',
              messageId: sendResult.messageId,
              error: sendResult.error,
              index: i,
            };
            results.push(result);

            const data = JSON.stringify({ type: 'progress', current: i + 1, total: recipients.length, result });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch (err) {
            const result = {
              to: toEmail,
              from: account.email,
              status: 'failed',
              error: err.message,
              index: i,
            };
            results.push(result);

            const data = JSON.stringify({ type: 'progress', current: i + 1, total: recipients.length, result });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }

          // Delay between emails (except last one)
          if (i < recipients.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }

        // Send completion signal
        const summary = {
          type: 'complete',
          total: recipients.length,
          sent: results.filter(r => r.status === 'sent').length,
          failed: results.filter(r => r.status === 'failed').length,
          results,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(summary)}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
