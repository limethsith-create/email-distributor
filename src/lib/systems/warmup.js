/**
 * Warm-up Engine (SPEC §7.1). Builds sending reputation for new inboxes with
 * our own circle of mailboxes instead of a paid warm-up network (research:
 * no free external network can be connected automatically in 2026 —
 * docs/research/v2-deliverability.md §1).
 *
 * Pool = every inbox of a client in warming..converted + the aviance client's
 * own inboxes when WARMUP.includeAviance (default on) + the helper accounts
 * (warmup:helper:{email}, clientId `_helper`, free Gmail / Yahoo / AOL /
 * iCloud / GMX / WEB.DE / Yandex — presets in smtp-providers.js).
 *
 * Quota: the WARMUP.quota ramp table by days since warmupStartedAt; once the
 * client is sending, at least WARMUP.sendingShare (~1/3) of the inbox's cold
 * cap; minus what an owner-managed external network sends
 * (EXTERNAL_WARMUP.perDay); never above 15 (HARD_WARMUP_CAP).
 *
 * Pairing: trial inboxes send first, then aviance, then helpers; a receiver
 * from another filter family (Google / Yahoo+AOL / Apple / GMX / Yandex …)
 * scores highest, another client next.
 *
 * Replies carry the quoted original (rebuilt from the indices in the signed
 * marker, no body download) and threads stop at WARMUP_V2.maxThreadDepth.
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
 *
 * The hub (docs/WARMUP-HUB.md): a helper is saved only after its SMTP and
 * IMAP logins worked (`addHelper`, through io.smtpVerify / io.imapLogin);
 * `testHelper` re-tests one; `circleOf` / `helperView` / `helperProviders`
 * are the plain blocks of GET /api/mc/warmup; `warmupView` is a trial's
 * warm-up card; `helpersAlert` tells the owner (once a day) while a trial
 * waits for the circle to reach WARMUP.minPool.
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, HARD_WARMUP_CAP } from '@/lib/config';
import { getAllClients, WARMUP_STATES, SENDING_STATES } from '@/lib/db/client';
import { getInboxRecords, patchInbox, toAccount } from '@/lib/db/inboxes';
import { bump } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { clientNow, hasScaledClock } from '@/lib/testclock';
import { alertOwner } from '@/lib/notify';
import { encrypt, hasEncKey } from '@/lib/crypto';
import { io } from '@/lib/systems/intake-io';
import { PROVIDERS, HELPER_PROVIDERS, providerForAddress, familyOf, providerLabel } from '@/lib/smtp-providers';
import { ET, dayKeyIn, daysBetween, addDays, inWindow } from '@/lib/time';
import { composeWarmup, composeReply, renderWarmup, renderReply, encodeWarmMeta, decodeWarmMeta } from '@/lib/templates/warmup';

export const HELPER = '_helper';
export const AVIANCE = 'aviance';
export const MARKER_HEADER = 'X-Aviance-Warm';
const MARKER_KEY = MARKER_HEADER.toLowerCase();
const EXCLUDED_CLIENTS = new Set([AVIANCE, HELPER]);
/** Trial inboxes count warm-up in the client's counters; aviance and helpers only in warmup:stats. */
const countsForClient = (m) => !m.isHelper && !m.isAviance;

// ── marker ───────────────────────────────────────────────────────────────────

function markerSecret() {
  return process.env.WARMUP_SECRET || process.env.ENC_KEY || process.env.CRON_SECRET || '';
}

function sign(nonce, secret = markerSecret()) {
  return crypto.createHmac('sha256', secret).update(`aviance-warm:${nonce}`).digest('hex').slice(0, 32);
}

/**
 * New marker value. kind 'w' = warm-up (tag = optional build metadata,
 * `encodeWarmMeta`), 'c' = canary (tag = `{clientId}.{day}`).
 * Throws when no secret is configured (the caller alerts config_missing).
 */
export function makeMarker(kind = 'w', tag = '') {
  const secret = markerSecret();
  if (!secret) throw new Error('no WARMUP_SECRET / ENC_KEY to sign warm-up markers');
  const rand = crypto.randomBytes(6).toString('hex');
  const meta = String(tag || '').replace(/[^a-z0-9]/gi, '');
  const nonce = kind === 'c' ? `c.${tag}.${rand}` : `w.${rand}${meta ? `.${meta}` : ''}`;
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
  // w.{rand} (v1) or w.{rand}.{meta} (v2: how the mail was built, for quoting)
  return { kind: 'w', tag: nonce.split('.').slice(2).join('.'), nonce };
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

/**
 * Add or replace a helper account (password encrypted at rest). `provider`
 * defaults to the preset of the address's own domain (yahoo.com → yahoo),
 * else google. `imapUser` overrides the IMAP login name (iCloud uses the part
 * before the @ by default).
 */
export async function saveHelper({ email, password, displayName, provider = null, imapUser = null, testedAt = null }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr.includes('@')) throw new Error('invalid helper email');
  const prov = provider && PROVIDERS[provider] ? provider : (providerForAddress(addr) || 'google');
  const p = PROVIDERS[prov];
  const user = imapUser ? String(imapUser).trim() : p.imapUser === 'local' ? addr.split('@')[0] : '';
  const rec = {
    email: addr,
    clientId: HELPER,
    displayName: String(displayName || addr.split('@')[0]).trim(),
    provider: prov,
    smtpHost: p.smtp.host,
    smtpPort: p.smtp.port,
    imapHost: p.imap.host,
    imapPort: p.imap.port,
    enabled: '1',
    // Saved after a login test that worked (addHelper): healthy from the start.
    health: testedAt ? 'ok' : 'new',
    problem: '',
    updatedAt: new Date().toISOString(),
    ...(testedAt ? { healthAt: new Date(testedAt).toISOString(), lastOkAt: new Date(testedAt).toISOString() } : {}),
    ...(user ? { imapUser: user } : {}),
  };
  if (password) rec.passwordEnc = encrypt(String(password).replace(/\s+/g, ''));
  clearHelperMemo();
  await kv.hset(K.warmupHelper(addr), rec);
  await kv.sadd(K.warmupPool(), memberKey(HELPER, addr));
  await logEvent(null, 'warmup', 'helper_saved', { email: addr, provider: prov, passwordChanged: Boolean(password) });
  return rec;
}

export async function removeHelper(email) {
  const addr = String(email || '').trim().toLowerCase();
  clearHelperMemo();
  await kv.srem(K.warmupPool(), memberKey(HELPER, addr));
  await kv.del(K.warmupHelper(addr));
  await logEvent(null, 'warmup', 'helper_removed', { email: addr });
}

// Helper records change only from /mc/warmup; a warm instance reuses them for
// a minute (CFG_MEMO_MS) instead of one read per helper per warm-up run.
let helperMemo = null;
export function clearHelperMemo() { helperMemo = null; }

export async function getHelpers() {
  const ms = Number(process.env.CFG_MEMO_MS ?? 60_000);
  if (ms > 0 && helperMemo && helperMemo.exp > Date.now()) return helperMemo.value.map((h) => ({ ...h }));
  const value = await loadHelpers();
  if (ms > 0) helperMemo = { value, exp: Date.now() + ms };
  return value.map((h) => ({ ...h }));
}

async function loadHelpers() {
  const members = ((await kv.smembers(K.warmupPool())) || []).filter((m) => m.startsWith(`${HELPER}|`));
  const out = [];
  for (const m of members) {
    const rec = await kv.hgetall(K.warmupHelper(m.split('|')[1]));
    if (rec && rec.email) out.push(rec);
  }
  return out;
}

async function patchMember(member, fields) {
  if (member.isHelper && 'health' in fields && fields.health !== member.record?.health) clearHelperMemo();
  if (member.isHelper) await kv.hset(K.warmupHelper(member.email), { ...fields, updatedAt: new Date().toISOString() });
  else await patchInbox(member.clientId, member.email, fields);
  Object.assign(member.record, fields);
}

/**
 * Daily warm-up quota of one inbox (pure).
 *  - the ramp table by warm-up age (days since warmupStartedAt);
 *  - once the client sends: at least `share` × the inbox's cold cap (the
 *    owner's "keep a permanent warm-up baseline at ~1/3 of volume");
 *  - minus what an owner-managed external network sends for it (`external`);
 *  - never above HARD_WARMUP_CAP (15), never below 0.
 */
export function inboxQuota({ days, table, sending = false, dailyCap = null, share = 0, external = 0 }) {
  let q = warmupQuota(days, table);
  const cap = Number(dailyCap);
  if (sending && q > 0 && Number.isFinite(cap) && cap > 0 && share > 0) q = Math.max(q, Math.ceil(cap * share));
  q = Math.min(q, HARD_WARMUP_CAP - Math.max(0, Number(external) || 0));
  return Math.max(0, Math.min(HARD_WARMUP_CAP, q));
}

/** A settings group read key by key, so an override of one dotted key counts. */
async function group(prefix, keys) {
  const vals = await Promise.all(keys.map((k) => cfg(null, `${prefix}.${k}`)));
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

async function quotaSettings() {
  const ext = await group('EXTERNAL_WARMUP', ['name', 'perDay']);
  return {
    table: await cfg(null, 'WARMUP.quota'),
    share: Number(await cfg(null, 'WARMUP.sendingShare')) || 0,
    external: ext.name && Number(ext.perDay) > 0 ? Math.min(HARD_WARMUP_CAP, Number(ext.perDay)) : 0,
    helperQuota: Math.min(HARD_WARMUP_CAP, await cfg(null, 'BUILD.warmupHelperQuota')),
    includeAviance: Boolean(await cfg(null, 'WARMUP.includeAviance')),
  };
}

function baseMember(clientId, rec, extra = {}) {
  const provider = rec.provider || 'google';
  return { key: memberKey(clientId, rec.email), clientId, email: rec.email, provider, family: familyOf(provider), label: providerLabel(provider, rec.email), domain: domainOf(rec.email), tz: rec.tz || ET, isHelper: false, isAviance: false, record: rec, ...extra };
}

/**
 * Every pool member with its quota. Keeps warmup:pool in step with client
 * states (client inboxes leave the circle when the client leaves warm-up).
 */
export async function getPool({ now = new Date(), clients = null, sync = true } = {}) {
  const q = await quotaSettings();
  const all = clients || (await getAllClients());
  const members = [];
  for (const c of all) {
    if (EXCLUDED_CLIENTS.has(c.id) || !WARMUP_STATES.has(c.state)) continue;
    const sending = SENDING_STATES.has(c.state) || c.state === 'paused';
    for (const rec of await getInboxRecords(c.id)) {
      if (!rec.passwordEnc || rec.warmupEnabled === '0' || !rec.warmupStartedAt) continue;
      // Warm-up age on the client's own clock (Test Mode runs `_test` scaled).
      const days = warmupDays(rec, clientNow(c, now));
      const quota = inboxQuota({ days, table: q.table, sending, dailyCap: rec.dailyCap, share: q.share, external: q.external });
      members.push(baseMember(c.id, rec, { client: c, days, quota }));
    }
  }
  // The owner's own outreach inboxes (Redis-stored; env-only accounts are not
  // in the circle). They warm like a 15+ day inbox unless they carry their own
  // warmupStartedAt; a login failure takes one out until it is retried.
  const aviance = q.includeAviance ? all.find((c) => c.id === AVIANCE && c.state !== 'deleted') : null;
  if (aviance) {
    for (const rec of await getInboxRecords(AVIANCE).catch(() => [])) {
      if (!rec.passwordEnc || rec.warmupEnabled === '0' || rec.warmupHealth === 'auth_failed') continue;
      const days = rec.warmupStartedAt ? warmupDays(rec, now) : null;
      const quota = days == null ? q.helperQuota : inboxQuota({ days, table: q.table, sending: true, dailyCap: rec.dailyCap, share: q.share });
      members.push(baseMember(AVIANCE, rec, { client: aviance, days, quota, isAviance: true }));
    }
  }
  for (const rec of await getHelpers()) {
    if (!rec.passwordEnc || rec.enabled === '0' || rec.health === 'auth_failed') continue;
    members.push(baseMember(HELPER, rec, { isHelper: true, days: null, quota: q.helperQuota }));
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
  const day = dayKeyIn(ET, now);
  const key = K.warmupStats(email, day);
  const v = await kv.hincrby(key, field, n);
  if (Number(v) === n) await kv.expire(key, 30 * 86400);
  // Day roll-up of sent/received for every member in one hash, so a warm-up
  // run reads one key instead of one per pool member (Redis budget).
  if (field === 'sent' || field === 'received') {
    const dk = K.warmupDayStats(day);
    const t = await kv.hincrby(dk, `${String(email).toLowerCase()}|${field}`, n);
    if (Number(t) === n) await kv.expire(dk, 3 * 86400);
  }
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

/** Sender order: trial inboxes (being warmed) first, then aviance, then helpers. */
const rankOf = (m) => (m.isHelper ? 2 : m.isAviance ? 1 : 0);
const famOf = (m) => m.family || familyOf(m.provider);

/**
 * Choose up to `n` sender → receiver pairs.
 * @param pool      members ({email, domain, provider, family, clientId, isHelper, isAviance, quota})
 * @param sent      {email: sentToday}
 * @param received  {email: receivedToday}
 * @param pairs     Set of pairKey already used today
 * @param inWindow  (member) → boolean (sender's local hours)
 * Receivers: another filter family first (+4: Gmail/Workspace vs Yahoo+AOL vs
 * iCloud vs GMX/WEB.DE …), another client next (+2), the least-loaded last.
 */
export function planPairs(pool, { sent = {}, received = {}, pairs = new Set(), n = 3, rng = Math.random, receiveCap = 30, inWindow: open = () => true } = {}) {
  const used = new Set(pairs);
  const recv = { ...received };
  const out = [];
  const senders = pool
    .filter((m) => (m.quota || 0) - (sent[m.email] || 0) > 0 && open(m))
    .map((m) => ({ m, remaining: m.quota - (sent[m.email] || 0), r: rng() }))
    // Client inboxes first (they are the ones being warmed), then most remaining.
    .sort((a, b) => (rankOf(a.m) - rankOf(b.m)) || (b.remaining - a.remaining) || (a.r - b.r))
    .map((x) => x.m);
  for (const s of senders) {
    if (out.length >= n) break;
    const candidates = pool
      .filter((r) => r.email !== s.email && r.domain !== s.domain && !used.has(pairKey(s.email, r.email)) && (recv[r.email] || 0) < receiveCap)
      .map((r) => ({
        r,
        score: (famOf(r) !== famOf(s) ? 4 : 0) + (r.clientId !== s.clientId ? 2 : 0) - (recv[r.email] || 0) * 0.1 + rng() * 0.05,
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

/**
 * Network seam for the warm-up engine and the canary (SMTP send, IMAP client).
 * Tests replace members (`net.send = …`) so nothing reaches a real server;
 * a per-call `deps` still wins.
 */
export const net = { send: (account, mail) => defaultSend(account, mail), imap: (account) => defaultImap(account) };

/**
 * Connection object for a pool member: the stored record (toAccount) plus the
 * provider preset's folder names and IMAP login name (iCloud: local part).
 */
export function accountFor(member) {
  const account = toAccount(member.record);
  if (!account) return null;
  const preset = PROVIDERS[member.record?.provider] || null;
  if (preset) {
    account.spamFolders = preset.spamFolders || [];
    account.archiveFolders = preset.archiveFolders || [];
  }
  if (member.record?.imapUser) account.imapUser = member.record.imapUser;
  return account;
}

/** Build + send one marked mail. Returns the mailer result plus the marker. */
export async function sendMarked(fromMember, toMember, { deps = {}, kind = 'w', tag = '', rng = Math.random, subject = null, text = null, inReplyTo = null, references = null } = {}) {
  const account = accountFor(fromMember);
  if (!account) return { success: false, error: 'password cannot be decrypted', kind: 'auth' };
  let msg;
  let meta = tag;
  if (text) msg = { subject, text, html: `<p>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>` };
  else {
    msg = composeWarmup(rng, { toName: toMember.record?.displayName, fromName: fromMember.record?.displayName });
    // A new warm-up mail records how it was built, so the reply can quote it.
    if (kind === 'w' && !meta) meta = encodeWarmMeta(msg);
  }
  const marker = makeMarker(kind, meta);
  const html = `${msg.html}<span data-w="${marker}" style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden"></span>`;
  const send = deps.send || net.send;
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
    await patchMember(member, member.isHelper ? { health: 'auth_failed', healthAt: now.toISOString(), problem: '' } : { warmupHealth: 'auth_failed', warmupHealthAt: now.toISOString() });
    if (member.isHelper) {
      const preset = PROVIDERS[member.provider];
      const why = preset && !preset.helper ? ` ${preset.helperNote}` : '';
      await alertOwner('helper_unhealthy', { scope: member.email, vars: { email: member.email }, body: `The helper ${member.email} refused the login (${res.error}).${why}`, did: 'It is out of the warm-up circle until you re-enter its app password on /mc/warmup.' });
    } else if (member.isAviance) {
      await alertOwner('helper_unhealthy', { scope: member.email, vars: { email: member.email }, body: `The aviance inbox ${member.email} refused the warm-up login (${res.error}).`, did: 'It is out of the warm-up circle (your own sending is not touched) until you press Retry on /mc/warmup or re-save its app password.' });
    } else {
      await alertOwner('inbox_auth_fail', { clientId: member.clientId, scope: `${member.clientId}:${member.email}`, vars: { email: member.email }, body: `Warm-up could not log in to ${member.email}: ${res.error}`, did: 'Warm-up for this inbox keeps retrying; nothing else changed.' });
    }
    return;
  }
  const limit = await cfg(null, 'BUILD.warmupErrorAlert');
  if (errs >= limit) {
    await alertOwner('warmup_errors', { clientId: countsForClient(member) ? member.clientId : null, scope: member.email, vars: { email: member.email }, body: `${errs} warm-up sends from ${member.email} failed today. Last error: ${res.error}`, did: 'The engine keeps pairing other inboxes; this one retries next run.' });
  }
}

/**
 * The pool at a glance, written by every warm-up send run (one hash write) so
 * the hub's deliverability view never recomputes the pool.
 */
export function poolSummary(pool, todayPairs, now = new Date()) {
  const providers = {};
  for (const m of pool) providers[m.label || providerLabel(m.provider, m.email)] = (providers[m.label || providerLabel(m.provider, m.email)] || 0) + 1;
  return {
    at: now.toISOString(),
    day: dayKeyIn(ET, now),
    pool: pool.length,
    helpers: pool.filter((m) => m.isHelper).length,
    trial: pool.filter((m) => countsForClient(m)).length,
    aviance: pool.filter((m) => m.isAviance).length,
    families: new Set(pool.map((m) => famOf(m))).size,
    providers,
    todayPairs,
  };
}

async function writeSummary(pool, todayPairs, now) {
  const s = poolSummary(pool, todayPairs, now);
  try { await kv.hset(K.warmupSummary(), { ...s, providers: JSON.stringify(s.providers) }); } catch {}
  return s;
}

/** Last pool summary (one read) → {at, day, pool, helpers, trial, aviance, families, providers, todayPairs} or null. */
export async function readPoolSummary() {
  const raw = (await kv.hgetall(K.warmupSummary())) || null;
  if (!raw || !raw.at) return null;
  let providers = raw.providers;
  if (typeof providers === 'string') { try { providers = JSON.parse(providers); } catch { providers = {}; } }
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return { at: raw.at, day: raw.day || null, pool: n(raw.pool), helpers: n(raw.helpers), trial: n(raw.trial), aviance: n(raw.aviance), families: n(raw.families), providers: providers || {}, todayPairs: n(raw.todayPairs) };
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
  // A trial waits while the circle is under WARMUP.minPool: tell the owner (once a day).
  const minPool = await cfg(null, 'WARMUP.minPool');
  if (pool.length < minPool) await helpersAlert(pool, { now, min: minPool });
  if (pool.length < 2) return { sent: 0, pool: pool.length };
  // Helpers exist to warm client inboxes; with no client in the circle they
  // rest (aviance alone keeps it going only with WARMUP_V2.avianceAlone).
  const avianceAlone = Boolean(await cfg(null, 'WARMUP_V2.avianceAlone'));
  if (!pool.some((m) => countsForClient(m) || (avianceAlone && m.isAviance))) return { sent: 0, skipped: 'no client inbox in the circle' };
  const day = dayKeyIn(ET, now);
  const hours = await cfg(null, 'BUILD.warmupHours');
  const n = await cfg(null, 'BUILD.warmupPairsPerTick');
  const receiveCap = await cfg(null, 'BUILD.warmupReceiveCap');
  const pairsRaw = (await kv.hgetall(K.warmupPair(day))) || {};
  const roll = (await kv.hgetall(K.warmupDayStats(day))) || {};
  const sent = {};
  const received = {};
  for (const m of pool) {
    const e = String(m.email).toLowerCase();
    sent[m.email] = Number(roll[`${e}|sent`]) || 0;
    received[m.email] = Number(roll[`${e}|received`]) || 0;
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
    if (countsForClient(from)) await bump(from.clientId, 'warmupSent', 1, now);
    done.push({ from: from.email, to: to.email, ok: true });
  }
  // Every entry in `done` claimed its pair (sent or failed).
  await writeSummary(pool, Object.keys(pairsRaw).length + done.length, now);
  return { pool: pool.length, planned: plan.length, sent: done.filter((d) => d.ok).length, failed: done.filter((d) => !d.ok).length };
}

// ── IMAP read ────────────────────────────────────────────────────────────────

async function defaultImap(account) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: true,
    auth: { user: account.imapUser || account.email, pass: account.appPassword },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 25000,
  });
}

const SPAM_NAME_RE = /^(\[(gmail|google mail)\]\/)?(spam|junk( ?e-?mail)?|bulk( mail)?|spamverdacht|unerw(ü|ue)nscht)$/i;
const ARCHIVE_NAME_RE = /^(\[(gmail|google mail)\]\/all mail|archive|archiv)$/i;

/**
 * INBOX, spam and archive folders for this server: RFC 6154 special-use flags
 * first (\Junk, \All, \Archive), then the provider preset's names (Yahoo
 * "Bulk", GMX "Spamverdacht", iCloud "Junk" …), then common names.
 */
export async function resolveFolders(client, account) {
  let spam = account.spamFolder || null;
  let archive = null;
  try {
    const list = (await client.list()) || [];
    const byName = (names) => {
      for (const n of names || []) {
        const f = list.find((x) => String(x.path).toLowerCase() === String(n).toLowerCase());
        if (f) return f;
      }
      return null;
    };
    const junk = list.find((f) => f.specialUse === '\\Junk') || byName(account.spamFolders) || list.find((f) => SPAM_NAME_RE.test(f.path));
    if (junk) spam = junk.path;
    const all = list.find((f) => f.specialUse === '\\All') || list.find((f) => f.specialUse === '\\Archive') || byName(account.archiveFolders) || list.find((f) => ARCHIVE_NAME_RE.test(f.path));
    if (all) archive = all.path;
  } catch {}
  return { inbox: 'INBOX', spam: spam && spam !== 'INBOX' ? spam : null, archive };
}

/**
 * The text a warm-up mail carried, rebuilt from the metadata in its marker
 * (no body download). null for v1 markers (no metadata) or an unknown member.
 */
export function quotedTextFor(meta, { reader, sender }) {
  if (!meta || !sender) return null;
  if (meta.kind === 'original') return renderWarmup(meta, { toName: reader?.record?.displayName, fromName: sender.record?.displayName }).text;
  if (meta.kind === 'reply') return renderReply(meta.lineIndex, meta.depth, { fromName: sender.record?.displayName });
  return null;
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
  const client = await (deps.imap || net.imap)(account);
  const rng = deps.rng || Math.random;
  const flagRate = await cfg(null, 'BUILD.warmupFlagRate');
  const replyRate = await cfg(null, 'WARMUP.replyRate');
  const v2 = await group('WARMUP_V2', ['maxThreadDepth', 'deeperReplyShare', 'quoteReplies']);
  const maxDepth = Number(v2.maxThreadDepth) || 4;
  const deeperShare = Number.isFinite(Number(v2.deeperReplyShare)) ? Number(v2.deeperReplyShare) : 0.6;
  const quoteReplies = v2.quoteReplies !== false;
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
          // Threads: a first reply at WARMUP.replyRate, later replies less
          // often, none past WARMUP_V2.maxThreadDepth. The roll is always
          // drawn so the random stream does not depend on the thread depth.
          const meta = mode === 'warm' ? decodeWarmMeta(marker.tag) : null;
          const depth = meta ? meta.depth : 0;
          const roll = mode === 'warm' ? rng() : 1;
          if (mode === 'warm' && depth < maxDepth && roll < (depth === 0 ? replyRate : replyRate * deeperShare) && poolByEmail[sender] && Date.now() < deadline - 5000) {
            const sentToday = (await statsFor(member.email, day)).sent || 0;
            // A trial inbox's replies count against its own ramp quota (3 a day in days 1–3, SPEC §7.1),
            // not only the hard ceiling — a new inbox must not send 7 warm-up emails on its third day.
            // Helpers and the aviance inboxes are old accounts: the ceiling alone.
            const cap = countsForClient(member) && Number.isFinite(Number(member.quota)) ? Math.min(Number(member.quota), HARD_WARMUP_CAP) : HARD_WARMUP_CAP;
            if (sentToday < cap) {
              const other = poolByEmail[sender];
              const quote = quoteReplies ? quotedTextFor(meta, { reader: member, sender: other }) : null;
              const reply = composeReply(rng, { fromName: member.record?.displayName, depth: depth + 1, quote, quoteMeta: { date: msg.envelope?.date || null, name: other.record?.displayName || '', email: sender, tz: member.tz || ET } });
              const subj = String(msg.envelope?.subject || '');
              const res = await sendMarked(member, other, { deps, rng, tag: encodeWarmMeta(reply), subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, text: reply.text, inReplyTo: msg.envelope?.messageId || null, references: [headers.references, msg.envelope?.messageId].filter(Boolean).join(' ') || null }).catch((err) => ({ success: false, error: err.message }));
              if (res.success) {
                out.replied++;
                await statBump(member.email, 'sent', 1, now);
                await statBump(member.email, 'replied', 1, now);
                await statBump(sender, 'received', 1, now);
                if (countsForClient(member)) await bump(member.clientId, 'warmupSent', 1, now);
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
      if (m && countsForClient(m)) await bump(m.clientId, counter, c[field], now);
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
  const avianceAlone = Boolean(await cfg(null, 'WARMUP_V2.avianceAlone'));
  if (!pool.some((m) => countsForClient(m) || (avianceAlone && m.isAviance))) return { read: 0, skipped: 'no client inbox in the circle' };
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
    await patchMember(m, { lastWarmReadAt: now.toISOString(), lastWarmReadError: r.error || '' , ...(m.isHelper ? { health: r.ok ? 'ok' : 'imap_error', healthAt: now.toISOString(), ...(r.ok ? { lastOkAt: now.toISOString(), problem: '' } : {}) } : {}) });
    if (!r.ok) {
      await logEvent(m.isHelper ? null : m.clientId, 'warmup', 'read_failed', { email: m.email, error: r.error });
      if (m.isHelper) {
        await alertOwner('helper_unhealthy', { scope: m.email, vars: { email: m.email }, body: `Could not read ${m.email} over IMAP: ${r.error}`, did: 'The helper keeps sending; its mailbox is retried next round.' });
      }
    }
    results.push({ email: m.email, ok: r.ok, found: r.found, replied: r.replied });
  }
  // inboxRate7d is refreshed by the daily readiness run (and computed live on
  // /mc/warmup); recomputing it here cost 7 reads per sender per run.
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
  const all = await getPool({ now, clients, sync: !scaled });
  const pool = all.filter((m) => (m.isHelper ? !scaled : hasScaledClock(m.client) === scaled));
  const day = dayKeyIn(ET, now);
  const readyRate = await cfg(null, 'WARMUP.readyRate');
  const needStreak = await cfg(null, 'WARMUP.readyConsecutiveDays');
  const minDays = await cfg(null, 'BUILD.warmupReadyMinDays');
  const minPool = await cfg(null, 'WARMUP.minPool');
  const out = [];
  for (const m of pool) {
    const { rate, inbox, spam } = await inboxRate7d(m.email, now);
    if (m.isHelper || m.isAviance) {
      // Helpers and the owner's own inboxes are not gated by readiness.
      if (rate != null) await patchMember(m, { inboxRate7d: rate.toFixed(3) });
      continue;
    }
    const u = readinessUpdate(m.record, { rate, day: m.client ? dayKeyIn(ET, clientNow(m.client, now)) : day, days: m.days, readyRate, needStreak, minDays });
    if (u.fields) await patchMember(m, u.fields);
    out.push({ email: m.email, clientId: m.clientId, rate, inbox, spam, streak: u.streak, ready: u.ready });
  }
  // A trial waiting for the circle gets the plainer warmup_needs_helpers (once a day) instead.
  if (!scaled && waitingClients(all, minPool).length) await helpersAlert(all, { now, min: minPool });
  else if (!scaled && pool.length < minPool) {
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
    members.push({ email: m.email, clientId: m.clientId, provider: m.provider, family: m.family, label: m.label, isHelper: m.isHelper, isAviance: Boolean(m.isAviance), days: m.days, quota: m.quota, sentToday: s.sent || 0, receivedToday: s.received || 0, errorsToday: s.errors || 0, inboxRate7d: rate, ready: m.record.warmupReady === '1', health: m.isHelper ? m.record.health || 'new' : m.record.warmupHealth || 'ok', lastReadAt: readAt[m.key] || null, lastReadError: m.record.lastWarmReadError || '' });
  }
  // Every helper (switched off and failing ones too), plain for the hub; the old page's fields stay on each.
  const roll = (await kv.hgetall(K.warmupDayStats(day))) || {};
  const helpers = (await getHelpers()).map((h) => helperView(h, { sentToday: roll[`${String(h.email).toLowerCase()}|sent`] }));
  const pairs = Object.entries((await kv.hgetall(K.warmupPair(day))) || {}).map(([k, at]) => ({ pair: k, at }));
  const includeAviance = Boolean(await cfg(null, 'WARMUP.includeAviance'));
  const avianceOut = includeAviance
    ? (await getInboxRecords(AVIANCE).catch(() => [])).filter((r) => r.warmupHealth === 'auth_failed').map((r) => ({ email: r.email, since: r.warmupHealthAt || null }))
    : [];
  const minPool = await cfg(null, 'WARMUP.minPool');
  return {
    // The hub's Settings › Warm-up (docs/WARMUP-HUB.md).
    circle: circleOf(pool, minPool),
    helpers,
    providers: helperProviders(),
    // What /mc/warmup already used.
    day, members, pairs,
    minPool,
    // Pairing across providers needs other filters to pair with (the trial
    // inboxes are Google): the page warns below this many families.
    minFamilies: Number(await cfg(null, 'WARMUP_V2.minFamilies')) || 0,
    summary: poolSummary(pool, pairs.length, now),
    presets: providerPresets(),
    external: await externalStatus(),
    aviance: { included: includeAviance, loginFailed: avianceOut },
  };
}

/** Provider presets for the /mc/warmup form (no hosts needed there). */
export function providerPresets() {
  return Object.entries(PROVIDERS)
    .filter(([id]) => !['namecheap', 'custom'].includes(id))
    .map(([id, p]) => ({ id, label: p.label || id, family: p.family || id, helper: Boolean(p.helper), note: p.helperNote || '', setup: p.setup || [], imap: `${p.imap.host}:${p.imap.port}`, smtp: `${p.smtp.host}:${p.smtp.port}`, spam: p.spamFolder }))
    .sort((a, b) => Number(b.helper) - Number(a.helper));
}

export { HELPER_PROVIDERS };

/**
 * The external warm-up network the owner runs by hand (EXTERNAL_WARMUP), or
 * null. None can be connected automatically in 2026 (research §1), so this is
 * only what the owner declared in /mc/config: its name and daily volume, which
 * the circle subtracts from each trial inbox's quota (the 15/day ceiling
 * counts both).
 */
export async function externalStatus() {
  const ext = await group('EXTERNAL_WARMUP', ['name', 'url', 'perDay']);
  if (!ext.name) return null;
  const perDay = Math.max(0, Math.min(HARD_WARMUP_CAP, Number(ext.perDay) || 0));
  return { name: String(ext.name), url: ext.url || null, perDay, status: perDay > 0 ? 'connected' : 'not connected', managedBy: 'owner' };
}

/** Put an aviance inbox whose warm-up login failed back into the circle (Retry on /mc/warmup). */
export async function retryMember(clientId, email) {
  if (clientId === HELPER) {
    clearHelperMemo();
    await kv.hset(K.warmupHelper(email), { health: 'new', healthAt: new Date().toISOString(), problem: '' });
  } else {
    await patchInbox(clientId, email, { warmupHealth: '', warmupHealthAt: new Date().toISOString() });
  }
  await logEvent(clientId === HELPER ? null : clientId, 'warmup', 'member_retry', { email: String(email).toLowerCase() });
}

// ── the hub (docs/WARMUP-HUB.md) ─────────────────────────────────────────────

/** How long "Test and add" / "Test" may take: the SMTP login, then the IMAP login. */
export const HELPER_TEST_MS = 20_000;
/** The IMAP login keeps at least this much of the budget. */
const IMAP_MIN_MS = 8_000;
const NET_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'ENOTFOUND', 'EDNS', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const NET_RE = /\b(ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b|timed? ?out/i;
const AUTH_RE = /auth|password|credential|username|login/i;
const IMAP_OFF_RE = /imap[^.]*\b(disabled|not enabled|is off|turned off|not allowed|not permitted)\b|enable imap|web ?login required|not (enabled|allowed) for (this|your) account/i;

const short = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 140);
const helperName = (p, key) => p?.helperLabel || p?.label || String(key || 'the provider');
const helpersText = (n) => `${n} warm-up helper${n === 1 ? '' : 's'}`;
const pctText = (x) => `${Math.round(x * 100)}%`;

/** A promise that answers {timedOut: true} after `ms` instead of waiting on (and {thrown} instead of throwing). */
function within(run, ms) {
  let t;
  return Promise.race([
    Promise.resolve().then(run).catch((err) => ({ thrown: err })).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms)); }),
  ]);
}

/**
 * Why a helper's login test failed, in the owner's words, per provider (pure).
 * `smtp` = io.smtpVerify's answer ({success, error, code, responseCode}),
 * `imap` = io.imapLogin's ({ok, error, auth}) or null when not tried; either
 * may be {timedOut} / {thrown}. → { kind, reason } — kind wrong_password |
 * imap_off | imap_user | unreachable | other — or null when both logins worked.
 * SMTP took the password when only IMAP refuses it, so the password is right
 * and the mailbox login (IMAP) is what is switched off.
 */
export function helperFailure(provider, { smtp, imap = null }) {
  const p = PROVIDERS[provider] || null;
  const name = helperName(p, provider);
  const pw = p?.passwordLabel || 'app password';
  const secs = HELPER_TEST_MS / 1000;
  if (!smtp || !smtp.success) {
    const x = smtp || {};
    if (x.timedOut) return { kind: 'unreachable', reason: `${name} did not answer within ${secs} seconds — try again in a minute` };
    const code = x.code || x.thrown?.code || null;
    const err = short(x.error || x.thrown?.message);
    if (NET_CODES.has(code) || (!x.responseCode && NET_RE.test(err))) return { kind: 'unreachable', reason: `Could not reach ${name}'s mail server${code ? ` (${code})` : ''} — try again in a minute` };
    if (code === 'EAUTH' || [530, 534, 535].includes(Number(x.responseCode)) || AUTH_RE.test(err)) return { kind: 'wrong_password', reason: p?.wrongPassword || `${name} said the password is wrong — use the ${pw}` };
    return { kind: 'other', reason: `${name} did not accept the sending login${err ? ` (${err})` : ''} — check the address and the ${pw}` };
  }
  if (!imap || imap.ok) return null;
  if (imap.timedOut) return { kind: 'unreachable', reason: `${name} did not open the mailbox within ${secs} seconds — try again in a minute` };
  const err = short(imap.error || imap.thrown?.message);
  if (IMAP_OFF_RE.test(err)) return { kind: 'imap_off', reason: p?.imapOff || `IMAP is off — ${name}: turn on IMAP access in its mail settings, then press Test and add again` };
  if (NET_RE.test(err) && !imap.auth) return { kind: 'unreachable', reason: `Could not reach ${name}'s mailbox server — try again in a minute` };
  if (imap.auth || AUTH_RE.test(err)) {
    if (p?.imapOff) return { kind: 'imap_off', reason: p.imapOff };
    if (p?.imapUser === 'local') return { kind: 'imap_user', reason: `${name} took the password for sending but not for reading mail — if your Apple Account uses another address, enter it as the IMAP user` };
    return { kind: 'other', reason: `${name} took the password for sending but refused the mailbox login (IMAP) — create a new ${pw} and try again` };
  }
  return { kind: 'other', reason: `${name} did not open the mailbox (IMAP)${err ? `: ${err}` : ''} — try again in a minute` };
}

/** Connection object for an address + password on a provider preset (what saveHelper would store). */
function presetAccount(email, password, provider, imapUser = null) {
  const p = PROVIDERS[provider];
  return {
    email, appPassword: password, password, provider,
    smtp: { host: p.smtp.host, port: p.smtp.port, secure: p.smtp.port === 465 },
    imap: { host: p.imap.host, port: p.imap.port },
    spamFolder: p.spamFolder,
    ...(imapUser ? { imapUser } : {}),
  };
}

/**
 * Log in to a helper the way the circle will, sending nothing: SMTP through
 * io.smtpVerify, then IMAP through io.imapLogin, both inside one
 * HELPER_TEST_MS budget. An IMAP user other than the address (iCloud: the
 * part before the @) is tried first, then the full address.
 * → { ok: true, imapUser } | { ok: false, kind, reason }
 */
export async function testHelperLogin(account, { provider = account?.provider, deadline = Date.now() + HELPER_TEST_MS } = {}) {
  const left = () => deadline - Date.now();
  const smtp = await within(() => io.smtpVerify(account), Math.max(1000, left() - IMAP_MIN_MS));
  if (!smtp?.success) return { ok: false, ...helperFailure(provider, { smtp }) };
  const users = [...new Set([account.imapUser || account.email, account.email])];
  let imap = null;
  let user = users[0];
  for (const u of users) {
    if (left() < 1000) { imap = imap || { timedOut: true }; break; }
    user = u;
    imap = await within(() => io.imapLogin({ ...account, imapUser: u }), left());
    // Another login name only helps when this one was refused.
    if (imap?.ok || imap?.timedOut || !(imap?.auth || AUTH_RE.test(String(imap?.error || '')))) break;
  }
  const fail = helperFailure(provider, { smtp, imap });
  if (fail) return { ok: false, ...fail };
  return { ok: true, imapUser: user };
}

/**
 * "Test and add" (POST /api/mc/warmup addHelper): the address and preset
 * checked, then both logins tested; saved (password encrypted, health ok)
 * only when both worked. The machine never creates the account — the owner
 * makes it once at the provider. Never returns the password.
 * → { ok: true, helper } | { ok: false, status, error, kind? }
 */
export async function addHelper({ email, password, provider = null, displayName = null, imapUser = null, force = false } = {}, { now = new Date(), deadline = Date.now() + HELPER_TEST_MS } = {}) {
  if (!hasEncKey()) return { ok: false, status: 503, error: 'ENC_KEY is not set on the server, so passwords cannot be stored safely yet.' };
  const addr = String(email || '').trim().toLowerCase();
  const pass = String(password || '').replace(/\s+/g, '');
  if (!addr || !pass) return { ok: false, status: 400, error: 'email and app password are required' };
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr)) return { ok: false, status: 400, error: `"${addr}" does not look like an email address` };
  const key = provider || providerForAddress(addr) || 'google';
  const preset = PROVIDERS[key];
  if (!preset) return { ok: false, status: 400, error: `Unknown provider "${key}" — pick one of: ${HELPER_PROVIDERS.map((k) => helperName(PROVIDERS[k], k)).join(', ')}` };
  // Free accounts that cannot log in with a password (Outlook.com: OAuth2
  // only since Sep 2024; Zoho / mail.com free: no IMAP) would only fail.
  if (!preset.helper && !force) return { ok: false, status: 400, error: preset.helperNote || `${preset.label || key} cannot be a free helper.` };
  const user = imapUser ? String(imapUser).trim() : preset.imapUser === 'local' ? addr.split('@')[0] : null;
  const res = await testHelperLogin(presetAccount(addr, pass, key, user), { provider: key, deadline });
  if (!res.ok) {
    await logEvent(null, 'warmup', 'helper_test_failed', { email: addr, provider: key, kind: res.kind });
    return { ok: false, status: 400, error: res.reason, kind: res.kind };
  }
  // The login name that worked is kept when it is not the address itself (or iCloud found the full address).
  const keepUser = res.imapUser && (res.imapUser !== addr || preset.imapUser === 'local') ? res.imapUser : null;
  const rec = await saveHelper({ email: addr, password: pass, displayName, provider: key, imapUser: keepUser, testedAt: now });
  return { ok: true, helper: helperView(rec) };
}

/**
 * "Test" on a saved helper (POST /api/mc/warmup testHelper): the same two
 * logins; health, problem and lastOkAt follow. A refused login (wrong
 * password, IMAP off) takes it out of the circle until it passes again; a
 * server that did not answer only notes the problem.
 * → { ok, found, error?, kind?, helper? }
 */
export async function testHelper(email, { now = new Date(), deadline = Date.now() + HELPER_TEST_MS } = {}) {
  const addr = String(email || '').trim().toLowerCase();
  const rec = addr ? await kv.hgetall(K.warmupHelper(addr)) : null;
  if (!rec || !rec.email) return { ok: false, found: false, error: `No warm-up helper ${addr || 'without an address'}` };
  const account = accountFor({ record: rec });
  const res = account
    ? await testHelperLogin(account, { provider: rec.provider, deadline })
    : { ok: false, kind: 'other', reason: 'The stored password cannot be read (ENC_KEY changed?) — remove the helper and add it again' };
  const at = now.toISOString();
  const fields = res.ok
    ? { health: 'ok', healthAt: at, lastOkAt: at, problem: '', ...(res.imapUser && res.imapUser !== (rec.imapUser || rec.email) ? { imapUser: res.imapUser } : {}) }
    : { health: res.kind === 'unreachable' ? 'unreachable' : 'auth_failed', healthAt: at, problem: res.reason };
  clearHelperMemo();
  await kv.hset(K.warmupHelper(addr), { ...fields, updatedAt: at });
  await logEvent(null, 'warmup', res.ok ? 'helper_test_ok' : 'helper_test_failed', { email: addr, provider: rec.provider, kind: res.kind || null });
  const roll = (await kv.hgetall(K.warmupDayStats(dayKeyIn(ET, now)))) || {};
  const helper = helperView({ ...rec, ...fields }, { sentToday: roll[`${addr}|sent`] });
  return res.ok ? { ok: true, found: true, helper } : { ok: false, found: true, error: res.reason, kind: res.kind, helper };
}

/** The plain problem of a helper whose stored health is not ok / new. */
function failingProblem(raw, p, rec) {
  const name = helperName(p, rec.provider);
  if (raw === 'auth_failed') return `${name} refused the login — ${p?.wrongPassword ? p.wrongPassword.replace(/^[^—]*— /, '') : 'make a new app password'}. Add the helper again with it`;
  if (raw === 'imap_error') return `Could not read the mailbox${rec.lastWarmReadError ? ` (${short(rec.lastWarmReadError)})` : ''} — it keeps sending; press Test to see why`;
  if (raw === 'unreachable') return `${name} did not answer the last test — press Test again later`;
  return 'Not working — press Test to see why';
}

/**
 * A helper as the hub shows it: health ok | new | failing | disabled, the
 * problem in plain words, when it last worked, today's sends. The fields
 * /mc/warmup already used stay on it (displayName, enabled, hasPassword,
 * providerOk, providerNote; `state` = the stored health). Never the password.
 */
export function helperView(rec, { sentToday = 0 } = {}) {
  const p = PROVIDERS[rec.provider] || null;
  const raw = rec.health || 'new';
  const off = rec.enabled === '0' || rec.enabled === 0 || rec.enabled === false;
  const health = off ? 'disabled' : raw === 'ok' ? 'ok' : raw === 'new' ? 'new' : 'failing';
  const providerOk = Boolean(p?.helper);
  let problem = null;
  if (health === 'failing') problem = rec.problem || failingProblem(raw, p, rec);
  else if (health === 'disabled') problem = 'Switched off — it trades no emails until you switch it on';
  if (!problem && !providerOk) problem = p?.helperNote || `${rec.provider || 'This provider'} cannot be a free helper`;
  return {
    email: rec.email,
    provider: rec.provider || null,
    providerLabel: helperName(p, rec.provider),
    health,
    lastOkAt: rec.lastOkAt || (raw === 'ok' ? rec.healthAt || null : null),
    problem,
    sentToday: Number(sentToday) || 0,
    displayName: rec.displayName || null,
    enabled: off ? '0' : '1',
    hasPassword: Boolean(rec.passwordEnc),
    providerOk,
    providerNote: providerOk ? '' : (p?.helperNote || ''),
    state: raw,
  };
}

/** The providers a free helper can be made at, with the owner's one-time steps (Settings › Warm-up › Add a helper). */
export function helperProviders() {
  return HELPER_PROVIDERS.map((key) => {
    const p = PROVIDERS[key];
    return { key, label: helperName(p, key), steps: p.setup || [], note: p.helperNote || '', passwordLabel: p.passwordLabel || 'app password' };
  });
}

/**
 * Trials that wait for the circle (pure): in `warming` with an inbox not ready
 * yet, while the circle (`pool`, getPool) is under `min` members.
 */
export function waitingClients(pool, min) {
  if (pool.length >= min) return [];
  const out = new Map();
  for (const m of pool) {
    if (!countsForClient(m) || m.client?.state !== 'warming' || m.record?.warmupReady === '1' || out.has(m.clientId)) continue;
    out.set(m.clientId, { clientId: m.clientId, name: m.client.name || m.clientId });
  }
  return [...out.values()];
}

/** The circle meter (pure): who is in it, how many are missing, and who waits. */
export function circleOf(pool, min) {
  const members = pool.length;
  const missing = Math.max(0, (Number(min) || 0) - members);
  return {
    members,
    helpers: pool.filter((m) => m.isHelper).length,
    clientInboxes: pool.filter((m) => countsForClient(m)).length,
    avianceInboxes: pool.filter((m) => m.isAviance).length,
    min: Number(min) || 0,
    ready: missing === 0,
    missing,
    label: missing ? `${members} of ${min} in the warm-up circle — add ${missing} more helper${missing === 1 ? '' : 's'}` : `${members} in the warm-up circle — enough (at least ${min} needed)`,
    waiting: waitingClients(pool, min),
  };
}

/**
 * warmup_needs_helpers: once a day at most (a day claim on top of the alert
 * dedupe), only while a trial waits for the circle. true when it went out.
 */
export async function helpersAlert(pool, { now = new Date(), min }) {
  const waiting = waitingClients(pool, min);
  if (!waiting.length) return false;
  const day = dayKeyIn(ET, now);
  let claimed = 'OK';
  try { claimed = await kv.set(K.warmupNeedsHelpers(day), now.toISOString(), { nx: true, ex: 2 * 86400 }); } catch {}
  if (claimed !== 'OK') return false;
  const missing = Math.max(1, min - pool.length);
  const names = waiting.map((w) => w.name);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  await alertOwner('warmup_needs_helpers', {
    scope: `helpers:${day}`,
    vars: { helpers: helpersText(missing), members: pool.length, min },
    body: `${who} ${names.length === 1 ? 'is' : 'are'} warming up, but the warm-up circle has only ${pool.length} of the ${min} members it needs.\n\nIn the hub: Settings › Warm-up › Add a helper — make ${helpersText(missing)} (free Gmail, Yahoo, AOL, iCloud, GMX, WEB.DE or Yandex accounts; each provider's steps are shown), then press "Test and add". Helpers are made once and help every client.`,
    did: 'Warm-up keeps going with the members it has; this reminder comes at most once a day while a trial waits.',
    url: '/#settings/warmup',
  });
  await logEvent(null, 'warmup', 'needs_helpers', { members: pool.length, min, waiting: waiting.map((w) => w.clientId) });
  return true;
}

// ── a trial's warm-up card ───────────────────────────────────────────────────

/** States past warm-up whose card still shows how it ended (the decision weeks; the inboxes are back in the circle if they convert). */
const PAST_WARMUP = new Set(['deciding']);
/** States in which a trial's warm-up card shows (null before the inboxes are connected). */
export const WARMUP_VIEW_STATES = new Set(['setup_check', ...WARMUP_STATES, ...PAST_WARMUP]);

/** The rules the card reads (global, like the daily readiness run): readiness, ramp, slide window, circle size. */
export async function warmupHubSettings() {
  const [q, readyRate, need, minDays, maxSlideDays, minPool] = await Promise.all([
    quotaSettings(), cfg(null, 'WARMUP.readyRate'), cfg(null, 'WARMUP.readyConsecutiveDays'), cfg(null, 'BUILD.warmupReadyMinDays'), cfg(null, 'WARMUP.maxSlideDays'), cfg(null, 'WARMUP.minPool'),
  ]);
  return { table: q.table, share: q.share, external: q.external, readyRate: Number(readyRate), need: Math.max(1, Number(need) || 1), minDays: Number(minDays) || 14, maxSlideDays: Math.max(0, Number(maxSlideDays) || 0), minPool: Number(minPool) || 0 };
}

/** What every trial's card shares, read once per board: the rules, today's send roll-up, the circle (when asked). */
export async function hubWarmupData({ now = new Date(), clients = null, circle = true } = {}) {
  const settings = await warmupHubSettings();
  const dayStats = (await kv.hgetall(K.warmupDayStats(dayKeyIn(ET, now))).catch(() => null)) || {};
  const pool = circle ? await getPool({ now, clients, sync: false }) : null;
  return { settings, dayStats, circle: pool ? circleOf(pool, settings.minPool) : null };
}

/**
 * When the slowest inbox should pass the readiness rule (pure). Its day
 * `minDays` from its first warm-up day; later only when the rule's `need`
 * passing daily checks (inbox rate ≥ readyRate) cannot finish by then — the
 * next check is tonight (tomorrow night when today's already ran). null when
 * unknown: no start day, or an inbox under the line (or never measured)
 * whose earliest date is past the Day 1 slide window (`maxSlideDays` after
 * its day `minDays`). rows: [{ start, rate, streak, checkedDay, ready }].
 */
export function estimateReadyBy(rows, { today, readyRate = 0.9, need = 2, minDays = 14, maxSlideDays = 7 }) {
  let latest = null;
  for (const x of rows) {
    if (x.ready) continue;
    if (!x.start) return null;
    const dayN = addDays(x.start, minDays - 1);
    const passing = x.rate != null && x.rate >= readyRate;
    const alive = passing && x.checkedDay && daysBetween(x.checkedDay, today) <= 1;
    const remaining = Math.max(0, need - (alive ? Number(x.streak) || 0 : 0));
    const earliest = addDays(today, x.checkedDay === today ? remaining : Math.max(0, remaining - 1));
    const est = earliest > dayN ? earliest : dayN;
    if (!passing && est > addDays(dayN, maxSlideDays)) return null;
    if (!latest || est > latest) latest = est;
  }
  return latest;
}

const rateOf = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * A trial's warm-up card (pure; docs/WARMUP-HUB.md "Trial detail"): null
 * before the inboxes are connected. `inboxes` = the client's inbox records,
 * `now` = the client's clock, `circle` = circleOf (needed in `warming`),
 * `dayStats` = today's send roll-up, `s` = warmupHubSettings.
 *   status  paused (not started / switched off) · ready (every inbox passed
 *           the readiness rule, or the trial is past warm-up) ·
 *           waiting_for_helpers (warming while the circle is under min) · warming
 *   day     the slowest inbox's warm-up day; inboxRate the lowest 7-day rate
 *   readyBy estimateReadyBy while warming, else null
 */
export function warmupView({ client, inboxes = [], now = new Date(), circle = null, dayStats = {}, s }) {
  const st = client?.state;
  if (!WARMUP_VIEW_STATES.has(st)) return null;
  const connected = (inboxes || []).filter((r) => r && r.email && (r.passwordEnc || r.hasPassword));
  if (!connected.length) return null;
  const today = dayKeyIn(ET, now);
  const warmingState = WARMUP_STATES.has(st) || PAST_WARMUP.has(st);
  const sending = SENDING_STATES.has(st) || st === 'paused';
  const rows = connected.map((r) => {
    const on = warmingState && Boolean(r.warmupStartedAt) && r.warmupEnabled !== '0';
    const day = on ? warmupDays(r, now) : 0;
    return {
      email: r.email,
      day,
      sentToday: Number(dayStats[`${String(r.email).toLowerCase()}|sent`]) || 0,
      quota: on ? inboxQuota({ days: day, table: s.table, sending, dailyCap: r.dailyCap, share: s.share, external: s.external }) : 0,
      inboxRate7d: rateOf(r.inboxRate7d),
      ready: r.warmupReady === '1',
      _rec: r,
      _on: on,
    };
  });
  const on = rows.filter((x) => x._on);
  let status = 'warming';
  if (!on.length) status = 'paused';
  else if (st !== 'warming' || on.every((x) => x.ready)) status = 'ready';
  else if (circle && circle.members < circle.min) status = 'waiting_for_helpers';
  // Before warm-up really runs (the circle is short) every inbox is on day 0 with nothing to send.
  if (status === 'waiting_for_helpers') for (const x of rows) { x.day = 0; x.quota = 0; }
  const minDay = on.length ? Math.min(...on.map((x) => x.day)) : 0;
  const rates = on.map((x) => x.inboxRate7d).filter((x) => x != null);
  const inboxRate = rates.length ? Math.min(...rates) : null;

  const readyBy = status === 'warming'
    ? estimateReadyBy(on.map((x) => ({ start: dayKeyIn(ET, new Date(x._rec.warmupStartedAt)), rate: x.inboxRate7d, streak: x._rec.readyStreak, checkedDay: x._rec.readyCheckedDay || null, ready: x.ready })), { today, readyRate: s.readyRate, need: s.need, minDays: s.minDays, maxSlideDays: s.maxSlideDays })
    : null;
  const reach = inboxRate != null ? ` · ${pctText(inboxRate)} reach the inbox` : '';
  let label;
  if (status === 'paused') label = !warmingState ? 'Warm-up starts when the setup checks pass' : connected.some((r) => r.warmupStartedAt) ? 'Warm-up is switched off for these inboxes' : 'Warm-up has not started yet';
  else if (status === 'ready') label = `Warm-up done${reach}`;
  else if (status === 'waiting_for_helpers') label = `Waiting for warm-up helpers — ${circle.members} of ${circle.min} in the circle, add ${circle.missing} more`;
  else label = `Warming up — day ${minDay} of about ${s.minDays}${reach}`;

  let problem = null;
  const authFail = on.find((x) => x._rec.warmupHealth === 'auth_failed');
  const lagging = on.find((x) => !x.ready && x.inboxRate7d != null && x.inboxRate7d < s.readyRate);
  if (status === 'waiting_for_helpers') problem = `The warm-up circle has ${circle.members} of the ${circle.min} members it needs — add ${helpersText(circle.missing)} in Settings › Warm-up`;
  else if (authFail) problem = `Warm-up could not log in to ${authFail.email} — check its app password`;
  else if (status === 'warming' && lagging) problem = `${lagging.email}: ${pctText(lagging.inboxRate7d)} reach the inbox — it needs ${pctText(s.readyRate)} on ${s.need} day${s.need === 1 ? '' : 's'} in a row${readyBy ? '' : ', so Day 1 waits for it'}`;
  else if (status === 'warming' && !readyBy) problem = 'The inbox rate has not been measured for too long — check the warm-up circle in Settings › Warm-up';

  return {
    status,
    label,
    day: minDay,
    of: s.minDays,
    readyBy,
    inboxRate,
    inboxes: rows.map(({ _rec, _on, ...x }) => x),
    problem,
    helpersNeeded: status === 'waiting_for_helpers' ? circle.missing : 0,
  };
}
