/**
 * Remove test data (owner only). The owner presses it; nothing here runs by itself.
 *
 *   previewCleanup()        → { ok, clients:[item], bookings:[item], keys:[item], counts }   (reads only)
 *   applyCleanup(ids, opts) → { ok, removed:[…], skipped:[…], counts }  deletes exactly the confirmed ids
 *
 * item = { id, kind:'client'|'booking'|'keys', label, reasons:[plain words WHY it matched], strong:bool, detail }
 * Only clearly-test records match: demo-* ids, the `_test` client, the Test run's flag, names that are exactly
 * "Test"/"Demo"-like, and reserved example/test addresses (example.com/.org/.net, *.example, *.test, *.invalid,
 * *.localhost). A real client never matches. `strong` = an id/flag match (ticked by default in the hub);
 * a name-only or address-only match is listed but not ticked, so the owner decides.
 * Apply re-reads the data and only removes ids that are STILL test records (a stale or forged id is skipped).
 */
import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { listClientIds, syncClientIndex } from '@/lib/db/client';

const PROTECTED = new Set(['aviance']);
const TEST_DOMAIN = /@(?:[^\s@>]+\.)?(?:example\.(?:com|org|net)|[^\s@>]*\.(?:example|test|invalid|localhost)|example|test|invalid|localhost)>?\s*$/i;
// A name that is just "Test" / "Demo" (optionally "client", "company", "co", "account", a number). Never "Test Prep Pros".
const TEST_NAME = /^\s*(?:test|testing|tester|demo|dummy|sample|fake)(?:\s+(?:client|company|co|inc|llc|account|business|user|booking|lead|\d+))?\s*\d*\s*$/i;
const DEMO_META_KEYS = ['demo:keys', 'demo:members', 'demo:meta', 'demo:autoloaded'];

const s = (v) => String(v == null ? '' : v).trim();
const isTestAddress = (a) => TEST_DOMAIN.test(s(a));
const isTestName = (n) => TEST_NAME.test(s(n));

/** Why this client row is a test record (plain words), and whether the match is strong. */
export function clientTestReasons(id, rec = {}, extra = {}) {
  const reasons = []; let strong = false;
  if (PROTECTED.has(id)) return { reasons, strong };
  if (/^demo-/.test(id)) { reasons.push('Its id starts with "demo-" (a Test run client)'); strong = true; }
  if (id === '_test') { reasons.push('It is the built-in test client (_test)'); strong = true; }
  if (rec.demo === '1' || rec.demo === 1 || rec.demo === true || rec.isDemo === true || rec.isDemo === '1') { reasons.push('It is marked as a Test run client'); strong = true; }
  if (rec.test === '1' || rec.test === true || rec.isTest === true || rec.isTest === '1') { reasons.push('It is marked as a test'); strong = true; }
  if (isTestName(rec.name)) reasons.push(`Its name is just "${s(rec.name).slice(0, 40)}"`);
  for (const [label, addr] of [['contact email', rec.contactEmail], ['application email', extra.applicationEmail], ['profile email', extra.profileEmail]]) {
    if (addr && isTestAddress(addr)) reasons.push(`Its ${label} is a test address (${s(addr).replace(/^[^@]*/, '…')})`);
  }
  return { reasons, strong };
}

/** Why a website booking is a test record. */
export function bookingTestReasons(q = {}) {
  const reasons = [];
  if (q.email && isTestAddress(q.email)) reasons.push(`Their email is a test address (${s(q.email).replace(/^[^@]*/, '…')})`);
  if (isTestName(q.name) && isTestName(q.company)) reasons.push('Both name and company just say "test"');
  else if (isTestName(q.company)) reasons.push(`The company is just "${s(q.company).slice(0, 40)}"`);
  if (q.clientId && (/^demo-/.test(q.clientId) || q.clientId === '_test')) reasons.push(`It belongs to the test client ${q.clientId}`);
  if (q.test === true || q.test === '1' || q.demo === true) reasons.push('It is marked as a test');
  // Weak signals (name/company alone) are shown, never ticked; a test address or test client is firm.
  const strong = reasons.some((r) => /test address|test client|marked as a test/.test(r));
  return { reasons, strong };
}

async function scanKeys(match) {
  const out = []; let cursor = 0, guard = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match, count: 500 });
    out.push(...(keys || [])); cursor = next; guard++;
  } while (String(cursor) !== '0' && guard < 200);
  return [...new Set(out)];
}

/** Every key that belongs to one client id (exact patterns only, never a prefix of another id). */
async function clientKeys(id) {
  assertClientId(id);
  const keys = new Set([`client:${id}`, `pacing:${id}`]);
  for (const k of await scanKeys(`client:${id}:*`)) keys.add(k);
  for (const k of await scanKeys(`inbox:${id}:*`)) keys.add(k);
  for (const k of await scanKeys(`lead:${id}:*`)) keys.add(k);
  for (const k of await scanKeys(`intake:once:*:${id}:*`)) keys.add(k);
  return [...keys];
}

const parse = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

async function findClients() {
  const ids = (await listClientIds()).filter((id) => !PROTECTED.has(id));
  // `_test` and demo ids may exist as keys without being in the set: look for them too.
  for (const extra of ['_test']) if (!ids.includes(extra) && (await kv.exists(K.client(extra)))) ids.push(extra);
  const items = [];
  for (const id of ids) {
    let rec = {};
    try { rec = (await kv.hgetall(K.client(id))) || {}; } catch { rec = {}; }
    const app = (await kv.hgetall(K.application(id)).catch(() => null)) || {};
    const prof = (await kv.hgetall(K.profile(id)).catch(() => null)) || {};
    const { reasons, strong } = clientTestReasons(id, rec, { applicationEmail: app.contactEmail || app.email, profileEmail: prof.email || prof.contactEmail });
    if (!reasons.length) continue;
    items.push({ id, kind: 'client', label: s(rec.name) || id, reasons, strong, detail: `${s(rec.state) || 'unknown state'}${rec.plan ? `, ${rec.plan} plan` : ''}` });
  }
  return items;
}

async function findBookings() {
  const ids = (await kv.lrange(K.inquiryOrder(), 0, -1).catch(() => [])) || [];
  const all = ids.length ? (await kv.hmget(K.inquiries(), ...ids)) || {} : {};
  const items = [];
  for (const id of ids) {
    const q = parse(all[id]);
    if (!q) continue;
    const { reasons, strong } = bookingTestReasons(q);
    if (!reasons.length) continue;
    items.push({ id: String(id), kind: 'booking', label: s(q.company) || s(q.name) || String(id), reasons, strong, detail: `${s(q.status) || 'new'}${q.slotStart ? `, call ${s(q.slotStart).slice(0, 10)}` : ''}` });
  }
  return items;
}

async function findKeyGroups() {
  const present = [];
  for (const k of DEMO_META_KEYS) if (await kv.exists(k)) present.push(k);
  if (!present.length) return [];
  return [{ id: 'demo-bookkeeping', kind: 'keys', label: 'Test run bookkeeping', reasons: [`Leftover records of the Test run (${present.join(', ')})`], strong: true, detail: `${present.length} record${present.length === 1 ? '' : 's'}` }];
}

export async function previewCleanup() {
  const [clients, bookings, keys] = await Promise.all([findClients(), findBookings(), findKeyGroups()]);
  for (const c of clients) c.keyCount = (await clientKeys(c.id).catch(() => [])).length;
  return { ok: true, clients, bookings, keys, counts: { clients: clients.length, bookings: bookings.length, keys: keys.length } };
}

async function delKeys(keys) {
  let n = 0;
  for (let i = 0; i < keys.length; i += 100) n += Number(await kv.del(...keys.slice(i, i + 100))) || 0;
  return n;
}

/** Delete exactly the confirmed ids that are still test records. ids = [{kind, id}] or ['client:demo-x', 'booking:abc', 'keys:demo-bookkeeping']. */
export async function applyCleanup(ids) {
  const want = (Array.isArray(ids) ? ids : []).map((x) => (typeof x === 'string' ? { kind: x.split(':')[0], id: x.slice(x.indexOf(':') + 1) } : { kind: s(x?.kind), id: s(x?.id) })).filter((x) => x.kind && x.id);
  if (!want.length) return { ok: false, error: 'Nothing was chosen to remove.' };
  const fresh = await previewCleanup();
  const live = new Map();
  for (const it of [...fresh.clients, ...fresh.bookings, ...fresh.keys]) live.set(`${it.kind}:${it.id}`, it);
  const removed = [], skipped = [];
  for (const w of want) {
    const it = live.get(`${w.kind}:${w.id}`);
    if (!it) { skipped.push({ kind: w.kind, id: w.id, why: 'It is not a test record (any more), so it was left alone.' }); continue; }
    try {
      if (it.kind === 'client') {
        const keys = await clientKeys(it.id);
        // Their page links point back by hash: drop those lookups too.
        const toks = [];
        for (const k of keys.filter((k) => k.includes(':token:'))) { const rec = await kv.get(k).catch(() => null); if (rec?.hash) toks.push(`tokenidx:${rec.hash}`); }
        const n = await delKeys([...keys, ...toks]);
        await kv.srem(K.clients(), it.id);
        await kv.hdel(K.trialLedger(), it.id).catch(() => {});
        await syncClientIndex().catch(() => {});
        // The restClients list on the heartbeat must not keep the id.
        const rest = parse(await kv.hget(K.heartbeat(), 'restClients').catch(() => null));
        if (Array.isArray(rest) && rest.includes(it.id)) await kv.hset(K.heartbeat(), { restClients: JSON.stringify(rest.filter((x) => x !== it.id)) });
        removed.push({ kind: 'client', id: it.id, label: it.label, records: n });
      } else if (it.kind === 'booking') {
        await kv.hdel(K.inquiries(), it.id);
        await kv.lrem(K.inquiryOrder(), 0, it.id);
        removed.push({ kind: 'booking', id: it.id, label: it.label, records: 1 });
      } else if (it.kind === 'keys') {
        const tracked = ((await kv.smembers('demo:keys').catch(() => [])) || []).filter((k) => typeof k === 'string' && /^(client:demo-|inbox:demo-|lead:demo-|tokenidx:)/.test(k));
        const n = await delKeys([...tracked, ...DEMO_META_KEYS]);
        removed.push({ kind: 'keys', id: it.id, label: it.label, records: n });
      }
    } catch (err) {
      skipped.push({ kind: w.kind, id: w.id, why: 'This one did not go through. Try again.' });
    }
  }
  return { ok: true, removed, skipped, counts: { removed: removed.length, skipped: skipped.length } };
}
