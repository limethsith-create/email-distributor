/**
 * Setup Checker (SPEC §6.6). Nothing sends until the infrastructure is
 * provably correct. Runs at purchase and re-runs failed checks hourly.
 *
 * The 11 checks: SPF, DKIM (google._domainkey), DMARC, MX (Google), SMTP
 * login (nodemailer verify), IMAP login + spam folder, loopback (inbox A →
 * inbox B, IMAP confirms within SETUP.loopbackWaitMin minutes, DKIM/SPF pass
 * in Authentication-Results), 2-Step (SMTP login with an app password),
 * DNSBL blacklists (SpamCop, Barracuda, SORBS — never Spamhaus), redirect to
 * mainDomain (warn only), auto-renew off.
 *
 * Each check stores {status, detail, fix, checkedAt} in client:{id}:domain
 * under `check:{name}`, plus the §3 summary fields (spf, dkim, dmarc, mx,
 * blacklist + *CheckedAt). Work is split across ticks: a run does the checks
 * that fit in its budget; the loopback sends on one run and looks for the
 * message on later runs. All blocking checks pass → `warming` with the trial
 * dates set and welcome_two_dates sent. Any fail → stays `setup_check`,
 * owner alert with the exact fix, hourly re-run.
 */

import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getDomain, getProfile, setState, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { getInboxRecords, toAccount, patchInbox } from '@/lib/db/inboxes';
import { initCounters } from '@/lib/db/counters';
import { parseAccount } from '@/lib/smtp-accounts';
import { dayKeyIn, addDays, ET } from '@/lib/time';
import { io, asObject, firstNameOf, ownerName, sendClient, formatDay, nextUsBusinessDay } from '@/lib/systems/intake-io';

const SYSTEM = 'setupcheck';

export const CHECKS = ['spf', 'dkim', 'dmarc', 'mx', 'autorenew', 'blacklist', 'redirect', 'smtp', 'imap', 'twostep', 'loopback'];
/** Checks that must pass before warming (redirect only warns). */
export const BLOCKING = new Set(CHECKS.filter((c) => c !== 'redirect'));

const TRANSIENT_DNS = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED', 'ECANCELLED']);
const MISSING_DNS = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

// ── pure evaluators (unit-tested) ───────────────────────────────────────────

const joinTxt = (records) => (records || []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));

export function evalSpf(records, include = '_spf.google.com') {
  const spf = joinTxt(records).filter((t) => /^v=spf1\b/i.test(t.trim()));
  if (!spf.length) return { status: 'fail', detail: 'no SPF record' };
  if (spf.length > 1) return { status: 'fail', detail: `${spf.length} SPF records (only one allowed)` };
  const rec = spf[0].trim();
  if (!new RegExp(`\\binclude:${include.replace(/\./g, '\\.')}\\b`, 'i').test(rec)) return { status: 'fail', detail: `SPF does not include ${include}: "${rec}"` };
  if (!/[~-]all$/i.test(rec)) return { status: 'fail', detail: `SPF must end with ~all or -all: "${rec}"` };
  return { status: 'pass', detail: rec };
}

export function evalDkim(records) {
  const t = joinTxt(records).find((x) => /v=DKIM1/i.test(x));
  return t ? { status: 'pass', detail: `${t.slice(0, 40)}…` } : { status: 'fail', detail: 'no v=DKIM1 record at google._domainkey' };
}

export function evalDmarc(records, domain, collector = null) {
  const rec = joinTxt(records).find((x) => /^v=DMARC1/i.test(x.trim()));
  if (!rec) return { status: 'fail', detail: 'no DMARC record' };
  const p = (rec.match(/;\s*p=(\w+)/i) || [])[1];
  if (!p || !['none', 'quarantine', 'reject'].includes(p.toLowerCase())) return { status: 'fail', detail: `DMARC policy missing: "${rec}"` };
  const rua = (rec.match(/rua=([^;]+)/i) || [])[1] || '';
  const targets = rua.split(',').map((s) => s.trim().toLowerCase().replace(/^mailto:/, ''));
  const okTargets = [`dmarc@${domain}`, collector && String(collector).toLowerCase()].filter(Boolean);
  if (!targets.some((t) => okTargets.includes(t))) return { status: 'fail', detail: `DMARC rua must be mailto:${okTargets.join(' or mailto:')} (found "${rua || 'none'}")` };
  return { status: 'pass', detail: rec };
}

export function evalMx(records, googleMx = ['aspmx.l.google.com', 'smtp.google.com']) {
  const hosts = (records || []).map((r) => String(r.exchange || r).toLowerCase().replace(/\.$/, ''));
  if (!hosts.length) return { status: 'fail', detail: 'no MX record' };
  return hosts.some((h) => googleMx.includes(h)) ? { status: 'pass', detail: hosts.join(', ') } : { status: 'fail', detail: `MX does not point at Google: ${hosts.join(', ')}` };
}

export const reverseIp = (ip) => String(ip).split('.').reverse().join('.');

/** DNSBL query names for each IP × list: 4.3.2.1.bl.spamcop.net … */
export function dnsblQueries(ips, lists) {
  const out = [];
  for (const ip of ips) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    for (const list of lists) out.push({ ip, list, name: `${reverseIp(ip)}.${list}` });
  }
  return out;
}

/** A DNSBL answer means "listed" only when it is 127.0.0.2–127.0.0.99 (127.255.x = query refused). */
export const isListedAnswer = (addrs) => (addrs || []).some((a) => /^127\.0\.0\.(\d{1,2})$/.test(a) && Number(a.split('.')[3]) >= 2);

/** Authentication-Results → { present, dkim, spf } ('pass' | other | null). */
export function parseAuthResults(headers) {
  const unfolded = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  const lines = unfolded.split(/\r?\n/).filter((l) => /^authentication-results:/i.test(l));
  if (!lines.length) return { present: false, dkim: null, spf: null };
  const text = lines.join(' ');
  return {
    present: true,
    dkim: ((text.match(/\bdkim=(\w+)/i) || [])[1] || '').toLowerCase() || null,
    spf: ((text.match(/\bspf=(\w+)/i) || [])[1] || '').toLowerCase() || null,
  };
}

/** The exact DNS record the owner must add for a failing check. */
export function fixFor(check, domain, collector) {
  switch (check) {
    case 'spf': return `Add (or replace the existing SPF with) TXT record on ${domain}:  v=spf1 include:_spf.google.com ~all`;
    case 'dkim': return `In Google Admin → Apps → Google Workspace → Gmail → Authenticate email, generate a 2048-bit key for ${domain}, add it as TXT record google._domainkey.${domain}, then click "Start authentication".`;
    case 'dmarc': return `Add TXT record _dmarc.${domain}:  v=DMARC1; p=none; rua=mailto:${collector || `dmarc@${domain}`}`;
    case 'mx': return `Set the MX record of ${domain} to:  1 smtp.google.com  (remove any other MX records)`;
    case 'autorenew': return `Turn auto-renew OFF for ${domain} at the registrar, then tick the box on the purchase page again.`;
    case 'redirect': return `Forward https://${domain} to the client's main site (registrar URL forwarding, 301).`;
    case 'smtp':
    case 'twostep': return 'Turn on 2-Step Verification for the inbox, create an app password (Google Account → Security → App passwords) and paste it again on the purchase page.';
    case 'imap': return 'Make sure IMAP is enabled (Gmail settings → Forwarding and POP/IMAP) and the app password is right; paste it again on the purchase page if needed.';
    case 'loopback': return 'Check SPF/DKIM above, then re-run the setup check. If the test mail landed in spam, keep warming and re-run tomorrow.';
    case 'blacklist': return 'Request delisting at the list named above, or replace the domain.';
    default: return '';
  }
}

/** Day 1 = signedDay + buildDays moved to the next US business day; Day 30 = Day 1 + decisionDay − 1. */
export function computeDates(signedDay, buildDays = 14, decisionDay = 30) {
  const day1Date = nextUsBusinessDay(addDays(signedDay, buildDays));
  return { signedDay, day1Date, day30Date: addDays(day1Date, decisionDay - 1) };
}

// ── network checks ──────────────────────────────────────────────────────────

async function dnsLookup(fn, name, ms) {
  try {
    return { ok: true, value: await fn(name, ms) };
  } catch (err) {
    const code = err?.code || '';
    if (MISSING_DNS.has(code)) return { ok: true, value: [] };
    return { ok: false, transient: TRANSIENT_DNS.has(code) || !code, error: `${code || 'error'} ${String(err?.message || '').slice(0, 80)}` };
  }
}

/** SPF/DKIM/DMARC/MX for a domain → { spf, dkim, dmarc, mx } results. */
export async function checkDns(domain, which = ['spf', 'dkim', 'dmarc', 'mx'], { collector = null } = {}) {
  const setup = await cfg(null, 'SETUP');
  const ms = setup.dnsTimeoutMs;
  const tasks = {
    spf: async () => { const r = await dnsLookup(io.dns.resolveTxt, domain, ms); return r.ok ? evalSpf(r.value, setup.spfInclude) : { status: 'fail', transient: r.transient, detail: `lookup failed: ${r.error}` }; },
    dkim: async () => { const r = await dnsLookup(io.dns.resolveTxt, `${setup.dkimSelector}._domainkey.${domain}`, ms); return r.ok ? evalDkim(r.value) : { status: 'fail', transient: r.transient, detail: `lookup failed: ${r.error}` }; },
    dmarc: async () => { const r = await dnsLookup(io.dns.resolveTxt, `_dmarc.${domain}`, ms); return r.ok ? evalDmarc(r.value, domain, collector) : { status: 'fail', transient: r.transient, detail: `lookup failed: ${r.error}` }; },
    mx: async () => { const r = await dnsLookup(io.dns.resolveMx, domain, ms); return r.ok ? evalMx(r.value, setup.googleMx) : { status: 'fail', transient: r.transient, detail: `lookup failed: ${r.error}` }; },
  };
  const entries = await Promise.all(which.map(async (k) => [k, await tasks[k]()]));
  return Object.fromEntries(entries);
}

/** DNSBL check on the domain's A record and its MX hosts' IPs. */
export async function checkBlacklist(domain) {
  const setup = await cfg(null, 'SETUP');
  const ms = setup.dnsTimeoutMs;
  const ips = new Set();
  const a = await dnsLookup(io.dns.resolve4, domain, ms);
  if (a.ok) a.value.forEach((ip) => ips.add(ip));
  const mx = await dnsLookup(io.dns.resolveMx, domain, ms);
  if (mx.ok) {
    const hosts = mx.value.map((m) => String(m.exchange || '').replace(/\.$/, '')).filter(Boolean).slice(0, 3);
    const res = await Promise.all(hosts.map((h) => dnsLookup(io.dns.resolve4, h, ms)));
    res.forEach((r) => r.ok && r.value.slice(0, 2).forEach((ip) => ips.add(ip)));
  }
  if (!ips.size) return { status: 'pass', detail: 'no A/MX addresses to check yet', listed: [], skipped: [] };
  const queries = dnsblQueries([...ips], setup.dnsbl);
  const listed = [];
  const skipped = [];
  await Promise.all(queries.map(async (q) => {
    const r = await dnsLookup(io.dns.resolve4, q.name, ms);
    if (!r.ok) { skipped.push(`${q.list} (${q.ip})`); return; }
    if (isListedAnswer(r.value)) listed.push(`${q.ip} on ${q.list}`);
  }));
  return listed.length
    ? { status: 'fail', detail: `listed: ${listed.join('; ')}`, listed, skipped }
    : { status: 'pass', detail: `clean on ${setup.dnsbl.length} lists for ${ips.size} IPs${skipped.length ? ` (skipped on timeout: ${skipped.join(', ')})` : ''}`, listed, skipped };
}

/** GET https://{domain} must land (2xx) on the main domain. Warn only. */
export async function checkRedirect(domain, mainDomain) {
  try {
    const res = await io.fetchExt(`https://${domain}`, { timeoutMs: 8000, retry: false, redirect: 'follow' });
    const host = String(new URL(res.url || `https://${domain}`).hostname).replace(/^www\./, '');
    if (res.status >= 200 && res.status < 300 && host === String(mainDomain).replace(/^www\./, '')) return { status: 'pass', detail: `→ ${res.url}` };
    return { status: 'warn', detail: `https://${domain} ends at ${res.url || domain} (${res.status})` };
  } catch (err) {
    return { status: 'warn', detail: `https://${domain} did not answer: ${String(err?.message || err).slice(0, 80)}` };
  }
}

// ── state in client:{id}:domain ─────────────────────────────────────────────

export async function readChecks(clientId) {
  const d = await getDomain(clientId);
  const checks = {};
  for (const c of CHECKS) checks[c] = asObject(d[`check:${c}`]) || null;
  return { domain: d, checks };
}

async function writeCheck(clientId, name, result, now, extra = {}) {
  const rec = {
    status: result.status,
    detail: String(result.detail || '').slice(0, 400),
    checkedAt: now.toISOString(),
    ...(result.transient ? { transient: true } : {}),
    ...(result.fix ? { fix: result.fix } : {}),
    ...(Array.isArray(result.inboxes) ? { inboxes: result.inboxes } : {}),
    ...extra,
  };
  const fields = { [`check:${name}`]: JSON.stringify(rec) };
  if (['spf', 'dkim', 'dmarc', 'mx'].includes(name)) { fields[name] = rec.status; fields[`${name}CheckedAt`] = rec.checkedAt; }
  if (name === 'blacklist') { fields.blacklist = rec.status === 'pass' ? 'clean' : 'listed'; fields.blacklistCheckedAt = rec.checkedAt; }
  await kv.hset(K.domain(clientId), fields);
  return rec;
}

async function collectorAddress(clientId) {
  const c = await cfg(clientId, 'AUTH.dmarcCollector');
  if (c) return String(c).toLowerCase();
  const own = parseAccount(process.env.DMARC_INBOX || process.env.OWNER_INBOX || '');
  return own ? own.email : null;
}

/**
 * Start a round. `all` (purchase submit) re-checks everything; otherwise
 * only checks that did not pass are marked pending again.
 */
export async function startSetupCheck(clientId, { all = true, now = io.now() } = {}) {
  const { checks } = await readChecks(clientId);
  const fields = { setupPhase: 'running', setupRoundAt: now.toISOString() };
  for (const c of CHECKS) {
    if (all || !checks[c] || checks[c].status !== 'pass') fields[`check:${c}`] = JSON.stringify({ status: 'pending', checkedAt: now.toISOString() });
  }
  if (all || checks.loopback?.status !== 'pass') Object.assign(fields, { loopbackSentAt: '', loopbackToken: '', loopbackFrom: '', loopbackTo: '' });
  await kv.hset(K.domain(clientId), fields);
  await updateClient(clientId, { intakeStep: 'setup_running' });
  await logEvent(clientId, SYSTEM, 'round_started', { all });
}

async function accountsOf(clientId) {
  const recs = await getInboxRecords(clientId);
  return recs.map((r) => ({ rec: r, account: toAccount(r) }));
}

/**
 * Run pending checks while the budget allows. Returns
 * { phase: 'running' | 'passed' | 'failed', checks }.
 */
export async function runSetupCheck(clientId, { deadline = Date.now() + 15000, now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'setup_check') return { phase: 'skipped', reason: `state ${client?.state}` };
  let { domain, checks } = await readChecks(clientId);
  if (!domain.name) {
    await io.alertOwner('dns_fail', { clientId, vars: { domain: '(none)' }, body: `${clientId} is in setup_check but no domain name is stored.`, did: 'Nothing checked. Paste the domain on the purchase page.' });
    return { phase: 'failed', reason: 'no domain' };
  }
  if (domain.setupPhase !== 'running') { await startSetupCheck(clientId, { all: false, now }); ({ domain, checks } = await readChecks(clientId)); }
  const name = domain.name;
  const collector = await collectorAddress(clientId);
  const left = () => deadline - Date.now();
  const pending = (c) => !checks[c] || checks[c].status === 'pending';
  const results = {};
  const put = async (c, r, extra) => { checks[c] = await writeCheck(clientId, c, r, now, extra); results[c] = checks[c]; };

  const dnsWanted = ['spf', 'dkim', 'dmarc', 'mx'].filter(pending);
  if (dnsWanted.length && left() > 5000) {
    const r = await checkDns(name, dnsWanted, { collector });
    for (const [c, v] of Object.entries(r)) await put(c, { ...v, fix: v.status === 'pass' ? undefined : fixFor(c, name, collector) });
  }
  if (pending('autorenew')) {
    const off = domain.autoRenew === false || String(domain.autoRenew).toLowerCase() === 'false';
    await put('autorenew', off ? { status: 'pass', detail: 'auto-renew off (confirmed by owner)' } : { status: 'fail', detail: `auto-renew is "${domain.autoRenew ?? 'not confirmed'}"` });
  }
  if (pending('blacklist') && left() > 6000) await put('blacklist', await checkBlacklist(name));
  if (pending('redirect') && left() > 9000) await put('redirect', await checkRedirect(name, client.mainDomain));

  const inboxes = await accountsOf(clientId);
  if (pending('smtp') && left() > 12000) {
    if (!inboxes.length) await put('smtp', { status: 'fail', detail: 'no inboxes saved' });
    else {
      const rows = await Promise.all(inboxes.map(async ({ rec, account }) => {
        if (!account) return { email: rec.email, ok: false, error: 'password missing or unreadable (ENC_KEY?)' };
        const r = await io.smtpVerify(account);
        return { email: rec.email, ok: Boolean(r.success), error: r.success ? null : String(r.error || r.code || 'failed').slice(0, 160) };
      }));
      for (const row of rows) {
        await patchInbox(clientId, row.email, row.ok ? { twoStepVerified: '1', lastSmtpCheckAt: now.toISOString() } : { enabled: '0', twoStepVerified: '0', lastSmtpCheckAt: now.toISOString() });
      }
      const bad = rows.filter((r) => !r.ok);
      await put('smtp', bad.length ? { status: 'fail', detail: bad.map((b) => `${b.email}: ${b.error}`).join('; '), inboxes: bad.map((b) => b.email) } : { status: 'pass', detail: `${rows.length} inbox(es) logged in` });
      await put('twostep', bad.length ? { status: 'fail', detail: 'SMTP login with an app password failed' } : { status: 'pass', detail: 'app-password login works, so 2-Step is on' });
    }
  }
  if (pending('imap') && checks.smtp?.status !== 'pending' && left() > 12000) {
    if (!inboxes.length) await put('imap', { status: 'fail', detail: 'no inboxes saved' });
    else {
      const rows = await Promise.all(inboxes.map(async ({ rec, account }) => {
        if (!account) return { email: rec.email, ok: false, error: 'password missing' };
        const r = await io.imapLogin(account);
        if (!r.ok) return { email: rec.email, ok: false, error: r.error };
        return r.spamFolderExists ? { email: rec.email, ok: true } : { email: rec.email, ok: false, error: `spam folder ${account.spamFolder} not found` };
      }));
      for (const row of rows.filter((r) => !r.ok)) await patchInbox(clientId, row.email, { enabled: '0' });
      const bad = rows.filter((r) => !r.ok);
      await put('imap', bad.length ? { status: 'fail', detail: bad.map((b) => `${b.email}: ${b.error}`).join('; '), inboxes: bad.map((b) => b.email) } : { status: 'pass', detail: `${rows.length} inbox(es), spam folder found` });
    }
  }

  // Loopback: needs working SMTP + IMAP. Send on one run, look on later runs.
  if (pending('loopback')) {
    if (checks.smtp?.status === 'fail' || checks.imap?.status === 'fail') {
      await put('loopback', { status: 'fail', detail: 'skipped: inbox login failed' });
    } else if (checks.smtp?.status === 'pass' && checks.imap?.status === 'pass') {
      const usable = inboxes.filter((i) => i.account);
      const from = usable[0]?.account;
      const to = (usable[1] || usable[0])?.account;
      if (!domain.loopbackSentAt && from && left() > 8000) {
        const token = `AVL-${crypto.randomBytes(5).toString('hex')}`;
        const r = await io.sendEmail(from, { to: to.email, subject: `Setup check ${token}`, text: `Loopback test for ${name}. No action needed.\n${token}`, html: `<p>Loopback test for ${name}. No action needed.</p><p>${token}</p>`, transactional: true, noTrack: true });
        if (r.success) {
          await kv.hset(K.domain(clientId), { loopbackSentAt: now.toISOString(), loopbackToken: token, loopbackFrom: from.email, loopbackTo: to.email });
          domain = { ...domain, loopbackSentAt: now.toISOString(), loopbackToken: token };
          await logEvent(clientId, SYSTEM, 'loopback_sent', { from: from.email, to: to.email });
        } else {
          await put('loopback', { status: 'fail', detail: `send failed: ${String(r.error).slice(0, 160)}` });
        }
      } else if (domain.loopbackSentAt && to && left() > 8000) {
        const found = await io.imapFindMessage(to, domain.loopbackToken, domain.loopbackSentAt);
        const waitMin = await cfg(clientId, 'SETUP.loopbackWaitMin');
        const ageMin = (now.getTime() - Date.parse(domain.loopbackSentAt)) / 60000;
        if (found.found) {
          const auth = parseAuthResults(found.headers);
          const spamNote = /spam|junk|bulk/i.test(found.folder || '') ? ' (landed in spam)' : '';
          if (!auth.present) await put('loopback', { status: 'pass', detail: `received in ${found.folder}${spamNote}; no Authentication-Results header (same-domain delivery)` });
          else if (auth.dkim === 'pass' && auth.spf === 'pass') await put('loopback', { status: 'pass', detail: `received in ${found.folder}${spamNote}; dkim=pass spf=pass` });
          else await put('loopback', { status: 'fail', detail: `received but dkim=${auth.dkim || 'none'} spf=${auth.spf || 'none'}` });
        } else if (ageMin >= waitMin) {
          await put('loopback', { status: 'fail', detail: `not received within ${waitMin} min${found.error ? ` (${found.error})` : ''}` });
        }
      }
    }
  }

  const stillPending = CHECKS.filter(pending);
  if (stillPending.length) return { phase: 'running', pending: stillPending, results };
  return concludeRound(clientId, checks, { now, domainName: name, collector });
}

async function concludeRound(clientId, checks, { now, domainName, collector }) {
  const failed = [...BLOCKING].filter((c) => checks[c]?.status !== 'pass');
  if (checks.redirect?.status === 'warn') {
    await io.alertOwner('redirect_missing', { clientId, vars: { domain: domainName }, body: `${checks.redirect.detail}\nFix: ${fixFor('redirect', domainName)}`, did: 'Not blocking: setup continues.' });
  }
  if (!failed.length) return finishSetup(clientId, { now });

  await kv.hset(K.domain(clientId), { setupPhase: 'failed', setupFailedAt: now.toISOString() });
  await updateClient(clientId, { intakeStep: '' });
  await logEvent(clientId, SYSTEM, 'round_failed', { failed });
  const line = (c) => `• ${c.toUpperCase()}: ${checks[c]?.detail || 'failed'}\n  Fix: ${fixFor(c, domainName, collector)}`;
  const dns = failed.filter((c) => ['spf', 'dkim', 'dmarc', 'mx'].includes(c));
  if (dns.length) {
    const transient = dns.every((c) => checks[c]?.transient);
    await io.alertOwner('dns_fail', { clientId, scope: `${clientId}:dns`, vars: { domain: domainName }, body: `${transient ? 'DNS lookups timed out for' : 'DNS records are wrong for'} ${domainName}:\n\n${dns.map(line).join('\n')}`, did: 'Setup is on hold in setup_check; the check re-runs every hour.' });
  }
  for (const c of ['smtp', 'imap']) {
    if (failed.includes(c)) {
      for (const email of checks[c]?.inboxes || [domainName]) {
        await io.alertOwner('inbox_auth_fail', { clientId, scope: `${clientId}:${email}`, vars: { email }, body: `${c.toUpperCase()} check failed for ${email}: ${checks[c]?.detail}\nFix: ${fixFor(c, domainName)}`, did: 'Inbox disabled; setup re-checks every hour.' });
      }
    }
  }
  if (failed.includes('loopback') && !failed.includes('smtp') && !failed.includes('imap')) {
    await io.alertOwner('loopback_fail', { clientId, vars: { domain: domainName }, body: `${checks.loopback?.detail}\nFix: ${fixFor('loopback', domainName)}`, did: 'Setup is on hold; the loopback re-runs every hour.' });
  }
  if (failed.includes('blacklist')) {
    await io.alertOwner('blacklisted', { clientId, vars: { domain: domainName }, body: `${checks.blacklist?.detail}\nFix: ${fixFor('blacklist', domainName)}`, did: 'Setup is on hold; nothing is sent from this domain.' });
  }
  if (failed.includes('autorenew')) {
    await io.alertOwner('autorenew_on', { clientId, vars: { domain: domainName }, body: `${checks.autorenew?.detail}\nFix: ${fixFor('autorenew', domainName)}`, did: 'Setup is blocked until auto-renew is confirmed off.' });
  }
  return { phase: 'failed', failed };
}

/** All checks passed: dates, inboxes on, counters, state warming, welcome email. */
export async function finishSetup(clientId, { now = io.now() } = {}) {
  const buildDays = await cfg(clientId, 'TRIAL.buildDays');
  const decisionDay = await cfg(clientId, 'TRIAL.decisionDay');
  const dates = computeDates(dayKeyIn(ET, now), buildDays, decisionDay);
  const inboxes = await getInboxRecords(clientId);
  for (const r of inboxes) await patchInbox(clientId, r.email, { enabled: '1', warmupStartedAt: r.warmupStartedAt || now.toISOString() });
  await initCounters(clientId);
  await kv.hset(K.trial(clientId), dates);
  await kv.hset(K.domain(clientId), { setupPhase: 'passed', setupPassedAt: now.toISOString() });
  await setState(clientId, 'warming', 'all setup checks passed');
  await updateClient(clientId, { intakeStep: 'welcome' });
  await logEvent(clientId, SYSTEM, 'passed', dates);
  await sendWelcome(clientId, { now }).catch(async (err) => {
    await logEvent(clientId, SYSTEM, 'welcome_failed', { error: String(err.message).slice(0, 200) });
  });
  return { phase: 'passed', ...dates };
}

/** welcome_two_dates; retried hourly by the `welcome` job until sent. */
export async function sendWelcome(clientId, { now = io.now() } = {}) {
  const client = await getClient(clientId);
  const trial = await kv.hgetall(K.trial(clientId));
  if (!trial?.day1Date) throw new Error('no day1Date');
  if (trial.welcomeSentAt) { await updateClient(clientId, { intakeStep: '' }); return { skipped: 'sent' }; }
  // The approval link goes out on Day −7 (SPEC §7.6). Build days count from
  // signedDay = Day −14 (time.js trialDay), so Day −7 is signedDay + 7.
  const approvalDate = addDays(trial.signedDay || dayKeyIn(ET, now), 7);
  await sendClient(clientId, 'welcome_two_dates', {
    firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId),
    day1Date: formatDay(trial.day1Date), day30Date: formatDay(trial.day30Date), approvalDate: formatDay(approvalDate),
  }, { dedupe: 'welcome_two_dates' });
  await kv.hset(K.trial(clientId), { welcomeSentAt: now.toISOString() });
  await updateClient(clientId, { intakeStep: '' });
  return { sent: true };
}

/** Profile + domain summary for the Mission Control purchase page. */
export async function setupSummary(clientId) {
  const { domain, checks } = await readChecks(clientId);
  const profile = await getProfile(clientId);
  return { domain: { name: domain.name || null, setupPhase: domain.setupPhase || null, loopbackSentAt: domain.loopbackSentAt || null }, checks, senderName: profile.senderName || null };
}
