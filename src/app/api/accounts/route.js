/**
 * Server-side accounts endpoint
 * Returns configured SMTP accounts from environment variables.
 * Supports both SMTP_ACCOUNT_* (new) and GMAIL_ACCOUNT_* (legacy) formats.
 * Format: email:password:displayName
 *
 * Auth: Requires CRON_SECRET token (Bearer header or ?token= param)
 * Passwords are never included in the response.
 */

import { getSmtpAccounts } from '@/lib/smtp-accounts';

export async function GET(request) {
  // Auth check — require CRON_SECRET (same pattern as /api/cron/auto-send)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const { searchParams } = new URL(request.url);
    const tokenParam = searchParams.get('token');
    if (authHeader !== `Bearer ${cronSecret}` && tokenParam !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const rawAccounts = getSmtpAccounts();
    const accounts = rawAccounts.map((acc, i) => ({
      id: `server-${i + 1}`,
      email: acc.email,
      displayName: acc.displayName,
      addedAt: new Date().toISOString(),
      status: 'verified',
      source: 'server',
    }));

    return Response.json({ success: true, accounts });
  } catch (error) {
    return Response.json(
      { success: false, error: error.message, accounts: [] },
      { status: 500 }
    );
  }
}
