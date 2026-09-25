/**
 * Safe fetch for addresses that come from outside (an applicant's website, a
 * client's calendar link). The machine must never be steered into its own
 * network (SSRF): every hop — the first address and each redirect — may only
 * connect to a public IP. The check sits in the socket's DNS lookup, so the
 * address that was checked is the address that is connected to (no DNS
 * rebinding between a check and the request), and names like
 * 127.0.0.1.nip.io are refused the same as the literal.
 *
 * Returns a standard Response (status, headers, url, text(), body) so callers
 * need no change. Only http(s), no credentials in the URL, at most 5 hops.
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

/** Private, loopback, link-local, CGNAT, documentation, multicast and reserved ranges. */
export function isPrivateAddress(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(s)) {
    const [a, b, c] = s.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(s)) {
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) + parseInt(hex[2], 16); return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    const first = parseInt(s.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
      || (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
      || (first & 0xff00) === 0xff00 // multicast
      || s.startsWith('64:ff9b:') // NAT64 (can reach IPv4 private space)
      || s.startsWith('2001:db8:') || s.startsWith('2001:0db8:')
      || s.startsWith('100::');
  }
  return true; // not an IP at all: refuse
}

class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError'; this.code = 'EBLOCKED'; }
}

/** dns.lookup that refuses a name when any of its addresses is not public. */
export function safeLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs?.length || addrs.some((a) => isPrivateAddress(a.address))) return callback(new BlockedError(`${hostname} is not a public address`));
    if (opts.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new BlockedError('not a web address'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new BlockedError('only http(s) addresses');
  if (u.username || u.password) throw new BlockedError('no credentials in addresses');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedError(`${host} is not a public address`);
  if (host === 'localhost' || /\.(local|internal|localhost)$/i.test(host)) throw new BlockedError(`${host} is not a public address`);
  return u;
}

function requestOnce(u, { method, headers, body, deadline }) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) { const e = new Error('timed out'); e.name = 'TimeoutError'; reject(e); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, lookup: safeLookup, agent: false }, resolve);
    const timer = setTimeout(() => { const e = new Error('timed out'); e.name = 'TimeoutError'; req.destroy(e); }, left);
    timer.unref?.();
    req.on('response', (res) => {
      res.on('close', () => clearTimeout(timer));
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    if (body) req.write(body);
    req.end();
  });
}

function toResponse(res, url, method) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers || {})) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  const status = res.statusCode || 0;
  const noBody = method === 'HEAD' || [101, 204, 205, 304].includes(status);
  let stream = res;
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (!noBody && enc === 'gzip') stream = res.pipe(zlib.createGunzip());
  else if (!noBody && enc === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (!noBody && enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
  if (stream !== res) { headers.delete('content-encoding'); headers.delete('content-length'); stream.on('error', () => {}); }
  if (noBody) res.resume();
  const out = new Response(noBody ? null : Readable.toWeb(stream), { status: status >= 200 && status <= 599 ? status : 502, statusText: res.statusMessage || '', headers });
  Object.defineProperty(out, 'url', { value: url });
  Object.defineProperty(out, 'redirected', { value: false, writable: true });
  return out;
}

/**
 * fetch() for outside addresses. `redirect`: 'manual' (default, the 3xx is
 * returned) or 'follow' (each hop re-checked). Throws BlockedError for a
 * private address, TimeoutError after `timeoutMs` for the whole call.
 */
export async function safeFetch(url, { method = 'GET', headers = {}, body = null, redirect = 'manual', timeoutMs = 10_000, maxRedirects = 5 } = {}) {
  if (globalThis.__blockSafeFetch) throw new Error(`real network call blocked in tests: ${String(url).slice(0, 120)}`);
  const deadline = Date.now() + timeoutMs;
  const h = { 'accept-encoding': 'gzip, deflate, br', ...headers };
  let current = checkUrl(url);
  let m = String(method).toUpperCase();
  let b = body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, { method: m, headers: h, body: b, deadline });
    const status = res.statusCode || 0;
    const loc = res.headers.location;
    if (redirect === 'follow' && status >= 300 && status < 400 && loc) {
      res.resume();
      current = checkUrl(new URL(loc, current).href);
      if (status === 303 || ((status === 301 || status === 302) && m === 'POST')) { m = 'GET'; b = null; }
      continue;
    }
    const out = toResponse(res, current.href, m);
    if (hop) out.redirected = true;
    return out;
  }
  throw new BlockedError('too many redirects');
}
