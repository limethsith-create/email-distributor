/**
 * Learning Library (SPEC §8.11). Aggregate counters per niche and copy
 * variant — sends, replies, positive, booked — plus the best send hour and
 * the best city slice. No personal data: only niche, variant id, hour of day
 * and city names are stored, so learning:* survives client deletion.
 *
 *   learning:{niche}:raw   flat counters: v:{variant}:{event}, h:{HH}:{event}, c:{city}:{event}, emergency:{trigger}
 *   learning:{niche}       rolled-up view (SPEC §3): {variant} → {sends, replies, positive, booked},
 *                          plus _bestHour, _bestCity, _rank, _rankedAt (weekly)
 *   client:{id}:learnstats the same flat counters for one client (+ s:{sizeBand}:{event}),
 *                          used by the Pace Checks; deleted with the client.
 *
 * A variant id is `{A|B}{sequence version}` (A1, B1, A2 …): the same letter +
 * version means the same template for every client in a niche.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getProfile } from '@/lib/db/client';
import { partsIn, ET } from '@/lib/time';
import { nicheOf, lower, ccfg } from '@/lib/systems/stagec-common';

export const EVENTS = ['sends', 'replies', 'positive', 'booked'];
const cleanCity = (c) => String(c || '').trim().replace(/[:|]/g, ' ').slice(0, 40);

export function variantId(letter, version) {
  return `${String(letter || 'A').toUpperCase().slice(0, 1)}${Number(version) || 1}`;
}

/**
 * Count one event. `lead` supplies variant (lead.sentVariant/sentVersion),
 * city and size band; `at` is the time used for the hour slice (the send time
 * for sends, the original send time for replies so the hour means "hour we
 * sent that got an answer").
 */
export async function recordLearning(clientId, event, { lead = {}, niche = null, at = null } = {}) {
  if (!EVENTS.includes(event)) return;
  try {
    let n = niche;
    if (!n) {
      const [client, profile] = await Promise.all([getClient(clientId), getProfile(clientId)]);
      n = nicheOf(client || {}, profile || {});
    }
    const variant = variantId(lead.sentVariant || lead.sequenceVariant, lead.sentVersion);
    const whenIso = at || lead.sent_at || new Date().toISOString();
    const hour = String(partsIn(lead.tz || ET, new Date(whenIso)).hour).padStart(2, '0');
    const city = cleanCity(lead.city);
    const size = cleanCity(lead.sizeBand || lead.size);
    const p = kv.pipeline();
    for (const key of [K.learningRaw(n), K.learnStats(clientId)]) {
      p.hincrby(key, `v:${variant}:${event}`, 1);
      p.hincrby(key, `h:${hour}:${event}`, 1);
      if (city) p.hincrby(key, `c:${city}:${event}`, 1);
    }
    if (size) p.hincrby(K.learnStats(clientId), `s:${size}:${event}`, 1);
    await p.exec();
    // Sends are rolled up with the next reply / positive / booking and by the
    // weekly job (a roll-up per send cost ~2 commands per email).
    if (event !== 'sends') await rollVariant(n, variant);
  } catch (err) {
    console.error('[learning] record failed', clientId, event, err?.message);
  }
}

/** Refresh the rolled-up variant field after a change ("on every counter change"). */
async function rollVariant(niche, variant) {
  const fields = EVENTS.map((e) => `v:${variant}:${e}`);
  const res = (await kv.hmget(K.learningRaw(niche), ...fields)) || {};
  const row = {};
  EVENTS.forEach((e, i) => { const v = Array.isArray(res) ? res[i] : res[fields[i]]; row[e] = Number(v) || 0; });
  await kv.hset(K.learning(niche), { [variant]: row });
}

/** Deliverability cause, logged per niche (SPEC §8.10 step 6). */
export async function recordEmergencyCause(clientId, trigger) {
  try {
    const [client, profile] = await Promise.all([getClient(clientId), getProfile(clientId)]);
    await kv.hincrby(K.learningRaw(nicheOf(client || {}, profile || {})), `emergency:${trigger}`, 1);
  } catch {}
}

/** Parse flat counters → { variants, hours, cities, sizes, emergencies }. */
export function parseRaw(raw = {}) {
  const out = { variants: {}, hours: {}, cities: {}, sizes: {}, emergencies: {} };
  const into = (bucket, name, event, v) => {
    bucket[name] = bucket[name] || { sends: 0, replies: 0, positive: 0, booked: 0 };
    bucket[name][event] = (bucket[name][event] || 0) + (Number(v) || 0);
  };
  for (const [k, v] of Object.entries(raw || {})) {
    const parts = k.split(':');
    if (parts[0] === 'emergency') { out.emergencies[parts.slice(1).join(':')] = Number(v) || 0; continue; }
    const event = parts[parts.length - 1];
    const name = parts.slice(1, -1).join(':');
    if (!EVENTS.includes(event) || !name) continue;
    const bucket = { v: out.variants, h: out.hours, c: out.cities, s: out.sizes }[parts[0]];
    if (bucket) into(bucket, name, event, v);
  }
  return out;
}

const rate = (row, ev) => (row.sends ? (row[ev] || 0) / row.sends : 0);

/** Best entry of a bucket by reply rate (ties: positive rate, then sends), with a minimum sample. */
export function bestOf(bucket, minSends) {
  const rows = Object.entries(bucket).filter(([, r]) => r.sends >= minSends);
  if (!rows.length) return null;
  rows.sort((a, b) => (rate(b[1], 'replies') - rate(a[1], 'replies')) || (rate(b[1], 'positive') - rate(a[1], 'positive')) || (b[1].sends - a[1].sends));
  const [name, r] = rows[0];
  return { name, ...r, replyRate: rate(r, 'replies') };
}

/** Rank variants: booked rate, then positive rate, then reply rate (minimum sample applies). */
export function rankVariants(variants, minSends) {
  return Object.entries(variants)
    .filter(([, r]) => r.sends >= minSends)
    .sort((a, b) => (rate(b[1], 'booked') - rate(a[1], 'booked')) || (rate(b[1], 'positive') - rate(a[1], 'positive')) || (rate(b[1], 'replies') - rate(a[1], 'replies')))
    .map(([name, r]) => ({ variant: name, ...r, replyRate: rate(r, 'replies'), positiveRate: rate(r, 'positive'), bookedRate: rate(r, 'booked') }));
}

/** Every niche with learning data. */
export async function listNiches() {
  const out = new Set();
  try {
    let cursor = '0';
    for (let i = 0; i < 50; i++) {
      const [next, keys] = await kv.scan(cursor, { match: 'learning:*', count: 200 });
      for (const k of keys || []) { const n = String(k).split(':')[1]; if (n) out.add(n); }
      cursor = String(next);
      if (cursor === '0') break;
    }
  } catch {}
  return [...out].sort();
}

/** Weekly rollup for one niche → writes the view fields and returns them. */
export async function rollupNiche(niche, now = new Date()) {
  const raw = (await kv.hgetall(K.learningRaw(niche))) || {};
  const parsed = parseRaw(raw);
  const minSends = await ccfg(null, 'LEARNING.minSends');
  const rank = rankVariants(parsed.variants, minSends);
  const bestHour = bestOf(parsed.hours, minSends);
  const bestCity = bestOf(parsed.cities, minSends);
  const view = { ...parsed.variants, _rank: rank, _bestHour: bestHour, _bestCity: bestCity, _emergencies: parsed.emergencies, _rankedAt: now.toISOString() };
  if (Object.keys(view).length) await kv.hset(K.learning(niche), view);
  return { niche, rank, bestHour, bestCity, variants: parsed.variants, emergencies: parsed.emergencies };
}

export async function runLearningWeekly({ now = new Date() } = {}) {
  const niches = await listNiches();
  const out = [];
  for (const n of niches) out.push(await rollupNiche(n, now));
  return { niches: out.length, top: out.map((r) => ({ niche: r.niche, top: r.rank[0]?.variant || null })) };
}

/** Per-client stats (for Pace Checks). */
export async function clientStats(clientId) {
  return parseRaw((await kv.hgetall(K.learnStats(clientId))) || {});
}

/** For the Copy Engine (Stage B): the niche's top two variants, or null when too little data. */
export async function topVariants(niche) {
  const minSends = await ccfg(null, 'LEARNING.minSends');
  const rank = rankVariants(parseRaw((await kv.hgetall(K.learningRaw(lower(niche)))) || {}).variants, minSends);
  return rank.length ? { first: rank[0].variant, second: rank[1]?.variant || null } : null;
}

