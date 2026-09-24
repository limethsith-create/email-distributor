/**
 * Warm-up Engine (SPEC §7.1). Builds sending reputation for new inboxes with
 * our own circle of mailboxes instead of a paid warm-up network.
 *
 * Pool = every inbox of a client in warming..extension (never `aviance`) +
 * the helper accounts (warmup:helper:{email}, clientId `_helper`).
 *
 *  - `runWarmupSend`  every 10 min, 07:00–22:00 in the sender's tz: up to
 *    3 pairs per run, daily quota by days since warmupStartedAt, a pair is
 *    never repeated on the same day, a different provider is preferred.
 *  - `runWarmupRead`  a couple of mailboxes per run, each mailbox at most
 *    every 30 min: IMAP-search Inbox + Spam (48 h) for the marker header,
 *    rescue from spam, \Seen, 30 % \Flagged, 40 % reply in thread, archive.
 *  - `runWarmupDaily` end of day: inboxRate7d + readiness streak per inbox.
 *
 * Every warm-up mail carries `X-Aviance-Warm: {nonce}~{hmac}` and an
 * invisible `<span data-w>`. `isWarmupMessage(headers)` is what the reply
 * handler uses to skip them (warm-up is never a send, reply or lead).
 *
 * Network pieces (SMTP send, IMAP client, randomness) are injectable through
 * `deps` so the tests never touch the network.
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, HARD_WARMUP_CAP } from '@/lib/config';
import { getAllClients, WARMUP_STATES } from '@/lib/db/client';
import { getInboxRecords, patchInbox, toAccount } from '@/lib/db/inboxes';
import { bump } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { clientNow, hasScaledClock } from '@/lib/testclock';
import { alertOwner } from '@/lib/notify';
import { encrypt } from '@/lib/crypto';
import { PROVIDERS } from '@/lib/smtp-providers';
import { ET, dayKeyIn, daysBetween, addDays, inWindow } from '@/lib/time';
import { composeWarmup, composeReply } from '@/lib/templates/warmup';

export const HELPER = '_helper';
export const MARKER_HEADER = 'X-Aviance-Warm';
const MARKER_KEY = MARKER_HEADER.toLowerCase();
const EXCLUDED_CLIENTS = new Set(['aviance', HELPER]);

// ── marker ───────────────────────────────────────────────────────────────────

function markerSecret() {
  return process.env.WARMUP_SECRET || process.env.ENC_KEY || process.env.CRON_SECRET || '';
}

function sign(nonce, secret = markerSecret()) {
  return crypto.createHmac('sha256', secret).update(`aviance-warm:${nonce}`).digest('hex').slice(0, 32);
}

/**
 * New marker value. kind 'w' = warm-up, 'c' = canary (tag = `{clientId}.{day}`).
 * Throws when no secret is configured (the caller alerts config_missing).
 */
export function makeMarker(kind = 'w', tag = '') {
  const secret = markerSecret();
  if (!secret) throw new Error('no WARMUP_SECRET / ENC_KEY to sign warm-up markers');
  const rand = crypto.randomBytes(6).toString('hex');
  const nonce = kind === 'c' ? `c.${tag}.${rand}` : `w.${rand}`;
  return `${nonce}~${sign(nonce, secret)}`;
}

/** Parse + verify a marker value → { kind, tag, nonce } or null. */
export function verifyMarker(value) {
  const v = String(value || '').trim();
  const i = v.lastIndexOf('~');
  if (i <= 0) return null;
  const nonce = v.slice(0, i);
  const sig = v.slice(i + 1);
  const secret = markerSecret();
  if (!secret || sig.length !== 32) return null;
  const want = sign(nonce, secret);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  if (nonce.startsWith('c.')) {
    const parts = nonce.split('.');
    return { kind: 'c', tag: parts.slice(1, -1).join('.'), nonce };
  }
  return { kind: 'w', tag: '', nonce };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers === 'string') {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(headers);
    return m ? m[1].trim() : null;
  }
  if (typeof headers.get === 'function') {
    const v = headers.get(name) ?? headers.get(name.toLowerCase());
    if (v != null) return Array.isArray(v) ? v[0] : String(v);
    return null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(v) ? String(v[0]) : String(v);
  }
  return null;
}

/**
 * True when a message carries a valid warm-up (or canary) marker. Accepts a
 * lowercase header map (mail-utils parseHeaders), a Map/Headers, or raw
 * header text. Stage C's reply handler calls this before classifying.
 */
export function isWarmupMessage(headers) {
  return Boolean(verifyMarker(headerValue(headers, MARKER_KEY)));
}

// ── quota ────────────────────────────────────────────────────────────────────

/** Warm-up emails/day for an inbox `days` days after warmupStartedAt (day 1 = start day). */
export function warmupQuota(days, table) {
  const d = Number(days) || 0;
  if (d < 1) return 0;
  let q = 0;
  for (const [range, n] of Object.entries(table || {})) {
    const m = /^(\d+)(?:-(\d+)|\+)$/.exec(range);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : Infinity;
    if (d >= lo && d <= hi) q = Number(n) || 0;
  }
  return Math.max(0, Math.min(HARD_WARMUP_CAP, q));
}

export function warmupDays(record, now = new Date()) {
  if (!record?.warmupStartedAt) return 0;
  const start = dayKeyIn(ET, new Date(record.warmupStartedAt));
  return daysBetween(start, dayKeyIn(ET, now)) + 1;
}

// ── pool ─────────────────────────────────────────────────────────────────────

const memberKey = (clientId, email) => `${clientId}|${String(email).toLowerCase()}`;
const domainOf = (email) => String(email).split('@')[1] || '';

/** Add or replace a helper account (password encrypted at rest). */
export async function saveHelper({ email, password, displayName, provider = 'google' }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr.includes('@')) throw new Error('invalid helper email');
  const p = PROVIDERS[provider] || PROVIDERS.google;
  const rec = {
    email: addr,
    clientId: HELPER,
    displayName: String(displayName || addr.split('@')[0]).trim(),
    provider,
    smtpHost: p.smtp.host,
    smtpPort: p.smtp.port,
    imapHost: p.imap.host,
    imapPort: p.imap.port,
    enabled: '1',
    health: 'new',
    updatedAt: new Date().toISOString(),
  };
  if (password) rec.passwordEnc = encrypt(String(password).replace(/\s+/g, ''));
  await kv.hset(K.warmupHelper(addr), rec);
  await kv.sadd(K.warmupPool(), memberKey(HELPER, addr));
  await logEvent(null, 'warmup', 'helper_saved', { email: addr, provider, passwordChanged: Boolean(password) });
  return rec;
}

export async function removeHelper(email) {
  const addr = String(email || '').trim().toLowerCase();
  await kv.srem(K.warmupPool(), memberKey(HELPER, addr));
  await kv.del(K.warmupHelper(addr));
  await logEvent(null, 'warmup', 'helper_removed', { email: addr });
}

export async function getHelpers() {
  const members = ((await kv.smembers(K.warmupPool())) || []).filter((m) => m.startsWith(`${HELPER}|`));
  const out = [];
  for (const m of members) {
    const rec = await kv.hgetall(K.warmupHelper(m.split('|')[1]));
    if (rec && rec.email) out.push(rec);
  }
  return out;
}

async function patchMember(member, fields) {
  if (member.isHelper) await kv.hset(K.warmupHelper(member.email), { ...fields, updatedAt: new Date().toISOString() });
  else await patchInbox(member.clientId, member.email, fields);
  Object.assign(member.record, fields);
}

/**
 * Every pool member with its quota. Keeps warmup:pool in step with client
 * states (client inboxes leave the circle when the client leaves warm-up).
 */
export async function getPool({ now = new Date(), clients = null, sync = true } = {}) {
  const quotaTable = await cfg(null, 'WARMUP.quota');
  const helperQuota = Math.min(HARD_WARMUP_CAP, await cfg(null, 'BUILD.warmupHelperQuota'));
  const all = clients || (await getAllClients());
  const members = [];
  for (const c of all) {
    if (EXCLUDED_CLIENTS.has(c.id) || !WARMUP_STATES.has(c.state)) continue;
    for (const rec of await getInboxRecords(c.id)) {
      if (!rec.passwordEnc || rec.warmupEnabled === '0' || !rec.warmupStartedAt) continue;
      // Warm-up age on the client's own clock (Test Mode runs `_test` scaled).
      const days = warmupDays(rec, clientNow(c, now));
      members.push({ key: memberKey(c.id, rec.email), clientId: c.id, client: c, email: rec.email, provider: rec.provider || 'google', domain: domainOf(rec.email), tz: rec.tz || ET, isHelper: false, days, quota: warmupQuota(days, quotaTable), record: rec });
    }
  }
  for (const rec of await getHelpers()) {
    if (!rec.passwordEnc || rec.enabled === '0' || rec.health === 'auth_failed') continue;
    members.push({ key: memberKey(HELPER, rec.email), clientId: HELPER, email: rec.email, provider: rec.provider || 'google', domain: domainOf(rec.email), tz: rec.tz || ET, isHelper: true, days: null, quota: helperQuota, record: rec });
  }
  // Sync the pool set: add live client inboxes, drop client inboxes that left
  // (only when `clients` is the whole client list, never for a partial view).
  if (sync) try {
    const current = (await kv.smembers(K.warmupPool())) || [];
    const live = new Set(members.map((m) => m.key));
    const stale = current.filter((m) => !m.startsWith(`${HELPER}|`) && !live.has(m));
    const fresh = members.filter((m) => !m.isHelper && !current.includes(m.key)).map((m) => m.key);
    if (stale.length) await kv.srem(K.warmupPool(), ...stale);
    if (fresh.length) await kv.sadd(K.warmupPool(), ...fresh);
  } catch {}
  return members;
}

// ── stats ────────────────────────────────────────────────────────────────────

export async function statBump(email, field, n = 1, now = new Date()) {
  const key = K.warmupStats(email, dayKeyIn(ET, now));
  await kv.hincrby(key, field, n);
  await kv.expire(key, 30 * 86400);
}

export async function statsFor(email, day) {
  const raw = (await kv.hgetall(K.warmupStats(email, day))) || {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v) || 0]));
}

/** inbox / (inbox + spam) over the last 7 ET days; null when nothing was observed. */
export async function inboxRate7d(email, now = new Date()) {
  const today = dayKeyIn(ET, now);
  let inbox = 0;
  let spam = 0;
  for (let i = 0; i < 7; i++) {
    const s = await statsFor(email, addDays(today, -i));
    inbox += s.inbox || 0;
    spam += s.spam || 0;
  }
  const total = inbox + spam;
  return { rate: total ? inbox / total : null, inbox, spam };
}

// ── pairing (pure) ───────────────────────────────────────────────────────────

export const pairKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|');

/**
 * Choose up to `n` sender → receiver pairs.
 * @param pool      members ({email, domain, provider, clientId, isHelper, quota})
 * @param sent      {email: sentToday}
 * @param received  {email: receivedToday}
 * @param pairs     Set of pairKey already used today
 * @param inWindow  (member) → boolean (sender's local hours)
 */
export function planPairs(pool, { sent = {}, received = {}, pairs = new Set(), n = 3, rng = Math.random, receiveCap = 30, inWindow: open = () => true } = {}) {
  const used = new Set(pairs);
  const recv = { ...received };
  const out = [];
  const senders = pool
    .filter((m) => (m.quota || 0) - (sent[m.email] || 0) > 0 && open(m))
    .map((m) => ({ m, remaining: m.quota - (sent[m.email] || 0), r: rng() }))
    // Client inboxes first (they are the ones being warmed), then most remaining.
    .sort((a, b) => (a.m.isHelper - b.m.isHelper) || (b.remaining - a.remaining) || (a.r - b.r))
    .map((x) => x.m);
  for (const s of senders) {
    if (out.length >= n) break;
    const candidates = pool
      .filter((r) => r.email !== s.email && r.domain !== s.domain && !used.has(pairKey(s.email, r.email)) && (recv[r.email] || 0) < receiveCap)
      .map((r) => ({
        r,
        score: (r.provider !== s.provider ? 4 : 0) + (r.clientId !== s.clientId ? 2 : 0) - (recv[r.email] || 0) * 0.1 + rng() * 0.05,
      }))
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) continue;
    const r = candidates[0].r;
    used.add(pairKey(s.email, r.email));
    recv[r.email] = (recv[r.email] || 0) + 1;
    out.push({ from: s, to: r });
  }
  return out;
}

// ── send ─────────────────────────────────────────────────────────────────────

async function defaultSend(account, mail) {
  const { sendEmail } = await import('@/lib/mailer');
  return sendEmail(account, mail);
}

function accountFor(member) {
  return toAccount(member.record);
}

/** Build + send one marked mail. Returns the mailer result plus the marker. */
export async function sendMarked(fromMember, toMember, { deps = {}, kind = 'w', tag = '', rng = Math.random, subject = null, text = null, inReplyTo = null, references = null } = {}) {
  const account = accountFor(fromMember);
  if (!account) return { success: false, error: 'password cannot be decrypted', kind: 'auth' };
  const marker = makeMarker(kind, tag);
  let msg;
  if (text) msg = { subject, text, html: `<p>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` };
  else msg = composeWarmup(rng, { toName: toMember.record?.displayName, fromName: fromMember.record?.displayName });
  const html = `${msg.html}<span data-w="${marker}" style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden"></span>`;
  const send = deps.send || defaultSend;
  const res = await send(account, {
    to: toMember.email,
    subject: subject || msg.subject,
    text: msg.text,
    html,
    headers: { [MARKER_HEADER]: marker },
    transactional: true,
    noTrack: true,
    ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
  });
  return { ...res, marker };
}

async function onSendFailure(member, res, now) {
  await statBump(member.email, 'errors', 1, now);
  const errs = (await statsFor(member.email, dayKeyIn(ET, now))).errors || 0;
  await logEvent(member.isHelper ? null : member.clientId, 'warmup', 'send_failed', { email: member.email, kind: res.kind, error: res.error });
  if (res.kind === 'auth') {
    await patchMember(member, member.isHelper ? { health: 'auth_failed', healthAt: now.toISOString() } : { warmupHealth: 'auth_failed', warmupHealthAt: now.toISOString() });
    if (member.isHelper) {
      await alertOwner('helper_unhealthy', { scope: member.email, vars: { email: member.email }, body: `The helper ${member.email} refused the login (${res.error}).`, did: 'It is out of the warm-up circle until you re-enter its app password on /mc/warmup.' });
    } else {
      await alertOwner('inbox_auth_fail', { clientId: member.clientId, scope: `${member.clientId}:${member.email}`, vars: { email: member.email }, body: `Warm-up could not log in to ${member.email}: ${res.error}`, did: 'Warm-up for this inbox keeps retrying; nothing else changed.' });
    }
    return;
  }
  const limit = await cfg(null, 'BUILD.warmupErrorAlert');
  if (errs >= limit) {
    await alertOwner('warmup_errors', { clientId: member.isHelper ? null : member.clientId, scope: member.email, vars: { email: member.email }, body: `${errs} warm-up sends from ${member.email} failed today. Last error: ${res.error}`, did: 'The engine keeps pairing other inboxes; this one retries next run.' });
  }
}

/**
 * The `warmup` job: up to BUILD.warmupPairsPerTick sends.
 */
export async function runWarmupSend({ now = new Date(), deadline = Date.now() + 15_000, clients = null, deps = {} } = {}) {
  if (!markerSecret()) {
    await alertOwner('config_missing', { scope: 'warmup-secret', vars: { key: 'WARMUP_SECRET (or ENC_KEY)' }, body: 'Warm-up mails cannot be marked without a secret, so warm-up is not sending.', did: 'Warm-up is paused until the secret is set.' });
    return { sent: 0, skipped: 'no_secret' };
  }
  const pool = await getPool({ now, clients });
  if (pool.length < 2) return { sent: 0, pool: pool.length };
  const day = dayKeyIn(ET, now);
  const hours = await cfg(null, 'BUILD.warmupHours');
  const n = await cfg(null, 'BUILD.warmupPairsPerTick');
  const receiveCap = await cfg(null, 'BUILD.warmupReceiveCap');
  const pairsRaw = (await kv.hgetall(K.warmupPair(day))) || {};
  const sent = {};
  const received = {};
  for (const m of pool) {
    const s = await statsFor(m.email, day);
    sent[m.email] = s.sent || 0;
    received[m.email] = s.received || 0;
  }
  const rng = deps.rng || Math.random;
  const plan = planPairs(pool, { sent, received, pairs: new Set(Object.keys(pairsRaw)), n, rng, receiveCap, inWindow: (m) => inWindow(m.tz || ET, hours, now) });
  const done = [];
  for (const { from, to } of plan) {
    if (Date.now() > deadline - 4000) break;
    // Hard ceiling, re-checked right before the send (SPEC §14.8).
    if ((sent[from.email] || 0) >= Math.min(from.quota, HARD_WARMUP_CAP)) continue;
    // Reserve the pair first so a racing run cannot repeat it.
    const pk = pairKey(from.email, to.email);
    const claimed = await kv.hsetnx(K.warmupPair(day), pk, now.toISOString());
    await kv.expire(K.warmupPair(day), 3 * 86400);
    if (!(claimed === 1 || claimed === true)) continue;
    let res;
    try {
      res = await sendMarked(from, to, { deps, rng });
    } catch (err) {
      res = { success: false, error: err.message, kind: 'other' };
    }
    if (!res.success) {
      await onSendFailure(from, res, now);
      done.push({ from: from.email, to: to.email, ok: false });
      continue;
    }
    sent[from.email] = (sent[from.email] || 0) + 1;
    await statBump(from.email, 'sent', 1, now);
    await statBump(to.email, 'received', 1, now);
    if (!from.isHelper) await bump(from.clientId, 'warmupSent', 1, now);
    done.push({ from: from.email, to: to.email, ok: true });
  }
  return { pool: pool.length, planned: plan.length, sent: done.filter((d) => d.ok).length, failed: done.filter((d) => !d.ok).length };
}

// ── IMAP read ────────────────────────────────────────────────────────────────

async function defaultImap(account) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: true,
    auth: { user: account.email, pass: account.appPassword },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 25000,
  });
}

/** INBOX, spam and archive folders for this server (special-use aware). */
export async function resolveFolders(client, account) {
  let spam = account.spamFolder || null;
  let archive = null;
  try {
    const list = (await client.list()) || [];
    const junk = list.find((f) => f.specialUse === '\\Junk') || list.find((f) => /^(\[gmail\]\/)?(spam|junk( e-?mail)?|bulk( mail)?)$/i.test(f.path));
    if (junk) spam = junk.path;
    const all = list.find((f) => f.specialUse === '\\All') || list.find((f) => f.specialUse === '\\Archive') || list.find((f) => /^archive$/i.test(f.path));
    if (all) archive = all.path;
  } catch {}
  return { inbox: 'INBOX', spam: spam && spam !== 'INBOX' ? spam : null, archive };
}

const MAX_PER_FOLDER = 40;

/**
 * Process one mailbox for marked mail.
 * mode 'warm'   → warm-up markers: rescue, seen, flag, reply, archive.
 * mode 'canary' → canary markers with this tag: count, rescue, seen, archive.
 * Counts are attributed to the SENDER (placement is the sender's reputation).
 * @returns {{ok, bySender: {email: {inbox, spam, rescued}}, replied, error}}
 */
export async function processMailbox(member, { mode = 'warm', tag = '', now = new Date(), deadline = Date.now() + 15_000, deps = {}, poolByEmail = {} } = {}) {
  const out = { ok: false, member: member.email, found: 0, bySender: {}, replied: 0, archived: 0, error: null };
  const account = accountFor(member);
  if (!account) { out.error = 'password cannot be decrypted'; return out; }
  const client = await (deps.imap || defaultImap)(account);
  const rng = deps.rng || Math.random;
  const flagRate = await cfg(null, 'BUILD.warmupFlagRate');
  const replyRate = await cfg(null, 'WARMUP.replyRate');
  const lookback = await cfg(null, 'BUILD.warmupLookbackHours');
  const since = new Date(now.getTime() - lookback * 3600e3);
  const day = dayKeyIn(ET, now);
  const rescuedIds = new Set();
  const handled = [];
  const tally = (sender, field) => {
    const s = (out.bySender[sender] ||= { inbox: 0, spam: 0, rescued: 0 });
    s[field]++;
  };
  try {
    await client.connect();
    const folders = await resolveFolders(client, account);
    const order = folders.spam ? [folders.spam, folders.inbox] : [folders.inbox];
    for (const folder of order) {
      if (Date.now() > deadline - 3000) break;
      const isSpam = folder === folders.spam;
      let lock;
      try { lock = await client.getMailboxLock(folder); } catch { continue; }
      try {
        const query = { since, header: { [MARKER_KEY]: mode === 'canary' ? `c.${tag}.` : '' } };
        const uids = ((await client.search(query, { uid: true })) || []).slice(-MAX_PER_FOLDER);
        if (!uids.length) continue;
        const msgs = [];
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, headers: [MARKER_KEY, 'message-id', 'references'] }, { uid: true })) msgs.push(msg);
        for (const msg of msgs) {
          const headers = parseHeaderBlock(msg.headers);
          const marker = verifyMarker(headers[MARKER_KEY]);
          if (!marker) continue;
          if (mode === 'warm' && marker.kind !== 'w') continue;
          if (mode === 'canary' && (marker.kind !== 'c' || marker.tag !== tag)) continue;
          const msgId = String(msg.envelope?.messageId || headers['message-id'] || marker.nonce).toLowerCase();
          const sender = String(msg.envelope?.from?.[0]?.address || '').toLowerCase();
          if (!sender || sender === member.email) continue;
          if (!isSpam && rescuedIds.has(msgId)) {
            // Rescued earlier in this run: already counted as spam.
          } else if (await kv.sismember(K.warmupDone(day), msgId) || await kv.sismember(K.warmupDone(addDays(day, -1)), msgId)) {
            continue;
          } else {
            tally(sender, isSpam ? 'spam' : 'inbox');
            out.found++;
          }
          if (isSpam) {
            try { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); } catch {}
            // "Not junk" keywords where the server supports them (Yahoo/Outlook/Apple); Gmail learns from the move.
            try { await client.messageFlagsAdd(msg.uid, ['$NotJunk', 'NotJunk'], { uid: true }); } catch {}
            try {
              await client.messageMove(msg.uid, folders.inbox, { uid: true });
              rescuedIds.add(msgId);
              tally(sender, 'rescued');
            } catch {}
            continue;
          }
          const flags = ['\\Seen'];
          if (mode === 'warm' && rng() < flagRate) flags.push('\\Flagged');
          try { await client.messageFlagsAdd(msg.uid, flags, { uid: true }); } catch {}
          if (mode === 'warm' && rng() < replyRate && poolByEmail[sender] && Date.now() < deadline - 5000) {
            const sentToday = (await statsFor(member.email, day)).sent || 0;
            if (sentToday < HARD_WARMUP_CAP) {
              const reply = composeReply(rng, { fromName: member.record?.displayName });
              const subj = String(msg.envelope?.subject || '');
              const res = await sendMarked(member, poolByEmail[sender], { deps, rng, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, text: reply.text, inReplyTo: msg.envelope?.messageId || null, references: [headers.references, msg.envelope?.messageId].filter(Boolean).join(' ') || null }).catch((err) => ({ success: false, error: err.message }));
              if (res.success) {
                out.replied++;
                await statBump(member.email, 'sent', 1, now);
                await statBump(member.email, 'replied', 1, now);
                await statBump(sender, 'received', 1, now);
                if (!member.isHelper) await bump(member.clientId, 'warmupSent', 1, now);
              }
            }
          }
          if (folders.archive) {
            try { await client.messageMove(msg.uid, folders.archive, { uid: true }); out.archived++; } catch {}
          }
          handled.push(msgId);
        }
      } finally {
        try { lock.release(); } catch {}
      }
    }
    out.ok = true;
  } catch (err) {
    out.error = `${err.code ? `${err.code}: ` : ''}${err.message || String(err)}`;
  } finally {
    try { await client.logout(); } catch { try { client.close(); } catch {} }
  }
  if (handled.length) {
    await kv.sadd(K.warmupDone(day), ...handled);
    await kv.expire(K.warmupDone(day), 3 * 86400);
  }
  return out;
}

function parseHeaderBlock(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw) && typeof raw.get !== 'function') {
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const map = {};
  let key = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && key) { map[key] += ` ${line.trim()}`; continue; }
    const i = line.indexOf(':');
    if (i <= 0) { key = null; continue; }
    key = line.slice(0, i).trim().toLowerCase();
    map[key] = line.slice(i + 1).trim();
  }
  return map;
}

/** Write the counts of one processed mailbox to the senders' stats + client counters. */
async function recordLandings(bySender, poolByEmail, now) {
  for (const [sender, c] of Object.entries(bySender)) {
    const m = poolByEmail[sender];
    for (const [field, counter] of [['inbox', 'warmupInbox'], ['spam', 'warmupSpam'], ['rescued', 'warmupRescued']]) {
      if (!c[field]) continue;
      await statBump(sender, field, c[field], now);
      if (m && !m.isHelper) await bump(m.clientId, counter, c[field], now);
    }
  }
}

/**
 * The `warmup-read` job: read at most BUILD.warmupReadPerRun mailboxes whose
 * last read is older than BUILD.warmupReadEveryMin (oldest first).
 */
export async function runWarmupRead({ now = new Date(), deadline = Date.now() + 18_000, clients = null, deps = {} } = {}) {
  if (!markerSecret()) return { skipped: 'no_secret' };
  const pool = await getPool({ now, clients });
  if (!pool.length) return { read: 0 };
  const perRun = await cfg(null, 'BUILD.warmupReadPerRun');
  const everyMin = await cfg(null, 'BUILD.warmupReadEveryMin');
  const readAt = (await kv.hgetall(K.warmupReadAt())) || {};
  const due = pool
    .filter((m) => !readAt[m.key] || now.getTime() - Date.parse(readAt[m.key]) >= everyMin * 60e3)
    .sort((a, b) => String(readAt[a.key] || '').localeCompare(String(readAt[b.key] || '')))
    .slice(0, perRun);
  const poolByEmail = Object.fromEntries(pool.map((m) => [m.email, m]));
  const results = [];
  const touched = new Set();
  for (const m of due) {
    if (Date.now() > deadline - 5000) break;
    await kv.hset(K.warmupReadAt(), { [m.key]: now.toISOString() });
    const r = await processMailbox(m, { mode: 'warm', now, deadline, deps, poolByEmail });
    await recordLandings(r.bySender, poolByEmail, now);
    Object.keys(r.bySender).forEach((s) => touched.add(s));
    await patchMember(m, { lastWarmReadAt: now.toISOString(), lastWarmReadError: r.error || '' , ...(m.isHelper ? { health: r.ok ? 'ok' : 'imap_error', healthAt: now.toISOString() } : {}) });
    if (!r.ok) {
      await logEvent(m.isHelper ? null : m.clientId, 'warmup', 'read_failed', { email: m.email, error: r.error });
      if (m.isHelper) {
        await alertOwner('helper_unhealthy', { scope: m.email, vars: { email: m.email }, body: `Could not read ${m.email} over IMAP: ${r.error}`, did: 'The helper keeps sending; its mailbox is retried next round.' });
      }
    }
    results.push({ email: m.email, ok: r.ok, found: r.found, replied: r.replied });
  }
  // Keep the displayed rate fresh for the senders we just saw.
  for (const email of touched) {
    const m = poolByEmail[email];
    if (!m) continue;
    const { rate } = await inboxRate7d(email, now);
    if (rate != null) await patchMember(m, { inboxRate7d: rate.toFixed(3) });
  }
  return { read: results.length, results };
}

// ── daily readiness ──────────────────────────────────────────────────────────

/**
 * Readiness rule (SPEC §7.1): ready when inboxRate7d ≥ WARMUP.readyRate on
 * WARMUP.readyConsecutiveDays consecutive daily checks and days ≥ 14.
 * Pure: returns the fields to write.
 */
export function readinessUpdate(record, { rate, day, days, readyRate = 0.9, needStreak = 2, minDays = 14 }) {
  if (record.readyCheckedDay === day) {
    return { streak: Number(record.readyStreak) || 0, ready: record.warmupReady === '1', fields: null };
  }
  const prev = Number(record.readyStreak) || 0;
  const consecutive = record.readyCheckedDay && daysBetween(record.readyCheckedDay, day) === 1;
  const pass = rate != null && rate >= readyRate;
  const streak = pass ? (consecutive ? prev + 1 : 1) : 0;
  const ready = streak >= needStreak && days >= minDays;
  return { streak, ready, fields: { readyStreak: String(streak), readyCheckedDay: day, warmupReady: ready ? '1' : '0', inboxRate7d: rate == null ? '' : rate.toFixed(3) } };
}

/**
 * Daily readiness check. `scaled` = the Test Mode run for clients on a scaled
 * clock (their own job, once per virtual day); the normal run skips them so
 * the two day keys never mix.
 */
export async function runWarmupDaily({ now = new Date(), clients = null, scaled = false } = {}) {
  const pool = (await getPool({ now, clients, sync: !scaled })).filter((m) => (m.isHelper ? !scaled : hasScaledClock(m.client) === scaled));
  const day = dayKeyIn(ET, now);
  const readyRate = await cfg(null, 'WARMUP.readyRate');
  const needStreak = await cfg(null, 'WARMUP.readyConsecutiveDays');
  const minDays = await cfg(null, 'BUILD.warmupReadyMinDays');
  const minPool = await cfg(null, 'WARMUP.minPool');
  const out = [];
  for (const m of pool) {
    const { rate, inbox, spam } = await inboxRate7d(m.email, now);
    if (m.isHelper) {
      if (rate != null) await patchMember(m, { inboxRate7d: rate.toFixed(3) });
      continue;
    }
    const u = readinessUpdate(m.record, { rate, day: m.client ? dayKeyIn(ET, clientNow(m.client, now)) : day, days: m.days, readyRate, needStreak, minDays });
    if (u.fields) await patchMember(m, u.fields);
    out.push({ email: m.email, clientId: m.clientId, rate, inbox, spam, streak: u.streak, ready: u.ready });
  }
  if (!scaled && pool.length < minPool) {
    await alertOwner('warmup_pool_small', { scope: 'pool', vars: { count: pool.length, min: minPool }, body: `The warm-up circle has ${pool.length} working members; the spec needs at least ${minPool} (helpers + trial inboxes).`, did: 'Warm-up keeps running with what exists; add helper accounts on /mc/warmup.' });
  }
  return { pool: pool.length, inboxes: out };
}

/** Warm-up readiness of one client's inboxes (for the warming → ready gate). */
export async function inboxesReady(clientId) {
  const recs = (await getInboxRecords(clientId)).filter((r) => r.passwordEnc);
  if (!recs.length) return { ok: false, inboxes: [], reason: 'no inboxes' };
  const inboxes = recs.map((r) => ({ email: r.email, ready: r.warmupReady === '1', rate: r.inboxRate7d === '' || r.inboxRate7d == null ? null : Number(r.inboxRate7d), streak: Number(r.readyStreak) || 0 }));
  return { ok: inboxes.every((i) => i.ready), inboxes };
}

/** Everything /mc/warmup shows. Never includes passwords. */
export async function poolStatus({ now = new Date() } = {}) {
  const day = dayKeyIn(ET, now);
  const pool = await getPool({ now });
  const readAt = (await kv.hgetall(K.warmupReadAt())) || {};
  const members = [];
  for (const m of pool) {
    const s = await statsFor(m.email, day);
    const { rate } = await inboxRate7d(m.email, now);
    members.push({ email: m.email, clientId: m.clientId, provider: m.provider, isHelper: m.isHelper, days: m.days, quota: m.quota, sentToday: s.sent || 0, receivedToday: s.received || 0, errorsToday: s.errors || 0, inboxRate7d: rate, ready: m.record.warmupReady === '1', health: m.isHelper ? m.record.health || 'new' : m.record.warmupHealth || 'ok', lastReadAt: readAt[m.key] || null, lastReadError: m.record.lastWarmReadError || '' });
  }
  const helpers = (await getHelpers()).map(({ passwordEnc, ...h }) => ({ ...h, hasPassword: Boolean(passwordEnc) }));
  const pairs = Object.entries((await kv.hgetall(K.warmupPair(day))) || {}).map(([k, at]) => ({ pair: k, at }));
  return { day, members, helpers, pairs, minPool: await cfg(null, 'WARMUP.minPool') };
}
