/**
 * Domains v2 + the fixed inbox provider (Intake v2).
 *
 * "Take the top five domain providers with the best prices, keep them
 * together in a system, come up with the best domains, and list the best
 * domains at the best prices. Inboxes are fixed: CheapInboxes."
 *
 *  - Candidates: brand-stem variants (get/try/use/hey/join/with + brand,
 *    brand + hq/team/mail/co/app/labs/group/usa), hyphen-free, ≤ 15 letters,
 *    no digits, no confusable joins, never the client's own domain, TLDs
 *    .com → .net → .co only.
 *  - Score 0–100 with a one-line `why` (length, .com, how much it reads like
 *    a real company's second address, spammy words, big-brand look-alikes).
 *  - Availability: Porkbun checkDomain when keys exist, else RDAP
 *    (rdap.org, 404 = free), cached in intake:rdapcache, polite on 429.
 *  - Prices: the five registrars in config REGISTRARS (table, with
 *    checkedAt) + live Porkbun prices from its keyless pricing API
 *    (intake:registrarprices, refreshed monthly and on every shopping list).
 *    `best` = cheapest first year, tie → cheaper renewal. Promo codes are
 *    shown, never used for `best`.
 *  - Inboxes: CheapInboxes from config INBOX_PROVIDER, the buying steps
 *    filled with the domain and the sender names.
 *
 * Everything here is pure except checkNames / refreshLivePrices / livePrices.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { getPricing, checkDomain, porkbunKeys, rdapLookup } from '@/lib/ext/porkbun';
import { asObject } from '@/lib/systems/intake-io';

export const tldOf = (name) => String(name).split('.').slice(1).join('.');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const money = (n) => (num(n) === null ? 'unknown' : `$${Number(n).toFixed(2)}`);

// ── candidates ──────────────────────────────────────────────────────────────

/** 'www.Acme-Plumbing.com' → 'acme-plumbing'. */
export function brandLabel(mainDomain) {
  return String(mainDomain || '').toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9-]/g, '');
}

/** Brand stems without digits: the whole label joined ('acmeplumbing') and its first word ('acme'). */
export function brandStems(mainDomain) {
  const label = brandLabel(mainDomain);
  const words = label.split('-').filter(Boolean);
  const stems = [];
  const add = (s, full) => { const v = String(s).replace(/[^a-z]/g, ''); if (v.length >= 3 && !stems.some((x) => x.stem === v)) stems.push({ stem: v, full }); };
  const joined = words.join('');
  if (!/\d/.test(joined)) add(joined, true);
  if (words.length > 1 && words[0].length >= 3 && !/\d/.test(words[0])) add(words[0], false);
  if (!stems.length) add(joined.replace(/\d+/g, ''), true); // brand has digits: the letters only, as a last resort
  return stems;
}

const BAD_JOIN = new Set(['rn', 'vv']);
/** A join that reads badly or could be misread ('gett…', 'acmehhq', 'rn' ≈ 'm'). */
const confusableJoin = (left, right) => {
  const a = left.slice(-1);
  const b = right[0];
  return a === b || BAD_JOIN.has(a + b);
};

/**
 * Every candidate in generation order:
 * [{ domain, label, tld, stem, affix, position: 'prefix'|'suffix', fullBrand }].
 */
export function generateCandidates(mainDomain, D, tlds) {
  const main = String(mainDomain || '').toLowerCase().replace(/^www\./, '');
  const out = [];
  const seen = new Set();
  for (const tld of tlds) {
    for (const { stem, full } of brandStems(main)) {
      const variants = [
        ...(D.prefixes || []).map((p) => ({ label: `${p}${stem}`, affix: p, position: 'prefix', ok: !confusableJoin(p, stem) })),
        ...(D.suffixes || []).map((s) => ({ label: `${stem}${s}`, affix: s, position: 'suffix', ok: !confusableJoin(stem, s) })),
      ];
      for (const v of variants) {
        if (!v.ok || v.label.length > D.maxLabel || /[^a-z]/.test(v.label)) continue;
        const domain = `${v.label}.${tld}`;
        if (domain === main || seen.has(domain)) continue;
        seen.add(domain);
        out.push({ domain, label: v.label, tld, stem, affix: v.affix, position: v.position, fullBrand: full });
      }
    }
  }
  return out;
}

const TLD_POINTS = { com: 20, net: 8, co: 4 };

/** { score 0–100, why } — rules only, see docs/assumptions/stage-a.md (Intake v2). */
export function scoreCandidate(c, D) {
  let score = 50;
  const why = [];
  const len = c.label.length;
  if (len <= 8) { score += 15; why.push(`short (${len})`); }
  else if (len <= 10) { score += 10; why.push(`${len} letters`); }
  else if (len <= 12) { score += 5; why.push(`${len} letters`); }
  else why.push(`long (${len})`);
  why.push(c.position === 'prefix' ? `'${c.affix}' + brand` : `brand + '${c.affix}'`);
  score += Number(D.affixWeights?.[c.affix]) || 0;
  if (c.fullBrand) score += 5; else why.push('first word of the brand');
  score += TLD_POINTS[c.tld] ?? 0;
  why.push(`.${c.tld}`);
  // The client's own brand is never held against it; only what the affix adds.
  const spam = (D.spamWords || []).find((w) => c.label.includes(w) && !c.stem.includes(w));
  if (spam) { score -= 30; why.push(`contains '${spam}'`); }
  const brand = (D.bigBrands || []).find((b) => c.label.includes(b) && !c.stem.includes(b));
  if (brand) { score -= 40; why.push(`looks like '${brand}'`); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), why: why.join(', ') };
}

/** Candidates scored and sorted best first (ties: .com first, then shorter, then generation order). */
export function rankCandidates(mainDomain, D, tlds) {
  const order = new Map(tlds.map((t, i) => [t, i]));
  return generateCandidates(mainDomain, D, tlds)
    .map((c, i) => ({ ...c, ...scoreCandidate(c, D), i }))
    .sort((a, b) => b.score - a.score || order.get(a.tld) - order.get(b.tld) || a.label.length - b.label.length || a.i - b.i)
    .map(({ i, ...c }) => c);
}

// ── availability ────────────────────────────────────────────────────────────

/** RDAP HTTP status → availability. 404 free, 200 taken, anything else unknown. */
export function rdapStatusToAvailable(status) {
  return status === 'free' ? true : status === 'taken' ? false : null;
}

/**
 * Availability for `names`, cheapest route first: the cache, then Porkbun
 * checkDomain (keys only), then RDAP. Returns { results: {name: {available,
 * source, price?, renewal?, premium?}}, limited: bool } — names not answered
 * (deadline, 429 back-off) are simply absent.
 */
export async function checkNames(names, { D, deadline = Date.now() + 10000, now = new Date() } = {}) {
  const results = {};
  if (!names.length) return { results, limited: false };
  let cached = {};
  try { cached = (await kv.hmget(K.rdapCache(), ...names)) || {}; } catch {}
  for (const n of names) {
    const v = asObject(cached[n]);
    if (!v || typeof v.available !== 'boolean') continue;
    const maxH = v.available ? D.rdapCacheHours.free : D.rdapCacheHours.taken;
    if (now.getTime() - Date.parse(v.at) < maxH * 3600e3) results[n] = { available: v.available, source: 'cache', ...(v.price ? { price: v.price } : {}) };
  }
  let todo = names.filter((n) => !results[n]);
  const fresh = {};
  let limited = false;
  if (todo.length && porkbunKeys()) {
    for (const n of todo) {
      if (Date.now() > deadline - 2500) break;
      try {
        const r = await checkDomain(n);
        results[n] = { available: r.available && !r.premium, source: 'porkbun', price: r.price, renewal: r.renewal, premium: r.premium };
        fresh[n] = { available: results[n].available, at: now.toISOString(), price: r.price || null };
      } catch { break; } // rate limit or keys: RDAP for the rest
    }
    todo = names.filter((n) => !results[n]);
  }
  if (todo.length) {
    let backoff = null;
    try { backoff = await kv.get(K.rdapBackoff()); } catch {}
    if (backoff) limited = true;
    else {
      const conc = Math.max(1, D.rdapConcurrency || 1);
      for (let i = 0; i < todo.length && !limited; i += conc) {
        if (Date.now() > deadline - 2500) break;
        const slice = todo.slice(i, i + conc);
        const rows = await Promise.all(slice.map((n) => rdapLookup(n, { base: D.rdapBase, timeoutMs: Math.min(6000, Math.max(1500, deadline - Date.now() - 1000)) })));
        rows.forEach((r, j) => {
          if (r.status === 'limited') { limited = true; return; }
          const available = rdapStatusToAvailable(r.status);
          results[slice[j]] = { available, source: 'rdap' };
          if (available !== null) fresh[slice[j]] = { available, at: now.toISOString() };
        });
      }
      if (limited) { try { await kv.set(K.rdapBackoff(), now.toISOString(), { ex: D.rdapBackoffSec }); } catch {} }
    }
  }
  if (Object.keys(fresh).length) {
    try { await kv.hset(K.rdapCache(), Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, JSON.stringify(v)]))); } catch {}
  }
  return { results, limited };
}

// ── prices ──────────────────────────────────────────────────────────────────

/** Live prices (intake:registrarprices): { porkbun: { com: {firstYear, renewal, confirmedAt}, … } }. */
export async function livePrices() {
  try {
    const raw = (await kv.hgetall(K.registrarPrices())) || {};
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, asObject(v) || {}]));
  } catch {
    return {};
  }
}

/** Porkbun's keyless price list → the live cache. Returns the prices stored (or throws). */
export async function refreshLivePrices({ tlds = ['com', 'net', 'co'], now = new Date(), pricing = null } = {}) {
  const p = pricing || (await getPricing());
  const out = {};
  for (const t of tlds) {
    const first = num(p?.[t]?.registration);
    if (first === null) continue;
    out[t] = { firstYear: first, renewal: num(p[t].renewal), confirmedAt: now.toISOString() };
  }
  if (!Object.keys(out).length) throw new Error('porkbun pricing: no .com/.net/.co rows');
  await kv.hset(K.registrarPrices(), { porkbun: JSON.stringify(out) });
  return out;
}

/** Monthly job: refresh every keyless live source; a failure keeps the table prices (marked `table`). */
export async function runRegistrarPriceRefresh({ now = new Date() } = {}) {
  try {
    const porkbun = await refreshLivePrices({ now });
    await logEvent(null, 'domains', 'prices_refreshed', { porkbun });
    return { porkbun };
  } catch (err) {
    await logEvent(null, 'domains', 'prices_refresh_failed', { error: String(err?.message || err).slice(0, 200) });
    return { error: String(err?.message || err).slice(0, 200), fallback: 'table' };
  }
}

const daysOld = (iso, now) => (iso ? (now.getTime() - Date.parse(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso)) / 86400e3 : Infinity);

/**
 * One price row per registrar for a TLD, in the HUB shape:
 * { registrar, id, firstYear, renewal, promo, url, confirmedAt, source, stale }.
 * Live wins when younger than livePriceMaxAgeDays; else the table.
 */
export function priceRows(registrars, tld, { live = {}, now = new Date(), D = {}, domain = null } = {}) {
  return (registrars || []).map((r) => {
    const l = r.liveApi ? live?.[r.liveApi]?.[tld] || live?.[r.id]?.[tld] : null;
    const useLive = l && num(l.firstYear) !== null && daysOld(l.confirmedAt, now) <= (D.livePriceMaxAgeDays ?? 40);
    const t = r.prices?.[tld] || {};
    const promo = r.promo?.[tld] || null;
    return {
      registrar: r.name,
      id: r.id,
      firstYear: useLive ? num(l.firstYear) : num(t.firstYear),
      renewal: useLive ? num(l.renewal) ?? num(t.renewal) : num(t.renewal),
      promo: promo ? { code: promo.code, firstYear: num(promo.firstYear), note: promo.note || null } : null,
      url: domain && r.search ? r.search.replace('{domain}', encodeURIComponent(domain)) : r.url,
      confirmedAt: useLive ? l.confirmedAt : r.checkedAt ? new Date(`${r.checkedAt}T00:00:00Z`).toISOString() : null,
      source: useLive ? 'live' : 'table',
      stale: !useLive && daysOld(r.checkedAt, now) > (D.tableMaxAgeDays ?? 35),
    };
  });
}

/** Cheapest first year (list price, not promo); tie → cheaper renewal; unknown prices never win. */
export function pickBest(rows) {
  const known = (rows || []).filter((r) => num(r.firstYear) !== null);
  if (!known.length) return null;
  const b = [...known].sort((a, c) => a.firstYear - c.firstYear || (a.renewal ?? Infinity) - (c.renewal ?? Infinity))[0];
  return { registrar: b.registrar, firstYear: b.firstYear, renewal: b.renewal ?? null, url: b.url, ...(b.promo ? { promo: b.promo } : {}) };
}

/** The five registrars, cheapest .com first: [{ name, why, url }]. */
export function registrarList(registrars, rowsCom) {
  const byId = Object.fromEntries((rowsCom || []).map((r) => [r.id, r]));
  return [...(registrars || [])]
    .sort((a, b) => (byId[a.id]?.firstYear ?? Infinity) - (byId[b.id]?.firstYear ?? Infinity) || (byId[a.id]?.renewal ?? Infinity) - (byId[b.id]?.renewal ?? Infinity))
    .map((r) => ({ name: r.name, why: r.why, url: r.url }));
}

// ── inboxes (fixed: CheapInboxes) ───────────────────────────────────────────

/** Price per inbox for an account with `n` active mailboxes. */
export function tierPrice(tiers, n) {
  const sorted = [...(tiers || [])].sort((a, b) => a.from - b.from);
  let price = null;
  for (const t of sorted) if (n >= t.from) price = num(t.price);
  return price;
}

/**
 * The HUB `inboxes` object, steps filled with the domain and the users
 * ({ name, email }). A missing sender name stays visible as a gap to fill,
 * never an invented name.
 */
export function inboxPlan(P, { domain, mainDomain, users = [], count = null } = {}) {
  const n = count || P.count;
  const perInbox = tierPrice(P.tiers, n);
  const monthly = perInbox === null ? null : r2(perInbox * n);
  const userText = users.length
    ? users.map((u) => `${u.name || '(sender name not set yet)'} → ${u.email}`).join('; ')
    : '(sender name and prefix are not set yet — they come from the onboarding page)';
  const slots = { domain: domain || '(the domain you bought)', mainDomain: mainDomain || 'their main website', count: String(n), users: userText, perInbox: money(perInbox), monthly: money(monthly) };
  const steps = (P.steps || []).map((s) => s.replace(/\{(\w+)\}/g, (m, k) => (k in slots ? slots[k] : m)));
  return { provider: P.name, url: P.url, perInbox, count: n, monthly, notes: P.notes || null, steps };
}

/** Sender users for the inboxes: both addresses carry the sender's full name. */
export function inboxUsers(addresses, profile) {
  const name = String(profile?.senderName || '').trim() || null;
  return (addresses || []).map((email) => ({ name, email }));
}

// ── offers ──────────────────────────────────────────────────────────────────

/**
 * 5–8 offers from ranked candidates + availability: available names first
 * (best score first), then unknown availability only to reach `min`.
 */
export function buildOffers(ranked, availability, { registrars, live, now, D, min = 5, max = 8 }) {
  const rowsFor = (c) => {
    const rows = priceRows(registrars, c.tld, { live, now, D, domain: c.domain });
    const a = availability[c.domain];
    // Porkbun's own quote for this exact name (keys only) beats its list price.
    if (a?.source === 'porkbun' && num(a.price) !== null) {
      const row = rows.find((r) => r.id === 'porkbun');
      if (row) Object.assign(row, { firstYear: num(a.price), renewal: num(a.renewal) ?? row.renewal, source: 'live', confirmedAt: now.toISOString(), stale: false });
    }
    return rows;
  };
  const offer = (c, available) => {
    const prices = rowsFor(c);
    return { domain: c.domain, tld: c.tld, available, score: c.score, why: c.why, prices: prices.map(({ id, stale, ...p }) => p), best: pickBest(prices), _stale: prices.filter((p) => p.stale).map((p) => p.registrar) };
  };
  const free = ranked.filter((c) => availability[c.domain]?.available === true).slice(0, max).map((c) => offer(c, true));
  const unknown = free.length < min ? ranked.filter((c) => availability[c.domain] && availability[c.domain].available === null).slice(0, min - free.length).map((c) => offer(c, null)) : [];
  return [...free, ...unknown];
}

/** { domainFirstYear, inboxesMonthly, firstMonth } — null where a part is unknown. */
export function totalsOf(offers, inboxes) {
  const d = num(offers?.[0]?.best?.firstYear);
  const i = num(inboxes?.monthly);
  return { domainFirstYear: d, inboxesMonthly: i, firstMonth: d !== null && i !== null ? r2(d + i) : null };
}
