/**
 * The hub's "Test run" (docs/HUB-API.md "Test run (demo clients)"): two
 * finished example clients the owner can click through in his real hub —
 *   demo-harbor-dental   a trial that ended, pressed Start and paid;
 *   demo-summit-roofing  a paying client on Growth, a month of sending, paid.
 *
 * Their data is the final Redis state of the two clients in the end-to-end
 * simulation (tests/two-clients.test.mjs → tests/fixtures/demo-state.json,
 * made by exportDemoState below: ids renamed, every domain turned into a
 * reserved `.example` one, no credentials, no page tokens). `load` replays
 * those keys with every date moved so the simulation's last day is today;
 * `remove` deletes every key it wrote (tracked in `demo:keys` /
 * `demo:members`) and anything else under the two ids.
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

export const DEMO = { harbor: 'demo-harbor-dental', summit: 'demo-summit-roofing' };
export const DEMO_KEYS = 'demo:keys';          // every whole key `load` wrote (set)
export const DEMO_MEMBERS = 'demo:members';    // entries it added to shared keys (set of JSON {key, type, member})
export const DEMO_META = 'demo:meta';          // {loadedAt, ids} (hash)
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

/** Every date in a string moved by `days` whole days: ISO times, YYYY-MM-DD days and "Thursday 22 October" / "Tue 6 Oct". */
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
    });
}

/** The same through any stored value (strings inside objects and arrays too). */
export function shiftValue(v, days, year) {
  if (typeof v === 'string') return shiftText(v, days, year);
  if (Array.isArray(v)) return v.map((x) => shiftValue(x, days, year));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [shiftText(k, days, year), shiftValue(x, days, year)]));
  return v;
}

// ─── export (the simulation's final state → the fixture) ─────────────────────

const OWNED = (id) => [`client:${id}`, `client:${id}:`, `inbox:${id}:`, `pacing:${id}`];
// Heavy or machine-only parts the hub never shows (IMAP cursors, the Message-ID index, verification queues,
// one-time claims) and anything that could act as a credential (page tokens).
const SKIP = /:(leads|msgindex|imapstate|verifyq|senthosts|learnstats|mailretry|token:[^:]+|sanity|blocklist)$|:placementrun:|^lead:/;
const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)(com|net|org|co|io|us|test|online|store|app)\b/gi;
const LINK_FIELDS = /^(onboarding|approval|decision|dashboard)Link(At)?$|^dashboardSharedWith$/;

function typed(v) {
  if (v instanceof Map) return v.__z ? { t: 'zset', v: [...v.entries()] } : { t: 'hash', v: Object.fromEntries(v) };
  if (v instanceof Set) return { t: 'set', v: [...v] };
  if (Array.isArray(v)) return { t: 'list', v: [...v] };
  return { t: 'str', v };
}

/**
 * The two clients' final state from a Redis dump (tests' fake KV: key → Map | Set | Array | value), made
 * safe to replay anywhere: ids → the demo ids, every domain → `.example`, no encrypted fields, no page
 * tokens or links. → { version, endedAt, year, ids, keys: {key: {t, v}}, members: [{key, t, member, value|score}] }.
 */
export function exportDemoState(realIds, { dump, now = new Date() } = {}) {
  const map = new Map([[realIds[0], DEMO.harbor], [realIds[1], DEMO.summit]]);
  const rename = (s) => {
    let out = String(s);
    for (const [from, to] of map) out = out.split(from).join(to);
    return out.replace(DOMAIN_RE, (all, host) => `${host}example`);
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
      const id = `mdemo${mid.slice(1)}`.slice(0, 41);
      const out = clean({ ...m, id, googleEventId: null, meetError: null });
      members.push({ key: K.meetings(), t: 'hash', member: id, value: JSON.stringify(out) });
      const score = byStart instanceof Map ? byStart.get(mid) : null;
      if (score != null) members.push({ key: K.meetingsByStart(), t: 'zset', member: id, score });
    }
  }
  return { version: 1, endedAt: now.toISOString(), year: now.getUTCFullYear(), ids: [DEMO.harbor, DEMO.summit], keys, members };
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

/**
 * Write the two finished clients, every date moved so the simulation's last day is `now`'s day (ET). A
 * second load replaces the first. → { ok, ids }.
 */
export async function loadDemo({ now = new Date(), state = null } = {}) {
  // Loaded only here (its own chunk): the routes that import demoRefusal stay small.
  if (!state) state = (await import('../../../tests/fixtures/demo-state.json')).default;
  if (!state?.keys) throw new Error('the test-run data is missing (tests/fixtures/demo-state.json)');
  await removeDemo();
  const days = daysBetween(dayKeyIn(ET, new Date(state.endedAt)), dayKeyIn(ET, now));
  const year = Number(state.year) || new Date(state.endedAt).getUTCFullYear();
  const written = [];
  const password = await fakePassword();
  const at = now.toISOString();
  for (const [rawKey, { t, v }] of Object.entries(state.keys)) {
    const key = shiftText(rawKey, days, year);
    if (!DEMO_IDS.has(ownerId(key))) continue; // only ever the two demo ids' own keys
    const val = shiftValue(v, days, year);
    if (t === 'hash') {
      const fields = { ...val };
      if (key === `client:${ownerId(key)}`) Object.assign(fields, { demo: '1', demoLoadedAt: at });
      if (key.startsWith('inbox:')) fields.passwordEnc = password;
      const entries = Object.entries(fields);
      for (let i = 0; i < entries.length; i += CHUNK) await kv.hset(key, Object.fromEntries(entries.slice(i, i + CHUNK)));
    } else if (t === 'list') {
      for (let i = 0; i < val.length; i += CHUNK) await kv.rpush(key, ...val.slice(i, i + CHUNK));
    } else if (t === 'set') {
      for (let i = 0; i < val.length; i += CHUNK) await kv.sadd(key, ...val.slice(i, i + CHUNK));
    } else if (t === 'zset') {
      for (let i = 0; i < val.length; i += CHUNK) await kv.zadd(key, ...val.slice(i, i + CHUNK).map(([member, score]) => ({ member, score: Number(score) + days * 864e5 })));
    } else {
      await kv.set(key, val);
    }
    written.push(key);
  }
  // The warm-up history of their inboxes (per inbox, per day) is read by the Growth tab.
  for (const [rawKey, { t, v }] of Object.entries(state.keys)) {
    if (!rawKey.startsWith('warmup:stats:') || t !== 'hash') continue;
    const key = shiftText(rawKey, days, year);
    await kv.hset(key, shiftValue(v, days, year));
    written.push(key);
  }
  const members = [];
  for (const m of state.members || []) {
    if (m.t === 'hash') await kv.hset(m.key, { [m.member]: shiftText(m.value, days, year) });
    else if (m.t === 'zset') await kv.zadd(m.key, { member: m.member, score: Number(m.score) + days * 864e5 });
    members.push({ key: m.key, type: m.t, member: m.member });
  }
  for (const id of DEMO_IDS) {
    await kv.sadd(K.clients(), id);
    members.push({ key: K.clients(), type: 'set', member: id });
  }
  // A working link to each one's client dashboard (read-only; the hub shows it under links.dashboard).
  try {
    const { dashboardLink } = await import('@/lib/systems/clientdash');
    const { sha256 } = await import('@/lib/crypto');
    for (const id of DEMO_IDS) {
      const url = await dashboardLink(id, { fresh: true, now });
      const token = /\/c\/([A-Za-z0-9_-]{20,})\//.exec(String(url || ''))?.[1];
      if (token) written.push(`tokenidx:${sha256(token)}`, K.token(id, 'dashboard'));
    }
  } catch { /* no dashboard link: the rest of the test run still shows */ }
  for (let i = 0; i < written.length; i += CHUNK) await kv.sadd(DEMO_KEYS, ...written.slice(i, i + CHUNK));
  for (let i = 0; i < members.length; i += CHUNK) await kv.sadd(DEMO_MEMBERS, ...members.slice(i, i + CHUNK).map((m) => JSON.stringify(m)));
  await kv.hset(DEMO_META, { loadedAt: at, ids: JSON.stringify([...DEMO_IDS]) });
  await syncClientIndex();
  return { ok: true, ids: [...DEMO_IDS] };
}

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
