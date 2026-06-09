/**
 * Shared SMTP account loader.
 * Reads accounts from SMTP_ACCOUNT_1..10 env vars.
 * Falls back to GMAIL_ACCOUNT_1..10 for backward compatibility.
 * Format: email:password:displayName
 *
 * Returns: [{ email, appPassword, displayName }]
 * (appPassword key kept for backward compat with sendEmail())
 */
export function getSmtpAccounts() {
  const accounts = [];

  for (let i = 1; i <= 10; i++) {
    // Try new SMTP_ACCOUNT_* first, fall back to GMAIL_ACCOUNT_*
    const envVar = process.env[`SMTP_ACCOUNT_${i}`] || process.env[`GMAIL_ACCOUNT_${i}`];
    if (!envVar) continue;

    const parts = envVar.split(':');
    if (parts.length < 2) continue;

    accounts.push({
      email: parts[0],
      appPassword: parts[1], // kept as appPassword for backward compat with mailer.js
      displayName: parts[2] || parts[0].split('@')[0],
    });
  }

  return accounts;
}
