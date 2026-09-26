/**
 * SMTP/IMAP endpoints per provider. Shared by the env loader
 * (smtp-accounts.js), the Redis inbox store (db/inboxes.js) and the warm-up
 * circle (systems/warmup.js).
 *
 * Every preset keeps the original shape ({smtp, imap, spamFolder}); the
 * warm-up v2 fields are additive:
 *   family        mailbox-filter family used for pairing (yahoo + aol are one
 *                 filter, gmx + web.de are one company)
 *   spamFolders   IMAP names to try for Spam/Junk when the server does not
 *                 flag a folder \Junk (RFC 6154)
 *   archiveFolders same for Archive / All Mail (\All, \Archive)
 *   helper        can a FREE account of this provider be a warm-up helper in
 *                 2026 (IMAP + SMTP with a password or app password)?
 *   helperNote    why not / what to switch on — shown on /mc/warmup
 *   setup         the one-time steps the owner does when creating a helper
 *   helperLabel   short name in the hub (Gmail, not "Gmail / Google Workspace")
 *   passwordLabel what the password field asks for ("16-letter app password")
 *   wrongPassword / imapOff  the plain reason shown when a helper's login
 *                 test fails that way (docs/WARMUP-HUB.md); imapOff null =
 *                 IMAP cannot be switched off at this provider
 *
 * Sources and dates: docs/research/v2-deliverability.md §2.
 */

const GLOBAL_SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const GLOBAL_SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10) || 465;
const GLOBAL_IMAP_HOST = (process.env.IMAP_HOST || '').trim();

export const PROVIDERS = {
  google: {
    label: 'Gmail / Google Workspace',
    family: 'google',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993 },
    spamFolder: '[Gmail]/Spam',
    spamFolders: ['[Gmail]/Spam', '[Google Mail]/Spam'],
    archiveFolders: ['[Gmail]/All Mail', '[Google Mail]/All Mail'],
    helper: true,
    domains: ['gmail.com', 'googlemail.com'],
    helperNote: 'Free Gmail works with an app password (needs 2-Step Verification). IMAP is always on since Jan 2025. 500 emails/day limit.',
    helperLabel: 'Gmail',
    passwordLabel: '16-letter app password',
    wrongPassword: 'Gmail said the password is wrong — use the 16-letter app password (myaccount.google.com/apppasswords, needs 2-Step Verification), not your normal password',
    imapOff: null,
    setup: ['Create a Gmail account', 'Turn on 2-Step Verification (myaccount.google.com/security)', 'Create an app password at myaccount.google.com/apppasswords', 'Paste the address + the 16-letter app password below'],
  },
  yahoo: {
    label: 'Yahoo Mail',
    family: 'yahoo',
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    imap: { host: 'imap.mail.yahoo.com', port: 993 },
    spamFolder: 'Bulk',
    spamFolders: ['Bulk', 'Bulk Mail', 'Spam'],
    archiveFolders: ['Archive'],
    helper: true,
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    helperNote: 'Free Yahoo works with an app password (Account security → Create app password). Yahoo allows only a few IMAP connections at once.',
    passwordLabel: 'app password',
    wrongPassword: 'Yahoo said the password is wrong — Yahoo does not take your normal password here: create an app password under Account security › Generate app password',
    imapOff: null,
    setup: ['Create a Yahoo account', 'Account security → Generate app password', 'Paste the address + the app password below'],
  },
  aol: {
    label: 'AOL Mail',
    family: 'yahoo',
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    imap: { host: 'imap.aol.com', port: 993 },
    spamFolder: 'Bulk',
    spamFolders: ['Bulk', 'Bulk Mail', 'Spam'],
    archiveFolders: ['Archive'],
    helper: true,
    domains: ['aol.com'],
    helperNote: 'Free AOL works with an app password. AOL runs on Yahoo’s mail system, so it counts as the same filter family as Yahoo when pairing.',
    passwordLabel: 'app password',
    wrongPassword: 'AOL said the password is wrong — AOL does not take your normal password here: create an app password under Account security › Generate app password',
    imapOff: null,
    setup: ['Create an AOL account', 'Account security → Generate app password', 'Paste the address + the app password below'],
  },
  icloud: {
    label: 'iCloud Mail',
    family: 'apple',
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    imap: { host: 'imap.mail.me.com', port: 993 },
    spamFolder: 'Junk',
    spamFolders: ['Junk'],
    archiveFolders: ['Archive'],
    helper: true,
    // Apple: the IMAP user name is usually the part before the @ (full address if that fails).
    imapUser: 'local',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    helperNote: 'Free iCloud Mail works with an app-specific password (needs two-factor authentication). 1,000 emails/day.',
    passwordLabel: 'app-specific password',
    wrongPassword: 'iCloud said the password is wrong — use an app-specific password (account.apple.com › Sign-In and Security › App-Specific Passwords; needs two-factor authentication), not your Apple Account password',
    imapOff: null,
    setup: ['Create an Apple Account with an @icloud.com address', 'Turn on two-factor authentication', 'account.apple.com → Sign-In and Security → App-Specific Passwords → generate one', 'Paste the address + the app-specific password below'],
  },
  gmx: {
    label: 'GMX (gmx.com)',
    family: 'gmx',
    smtp: { host: 'mail.gmx.com', port: 587, secure: false },
    imap: { host: 'imap.gmx.com', port: 993 },
    spamFolder: 'Spam',
    spamFolders: ['Spam', 'Spamverdacht'],
    archiveFolders: ['Archive', 'Archiv'],
    helper: true,
    domains: ['gmx.com', 'gmx.us'],
    helperNote: 'Free GMX works, but IMAP must be switched on (Settings → POP3 & IMAP) and GMX switches it off again after a long idle spell — the circle reads it every 30 minutes, which keeps it on.',
    passwordLabel: 'GMX password (an application-specific password if two-factor is on)',
    wrongPassword: 'GMX said the password is wrong — use the GMX password (or an application-specific password if you turned on two-factor)',
    imapOff: 'IMAP is off — GMX: Email › Settings › POP3 & IMAP › enable access, then press Test and add again',
    setup: ['Create a gmx.com account', 'Email → Settings → POP3 & IMAP → enable access', 'Paste the address + the account password below (an application-specific password if you turned on two-factor)'],
  },
  gmxnet: {
    label: 'GMX (gmx.net / gmx.de)',
    family: 'gmx',
    smtp: { host: 'mail.gmx.net', port: 587, secure: false },
    imap: { host: 'imap.gmx.net', port: 993 },
    spamFolder: 'Spamverdacht',
    spamFolders: ['Spamverdacht', 'Spam'],
    archiveFolders: ['Archiv', 'Archive'],
    helper: true,
    domains: ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    helperNote: 'Free GMX (German) works once POP3 & IMAP is switched on in the settings.',
    passwordLabel: 'GMX password',
    wrongPassword: 'GMX said the password is wrong — use the GMX password (or an application-specific password if you turned on two-factor)',
    imapOff: 'IMAP is off — GMX: E-Mail › Einstellungen › POP3 & IMAP › enable, then press Test and add again',
    setup: ['Create a gmx.net account', 'E-Mail → Einstellungen → POP3 & IMAP → enable', 'Paste the address + the password below'],
  },
  webde: {
    label: 'WEB.DE',
    family: 'gmx',
    smtp: { host: 'smtp.web.de', port: 587, secure: false },
    imap: { host: 'imap.web.de', port: 993 },
    spamFolder: 'Spam',
    spamFolders: ['Spam', 'Spamverdacht', 'Unerwünscht'],
    archiveFolders: ['Archiv', 'Archive'],
    helper: true,
    domains: ['web.de'],
    helperNote: 'Free WEB.DE works once IMAP is switched on in the settings (same company as GMX, so the same filter family).',
    passwordLabel: 'WEB.DE password',
    wrongPassword: 'WEB.DE said the password is wrong — use the WEB.DE password (or an application-specific password if you turned on two-factor)',
    imapOff: 'IMAP is off — WEB.DE: Settings › POP3/IMAP › enable, then press Test and add again',
    setup: ['Create a web.de account', 'Settings → POP3/IMAP → enable', 'Paste the address + the password below'],
  },
  yandex: {
    label: 'Yandex Mail',
    family: 'yandex',
    smtp: { host: 'smtp.yandex.com', port: 465, secure: true },
    imap: { host: 'imap.yandex.com', port: 993 },
    spamFolder: 'Spam',
    spamFolders: ['Spam'],
    archiveFolders: ['Archive'],
    helper: true,
    domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
    helperNote: 'Free Yandex works with an app password; two settings must be on (IMAP, and app passwords). Sign-up needs a phone number.',
    passwordLabel: 'app password',
    wrongPassword: 'Yandex said the password is wrong — create an app password for Mail at id.yandex.com › Security › App passwords (Mail › Settings › Email clients › "App passwords and OAuth tokens" must be on)',
    imapOff: 'IMAP is off — Yandex: Mail › Settings › Email clients › turn on IMAP (and "App passwords and OAuth tokens"), then press Test and add again',
    setup: ['Create a Yandex account', 'Settings → Email clients → turn on IMAP and "App passwords and OAuth tokens"', 'id.yandex.com → Security → App passwords → create one for Mail', 'Paste the address + the app password below'],
  },
  outlook: {
    label: 'Outlook.com / Hotmail',
    family: 'microsoft',
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    imap: { host: 'outlook.office365.com', port: 993 },
    spamFolder: 'Junk',
    spamFolders: ['Junk', 'Junk Email', 'Junk E-mail'],
    archiveFolders: ['Archive'],
    helper: false,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    helperNote: 'Not supported: Microsoft ended password (basic-auth) access for Outlook.com personal accounts on 16 Sep 2024 — IMAP/SMTP need OAuth2, which this machine does not do. Existing Outlook helpers stop at their first login failure.',
    setup: [],
  },
  zoho: {
    label: 'Zoho Mail (paid plans)',
    family: 'zoho',
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    imap: { host: 'imap.zoho.com', port: 993 },
    spamFolder: 'Spam',
    spamFolders: ['Spam'],
    archiveFolders: ['Archive'],
    helper: false,
    domains: ['zohomail.com', 'zoho.com'],
    helperNote: 'Not on the free plan: Zoho’s Forever Free plan has no IMAP/POP (and reportedly no SMTP). Paid Zoho mailboxes work.',
    setup: [],
  },
  mailcom: {
    label: 'mail.com',
    family: 'gmx',
    smtp: { host: 'smtp.mail.com', port: 587, secure: false },
    imap: { host: 'imap.mail.com', port: 993 },
    spamFolder: 'Spam',
    spamFolders: ['Spam'],
    archiveFolders: [],
    helper: false,
    domains: ['mail.com'],
    helperNote: 'Not on the free plan: mail.com has sold IMAP/POP only with Premium since 2010.',
    setup: [],
  },
  namecheap: {
    label: 'Namecheap Private Email',
    family: 'namecheap',
    smtp: { host: 'mail.privateemail.com', port: 465, secure: true },
    imap: { host: 'mail.privateemail.com', port: 993 },
    spamFolder: 'Junk',
    spamFolders: ['Junk', 'Spam'],
    archiveFolders: ['Archive'],
    helper: false,
    domains: [],
    helperNote: 'A paid mailbox (works, but is not a free helper).',
    setup: [],
  },
  custom: {
    label: 'Custom (SMTP_HOST / IMAP_HOST)',
    family: 'custom',
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
    spamFolders: ['Junk', 'Spam'],
    archiveFolders: ['Archive'],
    helper: false,
    domains: [],
    helperNote: 'Uses the SMTP_HOST / IMAP_HOST environment settings.',
    setup: [],
  },
};

/** Provider ids a free helper account can use (IMAP + SMTP with an app password). */
export const HELPER_PROVIDERS = Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].helper);

/** The preset for an address's own domain (gmail.com → google), or null. */
export function providerForAddress(email) {
  const d = String(email || '').split('@')[1]?.toLowerCase() || '';
  if (!d) return null;
  return Object.keys(PROVIDERS).find((p) => (PROVIDERS[p].domains || []).includes(d)) || null;
}

/** Filter family of a provider id ('aol' → 'yahoo'); unknown ids are their own family. */
export function familyOf(provider) {
  return PROVIDERS[provider]?.family || String(provider || 'google');
}

/**
 * A readable label for counting mailboxes by provider: Google is split into
 * free Gmail and Google Workspace (the trial inboxes), everything else is the
 * provider id.
 */
export function providerLabel(provider, email) {
  const p = String(provider || 'google');
  if (p !== 'google') return p;
  const d = String(email || '').split('@')[1]?.toLowerCase() || '';
  return ['gmail.com', 'googlemail.com'].includes(d) ? 'gmail' : 'google-workspace';
}

export { GLOBAL_SMTP_HOST };
