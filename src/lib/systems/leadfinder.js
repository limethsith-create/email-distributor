/**
 * Lead Finder — the app side (SPEC §7.2). The long-running search/crawl runs
 * in GitHub Actions (scripts/leadfinder); this module
 *   - dispatches it (on entering `warming`, daily refill when unsent is low,
 *     after a rejected batch with the failing pattern excluded, once more
 *     widened to adjacent states when the list comes up short),
 *   - serves what the job needs (profile, blocklist, budgets, fairness),
 *   - receives batches: counts Places/Reoon usage, runs the List Sanity
 *     Check, the Blocklist Keeper and cross-client fairness, then inserts
 *     leads (status unsent, campaign trial, sequenceVariant A/B alternating,
 *     tz from state),
 *   - tracks readiness: `listReady(clientId)` for the warming → ready gate.
 *
 * Leads v2: every posted lead is graded (systems/grader.js) before it is
 * stored — rejects (role address, chain, outside the area, duplicate company,
 * no name …) are counted, never stored — and arrives `verifyStatus: pending`;
 * the verification waterfall (systems/verify.js) checks it, best leads first.
 * The finder's own reject counts (posted with every batch) are summed into
 * client:{id}:leadfinder.rejects for the lead-quality rollup. Fairness: a
 * company taken by another client in the same niche in the last 90 days is
 * skipped (the monthly leadhosts keys of this month and the 3 before it).
 *
 * State: client:{id}:leadfinder (hash).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile } from '@/lib/db/client';
import { countByStatus, hostOf, saveLead, getLeadsByStatus } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { countUsage, isThrottled } from '@/lib/systems/usage';
import { repositoryDispatch } from '@/lib/ext/github';
import { checkLead, blockedHosts } from '@/lib/systems/blocklist';
import { sanityCheck, storeSanityRows } from '@/lib/systems/sanity';
import { nicheOf } from '@/lib/systems/copy';
import { gradeContext, gradePatch, isSendable, maybeRollup } from '@/lib/systems/grader';
import { queueLeads, verifyAddress } from '@/lib/systems/verify';
import { ET, dayKeyIn, partsIn, tzForState } from '@/lib/time';

const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const list = (v) => { const x = parse(v, v); return (Array.isArray(x) ? x : String(x || '').split(/[,;\n]+/)).map((s) => String(s).trim()).filter(Boolean); };
const monthOf = (now = new Date()) => partsIn('UTC', now).monthKey;

export async function getState(clientId) {
  return (await kv.hgetall(K.leadfinder(clientId))) || {};
}

async function setState(clientId, fields) {
  await kv.hset(K.leadfinder(clientId), { ...fields, updatedAt: new Date().toISOString() });
}

/**
 * Dispatch the workflow. Returns { ok, error }. On failure alerts
 * leadfinder_failed (the caller's job also records the error).
 */
export async function dispatchLeadFinder(clientId, { mode = 'initial', need = null, exclude = null, widen = false } = {}, deps = {}) {
  const n = need || (mode === 'refill' ? await cfg(clientId, 'BUILD.refillNeed') : await cfg(clientId, 'LIST.need'));
  const payload = { clientId, need: n, mode, ...(exclude ? { exclude } : {}), ...(widen ? { widen: true } : {}) };
  const repo = await cfg(clientId, 'BUILD.repo');
  const res = await (deps.dispatch || ((p) => repositoryDispatch('leadfinder', p, { repo: process.env.GITHUB_REPO || repo })))(payload);
  const now = new Date().toISOString();
  if (!res.ok) {
    await setState(clientId, { lastDispatchError: String(res.error || '').slice(0, 200), lastDispatchErrorAt: now });
    await logEvent(clientId, 'leadfinder', 'dispatch_failed', { mode, error: res.error });
    await alertOwner('leadfinder_failed', { clientId, scope: `${clientId}:dispatch`, vars: { clientId }, body: `Could not start the Lead Finder (${mode}): ${res.error}`, did: 'Nothing changed; the job retries next hour (initial) or tomorrow (refill).' });
    return { ok: false, error: res.error };
  }
  const st = await getState(clientId);
  await setState(clientId, {
    status: 'running',
    lastMode: mode,
    dispatchedAt: now,
    ...(mode === 'initial' && !st.initialAt ? { initialAt: now } : {}),
    runs: String((Number(st.runs) || 0) + 1),
    ...(exclude ? { exclude: JSON.stringify(exclude) } : {}),
    lastDispatchError: '',
  });
  await logEvent(clientId, 'leadfinder', 'dispatched', { mode, need: n, widen, exclude: exclude || undefined });
  return { ok: true };
}

/** What GET /api/clients/{id}/profile returns to the workflow. */
export async function profilePayload(clientId, now = new Date()) {
  const [client, profile, st] = await Promise.all([getClient(clientId), getProfile(clientId), getState(clientId)]);
  if (!client) return null;
  const month = monthOf(now);
  const places = (await kv.hgetall(K.usage('places', month))) || {};
  const placesLimit = await cfg(clientId, 'PLACES.monthlyEnterprise');
  const bl = await blockedHosts(clientId);
  const dreams = parse(profile.dreamCustomers, []);
  return {
    clientId,
    niche: nicheOf(profile),
    need: await cfg(clientId, 'LIST.need'),
    overshoot: await cfg(clientId, 'GRADE.findOvershoot'),
    profile: {
      industry: list(profile.industry),
      sellsTo: profile.sellsTo || '',
      cities: list(profile.cities),
      states: list(profile.states),
      zips: parse(profile.zips, null),
      sizeMin: Number(profile.sizeMin) || null,
      sizeMax: Number(profile.sizeMax) || null,
      titles: list(profile.titles),
      excludedTitles: list(profile.excludedTitles),
      dreamCustomers: Array.isArray(dreams) ? dreams : [],
      contactsPerCompany: Math.max(1, Math.min(3, Number(profile.contactsPerCompany) || 1)),
    },
    blocklist: bl,
    exclude: parse(st.exclude, {}),
    budget: {
      placesUsed: Number(places.enterprise) || 0,
      placesLimit,
      placesStopRatio: await cfg(clientId, 'BUILD.placesStopRatio'),
    },
  };
}

/** The monthly fairness keys covering the last 90 days (this month + the 3 before it). */
function fairnessMonths(now = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
  for (let i = 0; i < 4; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

/**
 * Cross-client fairness: hosts already taken by ANOTHER client in this niche
 * in the last 90 days (a company is one place in one city, so "same niche /
 * city" is the same host).
 */
export async function hostsTaken(clientId, niche, hosts, now = new Date()) {
  const clean = [...new Set((hosts || []).map((h) => hostOf(h)).filter(Boolean))].slice(0, 500);
  if (!clean.length) return [];
  const taken = new Set();
  for (const m of fairnessMonths(now)) {
    const owners = await kv.hmget(K.leadHosts(niche, m), ...clean);
    for (const h of clean) if (owners && owners[h] && owners[h] !== clientId) taken.add(h);
  }
  return clean.filter((h) => taken.has(h));
}

async function claimHosts(clientId, niche, hosts, now = new Date()) {
  const key = K.leadHosts(niche, monthOf(now));
  for (const h of hosts) await kv.hsetnx(key, h, clientId);
  await kv.expire(key, 130 * 86400); // read for 90 days after the month it was claimed in
}

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Facts for the first line + grader (bounded; nothing personal). */
function cleanFacts(f) {
  if (!f || typeof f !== 'object') return {};
  const sp = f.servicePage && typeof f.servicePage === 'object' ? { label: str(f.servicePage.label, 40), path: str(f.servicePage.path, 120) } : null;
  return {
    services: (Array.isArray(f.services) ? f.services : []).map((s) => str(s, 40)).filter(Boolean).slice(0, 5),
    servicePage: sp && sp.label ? sp : null,
    since: numOrNull(f.since),
    years: numOrNull(f.years),
    rating: numOrNull(f.rating),
    reviews: numOrNull(f.reviews),
    ratingSource: f.ratingSource === 'google' || f.ratingSource === 'site' ? f.ratingSource : null,
    primaryType: str(f.primaryType, 60),
  };
}

function cleanSignals(s) {
  if (!s || typeof s !== 'object') return {};
  const b = (v) => (v === true || v === false ? v : v == null ? null : bool(v));
  return {
    https: b(s.https), copyrightYear: numOrNull(s.copyrightYear), viewport: b(s.viewport), hasAddress: b(s.hasAddress), hasPhone: b(s.hasPhone),
    metaDescription: b(s.metaDescription), hiring: b(s.hiring), expansion: b(s.expansion), franchise: b(s.franchise),
    freemailContact: b(s.freemailContact), pagesRead: numOrNull(s.pagesRead),
  };
}

/**
 * One raw lead from the workflow → the stored lead record (SPEC CONTRACTS
 * lead record + Leads v2 fields). The workflow never verifies with an API,
 * so every lead starts `verifyStatus: pending` / `riskLevel: risky`.
 */
export function normaliseLead(raw, clientId, variant) {
  const email = String(raw.email || '').trim().toLowerCase();
  const state = String(raw.state || '').trim();
  const cands = (Array.isArray(raw.emailCandidates) ? raw.emailCandidates : []).map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e.includes('@') && e !== email).slice(0, 4);
  return {
    email,
    clientId,
    status: 'unsent',
    campaign: 'trial',
    first_name: String(raw.first_name || '').trim(),
    name: String(raw.name || '').trim(),
    title: String(raw.title || '').trim(),
    company: String(raw.company || '').trim(),
    website: String(raw.website || '').trim(),
    host: hostOf(raw.website || email),
    city: String(raw.city || '').trim(),
    state,
    zip: String(raw.zip || '').trim(),
    tz: tzForState(state),
    types: Array.isArray(raw.types) ? raw.types.slice(0, 8) : [],
    employees: Number(raw.employees) || null,
    sizeBand: raw.sizeBand || '',
    source: String(raw.source || 'leadfinder'),
    foundOn: String(raw.foundOn || ''),
    score: Number(raw.score) || 0,
    dreamMatch: Math.max(0, Math.min(3, Number(raw.dreamMatch) || 0)),
    riskLevel: 'risky',
    isRole: bool(raw.isRole),
    sequenceVariant: variant,
    sanityChecked: true,
    // Leads v2
    verifyStatus: 'pending',
    emailCandidates: cands,
    emailGuessed: bool(raw.emailGuessed),
    emailSource: str(raw.emailSource, 20),
    pattern: raw.pattern ? str(raw.pattern, 20) : null,
    nameSource: str(raw.nameSource, 20),
    linkedinHint: bool(raw.linkedinHint),
    address: str(raw.address, 200),
    phone: str(raw.phone, 40),
    query: str(raw.query, 120),
    facts: cleanFacts(raw.facts),
    signals: cleanSignals(raw.signals),
  };
}

/** Sum reject counts into client:{id}:leadfinder.rejects (JSON map reason → n). */
async function addRejects(clientId, counts) {
  const add = Object.entries(counts || {}).filter(([, n]) => Number(n) > 0);
  if (!add.length) return;
  const st = await getState(clientId);
  const cur = parse(st.rejects, {}) || {};
  for (const [k, n] of add) cur[String(k).slice(0, 40)] = (Number(cur[k]) || 0) + Number(n);
  await setState(clientId, { rejects: JSON.stringify(cur) });
}

/**
 * Handle one webhook body from the workflow. Returns the JSON response.
 * body.type: 'hosts' | 'batch' | 'done' | 'failed'
 */
export async function handleWebhook(body, deps = {}) {
  const clientId = body?.clientId;
  const client = clientId ? await getClient(clientId).catch(() => null) : null;
  if (!client) return { status: 404, json: { error: 'unknown client' } };
  switch (body.type) {
    case 'hosts':
      return { status: 200, json: { taken: await hostsTaken(clientId, body.niche || nicheOf(await getProfile(clientId)), body.hosts) } };
    case 'batch':
      return { status: 200, json: await handleBatch(client, body, deps) };
    case 'done':
      return { status: 200, json: await handleDone(client, body, deps) };
    case 'failed':
      return { status: 200, json: await handleFailed(client, body) };
    default:
      return { status: 400, json: { error: 'unknown type' } };
  }
}

async function countWorkflowUsage(body, now = new Date()) {
  const places = Math.max(0, Number(body.placesRequests) || 0);
  const placesPro = Math.max(0, Number(body.placesProRequests) || 0); // city viewports for the grid search (Pro SKU, 5,000 free)
  const reoon = Math.max(0, Number(body.reoonChecks) || 0);
  if (places) await countUsage('places', 'enterprise', places);
  if (placesPro) await countUsage('places', 'pro', placesPro);
  if (reoon) {
    await countUsage('reoon', 'checks', reoon);
    const key = K.usage('reoon-day', dayKeyIn(ET, now));
    await kv.hincrby(key, 'checks', reoon);
    await kv.expire(key, 3 * 86400);
  }
}

export async function handleBatch(client, body, { rng = Math.random, dispatch } = {}) {
  const id = client.id;
  const now = new Date();
  const batchId = `${body.runId || 'run'}-${body.batchNo ?? 0}`;
  // Idempotent: the same batch posted twice is accepted once.
  const fresh = await kv.set(K.jobClaim('lf-batch', id, batchId), Date.now(), { nx: true, ex: 30 * 86400 });
  if (fresh !== 'OK') return { ok: true, duplicate: true };
  await countWorkflowUsage(body, now);

  await addRejects(id, body.rejects);

  const profile = await getProfile(id);
  const rows = (Array.isArray(body.leads) ? body.leads : []).filter((l) => l && l.email);
  const st = await getState(id);
  await setState(id, { lastBatchAt: now.toISOString(), batches: String((Number(st.batches) || 0) + 1) });
  if (!rows.length) return { ok: true, added: 0 };
  const widened = body.mode === 'widen' || st.widened === '1';
  const ctx = await gradeContext(id, { now, profile: widened ? { ...profile, states: [...list(profile.states), ...adjacentOf(profile)].join(',') } : profile });

  // List Sanity Check (SPEC §7.4), on the grader's reasons.
  const sampleSize = await cfg(id, 'LIST.sanitySample');
  const maxFail = await cfg(id, 'LIST.maxFail');
  const sanity = sanityCheck(rows, { titles: list(profile.titles), excludedTitles: list(profile.excludedTitles), sizeMin: profile.sizeMin, sizeMax: profile.sizeMax }, { sampleSize, maxFail, rng, ctx });
  if (sanity.reject) {
    const prev = parse(st.exclude, {});
    const exclude = {
      titles: [...new Set([...(prev.titles || []), ...sanity.exclude.titles])],
      types: [...new Set([...(prev.types || []), ...sanity.exclude.types])],
      hosts: [...new Set([...(prev.hosts || []), ...sanity.exclude.hosts])],
      requireState: Boolean(prev.requireState || sanity.exclude.requireState),
    };
    await setState(id, { rejected: String((Number(st.rejected) || 0) + 1), lastRejectAt: now.toISOString(), exclude: JSON.stringify(exclude) });
    await logEvent(id, 'sanity', 'batch_rejected', { batchId, failCount: sanity.failCount, reasons: sanity.failures.map((f) => f.reasons.join('+')) });
    // Re-dispatch once per run with the failing pattern excluded; the running job is told to stop.
    let redispatched = false;
    if (st.redispatchedFor !== String(body.runId)) {
      await setState(id, { redispatchedFor: String(body.runId) });
      const r = await dispatchLeadFinder(id, { mode: body.mode === 'refill' ? 'refill' : 'initial', exclude }, { dispatch });
      redispatched = r.ok;
    }
    await alertOwner('list_quality', { clientId: id, scope: `${id}:${batchId}`, vars: { clientId: id }, body: `${sanity.failCount} of ${sanity.sample.length} sampled rows failed the sanity check (limit ${maxFail}).\n${sanity.failures.slice(0, 6).map((f) => `- ${f.row.company || f.row.email}: ${f.reasons.join(', ')}`).join('\n')}`, did: redispatched ? 'The batch was rejected and the Lead Finder restarted with that pattern excluded.' : 'The batch was rejected; it was already restarted once for this run, so it was not restarted again.' });
    return { ok: true, rejected: true, stop: true, failCount: sanity.failCount };
  }

  // Blocklist Keeper + cross-client fairness + the Lead Grader, then insert
  // with A/B alternating. Rejected leads are counted, not stored.
  const niche = nicheOf(profile);
  const taken = new Set(await hostsTaken(id, niche, rows.map((r) => r.website || r.email), now));
  const skipped = {};
  const rejects = {};
  const bumpSkip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  const existing = (await kv.hgetall(K.leads(id))) || {};
  const perHost = new Map();
  const people = new Set();
  for (const l of Object.values(existing)) {
    if (!l || typeof l !== 'object' || l.status === 'rejected') continue;
    const h = l.host || hostOf(l.website || l.email);
    perHost.set(h, (perHost.get(h) || 0) + 1);
    if (l.name) people.add(`${h}|${String(l.name).toLowerCase()}`);
  }
  const ready = [];
  let seq = Number(st.variantSeq) || 0;
  for (const raw of rows) {
    const variant = seq % 2 === 0 ? 'A' : 'B';
    const lead = normaliseLead(raw, id, variant);
    if (!lead.email.includes('@')) { bumpSkip('invalid'); continue; }
    if (taken.has(lead.host)) { bumpSkip('other_client'); rejects.other_client = (rejects.other_client || 0) + 1; continue; }
    const blocked = await checkLead(id, lead);
    if (blocked) { bumpSkip(blocked); const k = blocked === 'suppressed' ? 'suppressed' : 'blocklist'; rejects[k] = (rejects[k] || 0) + 1; continue; }
    if (existing[lead.email]) { bumpSkip('duplicate'); continue; }
    const personKey = lead.name ? `${lead.host}|${lead.name.toLowerCase()}` : null;
    if (personKey && people.has(personKey)) { bumpSkip('duplicate_person'); rejects.duplicate_person = (rejects.duplicate_person || 0) + 1; continue; }
    const g = gradePatch(lead, ctx, { duplicateCompany: (perHost.get(lead.host) || 0) >= ctx.contactsPerCompany });
    if (g.grade === 'rejected') { bumpSkip(`rejected:${g.rejectReason}`); rejects[g.rejectReason] = (rejects[g.rejectReason] || 0) + 1; continue; }
    const rec = await saveLead(id, { ...lead, ...g, status: 'unsent', createdAt: now.toISOString() });
    existing[rec.email] = rec;
    perHost.set(lead.host, (perHost.get(lead.host) || 0) + 1);
    if (personKey) people.add(personKey);
    ready.push(rec);
    seq++;
  }
  await addRejects(id, rejects);
  const queued = await queueLeads(id, ready, ctx);
  await claimHosts(id, niche, [...new Set(ready.map((l) => l.host).filter(Boolean))], now);
  const approval = (await kv.hgetall(K.approval(id))) || {};
  const haveRows = await kv.get(K.sanityRows(id));
  // "20 companies we found for you": the best-graded rows of this batch.
  const best = ready.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, sampleSize);
  if (!haveRows || !approval.sentAt) await storeSanityRows(id, best.length ? best : sanity.sample);
  await setState(id, { variantSeq: String(seq), received: String((Number(st.received) || 0) + ready.length) });
  await logEvent(id, 'leadfinder', 'batch_inserted', { batchId, added: ready.length, skipped, sanityFails: sanity.failCount, queued });
  await maybeRollup(id, { now, ctx, force: true });
  return { ok: true, added: ready.length, skipped };
}

// Neighbouring states (widen mode) — same table as scripts/leadfinder/lib.mjs.
const NEIGHBORS = {
  AL: 'FL GA MS TN', AZ: 'CA CO NM NV UT', AR: 'LA MO MS OK TN TX', CA: 'AZ NV OR', CO: 'AZ KS NE NM OK UT WY', CT: 'MA NY RI',
  DE: 'MD NJ PA', DC: 'MD VA', FL: 'AL GA', GA: 'AL FL NC SC TN', ID: 'MT NV OR UT WA WY', IL: 'IA IN KY MO WI', IN: 'IL KY MI OH',
  IA: 'IL MN MO NE SD WI', KS: 'CO MO NE OK', KY: 'IL IN MO OH TN VA WV', LA: 'AR MS TX', ME: 'NH', MD: 'DC DE PA VA WV',
  MA: 'CT NH NY RI VT', MI: 'IN OH WI', MN: 'IA ND SD WI', MS: 'AL AR LA TN', MO: 'AR IA IL KS KY NE OK TN', MT: 'ID ND SD WY',
  NE: 'CO IA KS MO SD WY', NV: 'AZ CA ID OR UT', NH: 'MA ME VT', NJ: 'DE NY PA', NM: 'AZ CO OK TX UT', NY: 'CT MA NJ PA VT',
  NC: 'GA SC TN VA', ND: 'MN MT SD', OH: 'IN KY MI PA WV', OK: 'AR CO KS MO NM TX', OR: 'CA ID NV WA', PA: 'DE MD NJ NY OH WV',
  RI: 'CT MA', SC: 'GA NC', SD: 'IA MN MT ND NE WY', TN: 'AL AR GA KY MO MS NC VA', TX: 'AR LA NM OK', UT: 'AZ CO ID NM NV WY',
  VT: 'MA NH NY', VA: 'DC KY MD NC TN WV', WA: 'ID OR', WV: 'KY MD OH PA VA', WI: 'IA IL MI MN', WY: 'CO ID MT NE SD UT',
};
function adjacentOf(profile) {
  const have = new Set(list(profile.states).map((s) => s.toUpperCase()));
  for (const c of list(profile.cities)) { const m = /,\s*([A-Za-z]{2})\s*$/.exec(c); if (m) have.add(m[1].toUpperCase()); }
  const out = new Set();
  for (const s of have) for (const n of String(NEIGHBORS[s] || '').split(' ').filter(Boolean)) out.add(n);
  return [...out];
}

export async function handleDone(client, body, { dispatch } = {}) {
  const id = client.id;
  await countWorkflowUsage(body);
  // The done post carries the reject counts since the last batch (idempotent per run).
  if (body.rejects && (await kv.set(K.jobClaim('lf-done', id, String(body.runId || 'run')), Date.now(), { nx: true, ex: 30 * 86400 })) === 'OK') await addRejects(id, body.rejects);
  const st = await getState(id);
  const counts = await countByStatus(id);
  const unsent = counts.unsent || 0;
  const need = await cfg(id, 'LIST.need');
  const startMin = await cfg(id, 'LIST.startMin');
  await setState(id, { status: body.stopped ? 'restarted' : 'done', lastDoneAt: new Date().toISOString(), lastFound: String(Number(body.found) || 0) });
  await logEvent(id, 'leadfinder', 'run_done', { found: body.found, candidates: body.candidates, dropped: body.dropped, unsent, stopped: body.stopped || undefined });
  if (body.stopped || body.mode === 'refill') return { ok: true };
  if (unsent >= need) return { ok: true, unsent };
  if (st.widened !== '1') {
    await setState(id, { widened: '1' });
    const r = await dispatchLeadFinder(id, { mode: 'widen', widen: true, need: need - unsent }, { dispatch });
    return { ok: true, widened: r.ok, unsent };
  }
  await alertOwner('list_short', { clientId: id, vars: { clientId: id, count: unsent }, body: `The list has ${unsent} contacts after widening to adjacent states (target ${need}).`, did: unsent >= startMin ? `Day 1 can start with what exists (at least ${startMin}).` : `Day 1 is held: fewer than ${startMin} contacts.` });
  return { ok: true, short: true, unsent };
}

export async function handleFailed(client, body) {
  const id = client.id;
  await countWorkflowUsage(body);
  await setState(id, { status: 'failed', failedAt: new Date().toISOString(), lastError: String(body.error || '').slice(0, 200) });
  await logEvent(id, 'leadfinder', 'run_failed', { error: body.error });
  await alertOwner('leadfinder_failed', { clientId: id, vars: { clientId: id }, body: `The Lead Finder run for ${id} failed: ${body.error || 'unknown error'}`, did: 'Sending continues on whatever list exists; the daily refill tries again.' });
  return { ok: true };
}

/** workflow_run failure (from /api/webhooks/github). display_title = "leadfinder {clientId} {mode}". */
export async function handleWorkflowRun(payload) {
  const wr = payload?.workflow_run || {};
  if (payload?.action !== 'completed' || !/leadfinder/i.test(String(wr.name || ''))) return { ignored: true };
  if (wr.conclusion === 'success') return { ignored: true };
  const m = /^leadfinder\s+([a-z0-9_-]+)/i.exec(String(wr.display_title || ''));
  const clientId = m ? m[1].toLowerCase() : null;
  const client = clientId ? await getClient(clientId).catch(() => null) : null;
  if (client) {
    const st = await getState(clientId);
    // The script usually reports its own failure first; do not double-alert.
    if (st.status !== 'failed') await handleFailed(client, { error: `workflow ${wr.conclusion} (${wr.html_url || wr.id})` });
    return { clientId, conclusion: wr.conclusion };
  }
  await alertOwner('leadfinder_failed', { scope: `run:${wr.id}`, vars: { clientId: clientId || 'unknown' }, body: `A Lead Finder run ended "${wr.conclusion}" and its client could not be identified (${wr.display_title || ''}).`, did: 'Nothing changed.' });
  return { clientId: null, conclusion: wr.conclusion };
}

/**
 * Unsent leads the Sender may actually use (Leads v2): graded A/B and
 * verified. A lead with no grade (v1 record, Test Mode, a manual import)
 * counts as it did in v1.
 */
export async function sendableUnsent(clientId, { now = new Date() } = {}) {
  const leads = await getLeadsByStatus(clientId, 'unsent', 5000);
  if (!leads.some((l) => l.grade)) return { sendable: leads.length, unsent: leads.length };
  const ctx = await gradeContext(clientId, { now });
  return { sendable: leads.filter((l) => !l.grade || isSendable(l, ctx)).length, unsent: leads.length };
}

/**
 * List gate for warming → ready: at least LIST.startMin sendable contacts
 * (graded A/B and verified — an unverified list is not a list yet).
 * (While the finder is still running a short list is simply "not yet".)
 */
export async function listReady(clientId, { now = new Date() } = {}) {
  const startMin = await cfg(clientId, 'LIST.startMin');
  const need = await cfg(clientId, 'LIST.need');
  const st = await getState(clientId);
  const { sendable, unsent } = await sendableUnsent(clientId, { now });
  return { ok: sendable >= startMin, unsent: sendable, allUnsent: unsent, startMin, need, status: st.status || 'not_started' };
}

/** Is the daily refill due for this client? (sendable unsent below LIST.refillBelow) */
export async function refillDue(clientId, now = new Date()) {
  if (await isThrottled('places')) return { due: false, reason: 'places throttled' };
  const st = await getState(clientId);
  const minHours = await cfg(clientId, 'BUILD.refillMinHoursBetween');
  if (st.dispatchedAt && now.getTime() - Date.parse(st.dispatchedAt) < minHours * 3600e3) return { due: false, reason: 'recent run' };
  const { sendable, unsent } = await sendableUnsent(clientId, { now });
  const below = await cfg(clientId, 'LIST.refillBelow');
  return { due: sendable < below, unsent: sendable, allUnsent: unsent };
}

/**
 * Ask for a refill now (Emergency Runner step 3, SPEC §8.10). Skipped when a
 * run is already going (dispatched in the last BUILD.refillMinHoursBetween
 * hours and not reported done) so two emergencies never start two runs.
 */
export async function requestRefill(clientId, { reason = 'manual', now = new Date() } = {}, deps = {}) {
  const st = await getState(clientId);
  const minHours = await cfg(clientId, 'BUILD.refillMinHoursBetween');
  if (st.status === 'running' && st.dispatchedAt && now.getTime() - Date.parse(st.dispatchedAt) < minHours * 3600e3) {
    return { ok: true, skipped: 'a Lead Finder run is already going' };
  }
  const r = await dispatchLeadFinder(clientId, { mode: 'refill' }, deps);
  await logEvent(clientId, 'leadfinder', 'refill_requested', { reason, ok: r.ok });
  return r;
}

/**
 * Deep check of one address (Emergency Runner step 3) through the
 * verification waterfall, inside the same free budgets as the lead-verify
 * job. Returns { valid: true|false|null, reason }; null when no credit or no
 * definite answer (never a guess). `verify` injects a stub (tests).
 */
export async function deepVerify(email, { now = new Date(), verify = null } = {}) {
  if (verify) {
    const r = await verify(email);
    return { valid: r.valid ?? null, reason: `${r.status || 'stub'}${r.raw ? ` (${r.raw})` : ''}` };
  }
  const r = await verifyAddress(email, { now });
  if (r.status === 'invalid') return { valid: false, reason: `${r.by} ${r.detail || 'invalid'}` };
  if (r.status === 'valid' || r.status === 'catchall') return { valid: true, reason: `${r.by} ${r.status}` };
  return { valid: null, reason: r.status === 'pending' ? 'no verification credits left today' : `${r.by || 'verify'} ${r.status}${r.detail ? ` (${r.detail})` : ''}` };
}
