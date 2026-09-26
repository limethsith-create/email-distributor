/**
 * Buy once, the rest sets itself up (docs/AUTO-BUY.md) — the machine side.
 * The owner's words: "When I click purchase on the inboxes and the domains,
 * the system should do all the DKIM / DNS / connecting by itself."
 *
 * The machine NEVER buys anything and never spends money (ext/cheapinboxes.js
 * refuses every such call before it leaves). What it does:
 *  1. The shopping list (`buy`) for a trial in awaiting_purchase: the best
 *     free domain from the existing candidate builder (systems/domains.js
 *     rankCandidates, the Price Scout's own pick first), availability and
 *     the CheapInboxes price from the read-only discovery search, up to
 *     CHEAPINBOXES.alternatives others, the mailboxes with the sender persona
 *     from the onboarding page (senderName → first/last, senderPrefix → two
 *     different lower-case prefixes), and the CheapInboxes order page.
 *  2. Finding the purchase — never from a webhook body: every domain the
 *     account owns is matched to the ONE waiting trial that was shown it
 *     (the list's domain, an alternative, the Price Scout's pick); anything
 *     else is `unmatched` for the owner to link. One domain, one trial.
 *  3. Connecting it: forwarding to the client's website once the domain is
 *     live (once, permanent), each active mailbox's login → the client's
 *     inbox record (encrypted; the shape mailer / warm-up / IMAP read today),
 *     and — all expected inboxes in — the existing setup check and its
 *     existing path to `warming` (warm-up starts on its own).
 *  4. Telling the owner, once each: purchase_found, inboxes_ready,
 *     autobuy_problem (the order failed, stuck past CHEAPINBOXES.stuckHours,
 *     a login missing), purchase_unmatched.
 *
 * The sync is idempotent and takes its truth from the API every time. It runs
 * from the webhook (in after()), the hub's check call, the `autobuy` job and
 * the owner's recheck / link — one at a time (a lock), and at most once per
 * CHEAPINBOXES.checkEveryMinutes unless forced.
 *
 * With no key set nothing here runs: the manual path (buy anywhere, paste the
 * logins on the purchase page) is unchanged.
 *
 * No AI anywhere.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, DEFAULTS } from '@/lib/config';
import { getClient, getAllClients, getProfile, getDomain, setState, updateClient, WARMUP_STATES } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { saveInbox, getInboxRecords } from '@/lib/db/inboxes';
import { hasEncKey } from '@/lib/crypto';
import { io, asObject } from '@/lib/systems/intake-io';
import { rankCandidates } from '@/lib/systems/domains';
import { allowedTlds } from '@/lib/systems/pricescout';
import { startSetupCheck, runSetupCheck } from '@/lib/systems/setupcheck';
import * as ci from '@/lib/ext/cheapinboxes';
import { ackAlerts } from '@/lib/notify';

const SYSTEM = 'autobuy';
/** A webhook may start a sync this often: signed ones every 10 s, unsigned ones every 2 min (they only ever wake the sync). */
export const WAKE = { signedSec: 10, unsignedSec: 120 };
const LOCK_SEC = 90;
const CLAIM_TTL = 400 * 86400;
/** A tick this recent means the setup-check job is running the checks; the sync leaves them to it. */
const HEARTBEAT_FRESH_MS = 5 * 60e3;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
const email = (s) => String(s || '').trim().toLowerCase();
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';
const iso = (d) => d.toISOString();
const hoursSince = (at, now) => { const t = Date.parse(at || ''); return Number.isFinite(t) ? (now.getTime() - t) / 3600e3 : 0; };
const parseJ = (v, fb) => { if (v == null || v === '') return fb; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fb; } };
const arr = (v) => { const a = parseJ(v, []); return Array.isArray(a) ? a : []; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A mistake in what the owner asked for (the route answers with `status` and the message). */
export class AutobuyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ─── settings ────────────────────────────────────────────────────────────────

/** CHEAPINBOXES (one machine-wide block) → safe values. */
export async function autobuySettings() {
  const d = DEFAULTS.CHEAPINBOXES;
  let block = null;
  try { block = await cfg(null, 'CHEAPINBOXES'); } catch {}
  const s = { ...d, ...(block && typeof block === 'object' ? block : {}) };
  const num = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.min(max, n) : def; };
  return {
    provider: s.provider === 'microsoft' ? 'microsoft' : 'google',
    mailboxes: Math.round(num(s.mailboxes, d.mailboxes, 1, 10)),
    stuckHours: num(s.stuckHours, d.stuckHours, 1, 24 * 30),
    orderUrl: /^https:\/\//.test(String(s.orderUrl || '')) ? String(s.orderUrl) : d.orderUrl,
    alternatives: Math.round(num(s.alternatives, d.alternatives, 0, 5)),
    maxSearches: Math.round(num(s.maxSearches, d.maxSearches, 1, 20)),
    refreshHours: num(s.refreshHours, d.refreshHours, 1, 24 * 30),
    credentialsGraceHours: num(s.credentialsGraceHours, d.credentialsGraceHours, 0, 24 * 7),
    checkEveryMinutes: num(s.checkEveryMinutes, d.checkEveryMinutes, 0.5, 60),
    jobEveryMinutes: Math.round(num(s.jobEveryMinutes, d.jobEveryMinutes, 1, 120)),
  };
}

// ─── the trial's record (client:{id}:autobuy) ────────────────────────────────

/** The stored hash, JSON fields parsed. */
export function parseRec(raw = {}) {
  return { ...raw, buy: asObject(raw.buy), shown: arr(raw.shown), mailboxes: arr(raw.mailboxes).filter((m) => m && typeof m === 'object') };
}

export async function readRec(clientId) {
  let raw = {};
  try { raw = (await kv.hgetall(K.autobuy(clientId))) || {}; } catch {}
  return parseRec(raw);
}

async function writeRec(clientId, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
  if (Object.keys(out).length) await kv.hset(K.autobuy(clientId), out);
}

// ─── the shopping list ───────────────────────────────────────────────────────

/** 'Jordan Test' → { firstName: 'Jordan', lastName: 'Test' }; a missing part stays null, never invented. */
export function splitName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: words[0] || null, lastName: words.length > 1 ? words.slice(1).join(' ') : null };
}
const letters = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

/**
 * The mailboxes to buy: the sender's name on each, and `count` different
 * lower-case prefixes — senderPrefix first, then first.last, jlast, firstlast,
 * first.team … ('Jordan Test' + 'jordan' → jordan, jordan.test). No name and
 * no prefix → [] (the hub shows the gap; nothing is invented).
 */
export function personas(profile = {}, domain, count = 2) {
  if (!domain) return [];
  const { firstName, lastName } = splitName(profile?.senderName);
  const f = letters(firstName);
  const l = letters(lastName ? lastName.split(/\s+/).pop() : '');
  const own = String(profile?.senderPrefix || '').toLowerCase().replace(/[^a-z.]/g, '').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  const first = own || f;
  if (!first) return [];
  const pool = [first, f && l ? `${f}.${l}` : null, f && l ? `${f[0]}${l}` : null, f && l ? `${f}${l}` : null, f && f !== first ? f : null,
    `${first}.team`, `${first}.hq`, `${first}.mail`, `hello.${first}`, `${first}.office`, ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => `${first}${i}`)];
  const prefixes = [...new Set(pool.filter((p) => p && p.length >= 2 && p.length <= 40))].slice(0, count);
  return prefixes.map((prefix) => ({ firstName, lastName, prefix, email: `${prefix}@${domain}` }));
}

/**
 * Domains to try, best first: the owner's own pick of an alternative, the
 * Price Scout's pick and offers (he may have seen them already), then the
 * ranked builder. Only allowed TLDs; each once.
 */
export function candidateOrder(ranked = [], shopping = {}, tlds = [], pinned = null) {
  const allowed = new Set(tlds);
  const ok = (d) => DOMAIN_RE.test(d) && allowed.has(d.split('.').slice(1).join('.'));
  const offers = arr(shopping?.offers).map((o) => o?.domain);
  return [...new Set([pinned, shopping?.chosenDomain, ...offers, ...ranked.map((c) => c.domain)].map(norm).filter(Boolean).filter(ok))];
}

/**
 * The first `max` names CheapInboxes says are free, in `order`: [{ domain,
 * price }]. `strict`: null while a name before them is not known yet (a
 * better name might still be free), so the search goes on. Pure.
 */
export function pickDomains(order, avail, max, { strict = false } = {}) {
  const out = [];
  for (const d of order) {
    if (out.length >= max) break;
    const a = avail[d];
    if (!a) { if (strict) return null; continue; }
    if (a.available === true) out.push({ domain: d, price: a.price ?? null });
  }
  return out;
}

/** The `buy` object (docs/AUTO-BUY.md) from the picked names, or null when none is free. Pure. */
export function buyFrom(picked, profile, s, { now = null, currency = 'USD' } = {}) {
  if (!picked?.length) return null;
  const [top, ...rest] = picked;
  return {
    domain: top.domain,
    price: top.price,
    currency,
    alternatives: rest.slice(0, s.alternatives).map(({ domain, price }) => ({ domain, price })),
    provider: s.provider,
    mailboxes: personas(profile, top.domain, s.mailboxes),
    orderUrl: s.orderUrl,
    builtAt: now ? iso(now) : null,
  };
}

/** Build (or rebuild) a trial's shopping list with the read-only discovery search. Stores it; returns { buy, searches }. */
export async function buildBuy(clientId, client, { key, s, now = io.now(), deadline = Date.now() + 12000, rec = null } = {}) {
  const [profile, shopping] = await Promise.all([getProfile(clientId), kv.hgetall(K.shopping(clientId)).catch(() => ({}))]);
  const tlds = allowedTlds(await cfg(clientId, 'ALLOWED_TLDS'), await cfg(clientId, 'BANNED_TLDS'));
  const D = await cfg(clientId, 'DOMAINS');
  const ranked = client.mainDomain ? rankCandidates(client.mainDomain, D, tlds) : [];
  const order = candidateOrder(ranked, shopping || {}, tlds, rec?.pinned || null);
  const want = 1 + s.alternatives;
  const avail = {};
  const searched = new Set();
  let searches = 0;
  for (const dom of order) {
    if (pickDomains(order, avail, want, { strict: true })) break; // the best `want` are known
    const label = dom.split('.')[0];
    if (avail[dom] || searched.has(label)) continue;
    if (searches >= s.maxSearches || deadline - Date.now() < 2500) break;
    searched.add(label);
    searches++;
    // One search per label answers every allowed TLD of it (exact) — plus suggestions, used only if they are our own candidates.
    for (const row of await ci.searchDomains(key, label, tlds, { deadline })) if (!avail[row.domain]) avail[row.domain] = row;
    // A TLD the answer left out is not for sale there: known, not free.
    for (const t of tlds) if (!avail[`${label}.${t}`]) avail[`${label}.${t}`] = { domain: `${label}.${t}`, available: false, price: null };
  }
  const picked = pickDomains(order, avail, want);
  const buy = buyFrom(picked, profile, s, { now, currency: picked[0] ? avail[picked[0].domain]?.currency || 'USD' : 'USD' });
  const shown = [...new Set([...(rec?.shown || []), ...(buy ? [buy.domain, ...buy.alternatives.map((a) => a.domain)] : []), ...[shopping?.chosenDomain, ...arr(shopping?.backups)].map(norm).filter(Boolean)])].slice(-40);
  const buyProblem = buy ? '' : !order.length ? 'The client has no main domain to build names from — set it on the trial first.'
    : 'None of the names we tried is free at CheapInboxes — buy one you like there, then link it here.';
  await writeRec(clientId, { buy: buy || '', buyAt: iso(now), buyProblem, shown });
  await logEvent(clientId, SYSTEM, 'shopping_list', { domain: buy?.domain || null, alternatives: buy?.alternatives.length || 0, searches });
  return { buy, searches };
}

const needsBuy = (rec, s, now) => !rec.buyAt || (!rec.buy && hoursSince(rec.buyAt, now) >= 1) || hoursSince(rec.buyAt, now) >= s.refreshHours;

// ─── matching a purchase to a trial ──────────────────────────────────────────

/** Every domain a trial was shown: the list's, its alternatives, the Price Scout's pick and backups. */
export function matchSet(rec = {}, shopping = {}) {
  return new Set([...(rec.shown || []), rec.buy?.domain, ...(rec.buy?.alternatives || []).map((a) => a?.domain), shopping?.chosenDomain, ...arr(shopping?.backups)].map(norm).filter(Boolean));
}

/** The one waiting trial a domain belongs to (not one that unlinked it), else null — two claimants is the owner's call. Pure. */
export function matchDomain(name, waiting, entry = {}) {
  const blocked = new Set(entry?.blocked || []);
  const hits = waiting.filter((w) => !blocked.has(w.id) && w.set.has(name));
  return hits.length === 1 ? hits[0].id : null;
}

// ─── what CheapInboxes says ──────────────────────────────────────────────────

const LIVE = new Set(['active', 'provisioned', 'dns_configured', 'configured', 'ready', 'live', 'completed']);
const FAILED = new Set(['error', 'failed', 'provisioning_failed', 'cancelled', 'canceled', 'expired', 'suspended']);

/** A domain → 'live' | 'failed' | 'provisioning'. Pure. */
export function domainState(d) {
  const s = String(d?.status || '').toLowerCase();
  if (FAILED.has(s) || (d?.provisioning_error && !LIVE.has(s))) return 'failed';
  return LIVE.has(s) ? 'live' : 'provisioning';
}

/** A mailbox → 'active' | 'failed' | 'provisioning'. Pure. */
export function mailboxState(m) {
  const s = String(m?.status || '').toLowerCase();
  if (s === 'active') return 'active';
  return FAILED.has(s) ? 'failed' : 'provisioning';
}

/** The API's mailboxes, carrying what we already knew about each (times first seen / active / connected). */
function mergeMailboxes(prev, rows, now) {
  const byId = new Map(prev.map((m) => [String(m.id), m]));
  return rows.map((r) => {
    const addr = email(r.full_email || r.email);
    const old = byId.get(String(r.id)) || prev.find((m) => m.email === addr) || {};
    const state = mailboxState(r);
    return {
      id: String(r.id), email: addr, state,
      firstName: r.first_name || old.firstName || null, lastName: r.last_name || old.lastName || null,
      provider: r.source_provider || old.provider || null,
      seenAt: old.seenAt || iso(now),
      activeAt: state === 'active' ? old.activeAt || iso(now) : old.activeAt || null,
      connectedAt: old.connectedAt || null,
      credsMissingSince: old.credsMissingSince || null,
    };
  }).filter((m) => m.email.includes('@'));
}

/** 'acme.com' → 'https://acme.com'. */
export const siteUrl = (mainDomain) => `https://${norm(mainDomain)}`;
const sameSite = (a, b) => Boolean(a) && norm(a) === norm(b);

/** The sender name on an inbox: the persona we listed for that address, else the name CheapInboxes has, else the profile's. */
function displayNameFor(m, rec, profile) {
  const p = (rec.buy?.mailboxes || []).find((x) => email(x.email) === m.email);
  const join = (a, b) => [a, b].filter(Boolean).join(' ').trim();
  return join(p?.firstName, p?.lastName) || join(m.firstName, m.lastName) || String(profile?.senderName || '').trim() || m.email.split('@')[0];
}

// ─── owner alerts, each once ─────────────────────────────────────────────────

async function once(clientId, what) {
  try { return (await kv.set(K.onceClaim('cibuy', clientId, what), iso(io.now()), { nx: true, ex: CLAIM_TTL })) === 'OK'; } catch { return true; }
}

const company = (client) => client.name || client.id;

/**
 * Record what is wrong right now (the first, most serious one is shown) and
 * alert each problem once; a run that finds none clears the record.
 */
async function settleProblems(client, rec, problems, ctx) {
  const { now, out } = ctx;
  const id = client.id;
  if (!problems.length) {
    if (rec.problem) { await writeRec(id, { problem: '', problemKind: '', problemAt: '' }); Object.assign(rec, { problem: '', problemKind: '' }); await logEvent(id, SYSTEM, 'problem_cleared', {}); }
    return;
  }
  const top = problems[0];
  if (rec.problem !== top.what || rec.problemKind !== top.kind) {
    await writeRec(id, { problem: top.what, problemKind: top.kind, problemAt: iso(now) });
    Object.assign(rec, { problem: top.what, problemKind: top.kind });
    await logEvent(id, SYSTEM, 'problem', { kind: top.kind, what: top.what });
  }
  out.problems += problems.length;
  for (const p of problems) {
    if (!(await once(id, `problem:${p.kind}:${p.scope}`))) continue;
    await io.alertOwner('autobuy_problem', {
      clientId: id,
      scope: `${id}:${p.kind}:${p.scope}`,
      vars: { what: p.what, domain: rec.domain || '' },
      body: `${p.body}\n\nWhat to do: ${p.fix}`,
      did: 'Nothing was bought, charged or cancelled. The machine keeps looking and carries on by itself once CheapInboxes has it ready.',
    });
  }
}

// ─── the steps after the purchase ────────────────────────────────────────────

/** Link a domain to a trial (the match or the owner's pick): the record, the index entry, the purchase flag, one alert. */
async function linkDomain(client, rec, entry, name, { by, now, s }) {
  const id = client.id;
  Object.assign(entry, { clientId: id, linkedAt: iso(now), linkedBy: by, blocked: (entry.blocked || []).filter((x) => x !== id) });
  delete entry.unlinkedAt;
  const boughtAt = entry.boughtAt || iso(now);
  const fields = { domain: name, domainId: entry.id, linkedAt: iso(now), linkedBy: by, boughtAt, expected: s.mailboxes, problem: '', problemKind: '', problemAt: '' };
  await writeRec(id, fields);
  Object.assign(rec, fields);
  // The purchase is made: the Price Scout's reminders stop (shopping.boughtAt), as after a paste.
  const marked = await kv.hsetnx(K.shopping(id), 'boughtAt', boughtAt);
  if (marked === 1 || marked === true) { await writeRec(id, { boughtMarked: '1' }); rec.boughtMarked = '1'; }
  await updateClient(id, { autobuyOpen: '1' });
  await logEvent(id, SYSTEM, 'linked', { domain: name, by });
  // Bought: the Price Scout's urgent "shopping list" / "still to buy" alerts are handled.
  await ackAlerts(id, ['shopping_list', 'purchase_reminder'], { reason: 'purchase found', now });
  if (await once(id, `found:${name}`)) {
    await io.alertOwner('purchase_found', {
      clientId: id,
      scope: `${id}:${name}`,
      vars: { domain: name, company: company(client) },
      body: `${name} is in your CheapInboxes account${by === 'owner' ? ' and you linked it' : ` — it is on ${company(client)}'s shopping list`}. The machine connects it now: the forwarding to ${client.mainDomain || 'their website'}, the inbox logins, the setup checks, then warm-up. CheapInboxes usually needs up to 48 hours to make the inboxes.`,
      did: `Linked ${name} to ${company(client)}. Nothing for you to do unless another alert says so.`,
    });
  }
}

/**
 * One linked trial, one step further (idempotent): the domain, its
 * forwarding (once), each active inbox's login, stuck / failed checks; all
 * inboxes in → connect.
 */
async function advance(client, rec, ctx) {
  const { key, s, now, deadline } = ctx;
  const id = client.id;
  if (WARMUP_STATES.has(client.state)) return finishReady(client, rec, ctx);
  if (client.state === 'setup_check') return rec.connectedAt ? continueSetup(client, rec, ctx) : null;
  if (client.state !== 'awaiting_purchase') { await updateClient(id, { autobuyOpen: '0' }); return null; }
  if (deadline - Date.now() < 2500) return null;

  const problems = [];
  const dom = await ci.getDomain(key, rec.domainId, { deadline });
  if (!dom) {
    problems.push({ kind: 'gone', scope: rec.domain, what: `${rec.domain} is no longer in your CheapInboxes account`,
      body: `${rec.domain} was linked to ${company(client)}, but CheapInboxes does not list it any more.`,
      fix: `Check the order in CheapInboxes. If it was refunded or removed, buy the domain again (or an alternative) — the machine finds the new purchase by itself — or press "Not this trial" in the hub to unlink ${rec.domain}.` });
    return settleProblems(client, rec, problems, ctx);
  }
  const upd = {};
  const dState = domainState(dom);
  if (String(dom.status || '') !== String(rec.domainStatus || '')) upd.domainStatus = String(dom.status || '');
  if (dState === 'failed') {
    const why = dom.provisioning_error ? `: ${String(asObject(dom.provisioning_error)?.message || dom.provisioning_error).slice(0, 160)}` : '';
    problems.push({ kind: 'failed', scope: rec.domain, what: `The CheapInboxes order for ${rec.domain} failed`,
      body: `CheapInboxes reports ${rec.domain} (for ${company(client)}) as "${dom.status || 'error'}"${why}.`,
      fix: 'Open CheapInboxes → Orders to see what went wrong, or ask their support. If you buy it again (or one of the alternatives), the machine finds the new purchase by itself.' });
  }
  // A failed order: what we knew of its inboxes stays as it was (nothing more will come).
  const list = dState === 'failed' ? [...(rec.mailboxes || [])] : mergeMailboxes(rec.mailboxes || [], await ci.listMailboxes(key, { domainId: rec.domainId, domain: rec.domain, deadline }), now);
  const live = dState === 'live' || list.some((m) => m.state === 'active');
  if (live && !rec.domainLiveAt) upd.domainLiveAt = iso(now);

  // The domain's own web address goes to the client's website — once; after that it is the owner's to change.
  if (live && !rec.forwardingSetAt && client.mainDomain && deadline - Date.now() > 2000) {
    const target = siteUrl(client.mainDomain);
    if (sameSite(dom.forwarding_url, target)) upd.forwardingSetAt = iso(now);
    else {
      const r = await ci.setForwarding(key, rec.domainId, target, { deadline });
      if (r.ok) { Object.assign(upd, { forwardingSetAt: iso(now), forwardingUrl: target }); await logEvent(id, SYSTEM, 'forwarding_set', { domain: rec.domain, to: target }); }
      else await logEvent(id, SYSTEM, 'forwarding_failed', { domain: rec.domain, error: r.error });
    }
  }

  // Each active inbox: its login → the client's inbox record (encrypted), as the purchase page would store it.
  const have = new Set((await getInboxRecords(id)).filter((r) => r.passwordEnc).map((r) => r.email));
  let profile = null;
  for (const m of list) {
    if (m.state === 'failed') {
      problems.push({ kind: 'mailbox_failed', scope: m.email, what: `CheapInboxes could not create ${m.email}`,
        body: `CheapInboxes reports the inbox ${m.email} (${rec.domain}, for ${company(client)}) as failed.`,
        fix: `Open CheapInboxes → Mailboxes and check ${m.email}; ask their support to fix it or add another inbox on ${rec.domain}. The machine connects it by itself once it is active.` });
      continue;
    }
    if (m.state !== 'active') continue;
    if (have.has(m.email)) { m.connectedAt = m.connectedAt || iso(now); continue; }
    if (!hasEncKey()) {
      problems.push({ kind: 'enc_key', scope: 'enc_key', what: 'The inbox logins cannot be stored safely (ENC_KEY is not set)',
        body: `The inboxes on ${rec.domain} are ready, but the server has no ENC_KEY, so their passwords cannot be stored encrypted.`,
        fix: 'Set ENC_KEY in Vercel (docs/PROGRESS.md). The machine connects the inboxes on its next look.' });
      break;
    }
    if (deadline - Date.now() < 2000) break;
    const cred = await ci.getCredentials(key, m.id, { deadline });
    const appPw = String(cred?.app_password || '').replace(/\s+/g, '');
    const pw = String(cred?.password || '');
    if (!cred || (!appPw && !pw)) {
      m.credsMissingSince = m.credsMissingSince || iso(now);
      if (hoursSince(m.credsMissingSince, now) >= s.credentialsGraceHours) {
        problems.push({ kind: 'credentials', scope: m.email, what: `No login came back for ${m.email}`,
          body: `${m.email} is active at CheapInboxes, but its login has not been available for ${Math.round(hoursSince(m.credsMissingSince, now))} hours.`,
          fix: `Open CheapInboxes → Mailboxes → ${m.email} → Credentials. If nothing is shown, ask their support for the login and app password. The machine picks it up by itself.` });
      }
      continue;
    }
    profile = profile || await getProfile(id);
    await saveInbox(id, {
      email: m.email,
      password: appPw || pw, // what SMTP/IMAP log in with: the app password when there is one
      loginPassword: pw || null,
      displayName: displayNameFor(m, rec, profile),
      provider: (m.provider || s.provider) === 'microsoft' ? 'outlook' : 'google',
      smtpHost: cred.smtp_host, smtpPort: cred.smtp_port, imapHost: cred.imap_host, imapPort: cred.imap_port,
      enabled: false,
      extra: { source: 'cheapinboxes', cheapinboxesId: m.id },
    });
    Object.assign(m, { connectedAt: iso(now), credsMissingSince: null });
    have.add(m.email);
    await logEvent(id, SYSTEM, 'inbox_connected', { email: m.email, appPassword: Boolean(appPw) });
  }
  if (JSON.stringify(list) !== JSON.stringify(rec.mailboxes || [])) upd.mailboxes = list;
  const expected = Number(rec.expected) || s.mailboxes;
  if (!rec.inboxesActiveAt && list.filter((m) => m.state === 'active').length >= expected) upd.inboxesActiveAt = iso(now);
  const connectedN = list.filter((m) => m.connectedAt).length;
  const hardFail = problems.some((p) => p.kind === 'failed');
  // Stuck only when nothing more precise was found (a failed order or a missing login says it better).
  if (!problems.length && connectedN < expected && hoursSince(rec.boughtAt || rec.linkedAt, now) >= s.stuckHours) {
    const h = Math.round(hoursSince(rec.boughtAt || rec.linkedAt, now));
    problems.push({ kind: 'stuck', scope: rec.domain, what: `${rec.domain} is still not ready ${h} hours after you bought it`,
      body: `${rec.domain} (for ${company(client)}): ${connectedN} of ${expected} inboxes are in after ${h} hours (CheapInboxes says the domain is "${dom.status || 'unknown'}"; inboxes: ${list.map((m) => `${m.email} ${m.state}`).join(', ') || 'none yet'}).`,
      fix: `Open CheapInboxes and look at ${rec.domain} and its inboxes. If something shows an error or is still provisioning, ask their support (chat on their site). The machine connects everything by itself once it is ready.` });
  }
  if (Object.keys(upd).length) { await writeRec(id, upd); Object.assign(rec, upd); }
  await settleProblems(client, rec, problems, ctx);
  if (!hardFail && connectedN >= expected) return connect(client, rec, dom, ctx);
  return null;
}

/** All expected inboxes in: the domain record, then the existing path — setup_check, the setup checks, warming. */
async function connect(client, rec, dom, ctx) {
  const { now, out } = ctx;
  const id = client.id;
  const shownPrice = rec.buy?.domain === rec.domain ? rec.buy?.price : (rec.buy?.alternatives || []).find((a) => a.domain === rec.domain)?.price;
  await kv.hset(K.domain(id), {
    name: rec.domain,
    registrar: 'cheapinboxes',
    purchasedAt: rec.boughtAt || iso(now),
    ...(Number(shownPrice) > 0 ? { price: Number(shownPrice) } : {}),
    // CheapInboxes' own flag; the setup check passes a CheapInboxes domain either way (it goes with the inboxes).
    autoRenew: dom?.auto_renew === false ? 'false' : String(dom?.auto_renew ?? 'unknown'),
    forwardsTo: client.mainDomain || '',
    cheapinboxesId: rec.domainId,
  });
  await writeRec(id, { connectedAt: iso(now) });
  rec.connectedAt = iso(now);
  let moved = false;
  try { moved = await setState(id, 'setup_check', 'CheapInboxes purchase connected'); } catch (err) {
    await logEvent(id, SYSTEM, 'connect_state_failed', { error: String(err?.message || err).slice(0, 200) });
    return null;
  }
  const n = (rec.mailboxes || []).filter((m) => m.connectedAt).length;
  await logEvent(id, SYSTEM, 'connected', { domain: rec.domain, inboxes: n, moved });
  out.connected.push(id);
  await startSetupCheck(id, { all: true, now });
  return continueSetup({ ...client, state: 'setup_check' }, rec, ctx);
}

/**
 * The setup checks move on without the heartbeat too (the hub's check call,
 * the webhook): a round in progress runs as far as the time allows. With a
 * live heartbeat the setup-check job runs it every minute, so the sync keeps
 * out of its way (no second loopback email).
 */
async function continueSetup(client, rec, ctx) {
  const { now, deadline } = ctx;
  const d = await getDomain(client.id);
  if (d.setupPhase !== 'running' || deadline - Date.now() < 6000) return null;
  let hb = {};
  try { hb = (await kv.hgetall(K.heartbeat())) || {}; } catch {}
  if (hb.lastTickAt && Date.now() - Date.parse(hb.lastTickAt) < HEARTBEAT_FRESH_MS) return null;
  const r = await runSetupCheck(client.id, { now, deadline });
  if (r.phase === 'passed') return finishReady({ ...client, state: 'warming' }, rec, ctx);
  return null;
}

/** Warm-up has started: inboxes_ready once, and the trial leaves the sync. */
async function finishReady(client, rec, ctx) {
  const { now, out } = ctx;
  const id = client.id;
  if (rec.connectedAt) {
    if (!rec.warmupAt) { await writeRec(id, { warmupAt: iso(now) }); rec.warmupAt = iso(now); }
    if (await once(id, `ready:${rec.domain}`)) {
      const n = (rec.mailboxes || []).filter((m) => m.connectedAt).length || Number(rec.expected) || 2;
      // Warm-up needs WARMUP.minPool members in the circle: with too few helpers, say so instead of "started".
      let short = null;
      try {
        const { getPool } = await import('@/lib/systems/warmup');
        const min = Number(await cfg(null, 'WARMUP.minPool')) || 8;
        const members = (await getPool({ now, sync: false })).length;
        if (members < min) short = { members, min, missing: min - members };
      } catch { short = null; }
      await io.alertOwner('inboxes_ready', {
        clientId: id,
        scope: `${id}:${rec.domain}`,
        vars: { domain: rec.domain, count: n, next: short ? `add ${short.missing} warm-up helper${short.missing === 1 ? '' : 's'} to start warm-up` : 'warm-up has started' },
        body: short
          ? `${rec.domain} and ${n} inboxes for ${company(client)} are bought, connected and checked (SPF, DKIM, DMARC, the logins and a test email). Warm-up needs helpers first: the circle has ${short.members} of the ${short.min} members it needs — add ${short.missing} in the hub, Settings › Warm-up.`
          : `${rec.domain} and ${n} inboxes for ${company(client)} are bought, connected and checked (SPF, DKIM, DMARC, the logins and a test email). Warm-up has started; the first emails go out on Day 1.`,
        did: `Pointed ${rec.domain} at ${client.mainDomain || 'their website'}, stored the logins encrypted, ran the setup checks and started the warm-up.`,
      });
      out.ready.push(id);
    }
  }
  await updateClient(id, { autobuyOpen: '0' });
  return 'ready';
}

async function unmatchedAlert(name, entry, now) {
  if (entry.alertedAt) return;
  entry.alertedAt = iso(now);
  await io.alertOwner('purchase_unmatched', {
    scope: `unmatched:${name}`,
    vars: { domain: name },
    body: `${name} appeared in your CheapInboxes account, but it is on no trial's shopping list, so the machine cannot tell which trial it is for.\n\nIn the hub: Settings › Inboxes & domains → pick the trial next to ${name}. The machine connects it the moment you pick.`,
    did: 'Nothing yet — it waits for your pick.',
    url: '/#settings/inboxes',
  });
}

// ─── the sync ────────────────────────────────────────────────────────────────

/**
 * One check between the trial list and the CheapInboxes account throttled to CHEAPINBOXES.checkEveryMinutes.
 * The key holds the last run's time, so a moved clock (tests) is measured on `now`.
 */
async function claimSync(now, minutes) {
  const windowMs = minutes * 60e3;
  const ex = Math.max(30, Math.round(minutes * 60));
  if ((await kv.set(K.cheapinboxesSync(), iso(now), { nx: true, ex })) === 'OK') return true;
  const last = Date.parse(String((await kv.get(K.cheapinboxesSync())) || ''));
  if (Number.isFinite(last) && now.getTime() >= last && now.getTime() - last < windowMs) return false;
  await kv.set(K.cheapinboxesSync(), iso(now), { ex });
  return true;
}

async function takeLock(now) {
  try { return (await kv.set(K.cheapinboxesLock(), iso(now), { nx: true, ex: LOCK_SEC })) === 'OK'; } catch { return true; }
}
async function releaseLock() { try { await kv.del(K.cheapinboxesLock()); } catch {} }

/** The owner's buttons wait a few seconds for a running sync rather than fail. */
async function withLock(now, fn) {
  for (let i = 0; i < 8; i++) {
    if (await takeLock(now)) {
      try { return await fn(); } finally { await releaseLock(); }
    }
    await sleep(500);
  }
  throw new AutobuyError('A check of CheapInboxes is running — try again in a few seconds.', 409);
}

/**
 * The sync: shopping lists for trials waiting to buy, what the account owns,
 * matching, and each linked trial one step further. → { ok, found, connected,
 * ready, unmatched, problems, skipped?, error? }. Never places an order.
 * `rebuild`: client ids whose shopping list is made again now (recheck).
 */
export async function syncAutobuy({ now = io.now(), deadline = Date.now() + 20000, force = false, reason = 'check', clients = null, rebuild = [] } = {}) {
  const out = { ok: true, found: [], connected: [], ready: [], unmatched: 0, problems: 0 };
  const acct = await ci.readAccount();
  const k = await ci.apiKey(acct);
  if (!k) return { ...out, skipped: 'not_set_up' };
  const s = await autobuySettings();
  if (!force && !(await claimSync(now, s.checkEveryMinutes))) return { ...out, skipped: 'too soon' };
  if (!(await takeLock(now))) return { ...out, skipped: 'busy' };
  try {
    await runSync({ key: k.key, acct, s, now, deadline, out, clients, rebuild: new Set(rebuild) });
  } catch (err) {
    out.ok = false;
    out.error = String(err?.message || err).slice(0, 200);
    if (err?.code === 'refused') await ci.markBroken(err.message, { now });
    await logEvent(null, SYSTEM, 'sync_failed', { reason, error: out.error });
  } finally {
    await releaseLock();
  }
  return out;
}

/** syncAutobuy for after() and the hub's check: never throws. */
export async function syncQuietly(opts = {}) {
  try { return await syncAutobuy(opts); } catch (err) {
    try { await logEvent(null, SYSTEM, 'sync_failed', { reason: opts.reason || 'check', error: String(err?.message || err).slice(0, 200) }); } catch {}
    return { ok: false, error: String(err?.message || err) };
  }
}

async function runSync(ctx) {
  const { key, acct, s, now, deadline, out, rebuild } = ctx;
  const all = (ctx.clients || await getAllClients()).filter((c) => c && c.id !== 'aviance');
  const watched = all.filter((c) => c.state === 'awaiting_purchase' || flag(c.autobuyOpen));
  const recs = new Map();
  for (const c of watched) recs.set(c.id, await readRec(c.id));

  // 1. The shopping list of each trial waiting to buy (made once, refreshed after CHEAPINBOXES.refreshHours).
  for (const c of watched) {
    const rec = recs.get(c.id);
    if (c.state !== 'awaiting_purchase' || rec.domain || !(rebuild.has(c.id) || needsBuy(rec, s, now))) continue;
    if (deadline - Date.now() < 6000) break;
    try {
      await buildBuy(c.id, c, { key, s, now, deadline: Math.min(deadline - 4000, Date.now() + 10000), rec });
      recs.set(c.id, await readRec(c.id));
    } catch (err) {
      if (err?.code === 'refused' || err?.code === 'forbidden') throw err;
      await logEvent(c.id, SYSTEM, 'shopping_list_failed', { error: String(err?.message || err).slice(0, 200) });
    }
  }

  // 2. What the account owns now — the only source of truth.
  const domains = await ci.listDomains(key, { deadline });
  const index = await ci.readDomainIndex();
  const before = JSON.parse(JSON.stringify(index));
  const waiting = [];
  for (const c of watched) {
    const rec = recs.get(c.id);
    if (c.state !== 'awaiting_purchase' || rec.domain) continue;
    let shop = {};
    try { shop = (await kv.hmget(K.shopping(c.id), 'chosenDomain', 'backups')) || {}; } catch {}
    waiting.push({ id: c.id, client: c, set: matchSet(rec, shop) });
  }

  // 3. Match: a domain on exactly one waiting trial's list is that trial's; the rest wait for the owner.
  const seen = new Set();
  const taken = new Set();
  let counted = 0;
  // A trial's own domain before its alternatives (the owner bought both by mistake: the one on the list wins).
  const primary = new Set(waiting.map((w) => norm(recs.get(w.id).buy?.domain)).filter(Boolean));
  const isPrimary = (d) => primary.has(norm(d?.domain || d?.name));
  const ordered = [...domains].sort((a, b) => Number(!isPrimary(a)) - Number(!isPrimary(b)));
  for (const d of ordered) {
    const name = norm(d?.domain || d?.name);
    if (!name || !d?.id) continue;
    seen.add(name);
    const prev = index[name] || {};
    const e = { ...prev, id: String(d.id), status: String(d.status || ''), boughtAt: prev.boughtAt || (d.created_at ? String(d.created_at) : iso(now)), firstSeenAt: prev.firstSeenAt || iso(now) };
    delete e.gone;
    index[name] = e;
    if (e.clientId) continue;
    const who = matchDomain(name, waiting.filter((w) => !taken.has(w.id)), e);
    if (who) {
      const w = waiting.find((x) => x.id === who);
      await linkDomain(w.client, recs.get(who), e, name, { by: 'match', now, s });
      taken.add(who);
      out.found.push({ clientId: who, domain: name });
      continue;
    }
    // The first look after the key is saved: what the account already had is not a new purchase.
    if (!acct.baselineAt) { e.preexisting = true; continue; }
    if (e.preexisting) continue;
    out.unmatched++;
    const listed = Number(d.mailbox_count ?? d.mailboxes_count ?? d.mailboxCount);
    if (Number.isFinite(listed)) e.mailboxes = listed;
    else if (!Number(e.mailboxes) && counted < 3 && hoursSince(e.firstSeenAt, now) < 72 && deadline - Date.now() > 4000) {
      counted++;
      try { e.mailboxes = (await ci.listMailboxes(key, { domainId: e.id, domain: name, deadline })).length; } catch (err) { if (err?.code === 'refused') throw err; }
    }
    await unmatchedAlert(name, e, now);
  }
  for (const [name, e] of Object.entries(index)) if (!seen.has(name) && !e.gone) index[name] = { ...e, gone: true };
  await ci.writeDomainIndex(index, before);
  await kv.hset(K.cheapinboxes(), { lastSyncAt: iso(now), ...(acct.baselineAt ? {} : { baselineAt: iso(now) }) });
  if (acct.brokenAt) await kv.hdel(K.cheapinboxes(), 'brokenAt', 'brokenReason');

  // 4. Each linked trial one step further.
  for (const c of watched) {
    const rec = recs.get(c.id);
    if (!rec.domain) continue;
    if (deadline - Date.now() < 2500) break;
    try {
      await advance(c, rec, ctx);
    } catch (err) {
      if (err?.code === 'refused' || err?.code === 'forbidden') throw err;
      out.ok = false;
      out.error = out.error || String(err?.message || err).slice(0, 200);
      await logEvent(c.id, SYSTEM, 'advance_failed', { error: String(err?.message || err).slice(0, 200) });
    }
  }
}

// ─── the webhook ─────────────────────────────────────────────────────────────

/**
 * A delivery at /api/webhooks/cheapinboxes. Its body is never read: signed or
 * not, it can only ask for a sync, rate-limited per kind (WAKE). → { verified,
 * queued } — the route runs the sync in after() when `queued`.
 */
export async function wakeFromWebhook(raw, headers, { now = io.now() } = {}) {
  const verified = await ci.verifyWebhook(raw, headers);
  let queued = false;
  try {
    queued = (await kv.set(K.cheapinboxesWake(verified ? 'signed' : 'unsigned'), iso(now), { nx: true, ex: verified ? WAKE.signedSec : WAKE.unsignedSec })) === 'OK';
  } catch { queued = false; }
  if (queued) { try { await logEvent(null, SYSTEM, 'webhook', { verified }); } catch {} }
  return { verified, queued };
}

// ─── the owner's buttons (POST /api/mc/clients/{id}/autobuy) ─────────────────

/** recheck | link {domain} | unlink | pick {domain} → the trial's `autobuy` after it (plus `sync` for recheck / link). */
export async function autobuyAction(clientId, body = {}, { now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client) throw new AutobuyError('Client not found.', 404);
  let sync;
  switch (String(body.action || '')) {
    case 'recheck': sync = await recheck(client, { now }); break;
    case 'link': sync = await ownerLink(client, body.domain, { now }); break;
    case 'unlink': await unlink(client, { now }); break;
    case 'pick': await pick(client, body.domain, { now }); break;
    default: throw new AutobuyError('Unknown action — use recheck, link, unlink or pick.');
  }
  return { ok: true, autobuy: await autobuyFor(clientId), ...(sync ? { sync } : {}) };
}

async function requireKey() {
  const k = await ci.apiKey();
  if (!k) throw new AutobuyError("CheapInboxes isn't connected — paste your API key in Settings › Inboxes & domains.", 409);
  return k;
}

/** Look for the purchase now (and make the shopping list again when it is over an hour old). */
async function recheck(client, { now }) {
  await requireKey();
  const rec = await readRec(client.id);
  const again = client.state === 'awaiting_purchase' && !rec.domain && (!rec.buyAt || hoursSince(rec.buyAt, now) >= 1);
  return syncAutobuy({ now, force: true, reason: 'recheck', deadline: Date.now() + 22000, rebuild: again ? [client.id] : [] });
}

/** "This domain is this trial's": any domain in the account nobody has, for a trial waiting to buy. */
async function ownerLink(client, domain, { now }) {
  const name = norm(domain);
  if (!DOMAIN_RE.test(name)) throw new AutobuyError('Enter the domain, e.g. acmeoutreach.com.');
  const k = await requireKey();
  const rec = await readRec(client.id);
  if (rec.domain === name) return syncAutobuy({ now, force: true, reason: 'link', deadline: Date.now() + 22000 });
  if (rec.domain) throw new AutobuyError(`${rec.domain} is already linked to ${company(client)} — unlink it first.`, 409);
  if (client.state !== 'awaiting_purchase') throw new AutobuyError(`${company(client)} is not waiting for a purchase (it is ${client.state}).`, 409);
  const s = await autobuySettings();
  await withLock(now, async () => {
    const index = await ci.readDomainIndex();
    const before = JSON.parse(JSON.stringify(index));
    let e = index[name];
    if (!e?.id) {
      // Bought a moment ago: look at the account now.
      const d = (await ci.listDomains(k.key, { deadline: Date.now() + 10000 })).find((x) => norm(x?.domain || x?.name) === name);
      if (!d?.id) throw new AutobuyError(`${name} is not in your CheapInboxes account yet — buy it there first, or try again in a minute.`, 404);
      e = { ...(e || {}), id: String(d.id), status: String(d.status || ''), boughtAt: d.created_at ? String(d.created_at) : iso(now), firstSeenAt: e?.firstSeenAt || iso(now) };
      index[name] = e;
    }
    if (e.clientId && e.clientId !== client.id) throw new AutobuyError(`${name} is already linked to ${e.clientId}.`, 409);
    const taken = await readRec(client.id);
    if (taken.domain) throw new AutobuyError(`${taken.domain} is already linked to ${company(client)} — unlink it first.`, 409);
    await linkDomain(client, rec, e, name, { by: 'owner', now, s });
    await ci.writeDomainIndex(index, before);
  });
  return syncAutobuy({ now, force: true, reason: 'link', deadline: Date.now() + 22000 });
}

/** Undo a wrong link — only while nothing of it is connected. The domain goes back to `unmatched` and is never matched to this trial again by itself. */
async function unlink(client, { now }) {
  const rec = await readRec(client.id);
  if (!rec.domain) throw new AutobuyError('No domain is linked to this trial.', 409);
  const inboxesIn = (await getInboxRecords(client.id)).some((r) => r.source === 'cheapinboxes');
  if (rec.connectedAt || (rec.mailboxes || []).some((m) => m.connectedAt) || inboxesIn) {
    throw new AutobuyError(`${rec.domain}'s inboxes are already connected to ${company(client)} — it can't be unlinked any more.`, 409);
  }
  await withLock(now, async () => {
    const index = await ci.readDomainIndex();
    const before = JSON.parse(JSON.stringify(index));
    const e = index[rec.domain];
    if (e && e.clientId === client.id) {
      const { clientId, linkedAt, linkedBy, ...rest } = e;
      // alertedAt: the owner is looking at it right now — no "which trial is it for?" alert.
      index[rec.domain] = { ...rest, clientId: null, blocked: [...new Set([...(e.blocked || []), client.id])], unlinkedAt: iso(now), alertedAt: e.alertedAt || iso(now) };
    }
    await ci.writeDomainIndex(index, before);
    await kv.hdel(K.autobuy(client.id), 'domain', 'domainId', 'linkedAt', 'linkedBy', 'boughtAt', 'expected', 'domainStatus', 'domainLiveAt',
      'forwardingSetAt', 'forwardingUrl', 'mailboxes', 'inboxesActiveAt', 'problem', 'problemKind', 'problemAt', 'boughtMarked');
    if (rec.boughtMarked) await kv.hdel(K.shopping(client.id), 'boughtAt');
    await updateClient(client.id, { autobuyOpen: '0' });
    await logEvent(client.id, SYSTEM, 'unlinked', { domain: rec.domain });
  });
}

/** "Buy this alternative instead": it becomes the domain to buy (the old one stays listed, and matched, as an alternative). */
async function pick(client, domain, { now }) {
  const name = norm(domain);
  if (client.state !== 'awaiting_purchase') throw new AutobuyError(`${company(client)} is not waiting for a purchase.`, 409);
  const rec = await readRec(client.id);
  if (rec.domain) throw new AutobuyError(`${rec.domain} is already bought for ${company(client)}.`, 409);
  const buy = rec.buy;
  if (!buy?.domain) throw new AutobuyError('There is no shopping list yet — press Check again in a moment.', 409);
  if (buy.domain === name) return;
  const alt = (buy.alternatives || []).find((a) => a.domain === name);
  if (!alt) throw new AutobuyError(`${name} is not one of the alternatives shown.`);
  const s = await autobuySettings();
  const profile = await getProfile(client.id);
  const next = {
    ...buy,
    domain: alt.domain,
    price: alt.price ?? null,
    alternatives: [{ domain: buy.domain, price: buy.price ?? null }, ...buy.alternatives.filter((a) => a.domain !== name)],
    mailboxes: personas(profile, alt.domain, s.mailboxes),
  };
  await writeRec(client.id, { buy: next, pinned: name, shown: [...new Set([...(rec.shown || []), name, buy.domain])] });
  await logEvent(client.id, SYSTEM, 'picked', { domain: name, instead: buy.domain, at: iso(now) });
}

// ─── the hub's `autobuy` (docs/AUTO-BUY.md "Status for the hub") ────────────

/**
 * The trial's `autobuy` object, a pure function of the stored record, the
 * client, the domain hash and whether a key is set. null while the trial is
 * not at the buying step and never used this path.
 */
export function autobuyView({ client, rec = {}, connected = false, domain = {}, s = DEFAULTS.CHEAPINBOXES, warmup = null } = {}) {
  const st = client?.state;
  const linked = Boolean(rec.domain);
  if (!client || (!linked && st !== 'awaiting_purchase')) return null;
  const n = Number(rec.expected) || rec.buy?.mailboxes?.length || Number(s.mailboxes) || 2;
  // The warm-up card (docs/WARMUP-HUB.md) knows whether warm-up really runs: while the circle is short it waits for helpers.
  const helpersShort = warmup && warmup.status === 'waiting_for_helpers' ? Math.max(1, Number(warmup.helpersNeeded) || 1) : 0;
  const stepsOf = (at = {}) => [
    { key: 'bought', label: 'You bought it', done: Boolean(at.bought), at: at.bought || null },
    { key: 'domain', label: 'Domain live + spam protection set', done: Boolean(at.domain), at: at.domain || null },
    { key: 'inboxes', label: `${n} inboxes created`, done: Boolean(at.inboxes), at: at.inboxes || null },
    { key: 'connected', label: 'Connected to our system', done: Boolean(at.connected), at: at.connected || null },
    { key: 'warmup', label: 'Warm-up started', done: Boolean(at.warmup), at: at.warmup || null },
  ];
  if (!linked && !connected) {
    return { status: 'not_set_up', buy: null, label: 'CheapInboxes is not connected — buy by hand and paste the logins, or connect it in Settings › Inboxes & domains', domain: null, steps: stepsOf(), mailboxes: [], problem: null, canUnlink: false };
  }
  const warmupAt = rec.warmupAt || (rec.connectedAt && WARMUP_STATES.has(st) ? domain.setupPassedAt || client.stateChangedAt || rec.connectedAt : null);
  const failed = ['failed', 'gone'].includes(rec.problemKind);
  const status = !linked ? 'ready_to_buy' : warmupAt ? 'done' : failed ? 'failed' : rec.connectedAt || rec.inboxesActiveAt ? 'connecting' : 'provisioning';
  const name = linked ? rec.domain : rec.buy?.domain || null;
  const mailboxes = (rec.mailboxes || []).map((m) => ({ email: m.email, status: m.connectedAt ? 'connected' : m.state === 'active' ? 'active' : 'provisioning' }));
  const label = {
    ready_to_buy: name ? `Buy ${name} and ${n} inboxes on CheapInboxes` : rec.buyProblem || `Buy their domain and ${n} inboxes on CheapInboxes — the list is being made`,
    provisioning: `Setting up ${name} — about 48 hours`,
    connecting: rec.connectedAt && domain.setupPhase === 'failed' ? `Connecting ${name} — a setup check failed` : `Connecting ${name} to our system`,
    done: helpersShort
      ? `${name} and ${n} inboxes are ready — add ${helpersShort} warm-up helper${helpersShort === 1 ? '' : 's'} to start warm-up`
      : `${name} and ${n} inboxes are ready — warm-up has started`,
    failed: rec.problem || `The order for ${name} failed`,
  }[status];
  return {
    status,
    buy: status === 'ready_to_buy' ? rec.buy || null : null,
    label,
    domain: name,
    // "Warm-up started" is done only when warm-up really runs (not while the circle waits for helpers).
    steps: linked ? stepsOf({ bought: rec.boughtAt || rec.linkedAt, domain: rec.domainLiveAt, inboxes: rec.inboxesActiveAt, connected: rec.connectedAt, warmup: helpersShort ? null : warmupAt }) : stepsOf(),
    mailboxes,
    problem: status === 'ready_to_buy' ? (rec.buy ? null : rec.buyProblem || null) : rec.problem || null,
    linkedBy: rec.linkedBy || null,
    canUnlink: linked && !rec.connectedAt && !mailboxes.some((m) => m.status === 'connected'),
  };
}

/** States in which a trial's record is read for the board (the rest never show `autobuy`). */
export const AUTOBUY_STATES = new Set(['awaiting_purchase', 'setup_check', 'warming']);

/** The trial's `autobuy` from Redis (two or three reads). */
export async function autobuyFor(clientId, { client = null, connected = null, now = new Date() } = {}) {
  const c = client || await getClient(clientId);
  if (!c) return null;
  const [rec, isOn, domain, s] = await Promise.all([readRec(clientId), connected ?? ci.isConnected(), getDomain(clientId), autobuySettings()]);
  // While the trial warms, the warm-up card says whether warm-up has really started (the circle may be short).
  let warmup = null;
  if (c.state === 'warming') {
    try {
      const [w, { getInboxRecords }] = await Promise.all([import('@/lib/systems/warmup'), import('@/lib/db/inboxes')]);
      const data = await w.hubWarmupData({ now, circle: true });
      warmup = w.warmupView({ client: c, inboxes: await getInboxRecords(clientId), now, circle: data.circle, dayStats: data.dayStats, s: data.settings });
    } catch { warmup = null; }
  }
  return autobuyView({ client: c, rec, connected: isOn, domain, s, warmup });
}
