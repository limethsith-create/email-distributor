// In-memory stand-in for the subset of @vercel/kv the app uses. Values are
// stored as-is (objects stay objects), like the real client's JSON handling.
const store = new Map();
const ttl = new Map();

function live(key) {
  const exp = ttl.get(key);
  if (exp && exp <= Date.now()) { store.delete(key); ttl.delete(key); }
  return store.get(key);
}
const hash = (k) => { let h = live(k); if (!h) { h = new Map(); store.set(k, h); } return h; };
const set_ = (k) => { let s = live(k); if (!s) { s = new Set(); store.set(k, s); } return s; };
const list = (k) => { let l = live(k); if (!l) { l = []; store.set(k, l); } return l; };
const obj = (m) => (m && m.size ? Object.fromEntries(m) : null);

const api = {
  async get(k) { const v = live(k); return v === undefined ? null : v; },
  async set(k, v, opts = {}) {
    if (opts.nx && live(k) !== undefined) return null;
    store.set(k, v);
    if (opts.ex) ttl.set(k, Date.now() + opts.ex * 1000); else ttl.delete(k);
    return 'OK';
  },
  async del(...ks) { let n = 0; for (const k of ks) if (store.delete(k)) n++; return n; },
  async incr(k) { const v = (Number(live(k)) || 0) + 1; store.set(k, v); return v; },
  async expire(k, s) { ttl.set(k, Date.now() + s * 1000); return 1; },
  async type(k) { const v = live(k); return v instanceof Map ? 'hash' : v instanceof Set ? 'set' : Array.isArray(v) ? 'list' : v === undefined ? 'none' : 'string'; },
  async hget(k, f) { const h = live(k); return h && h.has(f) ? h.get(f) : null; },
  async hset(k, fields) { const h = hash(k); let n = 0; for (const [f, v] of Object.entries(fields)) { if (!h.has(f)) n++; h.set(f, v); } return n; },
  async hsetnx(k, f, v) { const h = hash(k); if (h.has(f)) return 0; h.set(f, v); return 1; },
  async hgetall(k) { return obj(live(k)); },
  async hincrby(k, f, n) { const h = hash(k); const v = (Number(h.get(f)) || 0) + n; h.set(f, v); return v; },
  async hdel(k, ...fs) { const h = live(k); let n = 0; if (h) for (const f of fs) if (h.delete(f)) n++; return n; },
  async hmget(k, ...fs) { const h = live(k); const out = {}; for (const f of fs) out[f] = h && h.has(f) ? h.get(f) : null; return out; },
  async sadd(k, ...ms) { const s = set_(k); let n = 0; for (const m of ms.flat()) if (!s.has(m)) { s.add(m); n++; } return n; },
  async srem(k, ...ms) { const s = live(k); let n = 0; if (s) for (const m of ms) if (s.delete(m)) n++; return n; },
  async smembers(k) { const s = live(k); return s ? [...s] : []; },
  async sismember(k, m) { const s = live(k); return s && s.has(m) ? 1 : 0; },
  async smismember(k, ms) { const s = live(k); return ms.map((m) => (s && s.has(m) ? 1 : 0)); },
  async lpush(k, ...vs) { const l = list(k); l.unshift(...vs.reverse()); return l.length; },
  async rpush(k, ...vs) { const l = list(k); l.push(...vs); return l.length; },
  async ltrim(k, a, b) { const l = live(k); if (l) store.set(k, l.slice(a, b === -1 ? undefined : b + 1)); return 'OK'; },
  async lrange(k, a, b) { const l = live(k) || []; return l.slice(a, b === -1 ? undefined : b + 1); },
  async lset(k, i, v) { const l = live(k); l[i] = v; return 'OK'; },
  async scan(cursor, { match } = {}) { const re = match ? new RegExp(`^${match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : null; return ['0', [...store.keys()].filter((k) => live(k) !== undefined && (!re || re.test(k)))]; },
  // Only the compare-and-set used by setState().
  async eval(_script, keys, args) {
    const h = hash(keys[0]);
    if (String(h.get('state')) !== args[0]) return 0;
    h.set('state', args[1]); h.set('stateChangedAt', args[2]);
    return 1;
  },
  pipeline() {
    const ops = [];
    const p = new Proxy({}, {
      get(_t, name) {
        if (name === 'exec') return async () => { const out = []; for (const [n, a] of ops) out.push(await api[n](...a)); return out; };
        return (...a) => { ops.push([name, a]); return p; };
      },
    });
    return p;
  },
};

export const kv = api;
export function __reset() { store.clear(); ttl.clear(); }
export function __dump() { return store; }
