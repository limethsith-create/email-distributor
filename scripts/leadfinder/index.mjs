// Lead Finder (SPEC §7.2, Leads v2). Runs in GitHub Actions (Node 20, no npm deps):
//   node scripts/leadfinder/index.mjs
// env: APP_URL, LEADFINDER_TOKEN, PLACES_API_KEY,
//      CLIENT_PAYLOAD (the repository_dispatch client_payload JSON), GITHUB_RUN_ID
//
// 1 search (Places Enterprise mask incl. rating / reviews / business status;
//   Overpass fallback)
// 2 filter: no site, closed, blocklist, chains + franchises (host list, brand
//   names, location-page URLs, one host on 3+ listings), duplicate host,
//   outside the US or the client's area, excluded pattern, another client in
//   the same niche within 90 days
// 3 crawl: home page + the people / contact pages it links to (robots.txt)
// 4 contacts: named decision-makers best-titled first (one per company unless
//   the profile asks for more), never a role address; a name without an
//   address gets candidates from the company's own address pattern
// 5 local checks: syntax, disposable, MX — the app's verification waterfall
//   does the API checks (every lead posts as verifyStatus: pending)
// 6 facts + signals for the grader and the first line
// 7 post batches of 100 to /api/webhooks/leadfinder with the reject counts.
// Nothing here logs a secret; failures post {type:'failed'} and exit 1.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  queryPlan, pickContacts, splitName, isRoleAddress, titleApproved, dreamMatch, scoreLead, tzForState, hostOf, areaStates,
} from './lib.mjs';
import { placesTextSearch, placesCityViewport, gridCells, overpassSearch } from './sources.mjs';
import { crawlSite } from './crawl.mjs';
import { localCheck } from './verify.mjs';
import { franchiseBrand, isLocationPageUrl, isNonUsHost, normState, normCompany, isFreemail } from '../../src/lib/leadquality/rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/)).map((s) => String(s).trim()).filter(Boolean);
const normName = normCompany;

export function loadChains(file = path.join(here, '../../config/chains.txt')) {
  try {
    return new Set(readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  } catch {
    return new Set();
  }
}

/**
 * Step 2 (pure). Returns { kept, dropped: {reason: n} }.
 * `area` (a Set of state codes) drops candidates outside the client's states.
 */
export function filterCandidates(cands, { blockedHosts = [], blockedNames = [], chains = new Set(), exclude = {}, area = null, multiLocationMin = 3 } = {}) {
  const dropped = {};
  const drop = (r) => { dropped[r] = (dropped[r] || 0) + 1; };
  const bh = new Set(blockedHosts.map((h) => String(h).toLowerCase()));
  const bn = new Set(blockedNames.map(normName));
  const exHosts = new Set(list(exclude.hosts));
  const exTypes = new Set(list(exclude.types));
  // One website behind 3+ listings = a multi-location business or a franchise system.
  const hostCount = new Map();
  for (const c of cands) { const h = c.host || hostOf(c.website); if (h) hostCount.set(h, (hostCount.get(h) || 0) + 1); }
  const seen = new Set();
  const kept = [];
  for (const c of cands) {
    const host = c.host || hostOf(c.website);
    if (!host) { drop('no_website'); continue; }
    if (seen.has(host)) { drop('duplicate_host'); continue; }
    seen.add(host);
    if (/^CLOSED/i.test(c.businessStatus || '')) { drop('closed'); continue; }
    if (bh.has(host) || bn.has(normName(c.company))) { drop('blocklist'); continue; }
    if (chains.has(host) || franchiseBrand(c.company) || (c.brand && franchiseBrand(c.brand)) || isLocationPageUrl(c.website, c.city) || (hostCount.get(host) || 0) >= multiLocationMin) { drop('chain'); continue; }
    if (exHosts.has(host) || (c.types || []).some((t) => exTypes.has(t))) { drop('excluded_pattern'); continue; }
    if (exclude.requireState && !c.state) { drop('no_state'); continue; }
    if (isNonUsHost(host) || (c.state && !normState(c.state))) { drop('out_of_area'); continue; }
    if (area && area.size && c.state && !area.has(normState(c.state))) { drop('out_of_area'); continue; }
    kept.push({ ...c, host, state: normState(c.state) || c.state || '' });
  }
  return { kept, dropped };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  let stop = false;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!stop && i < items.length) {
      const idx = i++;
      const r = await fn(items[idx], () => { stop = true; });
      if (r) out.push(r);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Facts for the first line and the grader, from Places + the crawl (no personal data). */
export function factsOf(cand, site) {
  const f = site.facts || {};
  const now = new Date().getUTCFullYear();
  const since = Number(f.since) && f.since >= 1900 && f.since <= now - 2 ? f.since : null;
  const svc = (site.services || []).slice(0, 5);
  return {
    services: svc.map((s) => s.label),
    servicePage: svc[0] ? { label: svc[0].label, path: svc[0].path } : null,
    since,
    years: since ? now - since : (Number(f.yearsClaim) || null),
    rating: cand.rating ?? f.siteRating ?? null,
    reviews: cand.reviews ?? f.siteReviews ?? null,
    ratingSource: cand.rating != null ? 'google' : (f.siteRating ? 'site' : null),
    primaryType: cand.primaryType || '',
  };
}

export function signalsOf(site) {
  const f = site.facts || {};
  const all = [...(site.mailtos || []).map((m) => m.email), ...(site.emails || [])];
  return {
    https: site.https,
    copyrightYear: f.copyrightYear || null,
    viewport: Boolean(f.viewport),
    hasAddress: Boolean(f.hasAddress),
    hasPhone: Boolean(f.hasPhone),
    metaDescription: Boolean(f.metaDescription),
    hiring: Boolean(f.hiring),
    expansion: Boolean(f.expansion),
    franchise: Boolean(f.franchise),
    freemailContact: all.some((e) => isFreemail(e)),
    pagesRead: (site.pages || []).length,
  };
}

/**
 * Steps 3–6 for one candidate → { leads: [...], reject: reason|null }.
 * `contactsPerCompany` (profile) caps the contacts per company (default 1).
 */
export async function buildLeads(cand, { profile = {}, approvedTitles = [], excludedTitles = [], fetchImpl = fetch, resolveMx, contactsPerCompany = 1, crawl = {} } = {}) {
  const site = await crawlSite(cand.host, { fetchImpl, ...crawl });
  if (!site.pages.length) return { leads: [], reject: 'site_unreachable' };
  if (site.facts?.franchise) return { leads: [], reject: 'chain' };
  const found = { ...site, emails: [...site.emails, ...(cand.email ? [String(cand.email).toLowerCase()] : [])] };
  const excluded = (t) => t && excludedTitles.some((x) => String(t).toLowerCase().includes(String(x).toLowerCase()));
  let contacts = pickContacts(found, cand.host, approvedTitles, { max: Math.max(1, contactsPerCompany) + 2 }).filter((c) => !excluded(c.title));
  contacts = contacts.slice(0, Math.max(1, contactsPerCompany));
  if (!contacts.length) {
    const anyRole = [...site.mailtos.map((m) => m.email), ...found.emails].some((e) => isRoleAddress(e));
    return { leads: [], reject: anyRole ? 'role' : 'no_name' };
  }
  const leads = [];
  let lastReject = null;
  for (const c of contacts) {
    // Local checks on every candidate: drop the bad ones, keep the order.
    const ok = [];
    for (const e of c.candidates) {
      const r = await localCheck(e, resolveMx ? { resolveMx } : {});
      if (r.status !== 'invalid') ok.push(e);
      else lastReject = r.reason === 'no_mx' ? 'no_mx' : 'invalid_email';
    }
    if (!ok.length) continue;
    const named = Boolean(c.name);
    const { firstDisplay } = named ? splitName(c.name) : { firstDisplay: c.firstName || '' };
    const email = ok[0];
    const lead = {
      email,
      emailCandidates: ok.slice(1),
      emailGuessed: c.emailSource === 'guess' || c.emailSource === 'pattern',
      emailSource: c.emailSource || '',
      pattern: c.pattern || null,
      patternFrom: c.patternFrom || null,
      first_name: firstDisplay || '',
      name: c.name || '',
      nameSource: c.nameSource || '',
      linkedinHint: Boolean(c.linkedinHint),
      title: c.title || '',
      company: cand.company,
      website: cand.website,
      host: cand.host,
      address: cand.address || '',
      city: cand.city || '',
      state: cand.state || '',
      zip: cand.zip || '',
      phone: cand.phone || '',
      tz: tzForState(cand.state),
      types: cand.types || [],
      employees: site.employees,
      placeId: cand.placeId,
      query: cand.query || '',
      source: `leadfinder:${cand.source}`,
      foundOn: c.emailSource === 'mailto' ? (site.mailtos.find((m) => m.email === email)?.page || '') : (c.nameSource || ''),
      facts: factsOf(cand, site),
      signals: signalsOf(site),
      verifyStatus: 'pending',
      riskLevel: 'risky',
      isRole: false,
      hasNamedPerson: named,
      titleApproved: named ? titleApproved(c.title, approvedTitles) : false,
    };
    lead.dreamMatch = dreamMatch(lead, profile.dreamCustomers || []);
    lead.score = scoreLead(lead);
    leads.push(lead);
  }
  return { leads, reject: leads.length ? null : (lastReject || 'invalid_email') };
}

/** v1 signature: the best lead for a candidate, or null. */
export async function buildLead(cand, opts = {}) {
  const { leads } = await buildLeads(cand, opts);
  return leads[0] || null;
}

export async function run({ env = process.env, fetchImpl = fetch, resolveMx = undefined, log = console.log, crawl = {} } = {}) {
  const app = String(env.APP_URL || '').replace(/\/+$/, '');
  const token = env.LEADFINDER_TOKEN;
  const payload = JSON.parse(env.CLIENT_PAYLOAD || '{}');
  const runId = String(env.GITHUB_RUN_ID || `local-${Date.now()}`);
  const clientId = payload.clientId;
  if (!app || !token || !clientId) throw new Error('APP_URL, LEADFINDER_TOKEN and client_payload.clientId are required');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = async (body) => {
    const res = await fetchImpl(`${app}/api/webhooks/leadfinder`, { method: 'POST', headers: auth, body: JSON.stringify({ clientId, runId, mode: payload.mode || 'initial', ...body }), signal: AbortSignal.timeout(60000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`webhook ${res.status}: ${j.error || ''}`);
    return j;
  };

  try {
    const pr = await fetchImpl(`${app}/api/clients/${encodeURIComponent(clientId)}/profile`, { headers: auth, signal: AbortSignal.timeout(30000) });
    if (!pr.ok) throw new Error(`profile ${pr.status}`);
    const info = await pr.json();
    const profile = info.profile || {};
    const need = Number(payload.need || info.need) || 400;
    const exclude = { ...(info.exclude || {}), ...(payload.exclude || {}) };
    const widen = Boolean(payload.widen || payload.mode === 'widen');
    const approvedTitles = list(profile.titles);
    const excludedTitles = [...list(profile.excludedTitles), ...list(exclude.titles)];
    const contactsPerCompany = Math.max(1, Math.min(3, Number(profile.contactsPerCompany) || 1));

    // Collect more contacts than needed: some fail verification or are catch-all.
    const findTarget = Math.ceil(need * Math.max(1, Math.min(3, Number(payload.overshoot || info.overshoot) || 1)));

    // 1. search
    const target = findTarget * 3;
    const b = info.budget || {};
    let placesBudget = Math.max(0, Math.floor((Number(b.placesLimit) || 0) * (Number(b.placesStopRatio) || 0.8)) - (Number(b.placesUsed) || 0));
    let placesUnreported = 0;
    let placesTotal = 0;
    const cands = [];
    const byId = new Set();
    const add = (list2) => { for (const p of list2) if (!byId.has(p.placeId)) { byId.add(p.placeId); cands.push(p); } };
    const plan = queryPlan(profile, { widen });
    const viewports = new Map();
    let proUnreported = 0;
    if (env.PLACES_API_KEY) {
      search: for (const { q, kw, city, state } of plan) {
        if (cands.length >= target || placesBudget <= 0) break;
        const r = await placesTextSearch(q, { apiKey: env.PLACES_API_KEY, fetchImpl, budgetLeft: placesBudget });
        placesBudget -= r.requests;
        placesUnreported += r.requests;
        placesTotal += r.requests;
        add(r.places.map((p) => ({ ...p, query: q })));
        if (r.error) { log(`places: ${r.error} — switching to OpenStreetMap`); break; }
        // 60 results = Text Search's cap: there are more. Search the city cell by cell.
        if (r.places.length >= 60 && city && state && cands.length < target && placesBudget >= 3) {
          const key = `${city}|${state}`;
          if (!viewports.has(key)) {
            const v = await placesCityViewport(city, state, { apiKey: env.PLACES_API_KEY, fetchImpl });
            proUnreported += v.requests;
            viewports.set(key, v.viewport);
          }
          const vp = viewports.get(key);
          if (!vp) continue;
          for (const rect of gridCells(vp, 3)) {
            if (cands.length >= target || placesBudget <= 0) break search;
            const g = await placesTextSearch(kw, { apiKey: env.PLACES_API_KEY, fetchImpl, budgetLeft: placesBudget, rectangle: rect });
            placesBudget -= g.requests;
            placesUnreported += g.requests;
            placesTotal += g.requests;
            add(g.places.map((p) => ({ ...p, query: q })));
            if (g.error) { log(`places grid: ${g.error}`); break search; }
          }
        }
      }
    }
    if (cands.length < target) {
      const kw = list(profile.industry)[0] || '';
      for (const c of list(profile.cities)) {
        if (cands.length >= target) break;
        const [city, st] = c.includes('|') ? c.split('|') : [c.replace(/,\s*[A-Z]{2}$/, ''), (/,\s*([A-Z]{2})$/.exec(c) || [])[1] || list(profile.states)[0] || ''];
        if (!st) continue;
        const r = await overpassSearch(kw, city.trim(), st.trim(), { fetchImpl });
        add(r.places.map((p) => ({ ...p, query: `${kw} in ${city.trim()}, ${st.trim()}` })));
      }
    }
    log(`search: ${cands.length} candidates, ${placesTotal} Places requests`);

    // 2. filter
    const area = areaStates(profile, { widen });
    const { kept, dropped } = filterCandidates(cands, { blockedHosts: info.blocklist?.hosts || [], blockedNames: info.blocklist?.names || [], chains: loadChains(), exclude, area });
    let fresh = kept;
    for (let i = 0; i < kept.length; i += 200) {
      const chunk = kept.slice(i, i + 200);
      const r = await post({ type: 'hosts', niche: info.niche, hosts: chunk.map((c) => c.host) });
      const taken = new Set(r.taken || []);
      if (taken.size) { fresh = fresh.filter((c) => !taken.has(c.host)); dropped.other_client = (dropped.other_client || 0) + taken.size; }
    }
    log(`filter: kept ${fresh.length}; dropped ${JSON.stringify(dropped)}`);

    // 3–6. crawl, contacts, local checks, facts — post every 100
    let rejects = { ...dropped };
    let batchNo = 0;
    let found = 0;
    let pending = [];
    let stopped = false;
    const people = new Set(); // host|name — the same person twice (two listings) is one lead
    const flush = async (final = false) => {
      if (!pending.length && !final) return;
      const leads = pending.sort((a, c) => c.score - a.score);
      pending = [];
      if (leads.length) {
        batchNo++;
        const r = await post({ type: 'batch', batchNo, leads, placesRequests: placesUnreported, placesProRequests: proUnreported, rejects });
        placesUnreported = 0;
        proUnreported = 0;
        rejects = {};
        if (r.stop) stopped = true;
      }
    };
    await pool(fresh, 6, async (cand, stop) => {
      if (stopped || found >= findTarget) { stop(); return null; }
      let res = { leads: [], reject: 'crawl_error' };
      try { res = await buildLeads(cand, { profile, approvedTitles, excludedTitles, fetchImpl, resolveMx, contactsPerCompany, crawl }); } catch (err) { log(`crawl ${cand.host}: ${err.message}`); }
      if (res.reject) rejects[res.reject] = (rejects[res.reject] || 0) + 1;
      for (const lead of res.leads) {
        const key = `${lead.host}|${String(lead.name || lead.email).toLowerCase()}`;
        if (people.has(key)) { rejects.duplicate_person = (rejects.duplicate_person || 0) + 1; continue; }
        people.add(key);
        found++;
        pending.push(lead);
      }
      if (pending.length >= 100) await flush();
      return null;
    });
    if (!stopped) await flush(true);
    await post({ type: 'done', found, candidates: cands.length, kept: fresh.length, dropped, rejects, placesRequests: placesUnreported, placesProRequests: proUnreported, short: found < need, stopped });
    log(`done: ${found} leads in ${batchNo} batches${stopped ? ' (stopped by the app)' : ''}`);
    return { found, batches: batchNo, stopped };
  } catch (err) {
    try { await post({ type: 'failed', error: String(err.message || err).slice(0, 300) }); } catch {}
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().then(() => process.exit(0)).catch((err) => { console.error(`leadfinder failed: ${err.message}`); process.exit(1); });
}
