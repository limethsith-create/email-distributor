/**
 * Market Counter (SPEC §6.3). Proves there are at least MIN_MARKET matching
 * companies before anything is bought.
 *
 * 3–5 Places Text Search queries (industry keyword × top cities/states),
 * IDs-only field mask, up to 60 ids per query (3 pages). Unique ids × the
 * coverage factor (3) = marketEstimate. Places unavailable → Overpass count
 * per state. Under threshold → widen once to neighbouring states; still
 * under → declined + decline_market + market_small (the owner may override).
 *
 * Resumable: progress lives in client:{id}:market so one run does as many
 * requests as the tick budget allows and the `market` job continues it.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, setState, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { placesConfigured, textSearchIds } from '@/lib/ext/places';
import { countInState } from '@/lib/ext/overpass';
import { io, asArray, asObject, truthy, firstNameOf, ownerName, sendClient } from '@/lib/systems/intake-io';
import { STATES, stateCode, stateOfCity, neighboursOf } from '@/lib/systems/usgeo';

const SYSTEM = 'market';

/** Industry keywords from the profile (industryKeywords, else the industry text split on commas). */
export function keywordsOf(profile) {
  const list = asArray(profile.industryKeywords);
  const kws = (list.length ? list : String(profile.industry || '').split(/[,;\n]/)).map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(kws)].slice(0, 5);
}

/** Target state codes: explicit states, plus the states of the listed cities. */
export function statesOf(profile) {
  const codes = [...asArray(profile.states).map(stateCode), ...asArray(profile.cities).map(stateOfCity)].filter(Boolean);
  return [...new Set(codes)];
}

/**
 * Query strings for Places: keyword × location, round-robin so every keyword
 * and every location is used before any pair repeats. Locations are cities
 * first ("Dallas, TX"), then whole states ("Texas").
 */
export function buildQueries(keywords, locations, { min = 3, max = 5 } = {}) {
  const out = [];
  if (!keywords.length || !locations.length) return out;
  const total = keywords.length * locations.length;
  for (let i = 0; i < total && out.length < max; i++) {
    const kw = keywords[i % keywords.length];
    const loc = locations[Math.floor(i / keywords.length) % locations.length];
    const q = `${kw} ${loc}`;
    if (!out.includes(q)) out.push(q);
  }
  return out;
}

function baseLocations(profile) {
  const cities = asArray(profile.cities).map((c) => String(c).trim()).filter(Boolean);
  const states = statesOf(profile).map((c) => STATES[c]);
  return [...cities, ...states.filter((s) => !cities.some((c) => c.toLowerCase().includes(s.toLowerCase())))];
}

/** marketEstimate from a unique-id count (Places) or a raw count (Overpass). */
export function estimateFrom({ source, unique, count }, { coverageFactor, overpassFactor }) {
  return source === 'overpass' ? Math.round(count * overpassFactor) : unique * coverageFactor;
}

async function loadState(clientId) {
  const raw = (await kv.hgetall(K.market(clientId))) || {};
  return {
    status: raw.status || null,
    round: raw.round || 'base',
    source: raw.source || null,
    queries: asArray(raw.queries),
    states: asArray(raw.states),
    idx: Number(raw.idx) || 0,
    page: Number(raw.page) || 0,
    pageToken: raw.pageToken || null,
    ids: asArray(raw.ids),
    count: Number(raw.count) || 0,
    perQuery: asObject(raw.perQuery) || {},
    startedAt: raw.startedAt || null,
    error: raw.error || null,
  };
}

async function saveState(clientId, s) {
  await kv.hset(K.market(clientId), {
    status: s.status, round: s.round, source: s.source || '', queries: JSON.stringify(s.queries), states: JSON.stringify(s.states),
    idx: s.idx, page: s.page, pageToken: s.pageToken || '', ids: JSON.stringify(s.ids), count: s.count,
    perQuery: JSON.stringify(s.perQuery), startedAt: s.startedAt || '', updatedAt: new Date().toISOString(), error: s.error || '',
  });
}

function freshState(profile, limits, round, now) {
  const keywords = keywordsOf(profile);
  const states = round === 'widened' ? neighboursOf(statesOf(profile)) : statesOf(profile);
  const locations = round === 'widened' ? states.map((c) => STATES[c]) : baseLocations(profile);
  return {
    status: 'running', round, source: placesConfigured() ? 'places' : 'overpass',
    queries: buildQueries(keywords, locations, { min: limits.queriesMin, max: limits.queriesMax }),
    states, idx: 0, page: 0, pageToken: null, ids: [], count: 0, perQuery: {}, startedAt: now.toISOString(), error: null,
  };
}

/**
 * Advance the count while time remains. Returns
 * { status: 'running' | 'passed' | 'declined' | 'unavailable' | 'override', estimate? }.
 */
export async function runMarketCount(clientId, { deadline = Date.now() + 15000, now = io.now() } = {}) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'onboarding') return { status: 'skipped', reason: `state ${client?.state}` };
  const profile = await getProfile(clientId);
  const limits = await cfg(clientId, 'MARKET');
  const minMarket = await cfg(clientId, 'MIN_MARKET');

  if (truthy(profile.marketOverride)) return finishPass(clientId, { estimate: Number(profile.marketEstimate) || null, override: true }, now);

  let s = await loadState(clientId);
  if (!s.status || s.status === 'unavailable' || s.status === 'passed' || s.status === 'declined') {
    if (s.status === 'passed' || s.status === 'declined') return { status: s.status };
    s = freshState(profile, limits, 'base', now);
    if (!s.queries.length) {
      await updateClient(clientId, { intakeStep: '' });
      await io.alertOwner('market_unavailable', { clientId, vars: { clientId }, body: `The market count for ${clientId} has no industry keyword or location to search for.`, did: 'Nothing was bought. Fill industry and cities/states on the client profile, then re-run the count from Mission Control.' });
      s.status = 'unavailable'; s.error = 'no queries';
      await saveState(clientId, s);
      return { status: 'unavailable' };
    }
    await logEvent(clientId, SYSTEM, 'started', { source: s.source, queries: s.queries });
  }

  while (Date.now() < deadline - 2500) {
    if (s.source === 'overpass' && !s.states.length) {
      s.status = 'unavailable'; s.error = 'Places unavailable and no US state to count in';
      await saveState(clientId, s);
      await updateClient(clientId, { intakeStep: 'market_wait' });
      await io.alertOwner('market_unavailable', { clientId, vars: { clientId }, body: `Google Places is unavailable and the profile of ${clientId} names no US state, so OpenStreetMap cannot count the market.`, did: 'Nothing was bought. The count retries every hour; add states to the profile or override from Mission Control.' });
      return { status: 'unavailable' };
    }
    if (s.source === 'places') {
      if (s.idx >= s.queries.length) break;
      try {
        const q = s.queries[s.idx];
        const { ids, nextPageToken } = await textSearchIds(q, { pageToken: s.pageToken, pageSize: limits.pageSize });
        const set = new Set(s.ids);
        for (const id of ids) set.add(id);
        s.ids = [...set];
        s.perQuery[q] = (s.perQuery[q] || 0) + ids.length;
        s.page += 1;
        const reachedCap = s.perQuery[q] >= limits.maxPerQuery;
        if (nextPageToken && !reachedCap && ids.length) { s.pageToken = nextPageToken; } else { s.idx += 1; s.page = 0; s.pageToken = null; }
      } catch (err) {
        await logEvent(clientId, SYSTEM, 'places_failed', { error: String(err.message).slice(0, 200) });
        s.source = 'overpass'; s.idx = 0; s.ids = []; s.count = 0; s.page = 0; s.pageToken = null; s.perQuery = {};
      }
    } else {
      if (s.idx >= s.states.length) break;
      try {
        const n = await countInState(s.states[s.idx], keywordsOf(profile));
        s.count += n;
        s.perQuery[s.states[s.idx]] = n;
        s.idx += 1;
      } catch (err) {
        s.status = 'unavailable'; s.error = String(err.message).slice(0, 200);
        await saveState(clientId, s);
        await updateClient(clientId, { intakeStep: 'market_wait' });
        await io.alertOwner('market_unavailable', { clientId, vars: { clientId }, body: `Neither Google Places nor OpenStreetMap could count the market for ${clientId}.\nLast error: ${s.error}`, did: 'Nothing was bought. The count retries every hour; you can also override the market check from Mission Control.' });
        return { status: 'unavailable' };
      }
    }
    await saveState(clientId, s);
  }

  const done = s.source === 'places' ? s.idx >= s.queries.length : s.idx >= s.states.length;
  if (!done) { await saveState(clientId, s); return { status: 'running', progress: `${s.idx}/${s.source === 'places' ? s.queries.length : s.states.length}` }; }

  const unique = s.ids.length;
  const estimate = estimateFrom({ source: s.source, unique, count: s.count }, limits);
  await logEvent(clientId, SYSTEM, 'counted', { round: s.round, source: s.source, unique, count: s.count, estimate });

  // Google shows at most `maxPerQuery` results for one search, so the count can
  // never exceed queries × maxPerQuery × coverageFactor (5 × 60 × 3 = 900 —
  // under MIN_MARKET). When EVERY search came back full, the market is at least
  // that big and probably far bigger: that is a pass, not "too small".
  const saturated = s.source === 'places' && s.queries.length >= limits.queriesMin
    && s.queries.every((q) => (s.perQuery[q] || 0) >= limits.maxPerQuery);
  if (estimate >= minMarket || saturated) {
    s.status = 'passed';
    await saveState(clientId, s);
    return finishPass(clientId, { estimate, source: s.source, round: s.round, capped: saturated && estimate < minMarket }, now);
  }

  if (s.round === 'base') {
    const widened = freshState(profile, limits, 'widened', now);
    if (widened.states.length) {
      // Keep what was found; the widened round adds to it.
      widened.source = s.source === 'overpass' ? 'overpass' : widened.source;
      widened.ids = s.ids; widened.count = s.count; widened.perQuery = s.perQuery;
      await saveState(clientId, widened);
      await logEvent(clientId, SYSTEM, 'widened', { states: widened.states, estimateSoFar: estimate });
      if (Date.now() < deadline - 3000) return runMarketCount(clientId, { deadline, now });
      return { status: 'running', widened: true };
    }
  }

  s.status = 'declined';
  await saveState(clientId, s);
  return finishDecline(clientId, { estimate, widened: s.round === 'widened', minMarket }, now);
}

async function finishPass(clientId, { estimate, source = null, round = null, override = false, capped = false }, now) {
  // capped: every Google search was full — the estimate is a floor ("at least").
  await kv.hset(K.profile(clientId), { marketEstimate: estimate ?? '', marketCapped: capped ? '1' : '', marketCheckedAt: now.toISOString(), marketSource: override ? 'override' : source, marketRound: round || '' });
  await setState(clientId, 'awaiting_purchase', override ? 'market override' : `market ${estimate}`);
  await updateClient(clientId, { intakeStep: 'pricescout' });
  await logEvent(clientId, SYSTEM, 'passed', { estimate, override, capped: capped || undefined });
  return { status: override ? 'override' : 'passed', estimate };
}

async function finishDecline(clientId, { estimate, widened, minMarket }, now) {
  const client = await getClient(clientId);
  await kv.hset(K.profile(clientId), { marketEstimate: estimate, marketCheckedAt: now.toISOString() });
  await sendClient(clientId, 'decline_market', {
    firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId),
    minMarket: minMarket.toLocaleString('en-US'), estimate: estimate.toLocaleString('en-US'),
    widenedLine: widened ? ', even after widening the search to the neighbouring states' : ' in the areas you gave me',
  }, { dedupe: 'decline_market' });
  await setState(clientId, 'declined', `market ${estimate} < ${minMarket}`);
  await updateClient(clientId, { declineReason: 'market_small', intakeStep: '' });
  await io.alertOwner('market_small', {
    clientId, vars: { clientId, estimate },
    body: `${client.name || clientId}: market estimate ${estimate} is under ${minMarket}${widened ? ' after widening to neighbouring states' : ''}.`,
    did: 'Declined the trial and emailed decline_market. Nothing was bought. Override from Mission Control if you want to run it anyway.',
  });
  return { status: 'declined', estimate };
}

/**
 * Owner override (Mission Control): mark the market as accepted. A client
 * still in onboarding passes on the next count run; a client already
 * declined for market size is moved on to awaiting_purchase (forced — the
 * owner has decided).
 */
export async function overrideMarket(clientId, { now = io.now(), note = '' } = {}) {
  const client = await getClient(clientId);
  if (!client) throw new Error('not found');
  await kv.hset(K.profile(clientId), { marketOverride: '1', marketOverrideAt: now.toISOString(), marketOverrideNote: String(note).slice(0, 200) });
  await logEvent(clientId, SYSTEM, 'override', { note });
  if (client.state === 'declined' && client.declineReason === 'market_small') {
    await setState(clientId, 'awaiting_purchase', 'owner market override', { force: true });
    await updateClient(clientId, { intakeStep: 'pricescout', declineReason: '' });
    return { state: 'awaiting_purchase' };
  }
  if (client.state === 'onboarding') {
    const trial = await kv.hgetall(K.trial(clientId)).catch(() => null);
    if (trial?.agreementAcceptedAt) return runMarketCount(clientId, { now });
  }
  return { state: client.state };
}
