// Lead Finder (SPEC §7.2). Runs in GitHub Actions (Node 20, no npm deps):
//   node scripts/leadfinder/index.mjs
// env: APP_URL, LEADFINDER_TOKEN, PLACES_API_KEY, REOON_API_KEY,
//      CLIENT_PAYLOAD (the repository_dispatch client_payload JSON), GITHUB_RUN_ID
//
// 1 search (Places Enterprise mask; Overpass fallback) → 2 filter (no site,
// blocklist, chains, duplicate host, excluded pattern, other client same
// niche this month) → 3 crawl (6 pages, robots.txt) → 4 guess + check
// (syntax → MX → Reoon on guessed/role only) → 5 verify the rest → 6 score →
// 7 post batches of 100 to /api/webhooks/leadfinder.
// Nothing here logs a secret; failures post {type:'failed'} and exit 1.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildQueries, pickContact, splitName, guessPatterns, isRoleAddress, titleApproved, dreamMatch, scoreLead, tzForState, hostOf,
} from './lib.mjs';
import { placesTextSearch, overpassSearch } from './sources.mjs';
import { crawlSite } from './crawl.mjs';
import { syntaxOk, mxStatus, reoonVerify, reoonBudget } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/)).map((s) => String(s).trim()).filter(Boolean);
const normName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(the|inc|incorporated|llc|ltd|limited|co|corp|corporation|company|pllc|pc|lp|llp)\b/g, ' ').replace(/\s+/g, ' ').trim();

export function loadChains(file = path.join(here, '../../config/chains.txt')) {
  try {
    return new Set(readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  } catch {
    return new Set();
  }
}

/** Step 2 (pure). Returns { kept, dropped: {reason: n} }. */
export function filterCandidates(cands, { blockedHosts = [], blockedNames = [], chains = new Set(), exclude = {} } = {}) {
  const dropped = {};
  const drop = (r) => { dropped[r] = (dropped[r] || 0) + 1; };
  const bh = new Set(blockedHosts.map((h) => String(h).toLowerCase()));
  const bn = new Set(blockedNames.map(normName));
  const exHosts = new Set(list(exclude.hosts));
  const exTypes = new Set(list(exclude.types));
  const seen = new Set();
  const kept = [];
  for (const c of cands) {
    const host = c.host || hostOf(c.website);
    if (!host) { drop('no_website'); continue; }
    if (seen.has(host)) { drop('duplicate_host'); continue; }
    seen.add(host);
    if (bh.has(host) || bn.has(normName(c.company))) { drop('blocklist'); continue; }
    if (chains.has(host)) { drop('chain'); continue; }
    if (exHosts.has(host) || (c.types || []).some((t) => exTypes.has(t))) { drop('excluded_pattern'); continue; }
    if (exclude.requireState && !c.state) { drop('no_state'); continue; }
    kept.push({ ...c, host });
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

/**
 * Steps 3–6 for one candidate → a lead, or null.
 */
export async function buildLead(cand, { profile = {}, approvedTitles = [], excludedTitles = [], reoon, reoonKey, fetchImpl = fetch, resolveMx } = {}) {
  const site = await crawlSite(cand.host, { fetchImpl });
  const contact = pickContact(site, cand.host, approvedTitles);
  const extra = cand.email ? [cand.email] : [];
  const c = contact || (extra.length ? { kind: isRoleAddress(extra[0]) ? 'role' : 'email', email: extra[0], source: 'osm' } : null);
  if (!c) return null;
  if (c.title && excludedTitles.some((t) => String(c.title).toLowerCase().includes(String(t).toLowerCase()))) return null;

  const mx = await mxStatus(cand.host, resolveMx ? { resolveMx } : {});
  let email = c.email || '';
  let riskLevel = 'risky';
  let checkedBy = 'mx';
  const named = c.kind === 'person';
  const { first, last, firstDisplay } = named ? splitName(c.name) : { first: '', last: '', firstDisplay: '' };

  if (named && !email) {
    if (mx === 'none') return null;
    const guesses = guessPatterns(first, last, cand.host).filter(syntaxOk);
    if (!guesses.length) return null;
    if (reoonKey && reoon.left > 0) {
      let picked = null;
      for (const g of guesses) {
        if (!reoon.take()) break;
        const r = await reoonVerify(g, { apiKey: reoonKey, fetchImpl });
        if (r.status === 'valid') { picked = { email: g, risk: 'safe' }; break; }
        if (r.status === 'catchall') { picked = { email: guesses[0], risk: 'catchall' }; break; }
      }
      if (!picked) return null; // every guess checked came back invalid/unknown
      email = picked.email;
      riskLevel = picked.risk;
      checkedBy = 'reoon';
    } else {
      email = guesses[0];
      riskLevel = 'risky';
      checkedBy = 'guess';
    }
  } else {
    if (!syntaxOk(email)) return null;
    const emx = hostOf(email) === cand.host ? mx : await mxStatus(hostOf(email), resolveMx ? { resolveMx } : {});
    if (emx === 'none') return null;
    if (isRoleAddress(email) && reoonKey && reoon.take()) {
      const r = await reoonVerify(email, { apiKey: reoonKey, fetchImpl });
      if (r.status === 'invalid') return null;
      riskLevel = r.status === 'valid' ? 'safe' : r.status === 'catchall' ? 'catchall' : 'risky';
      checkedBy = 'reoon';
    } else {
      riskLevel = c.source === 'mailto' ? 'safe' : 'risky';
    }
  }

  const isRole = isRoleAddress(email);
  const lead = {
    email: email.toLowerCase(),
    first_name: named ? firstDisplay : '',
    name: named ? c.name : '',
    title: c.title || '',
    company: cand.company,
    website: cand.website,
    host: cand.host,
    city: cand.city || '',
    state: cand.state || '',
    zip: cand.zip || '',
    phone: cand.phone || '',
    tz: tzForState(cand.state),
    types: cand.types || [],
    employees: site.employees,
    placeId: cand.placeId,
    source: `leadfinder:${cand.source}`,
    foundOn: c.source === 'mailto' ? (site.mailtos.find((m) => m.email === email)?.page || '') : (c.source || ''),
    emailSource: c.source || '',
    checkedBy,
    riskLevel,
    isRole,
    hasNamedPerson: named,
    titleApproved: named ? titleApproved(c.title, approvedTitles) : false,
  };
  lead.dreamMatch = dreamMatch(lead, profile.dreamCustomers || []);
  lead.score = scoreLead(lead);
  return lead;
}

export async function run({ env = process.env, fetchImpl = fetch, resolveMx = undefined, log = console.log } = {}) {
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

    // 1. search
    const target = need * 3;
    const b = info.budget || {};
    let placesBudget = Math.max(0, Math.floor((Number(b.placesLimit) || 0) * (Number(b.placesStopRatio) || 0.8)) - (Number(b.placesUsed) || 0));
    let placesUnreported = 0;
    let placesTotal = 0;
    const cands = [];
    const byId = new Set();
    const add = (list2) => { for (const p of list2) if (!byId.has(p.placeId)) { byId.add(p.placeId); cands.push(p); } };
    const queries = buildQueries(profile, { widen });
    if (env.PLACES_API_KEY) {
      for (const q of queries) {
        if (cands.length >= target || placesBudget <= 0) break;
        const r = await placesTextSearch(q, { apiKey: env.PLACES_API_KEY, fetchImpl, budgetLeft: placesBudget });
        placesBudget -= r.requests;
        placesUnreported += r.requests;
        placesTotal += r.requests;
        add(r.places);
        if (r.error) { log(`places: ${r.error} — switching to OpenStreetMap`); break; }
      }
    }
    if (cands.length < target) {
      const kw = list(profile.industry)[0] || '';
      for (const c of list(profile.cities)) {
        if (cands.length >= target) break;
        const [city, st] = c.includes('|') ? c.split('|') : [c.replace(/,\s*[A-Z]{2}$/, ''), (/,\s*([A-Z]{2})$/.exec(c) || [])[1] || list(profile.states)[0] || ''];
        if (!st) continue;
        const r = await overpassSearch(kw, city.trim(), st.trim(), { fetchImpl });
        add(r.places);
      }
    }
    log(`search: ${cands.length} candidates, ${placesTotal} Places requests`);

    // 2. filter
    const { kept, dropped } = filterCandidates(cands, { blockedHosts: info.blocklist?.hosts || [], blockedNames: info.blocklist?.names || [], chains: loadChains(), exclude });
    let fresh = kept;
    for (let i = 0; i < kept.length; i += 200) {
      const chunk = kept.slice(i, i + 200);
      const r = await post({ type: 'hosts', niche: info.niche, hosts: chunk.map((c) => c.host) });
      const taken = new Set(r.taken || []);
      if (taken.size) { fresh = fresh.filter((c) => !taken.has(c.host)); dropped.other_client = (dropped.other_client || 0) + taken.size; }
    }
    log(`filter: kept ${fresh.length}; dropped ${JSON.stringify(dropped)}`);

    // 3–6. crawl, guess, verify, score — post every 100
    const reoon = reoonBudget(env.REOON_API_KEY ? info.budget?.reoonLeft : 0);
    let reoonReported = 0;
    let batchNo = 0;
    let found = 0;
    let pending = [];
    let stopped = false;
    const flush = async (final = false) => {
      if (!pending.length && !final) return;
      const leads = pending.sort((a, c) => c.score - a.score);
      pending = [];
      if (leads.length) {
        batchNo++;
        const r = await post({ type: 'batch', batchNo, leads, placesRequests: placesUnreported, reoonChecks: reoon.used - reoonReported });
        placesUnreported = 0;
        reoonReported = reoon.used;
        if (r.stop) stopped = true;
      }
    };
    await pool(fresh, 6, async (cand, stop) => {
      if (stopped || found >= need) { stop(); return null; }
      let lead = null;
      try { lead = await buildLead(cand, { profile, approvedTitles, excludedTitles, reoon, reoonKey: env.REOON_API_KEY, fetchImpl, resolveMx }); } catch (err) { log(`crawl ${cand.host}: ${err.message}`); }
      if (!lead) return null;
      found++;
      pending.push(lead);
      if (pending.length >= 100) await flush();
      return null;
    });
    if (!stopped) await flush(true);
    await post({ type: 'done', found, candidates: cands.length, kept: fresh.length, dropped, placesRequests: placesUnreported, reoonChecks: reoon.used - reoonReported, short: found < need, stopped });
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
