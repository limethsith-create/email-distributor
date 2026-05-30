/**
 * Server-side accounts endpoint
 * Returns pre-configured Gmail accounts from environment variables
 * Accounts are stored as GMAIL_ACCOUNT_1, GMAIL_ACCOUNT_2, etc.
 * Format: email:appPassword:displayName
 */

export async function GET() {
  try {
    const accounts = [];

    // Load accounts from environment variables
    for (let i = 1; i <= 10; i++) {
      const envVar = process.env[`GMAIL_ACCOUNT_${i}`];
      if (!envVar) continue;

      const parts = envVar.split(':');
      if (parts.length < 2) continue;

      const email = parts[0];
      const appPassword = parts[1];
      const displayName = parts[2] || email.split('@')[0];

      accounts.push({
        id: `server-${i}`,
        email,
        appPassword,
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
