/**
 * Auth Guard (SPEC §6.6). Repeats the Setup Checker's DNS and blacklist parts
 * daily for every live trial domain and parses DMARC aggregate reports.
 *
 *  - auth (06:00 ET): SPF/DKIM/DMARC/MX → dns_fail with the exact fix.
 *  - blacklist (06:10 ET): DNSBL → blacklisted; a sending client is paused.
 *  - dmarc (06:20 ET, global): IMAP-scan the DMARC collector inbox
 *    (DMARC_INBOX, else OWNER_INBOX) for aggregate reports (.xml, .xml.gz,
 *    .zip), count <record> rows per trial domain per day, store
 *    dmarcPassRate7d. Under 95% → dmarc_degraded; under 80% → pause sending.
 *    No reports = no rate (never a guessed number).
 *
 * zip is read with a minimal single-entry reader (central directory +
 * zlib.inflateRawSync), so no new dependency is needed.
 */

import { kv } from '@vercel/kv';
import zlib from 'node:zlib';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getAllClients, getClient, getDomain, setState, SENDING_STATES, WARMUP_STATES } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { parseAccount } from '@/lib/smtp-accounts';
import { dayKeyIn, addDays, ET } from '@/lib/time';
import { io } from '@/lib/systems/intake-io';
import { checkDns, checkBlacklist, fixFor } from '@/lib/systems/setupcheck';

const SYSTEM = 'authguard';

async function collector(clientId) {
  const c = await cfg(clientId, 'AUTH.dmarcCollector');
  if (c) return String(c).toLowerCase();
  const own = parseAccount(process.env.DMARC_INBOX || process.env.OWNER_INBOX || '');
  return own ? own.email : null;
}

async function pauseSending(clientId, reason) {
  const client = await getClient(clientId);
  if (client && SENDING_STATES.has(client.state)) {
    await setState(clientId, 'paused', reason);
    return true;
  }
  return false;
}

/** Daily DNS re-check for one client. */
export async function runAuthCheck({ clientId, now = io.now() }) {
  const domain = await getDomain(clientId);
  if (!domain.name || domain.retiredAt) return { skipped: 'no domain' };
  const coll = await collector(clientId);
  const r = await checkDns(domain.name, ['spf', 'dkim', 'dmarc', 'mx'], { collector: coll });
  const fields = {};
  for (const [c, v] of Object.entries(r)) {
    fields[c] = v.status;
    fields[`${c}CheckedAt`] = now.toISOString();
    fields[`check:${c}`] = JSON.stringify({ status: v.status, detail: String(v.detail || '').slice(0, 400), checkedAt: now.toISOString(), by: 'authguard', ...(v.transient ? { transient: true } : {}) });
  }
  await kv.hset(K.domain(clientId), fields);
  const failed = Object.entries(r).filter(([, v]) => v.status !== 'pass');
  await logEvent(clientId, SYSTEM, 'dns_checked', { failed: failed.map(([c]) => c) });
  if (failed.length) {
    await io.alertOwner('dns_fail', {
      clientId, scope: `${clientId}:dns`, vars: { domain: domain.name },
      body: `Daily check: DNS is wrong for ${domain.name}:\n\n${failed.map(([c, v]) => `• ${c.toUpperCase()}: ${v.detail}\n  Fix: ${fixFor(c, domain.name, coll)}`).join('\n')}`,
      did: 'Logged; sending continues unless the domain is also blacklisted or DMARC drops below 80%.',
    });
  }
  return { failed: failed.map(([c]) => c) };
}

/** Daily DNSBL check for one client. Listed → alert + pause if sending. */
export async function runBlacklistCheck({ clientId, now = io.now() }) {
  const domain = await getDomain(clientId);
  if (!domain.name || domain.retiredAt) return { skipped: 'no domain' };
  const r = await checkBlacklist(domain.name);
  await kv.hset(K.domain(clientId), { blacklist: r.status === 'pass' ? 'clean' : 'listed', blacklistCheckedAt: now.toISOString(), 'check:blacklist': JSON.stringify({ status: r.status, detail: r.detail, checkedAt: now.toISOString(), by: 'authguard' }) });
  await logEvent(clientId, SYSTEM, 'blacklist_checked', { status: r.status, listed: r.listed });
  if (r.status !== 'pass') {
    const paused = await pauseSending(clientId, `blacklisted: ${r.listed.join(', ')}`);
    await io.alertOwner('blacklisted', { clientId, vars: { domain: domain.name }, body: `${domain.name} is ${r.detail}.\nFix: ${fixFor('blacklist', domain.name)}`, did: paused ? 'Sending paused on this client (warm-up continues).' : 'Not sending yet; logged.' });
    return { listed: r.listed, paused };
  }
  return { listed: [] };
}

// ── DMARC aggregate reports ─────────────────────────────────────────────────

/**
 * Minimal zip reader: the first file entry (DMARC zips hold one XML).
 * Reads the central directory so data-descriptor zips work too.
 */
export function unzipFirst(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (b.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip: bad central directory');
  const method = b.readUInt16LE(cdOffset + 10);
  const compSize = b.readUInt32LE(cdOffset + 20);
  const localOffset = b.readUInt32LE(cdOffset + 42);
  if (b.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = b.readUInt16LE(localOffset + 26);
  const extraLen = b.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = b.subarray(start, start + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip: unsupported method ${method}`);
}

/** Attachment → XML text (xml, gz, zip). Throws on anything else. */
export function attachmentXml(filename, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return unzipFirst(buf).toString('utf8');
  const text = buf.toString('utf8');
  if (/<feedback[\s>]/i.test(text)) return text;
  throw new Error(`not a DMARC report: ${filename}`);
}

const tag = (xml, name) => ((xml.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i')) || [])[1] || '').trim();

/** DMARC aggregate XML → { reportId, org, begin, end, records: [{ headerFrom, count, dkim, spf, pass }] }. */
export function parseDmarcXml(xml) {
  const meta = tag(xml, 'report_metadata');
  const range = tag(meta, 'date_range');
  const records = [];
  for (const m of String(xml).matchAll(/<record>([\s\S]*?)<\/record>/gi)) {
    const rec = m[1];
    const pe = tag(rec, 'policy_evaluated');
    const dkim = tag(pe, 'dkim').toLowerCase();
    const spf = tag(pe, 'spf').toLowerCase();
    records.push({
      sourceIp: tag(rec, 'source_ip'),
      count: Number(tag(rec, 'count')) || 0,
      dkim, spf,
      pass: dkim === 'pass' || spf === 'pass',
      headerFrom: tag(tag(rec, 'identifiers'), 'header_from').toLowerCase(),
    });
  }
  return {
    reportId: tag(meta, 'report_id'),
    org: tag(meta, 'org_name'),
    begin: Number(tag(range, 'begin')) || null,
    end: Number(tag(range, 'end')) || null,
    policyDomain: tag(tag(xml, 'policy_published'), 'domain').toLowerCase(),
    records,
  };
}

/** Sum pass/total over the last `days` ET days. */
export async function dmarcPassRate(clientId, now = io.now(), days = 7) {
  const raw = (await kv.hgetall(K.dmarcDays(clientId))) || {};
  const today = dayKeyIn(ET, now);
  let pass = 0;
  let total = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(today, -i);
    pass += Number(raw[`${d}:pass`]) || 0;
    total += Number(raw[`${d}:total`]) || 0;
  }
  return { pass, total, rate: total ? pass / total : null };
}

/**
 * Global daily job: read new reports from the collector inbox, store per
 * client/day counts, then evaluate every live trial domain.
 */
export async function runDmarcScan({ now = io.now(), clients = null } = {}) {
  const account = parseAccount(process.env.DMARC_INBOX || process.env.OWNER_INBOX || '');
  const all = clients || (await getAllClients());
  const live = [];
  for (const c of all) {
    if (c.id === 'aviance' || !WARMUP_STATES.has(c.state)) continue;
    const d = await getDomain(c.id);
    if (d.name && !d.retiredAt) live.push({ id: c.id, state: c.state, domain: d.name.toLowerCase() });
  }
  if (!live.length) return { skipped: 'no live domains' };
  if (!account) {
    await io.alertOwner('config_missing', { scope: 'DMARC_INBOX', vars: { key: 'DMARC_INBOX / OWNER_INBOX' }, body: 'DMARC reports cannot be read: neither DMARC_INBOX nor OWNER_INBOX is set (format email:app-password:Name).', did: 'DMARC pass rates are not computed; nothing else changes.' });
    return { skipped: 'no collector inbox' };
  }

  const byDomain = Object.fromEntries(live.map((l) => [l.domain, l.id]));
  const state = (await kv.get(K.dmarcState())) || {};
  const lookback = await cfg(null, 'AUTH.dmarcLookbackDays');
  const max = await cfg(null, 'AUTH.dmarcMaxMessages');
  const fetched = await io.imapFetchAttachments(account, { afterUid: Number(state.lastUid) || 0, since: new Date(now.getTime() - lookback * 864e5), max });
  if (!fetched.ok && !fetched.messages.length) {
    await io.alertOwner('dmarc_degraded', { scope: 'collector', vars: { domain: 'collector inbox', rate: 'unreadable' }, body: `The DMARC collector inbox ${account.email} could not be read: ${fetched.error}`, did: 'Pass rates keep their last value; retried tomorrow.' });
    return { error: fetched.error };
  }
  let reports = 0;
  let rows = 0;
  for (const msg of fetched.messages) {
    for (const att of msg.attachments) {
      let rep;
      try { rep = parseDmarcXml(attachmentXml(att.filename, att.content)); } catch { continue; }
      if (!rep.reportId) continue;
      const seenKey = `${rep.org}:${rep.reportId}`;
      if (!(await kv.sadd(K.dmarcSeen(), seenKey))) continue;
      reports++;
      const day = dayKeyIn(ET, new Date((rep.begin || now.getTime() / 1000) * 1000));
      for (const r of rep.records) {
        const clientId = byDomain[r.headerFrom] || byDomain[rep.policyDomain];
        if (!clientId || !r.count) continue;
        const p = kv.pipeline();
        p.hincrby(K.dmarcDays(clientId), `${day}:total`, r.count);
        if (r.pass) p.hincrby(K.dmarcDays(clientId), `${day}:pass`, r.count);
        await p.exec();
        rows++;
      }
    }
  }
  await kv.set(K.dmarcState(), { lastUid: fetched.maxUid, scannedAt: now.toISOString(), more: Boolean(fetched.more) });
  await logEvent(null, SYSTEM, 'dmarc_scanned', { messages: fetched.messages.length, reports, rows, more: fetched.more });

  const warn = await cfg(null, 'AUTH.dmarcWarn');
  const pauseAt = await cfg(null, 'AUTH.dmarcPause');
  const results = {};
  for (const l of live) {
    const { rate, total } = await dmarcPassRate(l.id, now);
    results[l.id] = rate;
    await kv.hset(K.domain(l.id), { dmarcPassRate7d: rate === null ? '' : Math.round(rate * 1000) / 1000, dmarcMessages7d: total, dmarcCheckedAt: now.toISOString() });
    if (rate === null) continue;
    const pct = `${Math.round(rate * 100)}%`;
    if (rate < pauseAt) {
      const paused = await pauseSending(l.id, `DMARC pass ${pct}`);
      await io.alertOwner('dmarc_degraded', { clientId: l.id, vars: { domain: l.domain, rate: pct }, body: `DMARC pass rate for ${l.domain} over 7 days is ${pct} (${total} messages).`, did: paused ? 'Sending paused on this domain (warm-up continues).' : 'Not sending yet; logged.' });
    } else if (rate < warn) {
      await io.alertOwner('dmarc_degraded', { clientId: l.id, vars: { domain: l.domain, rate: pct }, body: `DMARC pass rate for ${l.domain} over 7 days is ${pct} (${total} messages).`, did: 'Warning only; sending continues.' });
    }
  }
  return { reports, rows, rates: results, more: Boolean(fetched.more) };
}
