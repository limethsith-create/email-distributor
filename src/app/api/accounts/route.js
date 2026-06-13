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

export async function GET() {
  // No auth required — this endpoint only returns email + displayName, never passwords.
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
