/**
 * Direct Outreach Blast — All-in-one endpoint
 * Accepts leads, personalizes emails, and sends immediately.
 * Distributes across Gmail accounts round-robin with random delays.
 * No storage dependency — everything happens in a single request.
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

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function getGmailAccounts() {
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    const envVar = process.env[`GMAIL_ACCOUNT_${i}`];
    if (!envVar) continue;
    const parts = envVar.split(':');
    if (parts.length >= 2) {
      accounts.push({
        email: parts[0],
        appPassword: parts[1],
        displayName: parts[2] || parts[0].split('@')[0],
      });
    }
  }
  return accounts;
}

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

  const accounts = getGmailAccounts();
  if (!accounts.length) {
    return Response.json({ error: 'No Gmail accounts configured. Set GMAIL_ACCOUNT_1 through GMAIL_ACCOUNT_5 env vars.' }, { status: 500 });
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
        results.details.push({
          to: qualifiedLead.email,
          from: account.email,
          company: qualifiedLead.company_name,
          status: 'sent',
          messageId: sendResult.messageId,
        });
      } else {
        results.failed++;
        results.details.push({
          to: qualifiedLead.email,
          from: account.email,
          status: 'failed',
          error: sendResult.error,
        });
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
