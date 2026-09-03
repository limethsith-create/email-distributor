/**
 * Shared SMTP/IMAP account loader — the single source of truth for inbox
 * connection details.
 *
 * Reads accounts from SMTP_ACCOUNT_1..10 (falls back to GMAIL_ACCOUNT_1..10).
 * Format: `email:password:displayName`. Display names may themselves contain
 * colons; passwords may not (Gmail app passwords never do). Values are
 * trimmed so a stray newline in a Vercel env var can no longer fail auth.
 *
 * Every account carries its own provider config so mixed setups (a Gmail /
 * Google Workspace inbox next to a Namecheap one) work, and so the sender,
 * reply scanner and bounce scanner all connect to the SAME servers instead of
 * each guessing from a global SMTP_HOST.
 *
 * Provider resolution, per account:
 *   1. SMTP_ACCOUNT_<n>_PROVIDER = google | namecheap | custom   (explicit)
 *   2. gmail.com / googlemail.com addresses                     → google
 *   3. SMTP_HOST set globally: matches gmail/google             → google
 *                              anything else                    → custom (SMTP_HOST / IMAP_HOST)
 *   4. otherwise                                                → namecheap
 *
 * Returns: [{ email, appPassword, password, displayName, provider,
 *             smtp: { host, port, secure }, imap: { host, port }, spamFolder }]
 */

const GLOBAL_SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const GLOBAL_SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10) || 465;
const GLOBAL_IMAP_HOST = (process.env.IMAP_HOST || '').trim();

export const PROVIDERS = {
  google: {
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993 },
    spamFolder: '[Gmail]/Spam',
  },
  namecheap: {
    smtp: { host: 'mail.privateemail.com', port: 465, secure: true },
    imap: { host: 'mail.privateemail.com', port: 993 },
    spamFolder: 'Junk',
  },
  custom: {
    smtp: {
      host: GLOBAL_SMTP_HOST || 'mail.privateemail.com',
      port: GLOBAL_SMTP_PORT,
      secure: GLOBAL_SMTP_PORT === 465,
    },
    imap: {
      host: GLOBAL_IMAP_HOST || GLOBAL_SMTP_HOST.replace(/^smtp\./i, 'imap.') || 'mail.privateemail.com',
      port: 993,
    },
    spamFolder: 'Junk',
  },
};

function detectProvider(email, explicit) {
  const wanted = String(explicit || '').trim().toLowerCase();
  if (PROVIDERS[wanted]) return wanted;
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(domain)) return 'google';
  if (GLOBAL_SMTP_HOST) return /gmail|google/i.test(GLOBAL_SMTP_HOST) ? 'google' : 'custom';
  return 'namecheap';
}

function parseAccount(raw, index) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const [emailRaw, password, ...rest] = value.split(':');
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!email || !email.includes('@') || !password) return null;
  const displayName = rest.join(':').trim() || email.split('@')[0];
  const provider = detectProvider(email, process.env[`SMTP_ACCOUNT_${index}_PROVIDER`]);
  const cfg = PROVIDERS[provider];
  return {
    email,
    appPassword: password, // kept as appPassword for backward compat with mailer.js
    password,
    displayName,
    provider,
    smtp: { ...cfg.smtp },
    imap: { ...cfg.imap },
    spamFolder: cfg.spamFolder,
    envIndex: index,
  };
}

let cache = null;

export function getSmtpAccounts() {
  if (cache) return cache.map((a) => ({ ...a, smtp: { ...a.smtp }, imap: { ...a.imap } }));
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    const envVar = process.env[`SMTP_ACCOUNT_${i}`] || process.env[`GMAIL_ACCOUNT_${i}`];
    const account = parseAccount(envVar, i);
    if (account) accounts.push(account);
  }
  cache = accounts;
  return getSmtpAccounts();
}

/** Look up one configured account by address (case-insensitive). */
export function findSmtpAccount(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  return getSmtpAccounts().find((a) => a.email === key) || null;
}

/** Lower-cased set of every address we send from (used to skip our own mail). */
export function getOwnAddresses() {
  return new Set(getSmtpAccounts().map((a) => a.email));
}
