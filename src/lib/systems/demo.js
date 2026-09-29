/**
 * The hub's "Test run" (docs/HUB-API.md "Test run (demo clients)"): three
 * example clients the owner can click through in his real hub —
 *   demo-harbor-dental   a trial that ended, pressed Start and paid;
 *   demo-summit-roofing  a paying client on Growth, a month of sending, paid;
 *   demo-lakeview-pt     a trial live mid-way (sending, about Day 12 of 30).
 *
 * Their data is the Redis state of the clients in the end-to-end simulation
 * (tests/two-clients.test.mjs → tests/fixtures/demo-state.json, made by
 * exportDemoState / exportDemoPart below: ids renamed, every domain turned
 * into a reserved `.example` one, no credentials, no page tokens). Harbor and
 * Summit are the final state; Lakeview is Harbor's trial snapshotted on its
 * Day 12 with every name changed. `load` replays each part with every date
 * moved so the part's last day is today (Lakeview: yesterday evening);
 * `remove` deletes every key it wrote (tracked in `demo:keys` /
 * `demo:members`) and anything else under the three ids. The first hub open
 * in production loads it once by itself (`maybeAutoloadDemo`).
 *
 * Safety: a demo client is never acted on. getAllClients leaves them out
 * unless a hub view asks (so no job, count, digest or scan sees them), notify
 * never emails or alerts for them, the mailer never sends to a `.example`
 * address, and the hub's buttons on them answer 409 (middleware + routes).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { DEMO_IDS, isDemoId, syncClientIndex } from '@/lib/db/client';
import { dayKeyIn, daysBetween, ET } from '@/lib/time';

export const DEMO = { harbor: 'demo-harbor-dental', summit: 'demo-summit-roofing', lakeview: 'demo-lakeview-pt' };
export const DEMO_KEYS = 'demo:keys';          // every whole key `load` wrote (set)
export const DEMO_MEMBERS = 'demo:members';    // entries it added to shared keys (set of JSON {key, type, member})
export const DEMO_META = 'demo:meta';          // {loadedAt, ids} (hash)
export const DEMO_AUTOLOADED = 'demo:autoloaded'; // when the test run loaded itself (string ISO); never removed
export const DEMO_READ_ONLY = 'This is a test-run client: nothing can be sent or changed for it. Remove the test run to clear it.';
const FAKE_PASSWORD = 'DEMO-not-a-real-password';
const CHUNK = 100;

/** A route's answer for a write on a demo client (null for any other id). */
export function demoRefusal(id) {
  return isDemoId(id) ? Response.json({ error: DEMO_READ_ONLY }, { status: 409 }) : null;
}

// ─── dates ───────────────────────────────────────────────────────────────────

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_RE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})/g;
const DAY_RE = /\b(20\d{2})-(\d{2})-(\d{2})\b(?!T\d)/g;
const HUMAN_RE = new RegExp(`\\b(?:(${[...DAYS_LONG, ...DAYS_SHORT].join('|')}),? )?(\\d{1,2}) (${[...MONTHS_LONG, ...MONTHS_SHORT].join('|')})\\b`, 'g');
// The US order the prospect emails use: "Wednesday, October 28" / "Tue, Nov 3" / "November 3".
const US_RE = new RegExp(`\\b(?:(${[...DAYS_LONG, ...DAYS_SHORT].join('|')}),? )?(${[...MONTHS_LONG, ...MONTHS_SHORT].join('|')}) (\\d{1,2})\\b(?!:)`, 'g');

/** Every date in a string moved by `days` whole days: ISO times, YYYY-MM-DD days, "Thursday 22 October" / "Tue 6 Oct" and "Wednesday, October 28". */
export function shiftText(text, days, year) {
  if (!days || typeof text !== 'string') return text;
  const ms = days * 864e5;
  return text
    .replace(ISO_RE, (all, body, zone) => {
      const t = Date.parse(`${body}${zone}`);
      if (!Number.isFinite(t)) return all;
      const out = new Date(t + ms).toISOString();
      return /\.\d/.test(body) ? out : out.replace(/\.\d{3}Z$/, 'Z');
    })
    .replace(DAY_RE, (all, y, m, d) => {
      const t = Date.UTC(Number(y), Number(m) - 1, Number(d));
      return Number.isFinite(t) ? new Date(t + ms).toISOString().slice(0, 10) : all;
    })
    .replace(HUMAN_RE, (all, wd, d, mon) => {
      const long = MONTHS_LONG.includes(mon);
      const mi = long ? MONTHS_LONG.indexOf(mon) : MONTHS_SHORT.indexOf(mon);
      const t = new Date(Date.UTC(year, mi, Number(d)) + ms);
      const month = (long ? MONTHS_LONG : MONTHS_SHORT)[t.getUTCMonth()];
      const weekday = wd ? `${(DAYS_LONG.includes(wd) ? DAYS_LONG : DAYS_SHORT)[t.getUTCDay()]}${all.startsWith(`${wd},`) ? ',' : ''} ` : '';
      return `${weekday}${t.getUTCDate()} ${month}`;
    })
    .replace(US_RE, (all, wd, mon, d) => {
      const long = MONTHS_LONG.includes(mon);
      const mi = long ? MONTHS_LONG.indexOf(mon) : MONTHS_SHORT.indexOf(mon);
      if (Number(d) < 1 || Number(d) > 31) return all;
      const t = new Date(Date.UTC(year, mi, Number(d)) + ms);
      const month = (long ? MONTHS_LONG : MONTHS_SHORT)[t.getUTCMonth()];
      const weekday = wd ? `${(DAYS_LONG.includes(wd) ? DAYS_LONG : DAYS_SHORT)[t.getUTCDay()]}${all.startsWith(`${wd},`) ? ',' : ''} ` : '';
      return `${weekday}${month} ${t.getUTCDate()}`;
    });
}

/** The same through any stored value (strings inside objects and arrays too). */
export function shiftValue(v, days, year) {
  if (typeof v === 'string') {
    // A JSON record kept as a string: shift inside it (its escaped "\n" would hide a word boundary).
    if (days && /^\s*[[{]/.test(v)) { try { return JSON.stringify(shiftValue(JSON.parse(v), days, year)); } catch { /* not JSON */ } }
    return shiftText(v, days, year);
  }
  if (Array.isArray(v)) return v.map((x) => shiftValue(x, days, year));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [shiftText(k, days, year), shiftValue(x, days, year)]));
  return v;
}

// ─── export (the simulation's final state → the fixture) ─────────────────────

const OWNED = (id) => [`client:${id}`, `client:${id}:`, `inbox:${id}:`, `pacing:${id}`];
// Heavy or machine-only parts the hub never shows (IMAP cursors, the Message-ID index, verification queues,
// one-time claims) and anything that could act as a credential (page tokens).
const SKIP = /:(msgindex|imapstate|verifyq|senthosts|learnstats|mailretry|token:[^:]+|sanity|blocklist)$|:placementrun:|^lead:/;
const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)(com|net|org|co|io|us|test|online|store|app)\b/gi;
const LINK_FIELDS = /^(onboarding|approval|decision|dashboard)Link(At)?$|^dashboardSharedWith$/;

function typed(v) {
  if (v instanceof Map) return v.__z ? { t: 'zset', v: [...v.entries()] } : { t: 'hash', v: Object.fromEntries(v) };
  if (v instanceof Set) return { t: 'set', v: [...v] };
  if (Array.isArray(v)) return { t: 'list', v: [...v] };
  return { t: 'str', v };
}

/** One pass of literal replacements (longest first at each position). */
function literalReplacer(pairs = []) {
  const map = new Map(pairs.filter(([from]) => from));
  if (!map.size) return (s) => s;
  const re = new RegExp([...map.keys()].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (s) => s.replace(re, (m) => map.get(m));
}

/**
 * Some clients' state from a Redis dump (tests' fake KV: key → Map | Set | Array | value), made safe to
 * replay anywhere: ids → demo ids, every domain → `.example`, no encrypted fields, no page tokens or links.
 *   pairs      [[realId, demoId]]
 *   before     literal replacements made before the ids are renamed (a domain that contains the id)
 *   words      literal replacements made after (names, a company, its trade words, its prospects)
 *   meetingPrefix  the first letters of their Calendar meeting ids (unique per part)
 * → { ids, endedAt, year, keys: {key: {t, v}}, members: [{key, t, member, value|score}] }.
 */
export function exportDemoPart(pairs, { dump, now = new Date(), before = [], words = [], meetingPrefix = 'mdemo' } = {}) {
  const realIds = pairs.map(([real]) => real);
  const pre = literalReplacer(before);
  const post = literalReplacer(words);
  const rename = (s) => {
    let out = pre(String(s));
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return post(out).replace(DOMAIN_RE, (all, host) => `${host}example`);
  };
  const clean = (v) => {
    if (typeof v === 'string') return rename(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/Enc$/.test(k)).map(([k, x]) => [rename(k), clean(x)]));
    return v;
  };
  const inboxEmails = new Set();
  for (const id of realIds) for (const e of dump.get(`client:${id}:inboxes`) || []) inboxEmails.add(String(e));
  const keys = {};
  for (const [key, raw] of dump) {
    const owned = realIds.some((id) => OWNED(id).some((p) => key === p || (p.endsWith(':') && key.startsWith(p))));
    const warm = key.startsWith('warmup:stats:') && [...inboxEmails].some((e) => key.startsWith(`warmup:stats:${e}:`));
    if (!(owned || warm) || SKIP.test(key)) continue;
    const entry = typed(raw);
    if (entry.t === 'hash') {
      entry.v = Object.fromEntries(Object.entries(entry.v).filter(([f]) => !/Enc$/.test(f) && !(key.endsWith(':trial') && LINK_FIELDS.test(f))));
    }
    keys[rename(key)] = { t: entry.t, v: clean(entry.v) };
  }
  // Their meetings on the owner's Calendar (a shared hash + its time index): ids renamed, no Google event.
  const members = [];
  const meetings = dump.get(K.meetings());
  const byStart = dump.get(K.meetingsByStart());
  if (meetings instanceof Map) {
    for (const [mid, json] of meetings) {
      const m = typeof json === 'string' ? JSON.parse(json) : json;
      if (!realIds.includes(m?.clientId)) continue;
      const id = `${meetingPrefix}${mid.slice(1)}`.slice(0, 41);
      const out = clean({ ...m, id, googleEventId: null, meetError: null });
      members.push({ key: K.meetings(), t: 'hash', member: id, value: JSON.stringify(out) });
      const score = byStart instanceof Map ? byStart.get(mid) : null;
      if (score != null) members.push({ key: K.meetingsByStart(), t: 'zset', member: id, score });
    }
  }
  return { ids: pairs.map(([, demo]) => demo), endedAt: now.toISOString(), year: now.getUTCFullYear(), keys, members };
}

/**
 * The fixture: the two finished clients (Harbor, Summit) at the simulation's end, plus `extra` parts (the
 * Lakeview trial, a mid-way snapshot). → { version: 2, ids, parts: [part…] }.
 */
export function exportDemoState(realIds, { dump, now = new Date(), before = [], words = [], extra = [] } = {}) {
  const main = exportDemoPart([[realIds[0], DEMO.harbor], [realIds[1], DEMO.summit]], { dump, now, before, words });
  const parts = [main, ...extra];
  return { version: 2, ids: parts.flatMap((p) => p.ids), parts };
}

/** The fixture's parts (a version-1 fixture is one part). */
export function demoParts(state) {
  if (Array.isArray(state?.parts)) return state.parts;
  return state?.keys ? [{ ids: state.ids, endedAt: state.endedAt, year: state.year, keys: state.keys, members: state.members }] : [];
}

// ─── load / remove / status ──────────────────────────────────────────────────

async function sweep(pattern) {
  const out = [];
  let cursor = '0';
  let guard = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match: pattern, count: 1000 });
    out.push(...(keys || []));
    cursor = String(next);
  } while (cursor !== '0' && ++guard < 500);
  return out;
}

async function fakePassword() {
  try { const { encrypt } = await import('@/lib/crypto'); return encrypt(FAKE_PASSWORD); } catch { return 'demo'; }
}

/** GET /api/mc/demo → { loaded, ids, at }. */
export async function demoStatus() {
  const meta = (await kv.hgetall(DEMO_META).catch(() => null)) || {};
  const present = [];
  for (const id of DEMO_IDS) if (await kv.exists(K.client(id))) present.push(id);
  return { loaded: present.length > 0, ids: present, at: meta.loadedAt || null };
}

/** Write in pieces of at most CHUNK items and about 256 KB (a request stays small). */
async function inPieces(items, write) {
  let piece = [];
  let size = 0;
  for (const it of items) {
    const n = JSON.stringify(it).length;
    if (piece.length && (piece.length >= CHUNK || size + n > 256_000)) { await write(piece); piece = []; size = 0; }
    piece.push(it);
    size += n;
  }
  if (piece.length) await write(piece);
}

/**
 * Write the test-run clients: every date of each part moved so the part's last day is `now`'s day (ET),
 * or `endsDaysAgo` days before it (the Lakeview trial: a snapshot of the evening before). A second load
 * replaces the first. Marks `demo:autoloaded` too, so the automatic load never brings it back after a
 * Remove. → { ok, ids }.
 */
export async function loadDemo({ now = new Date(), state = null } = {}) {
  // Loaded only here (its own chunk): the routes that import demoRefusal stay small.
  if (!state) state = (await import('../../../tests/fixtures/demo-state.json')).default;
  const parts = demoParts(state);
  if (!parts.length) throw new Error('the test-run data is missing (tests/fixtures/demo-state.json)');
  await removeDemo();
  const written = [];
  const members = [];
  const password = await fakePassword();
  const at = now.toISOString();
  for (const part of parts) {
    const own = new Set((part.ids || []).filter((id) => DEMO_IDS.has(id)));
    const days = daysBetween(dayKeyIn(ET, new Date(part.endedAt)), dayKeyIn(ET, now)) - (Number(part.endsDaysAgo) || 0);
    const year = Number(part.year) || new Date(part.endedAt).getUTCFullYear();
    for (const [rawKey, { t, v }] of Object.entries(part.keys || {})) {
      if (rawKey.startsWith('warmup:stats:')) continue;
      const key = shiftText(rawKey, days, year);
      if (!own.has(ownerId(key))) continue; // only ever the part's own demo ids' keys
      const val = shiftValue(v, days, year);
      if (t === 'hash') {
        const fields = { ...val };
        if (key === `client:${ownerId(key)}`) Object.assign(fields, { demo: '1', demoLoadedAt: at });
        if (key.startsWith('inbox:')) fields.passwordEnc = password;
        await inPieces(Object.entries(fields), (piece) => kv.hset(key, Object.fromEntries(piece)));
      } else if (t === 'list') {
        await inPieces(val, (piece) => kv.rpush(key, ...piece));
      } else if (t === 'set') {
        await inPieces(val, (piece) => kv.sadd(key, ...piece));
      } else if (t === 'zset') {
        await inPieces(val, (piece) => kv.zadd(key, ...piece.map(([member, score]) => ({ member, score: Number(score) + days * 864e5 }))));
      } else {
        await kv.set(key, val);
      }
      written.push(key);
    }
    // The warm-up history of their inboxes (per inbox, per day) is read by the Growth tab.
    for (const [rawKey, { t, v }] of Object.entries(part.keys || {})) {
      if (!rawKey.startsWith('warmup:stats:') || t !== 'hash') continue;
      const key = shiftText(rawKey, days, year);
      await kv.hset(key, shiftValue(v, days, year));
      written.push(key);
    }
    for (const m of part.members || []) {
      if (m.t === 'hash') await kv.hset(m.key, { [m.member]: shiftText(m.value, days, year) });
      else if (m.t === 'zset') await kv.zadd(m.key, { member: m.member, score: Number(m.score) + days * 864e5 });
      members.push({ key: m.key, type: m.t, member: m.member });
    }
  }
  const ids = [...DEMO_IDS].filter((id) => parts.some((p) => (p.ids || []).includes(id)));
  for (const id of ids) {
    await kv.sadd(K.clients(), id);
    members.push({ key: K.clients(), type: 'set', member: id });
  }
  // A working link to each one's client dashboard (read-only; the hub shows it under links.dashboard).
  try {
    const { dashboardLink } = await import('@/lib/systems/clientdash');
    const { sha256 } = await import('@/lib/crypto');
    for (const id of ids) {
      const url = await dashboardLink(id, { fresh: true, now });
      const token = /\/c\/([A-Za-z0-9_-]{20,})\//.exec(String(url || ''))?.[1];
      if (token) written.push(`tokenidx:${sha256(token)}`, K.token(id, 'dashboard'));
    }
  } catch { /* no dashboard link: the rest of the test run still shows */ }
  for (let i = 0; i < written.length; i += CHUNK) await kv.sadd(DEMO_KEYS, ...written.slice(i, i + CHUNK));
  for (let i = 0; i < members.length; i += CHUNK) await kv.sadd(DEMO_MEMBERS, ...members.slice(i, i + CHUNK).map((m) => JSON.stringify(m)));
  await kv.hset(DEMO_META, { loadedAt: at, ids: JSON.stringify(ids) });
  await kv.set(DEMO_AUTOLOADED, at, { nx: true });
  await syncClientIndex();
  return { ok: true, ids };
}

// ─── the automatic first load ────────────────────────────────────────────────

let autoloadSeen = false; // this server instance already saw the mark: no read at all

/**
 * The owner never has to press anything to see the test run: the first time the hub opens (GET
 * /api/mc/hub) in production it loads itself once and `demo:autoloaded` = the time is set. The mark stays
 * after a Remove (and a manual Load sets it too), so it never comes back by itself. Off with config
 * DEMO_AUTOLOAD = false. Outside production (tests, dev) only when `force` (tests) or
 * DEMO_AUTOLOAD_ANYWHERE=1. Never throws. → { loaded, reason?, at? }.
 */
export async function maybeAutoloadDemo({ now = new Date(), force = false } = {}) {
  if (autoloadSeen && !force) return { loaded: false, reason: 'done before' };
  if (!force && process.env.NODE_ENV !== 'production' && process.env.DEMO_AUTOLOAD_ANYWHERE !== '1') return { loaded: false, reason: 'not production' };
  try {
    const { cfg } = await import('@/lib/config');
    if ((await cfg(null, 'DEMO_AUTOLOAD')) === false) return { loaded: false, reason: 'off' };
    const at = now.toISOString();
    const claimed = await kv.set(DEMO_AUTOLOADED, at, { nx: true });
    if (!claimed) { autoloadSeen = true; return { loaded: false, reason: 'done before' }; }
    try {
      await loadDemo({ now });
    } catch (err) {
      await kv.del(DEMO_AUTOLOADED).catch(() => {}); // try again next time
      return { loaded: false, reason: `load failed: ${err?.message || err}` };
    }
    autoloadSeen = true;
    return { loaded: true, at };
  } catch (err) {
    return { loaded: false, reason: String(err?.message || err) };
  }
}

/** Tests: forget that this instance saw the mark. */
export function resetAutoloadMemo() { autoloadSeen = false; }

/** The client id a demo key belongs to ('client:{id}…', 'inbox:{id}:…', 'pacing:{id}'), else null. */
function ownerId(key) {
  const m = /^(?:client|inbox|pacing):([a-z0-9-]+)/.exec(key);
  return m ? m[1] : null;
}

/** Delete everything the test run wrote (and anything written under its ids since). → { ok, removed }. */
export async function removeDemo() {
  const tracked = (await kv.smembers(DEMO_KEYS).catch(() => [])) || [];
  const extra = [];
  for (const id of DEMO_IDS) extra.push(...await sweep(`client:${id}*`), ...await sweep(`inbox:${id}:*`), ...await sweep(`pacing:${id}`), ...await sweep(`notified:${id}:*`));
  // A page token minted for them since (a hub view makes the approval link, say) has its index key outside their prefix.
  for (const k of extra.filter((x) => /:token:/.test(x))) {
    try { const rec = await kv.get(k); if (rec?.hash) extra.push(`tokenidx:${rec.hash}`); } catch {}
  }
  const keys = [...new Set([...tracked, ...extra])];
  let removed = 0;
  for (let i = 0; i < keys.length; i += CHUNK) removed += Number(await kv.del(...keys.slice(i, i + CHUNK))) || 0;
  const members = ((await kv.smembers(DEMO_MEMBERS).catch(() => [])) || []).map((x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
  for (const m of members) {
    if (m.type === 'hash') removed += Number(await kv.hdel(m.key, m.member)) || 0;
    else if (m.type === 'zset') removed += Number(await kv.zrem(m.key, m.member)) || 0;
    else if (m.type === 'set') removed += Number(await kv.srem(m.key, m.member)) || 0;
  }
  // Whatever else names them in a shared index (never written by load, but never left behind either).
  for (const id of DEMO_IDS) removed += Number(await kv.srem(K.clients(), id)) || 0;
  await kv.del(DEMO_KEYS, DEMO_MEMBERS, DEMO_META);
  await syncClientIndex();
  return { ok: true, removed };
}
