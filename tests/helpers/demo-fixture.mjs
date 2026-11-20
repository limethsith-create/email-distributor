// Test-only: loads tests/fixtures/demo-state.json (a recorded Redis state of example clients) into the fake
// Redis, with every date moved to "now". This was the hub's "Test run" loader (src/lib/systems/demo.js); the
// Test run is gone from the product, and the privacy and shared-view tests still use its realistic data.
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
  if (!state) state = (await import('../fixtures/demo-state.json')).default;
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
