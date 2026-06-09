/**
 * Direct Outreach Blast — All-in-one endpoint
 * Accepts leads, personalizes emails, and sends immediately.
 * Distributes across SMTP accounts round-robin with random delays.
 * Logs every send to Vercel KV for dashboard visibility.
 *
 * POST body:
 * {
 *   leads: [{ email, company_name, industry, city, phone? }],
 *   secret: "your-cron-secret" (optional auth)
 * }
 *
 * Returns: { sent, failed, total, details: [...] }
 */

import { sendEmail } from '@/lib/mailer';
import { getEmailForSequenceDay } from '@/lib/personalize';
import { upsertLead, logSentEmail } from '@/lib/leads-db';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function randomDelay() {
  return 2000 + Math.random() * 6000;
}

export async function POST(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const body = await request.json();
    if (body.secret !== cronSecret) {
      const authHeader = request.headers.get('authorization');
      if (authHeader !== `Bearer ${cronSecret}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    return processBlast(body);
  }

  const body = await request.json();
  return processBlast(body);
}

async function processBlast(body) {
  const { leads = [] } = body;

  if (!leads.length) {
    return Response.json({ error: 'No leads provided' }, { status: 400 });
  }

  const accounts = getSmtpAccounts();
  if (!accounts.length) {
    return Response.json({ error: 'No SMTP accounts configured. Set SMTP_ACCOUNT_1 env var (format: email:password:displayName).' }, { status: 500 });
  }

  const results = { sent: 0, failed: 0, total: leads.length, details: [] };

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const account = accounts[i % accounts.length];

    if (!lead.email || !lead.email.includes('@')) {
      results.failed++;
      results.details.push({ to: lead.email, status: 'skipped', error: 'Invalid email' });
      continue;
    }

    const qualifiedLead = {
      ...lead,
      email: lead.email.toLowerCase().trim(),
      industry: lead.industry || 'other',
      company_name: lead.company_name || 'your business',
      city: lead.city || 'Sri Lanka',
      first_name: lead.contact_name?.split(/[\s,]/)[0] || null,
    };

    const emailContent = getEmailForSequenceDay(qualifiedLead, lead.sequenceDay || 0);

    const htmlBody = emailContent.body
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
        to: qualifiedLead.email,
        subject: emailContent.subject,
        html: htmlBody,
        text: emailContent.body,
      });

      if (sendResult.success) {
        results.sent++;
        const detail = {
          to: qualifiedLead.email,
          from: account.email,
          company: qualifiedLead.company_name,
          status: 'sent',
          messageId: sendResult.messageId,
        };
        results.details.push(detail);

        // Log to KV — persist the lead and the sent email
        try {
          await upsertLead({
            email: qualifiedLead.email,
            company_name: qualifiedLead.company_name,
            industry: qualifiedLead.industry,
            city: qualifiedLead.city,
            status: 'sent-d0',
            ai_score: lead.ai_score || 8,
            source: 'outreach-blast',
            account_used: account.email,
            sent_at: new Date().toISOString(),
            send_count: 1,
            sequence_day: lead.sequenceDay || 0,
          });

          await logSentEmail({
            to: qualifiedLead.email,
            from: account.email,
            company: qualifiedLead.company_name,
            industry: qualifiedLead.industry,
            city: qualifiedLead.city,
            subject: emailContent.subject,
            bodyPreview: emailContent.body.substring(0, 200),
            status: 'sent',
            messageId: sendResult.messageId,
            sequenceDay: lead.sequenceDay || 0,
          });
        } catch (kvErr) {
          // Don't fail the send if KV logging fails
          console.error('KV log error:', kvErr.message);
        }
      } else {
        results.failed++;
        results.details.push({
          to: qualifiedLead.email,
          from: account.email,
          status: 'failed',
          error: sendResult.error,
        });

        // Log failure to KV
        try {
          await logSentEmail({
            to: qualifiedLead.email,
            from: account.email,
            company: qualifiedLead.company_name,
            industry: qualifiedLead.industry,
            subject: emailContent.subject,
            status: 'failed',
            error: sendResult.error,
          });
        } catch (kvErr) {
          console.error('KV log error:', kvErr.message);
        }
      }
    } catch (err) {
      results.failed++;
      results.details.push({
        to: qualifiedLead.email,
        from: account.email,
        status: 'failed',
        error: err.message,
      });
    }

    if (i < leads.length - 1) {
      await new Promise(r => setTimeout(r, randomDelay()));
    }
  }

  return Response.json({
    success: true,
    timestamp: new Date().toISOString(),
    accounts_used: accounts.length,
    ...results,
  });
}
