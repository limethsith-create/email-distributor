/**
 * SMTP/IMAP endpoints per provider. Shared by the env loader
 * (smtp-accounts.js) and the Redis inbox store (db/inboxes.js).
 */

const GLOBAL_SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const GLOBAL_SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10) || 465;
const GLOBAL_IMAP_HOST = (process.env.IMAP_HOST || '').trim();

export const PROVIDERS = {
  outlook: {
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    imap: { host: 'outlook.office365.com', port: 993 },
    spamFolder: 'Junk',
  },
  yahoo: {
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    imap: { host: 'imap.mail.yahoo.com', port: 993 },
    spamFolder: 'Bulk',
  },
  zoho: {
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    imap: { host: 'imap.zoho.com', port: 993 },
    spamFolder: 'Spam',
  },
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

export { GLOBAL_SMTP_HOST };
