/**
 * Blacklists v2 (SPEC §6.6 check 9; research: docs/research/v2-deliverability.md §4).
 *
 * A trial domain sends through Google Workspace, so its sending IPs are
 * Google's (shared, and checked by the spam test's own blacklist step). What
 * we check ourselves:
 *   - the DOMAIN on free domain (URI) lists — a hit there hurts every mail
 *     that names the domain: "listed" (setup blocks, Auth Guard pauses);
 *   - the domain's A record IPs (usually the registrar's forwarding server)
 *     and MX IPs (Google) on free IP lists — neither sends our mail, so a hit
 *     is a warning (BLACKLISTS.ipAction 'warn'; 'block' counts it as listed).
 *
 * Never a false "listed": every zone is asked for its documented test entry
 * (must answer listed) and a clean control (must answer not listed) in the
 * same run; a zone failing either is "unknown" this run (a public resolver
 * that silently answers "not listed", or a dead list that lists everything).
 * Timeouts, SERVFAIL/REFUSED, 127.0.0.1 / 127.0.0.255 / 127.255.255.x
 * (query refused / over quota) and any answer outside 127.0.0.0/8 are
 * "unknown" too — never "listed".
 *
 * Result (stored by Auth Guard as client:{id}:domain.blacklists):
 *   { checkedAt, listed: [..], warnings: [..], clean: n, unknown: [..], lists: [..] }
 */

import { cfg } from '@/lib/config';
import { io } from '@/lib/systems/intake-io';

const NOT_LISTED = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export const reverseIp = (ip) => String(ip).split('.').reverse().join('.');
const isIpv4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip));

/**
 * Zone definition (BLACKLISTS config, one flat shape) → normalised spec:
 *   zone, type ('ip' | 'domain'), name,
 *   listedBits / warnBits  bitmask lists (URIBL, SURBL): last octet & bits (0 = off)
 *   listed / warn          [lo, hi] of the last octet (from listedFrom/listedTo,
 *                          warnFrom/warnTo; 0–0 = none)
 *   errors                 last octets that mean "refused / error"
 *   warnOnly               a hit is only ever a warning (UCEPROTECT L1)
 *   test                   entry that must answer listed ('2.0.0.127', 'test.uribl.com')
 *   control                entry that must answer not listed ('1.0.0.127', 'example.com')
 */
export function zoneSpec(z) {
  const s = typeof z === 'string' ? { zone: z } : { ...z };
  s.type = s.type === 'domain' ? 'domain' : 'ip';
  s.name = s.name || s.zone;
  const range = (lo, hi, arr, dflt) => (Array.isArray(arr) && arr.length === 2 ? arr : Number(hi) > 0 ? [Number(lo) || 0, Number(hi)] : dflt);
  s.listed = range(s.listedFrom, s.listedTo, s.listed, [2, 99]);
  s.warn = range(s.warnFrom, s.warnTo, s.warn, null);
  s.listedBits = Number(s.listedBits) > 0 ? Number(s.listedBits) : null;
  s.warnBits = Number(s.warnBits) > 0 ? Number(s.warnBits) : null;
  s.errors = Array.isArray(s.errors) ? s.errors.map(Number) : [1];
  s.warnOnly = s.warnOnly === true;
  if (s.test === undefined) s.test = s.type === 'ip' ? '2.0.0.127' : null;
  if (s.control === undefined) s.control = s.type === 'ip' ? '1.0.0.127' : 'example.com';
  return s;
}

/**
 * Pure: classify one DNS answer for a zone → 'listed' | 'warn' | 'clean' | 'unknown'.
 * `answer` = { ok: true, value: [ips] } or { ok: false, code }.
 */
export function classifyAnswer(spec, answer) {
  if (!answer) return 'unknown';
  if (!answer.ok) return NOT_LISTED.has(answer.code) ? 'clean' : 'unknown';
  const ips = (answer.value || []).map(String);
  if (!ips.length) return 'clean';
  let best = 'unknown';
  const rank = { unknown: 0, warn: 1, listed: 2 };
  for (const ip of ips) {
    const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m || m[1] !== '0' || m[2] !== '0') continue;   // outside 127.0.0.0/24: 127.255.255.x errors, hijacked answers
    const last = Number(m[3]);
    if (spec.errors.includes(last) || last === 255) continue;
    let v = 'unknown';
    if (spec.listedBits != null || spec.warnBits != null) {
      if (last & (spec.listedBits || 0)) v = 'listed';
      else if (last & (spec.warnBits || 0)) v = 'warn';
    } else if (last >= spec.listed[0] && last <= spec.listed[1]) v = 'listed';
    else if (spec.warn && last >= spec.warn[0] && last <= spec.warn[1]) v = 'warn';
    if (rank[v] > rank[best]) best = v;
  }
  return best;
}

async function lookup(name, ms) {
  try {
    return { ok: true, value: await io.dns.resolve4(name, ms) };
  } catch (err) {
    // ENOTFOUND / ENODATA = not listed; anything else (timeout, SERVFAIL,
    // REFUSED, no code) = no verdict.
    return { ok: false, code: err?.code || 'ERROR' };
  }
}

const queryName = (spec, target) => (spec.type === 'ip' && isIpv4(target) ? `${reverseIp(target)}.${spec.zone}` : `${String(target).toLowerCase()}.${spec.zone}`);

/** Pure: every query to make for a domain, its A IPs and MX IPs, plus each zone's two controls. */
export function planQueries(domain, { aIps = [], mxIps = [] }, zones) {
  const out = [];
  for (const z of zones.map(zoneSpec)) {
    const targets = z.type === 'domain'
      ? [{ target: domain, source: 'domain' }]
      : [...aIps.filter(isIpv4).map((ip) => ({ target: ip, source: 'A record' })), ...mxIps.filter(isIpv4).map((ip) => ({ target: ip, source: 'MX' }))];
    if (!targets.length) continue;
    for (const t of targets) out.push({ zone: z, ...t, name: queryName(z, t.target) });
    // Controls are written as query labels already (IP lists: reversed, e.g. 2.0.0.127 = 127.0.0.2).
    if (z.test) out.push({ zone: z, target: z.test, source: 'test', name: `${z.test}.${z.zone}` });
    if (z.control) out.push({ zone: z, target: z.control, source: 'control', name: `${z.control}.${z.zone}` });
  }
  return out;
}

/**
 * Pure: fold classified answers into the stored shape. A zone whose test entry
 * is not listed, or whose control is, gives no verdict this run.
 */
export function summarize(results, { zones, ipAction = 'warn', checkedAt = new Date().toISOString() } = {}) {
  const listed = [];
  const warnings = [];
  const unknown = [];
  let clean = 0;
  const specs = (zones || []).map(zoneSpec);
  for (const z of specs) {
    const rows = results.filter((r) => r.zone.zone === z.zone);
    const real = rows.filter((r) => r.source !== 'test' && r.source !== 'control');
    if (!real.length) continue;                                   // nothing to ask this zone
    const test = rows.find((r) => r.source === 'test');
    const control = rows.find((r) => r.source === 'control');
    const broken = (test && !['listed', 'warn'].includes(test.verdict)) || (control && control.verdict !== 'clean');
    if (broken) { unknown.push(z.zone); continue; }
    let zoneHit = false;
    let zoneUnknown = false;
    for (const r of real) {
      if (r.verdict === 'unknown') { zoneUnknown = true; continue; }
      if (r.verdict === 'clean') continue;
      zoneHit = true;
      const line = `${r.target}${r.source === 'domain' ? '' : ` (${r.source})`} on ${z.name}${r.verdict === 'warn' ? ' (low-confidence list)' : ''}`;
      const blocks = r.verdict === 'listed' && !z.warnOnly && (z.type === 'domain' || ipAction === 'block');
      (blocks ? listed : warnings).push(line);
    }
    if (zoneHit) continue;
    if (zoneUnknown) unknown.push(z.zone);
    else clean++;
  }
  return { checkedAt, listed, warnings, clean, unknown, lists: [...new Set(specs.map((z) => z.zone))] };
}

/** 'listed' | 'clean' | 'unknown' (no list gave a verdict) for the domain hash's summary field. */
export function statusOf(summary) {
  if (summary.listed.length) return 'listed';
  if (summary.clean === 0 && !summary.warnings.length) return 'unknown';
  return 'clean';
}

async function settings() {
  const keys = ['domainZones', 'ipZones', 'ipAction', 'timeoutMs', 'mxHosts'];
  const vals = await Promise.all(keys.map((k) => cfg(null, `BLACKLISTS.${k}`)));
  const b = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  const zones = [...(b.domainZones || []).map((z) => zoneSpec({ ...(typeof z === 'string' ? { zone: z } : z), type: 'domain' })), ...(b.ipZones || []).map((z) => zoneSpec({ ...(typeof z === 'string' ? { zone: z } : z), type: 'ip' }))];
  return { zones, ipAction: b.ipAction === 'block' ? 'block' : 'warn', ms: Number(b.timeoutMs) || 4000, mxHosts: Number(b.mxHosts) || 2 };
}

/**
 * Check one domain → the stored shape plus `status` and a one-line `detail`
 * for the setup check. Never throws.
 */
export async function checkDomainBlacklists(domain, { now = new Date() } = {}) {
  const s = await settings();
  const a = await lookup(domain, s.ms);
  const aIps = a.ok ? a.value.filter(isIpv4).slice(0, 2) : [];
  const mxIps = [];
  try {
    const mx = await io.dns.resolveMx(domain, s.ms);
    const hosts = (mx || []).sort((x, y) => (x.priority || 0) - (y.priority || 0)).map((m) => String(m.exchange || '').replace(/\.$/, '')).filter(Boolean).slice(0, s.mxHosts);
    const res = await Promise.all(hosts.map((h) => lookup(h, s.ms)));
    res.forEach((r) => r.ok && r.value.filter(isIpv4).slice(0, 1).forEach((ip) => mxIps.push(ip)));
  } catch {}
  const queries = planQueries(domain, { aIps, mxIps }, s.zones);
  const results = await Promise.all(queries.map(async (q) => ({ ...q, verdict: classifyAnswer(q.zone, await lookup(q.name, s.ms)) })));
  const summary = summarize(results, { zones: s.zones, ipAction: s.ipAction, checkedAt: now.toISOString() });
  const status = statusOf(summary);
  const asked = summary.clean + summary.unknown.length;
  const detail = status === 'listed'
    ? `listed: ${summary.listed.join('; ')}`
    : `${status === 'unknown' ? `no list gave a verdict (${summary.unknown.length} asked)` : `clean on ${summary.clean} of ${asked + (summary.warnings.length ? 1 : 0)} lists`}${status !== 'unknown' && summary.unknown.length ? ` (no verdict from ${summary.unknown.join(', ')})` : ''}${summary.warnings.length ? `; warning (not our sending IPs): ${summary.warnings.join('; ')}` : ''}`;
  return { ...summary, status, detail, ips: { a: aIps, mx: mxIps } };
}
