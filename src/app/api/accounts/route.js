/**
 * Server-side accounts endpoint
 * Returns pre-configured Gmail accounts from environment variables
 * Accounts are stored as GMAIL_ACCOUNT_1, GMAIL_ACCOUNT_2, etc.
 * Format: email:appPassword:displayName
 *
 * Auth: Requires CRON_SECRET token (Bearer header or ?token= param)
 * Passwords are never included in the response.
 */

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
    const accounts = [];

    // Load accounts from environment variables
    for (let i = 1; i <= 10; i++) {
      const envVar = process.env[`GMAIL_ACCOUNT_${i}`];
      if (!envVar) continue;

      const parts = envVar.split(':');
      if (parts.length < 2) continue;

      const email = parts[0];
      const displayName = parts[2] || email.split('@')[0];

      accounts.push({
        id: `server-${i}`,
        email,
        displayName,
        addedAt: new Date().toISOString(),
        status: 'verified',
        source: 'server',
      });
    }

    return Response.json({ success: true, accounts });
  } catch (error) {
    return Response.json(
      { success: false, error: error.message, accounts: [] },
      { status: 500 }
    );
  }
}
