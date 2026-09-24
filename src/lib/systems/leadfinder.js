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
 * State: client:{id}:leadfinder (hash).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile } from '@/lib/db/client';
import { insertLeads, countByStatus, hostOf } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { countUsage, isThrottled } from '@/lib/systems/usage';
import { repositoryDispatch } from '@/lib/ext/github';
import { checkLead, blockedHosts } from '@/lib/systems/blocklist';
import { sanityCheck, storeSanityRows } from '@/lib/systems/sanity';
import { nicheOf } from '@/lib/systems/copy';
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
  const reoonDay = (await kv.hgetall(K.usage('reoon-day', dayKeyIn(ET, now)))) || {};
  const placesLimit = await cfg(clientId, 'PLACES.monthlyEnterprise');
  const reoonDaily = await cfg(clientId, 'REOON.dailyFree');
  const bl = await blockedHosts(clientId);
  const dreams = parse(profile.dreamCustomers, []);
  return {
    clientId,
    niche: nicheOf(profile),
    need: await cfg(clientId, 'LIST.need'),
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
    },
    blocklist: bl,
    exclude: parse(st.exclude, {}),
    budget: {
      placesUsed: Number(places.enterprise) || 0,
      placesLimit,
      placesStopRatio: await cfg(clientId, 'BUILD.placesStopRatio'),
      reoonLeft: Math.max(0, reoonDaily - (Number(reoonDay.checks) || 0)),
    },
  };
}

/** Cross-client fairness: hosts already taken by ANOTHER client in this niche this month. */
export async function hostsTaken(clientId, niche, hosts, now = new Date()) {
  const clean = [...new Set((hosts || []).map((h) => hostOf(h)).filter(Boolean))].slice(0, 500);
  if (!clean.length) return [];
  const owners = await kv.hmget(K.leadHosts(niche, monthOf(now)), ...clean);
  return clean.filter((h) => owners && owners[h] && owners[h] !== clientId);
}

async function claimHosts(clientId, niche, hosts, now = new Date()) {
  const key = K.leadHosts(niche, monthOf(now));
  for (const h of hosts) await kv.hsetnx(key, h, clientId);
  await kv.expire(key, 40 * 86400);
}

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** One raw lead from the workflow → the stored lead record (SPEC CONTRACTS lead record). */
export function normaliseLead(raw, clientId, variant) {
  const email = String(raw.email || '').trim().toLowerCase();
  const state = String(raw.state || '').trim();
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
    riskLevel: ['safe', 'risky', 'catchall'].includes(raw.riskLevel) ? raw.riskLevel : 'risky',
    isRole: bool(raw.isRole),
    sequenceVariant: variant,
    sanityChecked: true,
  };
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
  const reoon = Math.max(0, Number(body.reoonChecks) || 0);
  if (places) await countUsage('places', 'enterprise', places);
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

  const profile = await getProfile(id);
  const rows = (Array.isArray(body.leads) ? body.leads : []).filter((l) => l && l.email);
  const st = await getState(id);
  await setState(id, { lastBatchAt: now.toISOString(), batches: String((Number(st.batches) || 0) + 1) });
  if (!rows.length) return { ok: true, added: 0 };

  // List Sanity Check (SPEC §7.4).
  const sampleSize = await cfg(id, 'LIST.sanitySample');
  const maxFail = await cfg(id, 'LIST.maxFail');
  const sanity = sanityCheck(rows, { titles: list(profile.titles), excludedTitles: list(profile.excludedTitles), sizeMin: profile.sizeMin, sizeMax: profile.sizeMax }, { sampleSize, maxFail, rng });
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

  // Blocklist Keeper + cross-client fairness, then insert with A/B alternating.
  const niche = nicheOf(profile);
  const taken = new Set(await hostsTaken(id, niche, rows.map((r) => r.website || r.email), now));
  const skipped = {};
  const bumpSkip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  const ready = [];
  let seq = Number(st.variantSeq) || 0;
  for (const raw of rows) {
    const variant = seq % 2 === 0 ? 'A' : 'B';
    const lead = normaliseLead(raw, id, variant);
    if (!lead.email.includes('@')) { bumpSkip('invalid'); continue; }
    if (taken.has(lead.host)) { bumpSkip('other_client'); continue; }
    const blocked = await checkLead(id, lead);
    if (blocked) { bumpSkip(blocked); continue; }
    ready.push(lead);
    seq++;
  }
  const res = await insertLeads(id, ready);
  for (const [k, v] of Object.entries(res.skipped || {})) skipped[k] = (skipped[k] || 0) + v;
  await claimHosts(id, niche, [...new Set(ready.map((l) => l.host).filter(Boolean))], now);
  const approval = (await kv.hgetall(K.approval(id))) || {};
  const haveRows = await kv.get(K.sanityRows(id));
  if (!haveRows || !approval.sentAt) await storeSanityRows(id, sanity.sample);
  await setState(id, { variantSeq: String(seq), received: String((Number(st.received) || 0) + res.added) });
  await logEvent(id, 'leadfinder', 'batch_inserted', { batchId, added: res.added, skipped, sanityFails: sanity.failCount });
  return { ok: true, added: res.added, skipped };
}

export async function handleDone(client, body, { dispatch } = {}) {
  const id = client.id;
  await countWorkflowUsage(body);
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
 * List gate for warming → ready: at least LIST.startMin unsent contacts.
 * (While the finder is still running a short list is simply "not yet".)
 */
export async function listReady(clientId) {
  const counts = await countByStatus(clientId);
  const startMin = await cfg(clientId, 'LIST.startMin');
  const need = await cfg(clientId, 'LIST.need');
  const st = await getState(clientId);
  const unsent = counts.unsent || 0;
  return { ok: unsent >= startMin, unsent, startMin, need, status: st.status || 'not_started' };
}

/** Is the daily refill due for this client? */
export async function refillDue(clientId, now = new Date()) {
  if (await isThrottled('places')) return { due: false, reason: 'places throttled' };
  const st = await getState(clientId);
  const minHours = await cfg(clientId, 'BUILD.refillMinHoursBetween');
  if (st.dispatchedAt && now.getTime() - Date.parse(st.dispatchedAt) < minHours * 3600e3) return { due: false, reason: 'recent run' };
  const { unsent = 0 } = await countByStatus(clientId);
  const below = await cfg(clientId, 'LIST.refillBelow');
  return { due: unsent < below, unsent };
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
 * Deep check of one address with Reoon (SPEC §7.2 step 4), inside today's
 * free credits (REOON.dailyFree, shared with the Lead Finder job). Returns
 * { valid: true|false|null, reason }; null when no credit or no answer.
 */
export async function deepVerify(email, { now = new Date(), verify = null } = {}) {
  const key = K.usage('reoon-day', dayKeyIn(ET, now));
  const daily = await cfg(null, 'REOON.dailyFree');
  const used = Number(await kv.hget(key, 'checks')) || 0;
  if (used >= daily) return { valid: null, reason: 'no Reoon credits left today' };
  if (!verify && !process.env.REOON_API_KEY) return { valid: null, reason: 'REOON_API_KEY is not set' };
  await kv.hincrby(key, 'checks', 1);
  await kv.expire(key, 3 * 86400);
  const fn = verify || (await import('@/lib/ext/reoon')).reoonVerify;
  const r = await fn(email);
  return { valid: r.valid, reason: `reoon ${r.status}${r.raw ? ` (${r.raw})` : ''}` };
}
