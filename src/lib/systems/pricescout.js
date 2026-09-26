/**
 * Price Scout + Promo Hunter + optional Auto-Buyer (SPEC §6.4), Intake v2.
 *
 * The minute the market count passes (state awaiting_purchase) this builds
 * the owner's complete shopping list (systems/domains.js):
 *  - 5–8 available lookalike domains, scored best first, each with the five
 *    registrars' first-year + renewal prices (REGISTRARS table + Porkbun's
 *    keyless live prices) and the cheapest one (`best`);
 *  - the inboxes, fixed to CheapInboxes (INBOX_PROVIDER): 2 × tier price,
 *    the buying checklist with the sender names filled in;
 *  - totals. The v1 fields (chosenDomain, backups, registrarQuotes,
 *    inboxQuotes, senderAddresses, total, unconfirmed) are kept, filled from
 *    the same data.
 * Availability is checked in score order until 8 free names are known; a
 * run that hits the tick deadline or an RDAP 429 continues next minute (the
 * RDAP cache makes that cheap). A price that could not be confirmed is
 * listed in `unconfirmed`, never guessed.
 *
 * Auto-Buyer runs only with AUTO_BUY=true and Porkbun keys: balance check,
 * dryRun, real create, auto-renew off. Any error → manual list +
 * autobuy_failed. Also: hourly purchase nudge (12 h / 48 h) and the monthly
 * promo/Cloudflare refresh.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, getDomain, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { baseUrl } from '@/lib/notify';
import { getPricing, checkDomain, porkbunKeys, rdapAvailable, balance, createDomain, setAutoRenewOff } from '@/lib/ext/porkbun';
import { dayKeyIn, ET } from '@/lib/time';
import { io, asArray, asObject, firstNameOf, ownerName, sendClient } from '@/lib/systems/intake-io';
import { rankCandidates, checkNames, livePrices, refreshLivePrices, priceRows, registrarList, inboxPlan, inboxUsers, buildOffers, totalsOf } from '@/lib/systems/domains';
import { isConnected as cheapInboxesConnected } from '@/lib/ext/cheapinboxes';

const SYSTEM = 'pricescout';
/** Runs a list may wait for availability answers before it goes out with what it has. */
const MAX_SCOUT_RUNS = 10;
const V2_TLDS = ['com', 'net', 'co'];

// ── candidates ──────────────────────────────────────────────────────────────

/** 'acme.com' → 'acme'; 'www.acme-plumbing.co.uk' → 'acme-plumbing'. */
export function baseLabel(mainDomain) {
  return String(mainDomain || '').toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9-]/g, '');
}

/** Allowed TLDs in order, minus anything banned (banned always wins). */
export function allowedTlds(allowed, banned) {
  const ban = new Set(banned.map((t) => String(t).replace(/^\./, '').toLowerCase()));
  return allowed.map((t) => String(t).replace(/^\./, '').toLowerCase()).filter((t) => !ban.has(t));
}

/** Candidate domains in preference order: every pattern on .com, then .net, then .co. */
export function candidateDomains(mainDomain, patterns, tlds) {
  const b = baseLabel(mainDomain);
  if (!b) return [];
  const out = [];
  for (const tld of tlds) {
    for (const p of patterns) {
      const label = p.replace(/\{b\}/g, b).replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (label.length < 3 || label.length > 63) continue;
      const name = `${label}.${tld}`;
      if (!out.includes(name) && name !== mainDomain) out.push(name);
    }
  }
  return out;
}

export const tldOf = (name) => String(name).split('.').slice(1).join('.');

// ── price cache ─────────────────────────────────────────────────────────────

async function cachePrice(registrar, tld, price, source, now) {
  await kv.hset(K.priceCache(), { [`${registrar}:${tld}`]: JSON.stringify({ price, source, seenAt: now.toISOString() }) });
}

async function cachedPrice(registrar, tld) {
  const v = asObject(await kv.hget(K.priceCache(), `${registrar}:${tld}`).catch(() => null));
  return v && Number.isFinite(Number(v.price)) ? { price: Number(v.price), seenAt: v.seenAt, source: v.source } : null;
}

/**
 * First-year quotes for one TLD, cheapest first:
 * [{ registrar, name, price, seenAt, source, unconfirmed, code? }].
 * `livePorkbun` is the result of getPricing() or null when it failed.
 */
export async function registrarQuotes(tld, { livePorkbun, registrars, promos, today, now }) {
  const quotes = [];
  for (const [id, r] of Object.entries(registrars)) {
    let q = null;
    if (id === 'porkbun' && livePorkbun && Number.isFinite(livePorkbun[tld]?.registration)) {
      q = { price: livePorkbun[tld].registration, seenAt: now.toISOString(), source: 'porkbun api', unconfirmed: false };
      await cachePrice(id, tld, q.price, q.source, now);
    } else if (id === 'porkbun' && r.live) {
      const c = await cachedPrice(id, tld);
      if (c) q = { ...c, unconfirmed: true };
      else if (Number.isFinite(r.prices?.[tld])) q = { price: r.prices[tld], seenAt: r.seenAt, source: 'static table', unconfirmed: true };
    } else {
      const c = await cachedPrice(id, tld);
      if (c && (!r.seenAt || c.seenAt > r.seenAt)) q = { ...c, unconfirmed: false };
      else if (Number.isFinite(r.prices?.[tld])) q = { price: r.prices[tld], seenAt: r.seenAt, source: 'static table', unconfirmed: false };
    }
    if (q) quotes.push({ registrar: id, name: r.name, ...q });
  }
  for (const p of promos || []) {
    if (String(p.tld || '').replace(/^\./, '') !== tld) continue;
    if (!p.expiresAt || p.expiresAt < today || !Number.isFinite(Number(p.firstYearPrice))) continue;
    quotes.push({ registrar: p.registrar, name: `${registrars[p.registrar]?.name || p.registrar} (promo ${p.code})`, price: Number(p.firstYearPrice), code: p.code, seenAt: p.seenAt || null, source: 'promo', unconfirmed: false, expiresAt: p.expiresAt });
  }
  const order = Object.keys(registrars);
  return quotes.sort((a, b) => a.price - b.price || order.indexOf(a.registrar) - order.indexOf(b.registrar));
}

/** Inbox providers that allow app passwords with minOrder ≤ n, cheapest first, top two. */
export function inboxQuotes(providers, need = 2) {
  return providers
    .filter((p) => p.allowsAppPasswords === true && (p.minOrder == null || p.minOrder <= need) && Number.isFinite(Number(p.pricePerMonth)))
    .sort((a, b) => a.pricePerMonth - b.pricePerMonth || (a.rank || 99) - (b.rank || 99))
    .slice(0, 2)
    .map((p) => ({ id: p.id, name: p.name, url: p.url, pricePerMonth: p.pricePerMonth, seenAt: p.seenAt }));
}

/** Two sender addresses from the profile: {prefix}@domain and a second variant from the sender name. */
export function senderAddresses(profile, domain) {
  const prefix = String(profile.senderPrefix || '').toLowerCase().replace(/[^a-z.]/g, '');
  const parts = String(profile.senderName || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const first = prefix || parts[0] || '';
  if (!first) return [];
  const alts = [];
  if (parts.length > 1) alts.push(`${parts[0][0]}${parts[parts.length - 1]}`, `${parts[0]}.${parts[parts.length - 1]}`);
  alts.push(`${first}.team`);
  const second = alts.find((a) => a && a !== first) || `${first}2`;
  return [`${first}@${domain}`, `${second}@${domain}`];
}

// ── availability ────────────────────────────────────────────────────────────

/**
 * Check candidates in order until `want` are available (or time runs out).
 * Returns [{ name, available: true|false|null, source, price? }] for every name checked.
 */
export async function checkAvailability(names, { want = 3, deadline = Date.now() + 12000 } = {}) {
  const results = [];
  const keys = porkbunKeys();
  let porkbunDown = !keys;
  const batch = 4;
  for (let i = 0; i < names.length; i += batch) {
    if (results.filter((r) => r.available === true).length >= want || Date.now() > deadline - 3000) break;
    const slice = names.slice(i, i + batch);
    const rows = await Promise.all(slice.map(async (name) => {
      if (!porkbunDown) {
        try {
          const r = await checkDomain(name);
          return { name, available: r.available, price: r.price, source: 'porkbun' };
        } catch {
          porkbunDown = true;
        }
      }
      return { name, available: await rdapAvailable(name), source: 'rdap' };
    }));
    results.push(...rows);
  }
  return results;
}

// ── the shopping list ───────────────────────────────────────────────────────

function money(n) { return Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : 'unknown'; }

/** Pure builder so the ranking rules can be tested without KV or network. */
export function buildShoppingList({ availability, quotesByTld, inboxes, profile, backups = 2, inboxesPerTrial = 2 }) {
  const free = availability.filter((a) => a.available === true).map((a) => a.name);
  const unknown = availability.filter((a) => a.available === null).map((a) => a.name);
  const ranked = [...free, ...unknown];
  const chosen = ranked[0] || null;
  const tld = chosen ? tldOf(chosen) : null;
  const regQuotes = tld ? (quotesByTld[tld] || []) : [];
  const bestReg = regQuotes[0] || null;
  const bestInbox = inboxes[0] || null;
  const unconfirmed = [];
  if (chosen && unknown.includes(chosen)) unconfirmed.push(`availability of ${chosen}`);
  if (bestReg?.unconfirmed) unconfirmed.push(`${bestReg.name} .${tld} price (last seen ${bestReg.seenAt || 'never'})`);
  if (!bestReg && chosen) unconfirmed.push(`no registrar price known for .${tld}`);
  if (!bestInbox) unconfirmed.push('no inbox provider matches (app passwords, min order ≤ 2)');
  const total = bestReg && bestInbox ? Math.round((bestReg.price + inboxesPerTrial * bestInbox.pricePerMonth) * 100) / 100 : null;
  return {
    chosenDomain: chosen,
    backups: ranked.slice(1, 1 + backups),
    registrarQuotes: regQuotes,
    inboxQuotes: inboxes,
    senderAddresses: chosen ? senderAddresses(profile, chosen) : [],
    total,
    unconfirmed,
  };
}

/**
 * The owner's shopping_list text: the top 3 domains with the cheapest
 * registrar and price (+ its search link), every registrar's price for the
 * top domain's TLD, the CheapInboxes line with the users, the total.
 */
export function shoppingText(client, list, { autoBought = null, link }) {
  const offers = list.offers || [];
  const top = offers[0] || null;
  const inb = list.inboxes || null;
  const lines = [`Shopping list for ${client.name || client.id} (${client.mainDomain}).`, ''];
  if (autoBought) lines.push(`Domain: ${autoBought.name} — ALREADY BOUGHT at Porkbun for ${money(autoBought.price)}, auto-renew off.`);
  else if (!offers.length) lines.push('Domain: no available lookalike found — pick one by hand.');
  else {
    lines.push('Best domains (first-year price at the cheapest of the five registrars):');
    offers.slice(0, 3).forEach((o, i) => {
      const b = o.best;
      lines.push(`${i + 1}. ${o.domain}${o.available === null ? ' (availability unconfirmed)' : ''} — ${b ? `${b.registrar} ${money(b.firstYear)}${b.renewal != null ? `, renews ${money(b.renewal)}` : ''}${b.url ? ` · ${b.url}` : ''}` : 'no price known'}`);
    });
    if (top) lines.push(`.${top.tld} at all five (first year / renewal): ${top.prices.map((p) => `${p.registrar} ${money(p.firstYear)}/${money(p.renewal)}${p.source === 'live' ? ' (live)' : ''}`).join(' · ')}`);
    const promos = top ? top.prices.filter((p) => p.promo) : [];
    if (promos.length) lines.push(`Promo codes (not counted, may have ended): ${promos.map((p) => `${p.registrar} ${p.promo.code} → ${money(p.promo.firstYear)}${p.promo.note ? ` (${p.promo.note})` : ''}`).join(' · ')}`);
    lines.push('Turn auto-renew OFF when you buy it.');
  }
  lines.push(inb
    ? `Inboxes: ${inb.provider} — ${inb.count} × ${money(inb.perInbox)} = ${money(inb.monthly)} a month (Google Workspace, no setup fee).`
    : 'Inboxes: provider price unknown.');
  lines.push(`Users: ${(list.users || []).length ? list.users.map((u) => `${u.name || '(sender name not set)'} → ${u.email}`).join('; ') : 'set the sender name/prefix on the onboarding page first'}`);
  lines.push(`Total: ${list.total != null ? `${money(list.total)} (domain first year + ${inb?.count || 2} inboxes, first month)` : 'unknown'}`);
  if (list.unconfirmed.length) lines.push('', `Unconfirmed: ${list.unconfirmed.join('; ')}`);
  lines.push('', `The CheapInboxes steps, every price and the paste form: ${link}`);
  return lines.join('\n');
}

/**
 * Domain availability + prices + inboxes for a client → the list (no side
 * effects beyond the RDAP / price caches). `exclude` drops names (e.g. a
 * burned domain). `complete` is false while fewer than DOMAINS.offersMax
 * free names are known and unchecked candidates remain.
 */
export async function computeShoppingList(clientId, client, { deadline = Date.now() + 15000, now = io.now(), exclude = [] } = {}) {
  const profile = await getProfile(clientId);
  const tlds = allowedTlds(await cfg(clientId, 'ALLOWED_TLDS'), await cfg(clientId, 'BANNED_TLDS')).filter((t) => V2_TLDS.includes(t));
  const price = await cfg(clientId, 'PRICE');
  const D = await cfg(clientId, 'DOMAINS');
  const P = await cfg(clientId, 'INBOX_PROVIDER');
  const ranked = rankCandidates(client.mainDomain, D, tlds).filter((c) => !exclude.includes(c.domain));

  let live = await livePrices();
  try { live = { ...live, porkbun: await refreshLivePrices({ now }) }; } catch (err) { await logEvent(clientId, SYSTEM, 'porkbun_pricing_failed', { error: String(err.message).slice(0, 200) }); }
  // Registrars in one stable order everywhere (cheapest .com first), so price columns line up.
  const table = await cfg(clientId, 'REGISTRARS');
  const comOrder = registrarList(table, priceRows(table, 'com', { live, now, D })).map((r) => r.name);
  const registrars = [...table].sort((a, b) => comOrder.indexOf(a.name) - comOrder.indexOf(b.name));

  const availability = {};
  let limited = false;
  const batch = 6;
  for (let i = 0; i < ranked.length; i += batch) {
    if (Object.values(availability).filter((a) => a.available === true).length >= D.offersMax) break;
    if (Date.now() > deadline - 3000) break;
    const r = await checkNames(ranked.slice(i, i + batch).map((c) => c.domain), { D, deadline, now });
    Object.assign(availability, r.results);
    if (r.limited) { limited = true; break; }
  }
  const freeCount = Object.values(availability).filter((a) => a.available === true).length;
  const complete = freeCount >= D.offersMax || ranked.every((c) => availability[c.domain]);

  const offersRaw = buildOffers(ranked, availability, { registrars, live, now, D, min: D.offersMin, max: D.offersMax });
  const top = offersRaw[0] || null;
  const chosen = top?.domain || null;
  const senders = chosen ? senderAddresses(profile, chosen) : [];
  const users = inboxUsers(senders, profile);
  const inboxes = inboxPlan(P, { domain: chosen, mainDomain: client.mainDomain, users });
  const comRows = priceRows(registrars, 'com', { live, now, D });
  const totals = totalsOf(offersRaw, inboxes);

  const unconfirmed = [];
  if (!chosen) unconfirmed.push('no available domain found among the candidates — pick one by hand');
  if (top && top.available === null) unconfirmed.push(`availability of ${chosen} (the registry did not answer)`);
  if (top?.best && top._stale.includes(top.best.registrar)) {
    const reg = registrars.find((r) => r.name === top.best.registrar);
    unconfirmed.push(`${top.best.registrar} .${top.tld} price is from the table checked ${reg?.checkedAt || 'on an unknown date'} — re-check at the registrar`);
  }
  if (top && !top.best) unconfirmed.push(`no registrar price known for .${top.tld}`);
  if (inboxes.perInbox === null) unconfirmed.push(`${P.name} price per inbox`);
  if (!users.length && chosen) unconfirmed.push('sender name / prefix not set yet (inbox user names)');

  const legacyQuotes = top
    ? priceRows(registrars, top.tld, { live, now, D, domain: top.domain })
      .filter((p) => p.firstYear !== null)
      .map((p) => ({ registrar: p.id, name: p.registrar, price: p.firstYear, renewal: p.renewal, seenAt: p.confirmedAt, source: p.source, unconfirmed: p.stale, url: p.url }))
      .sort((a, b) => a.price - b.price || (a.renewal ?? Infinity) - (b.renewal ?? Infinity))
    : [];
  const offers = offersRaw.map(({ _stale, ...o }) => o);
  const list = {
    offers,
    registrars: registrarList(registrars, comRows),
    inboxes,
    totals,
    users,
    chosenDomain: chosen,
    backups: offers.slice(1, 1 + price.backups).map((o) => o.domain),
    registrarQuotes: legacyQuotes,
    inboxQuotes: inboxes.perInbox === null ? [] : [{ id: P.id, name: P.name, url: P.url, pricePerMonth: inboxes.perInbox, seenAt: P.checkedAt }],
    senderAddresses: senders,
    total: totals.firstMonth,
    unconfirmed,
  };
  const checked = ranked.filter((c) => availability[c.domain]).map((c) => ({ name: c.domain, available: availability[c.domain].available, source: availability[c.domain].source, score: c.score }));
  return { profile, availability: checked, list, complete, limited };
}

/**
 * A new shopping list as text for the Emergency Runner's burned-domain alert
 * (SPEC §8.10 step 4). Does not change state or send anything itself.
 */
export async function replacementShoppingList(clientId, { deadline = Date.now() + 12000, now = io.now(), exclude = [] } = {}) {
  const client = await getClient(clientId);
  const { list } = await computeShoppingList(clientId, client, { deadline, now, exclude });
  return shoppingText(client, list, { link: `${baseUrl()}/mc/clients/${clientId}/purchase` });
}

/**
 * Build and send the shopping list for a client in awaiting_purchase.
 * Idempotent: once shopping.sentAt is set nothing is re-sent.
 */
export async function runPriceScout(clientId, { deadline = Date.now() + 15000, now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'awaiting_purchase') return { skipped: `state ${client?.state}` };
  const existing = (await kv.hgetall(K.shopping(clientId))) || {};
  if (existing.sentAt) { await updateClient(clientId, { intakeStep: '' }); return { skipped: 'already sent' }; }

  const { profile, availability, list, complete, limited } = await computeShoppingList(clientId, client, { deadline, now });
  if (!complete) {
    // Keep going next minute (the RDAP cache keeps every answer); after
    // MAX_SCOUT_RUNS runs the list goes out with what is known.
    const runs = (Number(existing.scoutRuns) || 0) + 1;
    await kv.hset(K.shopping(clientId), { scoutRuns: runs });
    if (runs < MAX_SCOUT_RUNS) return { status: 'running', checked: availability.length, rdapLimited: limited };
    await logEvent(clientId, SYSTEM, 'availability_partial', { checked: availability.length, runs });
  }

  const autoBought = await maybeAutoBuy(clientId, list, { now });
  const link = `${baseUrl()}/mc/clients/${clientId}/purchase`;

  // Claim before sending so two ticks can never send two lists.
  const claimed = await kv.set(K.onceClaim('shopping_list', clientId, 'sent'), now.toISOString(), { nx: true, ex: 400 * 86400 });
  if (claimed !== 'OK') return { skipped: 'claimed' };

  await kv.hset(K.shopping(clientId), {
    domainCandidates: JSON.stringify(availability),
    chosenDomain: list.chosenDomain || '',
    backups: JSON.stringify(list.backups),
    registrarQuotes: JSON.stringify(list.registrarQuotes),
    inboxQuotes: JSON.stringify(list.inboxQuotes),
    senderAddresses: JSON.stringify(list.senderAddresses),
    total: list.total ?? '',
    unconfirmed: JSON.stringify(list.unconfirmed),
    autoBought: autoBought ? JSON.stringify(autoBought) : '',
    offers: JSON.stringify(list.offers),
    registrars: JSON.stringify(list.registrars),
    inboxes: JSON.stringify(list.inboxes),
    totals: JSON.stringify(list.totals),
    builtAt: now.toISOString(),
    scoutRuns: 0,
  });

  const body = shoppingText(client, list, { autoBought, link });
  const alert = await io.alertOwner('shopping_list', { clientId, vars: { clientId }, body, did: `Market passed (${profile.marketEstimate || 'override'}). ${autoBought ? 'Domain bought automatically; only the inboxes are left.' : 'Nothing bought yet.'}` });
  if (!alert.sent && !alert.deduped) {
    await kv.del(K.onceClaim('shopping_list', clientId, 'sent'));
    throw new Error('shopping_list alert could not be delivered');
  }
  await kv.hset(K.shopping(clientId), { sentAt: now.toISOString() });
  await updateClient(clientId, { intakeStep: '' });
  await logEvent(clientId, SYSTEM, 'shopping_list_sent', { chosenDomain: list.chosenDomain, total: list.total, unconfirmed: list.unconfirmed.length });

  try {
    await sendClient(clientId, 'setup_in_progress', { firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId) }, { dedupe: 'setup_in_progress' });
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'setup_in_progress_failed', { error: String(err.message).slice(0, 200) });
  }
  return { sent: true, chosenDomain: list.chosenDomain, total: list.total, autoBought: Boolean(autoBought) };
}

// ── Auto-Buyer ──────────────────────────────────────────────────────────────

async function maybeAutoBuy(clientId, list, { now }) {
  if (String(process.env.AUTO_BUY || '').toLowerCase() !== 'true' || !porkbunKeys() || !list.chosenDomain) return null;
  const name = list.chosenDomain;
  const quote = list.registrarQuotes.find((q) => q.registrar === 'porkbun' && !q.code);
  const claimKey = K.onceClaim('autobuy', clientId, name);
  const claimed = await kv.set(claimKey, now.toISOString(), { nx: true, ex: 400 * 86400 });
  if (claimed !== 'OK') return null;
  try {
    const check = await checkDomain(name);
    if (!check.available) throw new Error(`${name} is not available at Porkbun`);
    const cost = check.price || quote?.price;
    if (!Number.isFinite(cost)) throw new Error('no Porkbun price for the domain');
    const margin = await cfg(clientId, 'PRICE.autoBuyMarginUsd');
    const bal = await balance();
    if (bal < cost + margin) throw new Error(`Porkbun credit ${money(bal)} is below ${money(cost + margin)}`);
    await createDomain(name, { cost, dryRun: true });
    await createDomain(name, { cost });
    await setAutoRenewOff(name);
    await kv.hset(K.domain(clientId), { name, registrar: 'porkbun', purchasedAt: now.toISOString(), price: cost, autoRenew: 'false', boughtBy: 'autobuyer' });
    await logEvent(clientId, SYSTEM, 'autobuy_done', { name, price: cost });
    return { name, price: cost };
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'autobuy_failed', { name, error: String(err.message).slice(0, 200) });
    await io.alertOwner('autobuy_failed', { clientId, vars: { domain: name }, body: `Auto-buy of ${name} failed: ${String(err.message).slice(0, 300)}`, did: 'Fell back to the manual shopping list; nothing was charged unless Porkbun says otherwise — check the account before buying by hand.' });
    return null;
  }
}

// ── hourly purchase nudge ───────────────────────────────────────────────────

/** 12 h without boughtAt → purchase_reminder; 48 h → purchase_reminder again as escalation. */
export async function runPurchaseNudge({ clientId, now = io.now() }) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'awaiting_purchase') return { skipped: 'state' };
  const shop = (await kv.hgetall(K.shopping(clientId))) || {};
  if (!shop.sentAt || shop.boughtAt) return { skipped: shop.boughtAt ? 'bought' : 'not sent' };
  const hours = (now.getTime() - Date.parse(shop.sentAt)) / 3600e3;
  const [first, second] = await cfg(clientId, 'PURCHASE.reminderHours');
  const link = `${baseUrl()}/mc/clients/${clientId}/purchase`;
  // With CheapInboxes connected (docs/AUTO-BUY.md) he only buys; the machine finds the purchase and connects it.
  const how = (await cheapInboxesConnected())
    ? `Buy them on CheapInboxes — the hub shows exactly which domain and inboxes (${await cfg(null, 'CHEAPINBOXES.orderUrl')}). The machine connects everything after.`
    : `Paste the logins: ${link}`;
  if (hours >= second && !shop.escalatedAt) {
    await io.alertOwner('purchase_reminder', { clientId, scope: `${clientId}:${second}`, vars: { clientId, hours: second }, body: `The domain and inboxes for ${client.name || clientId} are still not bought, ${second} hours after the shopping list (${shop.chosenDomain || 'see list'}).\n${how}`, did: 'Escalated: this also heads the morning digest until the purchase is in.' });
    await kv.hset(K.shopping(clientId), { escalatedAt: now.toISOString(), reminded12At: shop.reminded12At || now.toISOString() });
    return { escalated: true };
  }
  if (hours >= first && !shop.reminded12At) {
    await io.alertOwner('purchase_reminder', { clientId, scope: `${clientId}:${first}`, vars: { clientId, hours: first }, body: `Still to buy for ${client.name || clientId}: ${shop.chosenDomain || 'the domain'} and 2 inboxes.\n${how}`, did: `Reminder ${first} h after the shopping list.` });
    await kv.hset(K.shopping(clientId), { reminded12At: now.toISOString() });
    return { reminded: true };
  }
  return { hours: Math.round(hours) };
}

// ── monthly: promo expiry + Cloudflare refresh ──────────────────────────────

/** Parse the .com first-year price from tld-list.com's Cloudflare page. null when not found. */
export function parseCloudflareCom(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/(?:^|\s)\.?com\s+(?:[^$]{0,80}?)\$\s?(\d{1,3}\.\d{2})/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 1 && n < 100 ? n : null;
}

export async function runPromoCheck({ now = io.now() } = {}) {
  const today = dayKeyIn(ET, now);
  const promos = await cfg(null, 'promos');
  const expired = (promos || []).filter((p) => p.expiresAt && p.expiresAt < today);
  await kv.set(K.promoFlags(), { checkedAt: now.toISOString(), expired }, { ex: 40 * 86400 });
  for (const p of expired) {
    await io.alertOwner('promo_expired', { scope: `${p.registrar}:${p.code}`, vars: { registrar: p.registrar, code: p.code }, body: `Promo ${p.code} at ${p.registrar} for .${p.tld} expired on ${p.expiresAt}.`, did: 'Price Scout no longer uses it. Remove or update it in /mc/config.' });
  }
  let cloudflare = null;
  try {
    const res = await io.fetchExt('https://tld-list.com/registrars/cloudflare', { timeoutMs: 10000, retry: false, headers: { 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' } });
    if (res.ok) cloudflare = parseCloudflareCom(await res.text());
  } catch {}
  if (cloudflare) await cachePrice('cloudflare', 'com', cloudflare, 'tld-list.com', now);
  await logEvent(null, SYSTEM, 'promo_check', { expired: expired.length, cloudflareCom: cloudflare });
  return { expired: expired.length, cloudflareCom: cloudflare };
}

/**
 * Shopping list as stored, parsed (the purchase page and docs/HUB-API.md
 * `shopping`). Two reads, nothing recomputed per view: offers, registrars,
 * inboxes and totals were stored when the list was built.
 */
export async function getShopping(clientId) {
  const s = (await kv.hgetall(K.shopping(clientId))) || {};
  const { scoutRuns, ...rest } = s;
  return {
    ...rest,
    domainCandidates: asArray(s.domainCandidates),
    backups: asArray(s.backups),
    registrarQuotes: asArray(s.registrarQuotes),
    inboxQuotes: asArray(s.inboxQuotes),
    senderAddresses: asArray(s.senderAddresses),
    unconfirmed: asArray(s.unconfirmed),
    autoBought: asObject(s.autoBought),
    offers: asArray(s.offers).filter((o) => o && typeof o === 'object'),
    registrars: asArray(s.registrars).filter((r) => r && typeof r === 'object'),
    inboxes: asObject(s.inboxes),
    totals: asObject(s.totals),
    domain: await getDomain(clientId),
  };
}

/** docs/HUB-API.md `shopping` for one client (same object the purchase API returns). */
export const shoppingView = (clientId) => getShopping(clientId);
