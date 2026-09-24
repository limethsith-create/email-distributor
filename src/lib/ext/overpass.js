/**
 * OpenStreetMap Overpass API — the free fallback for counting businesses
 * when Google Places is unavailable (SPEC §6.3, §13). One request counts
 * every node/way/relation in a US state whose name matches any keyword.
 */

import { fetchJson } from '@/lib/ext/http';

const URL = 'https://overpass-api.de/api/interpreter';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

/** Overpass QL that counts name matches for `keywords` inside one state (2-letter code). */
export function buildCountQuery(stateCode, keywords) {
  const re = keywords.map((k) => escapeRe(String(k).trim())).filter(Boolean).join('|');
  return `[out:json][timeout:25];area["ISO3166-2"="US-${String(stateCode).toUpperCase()}"][admin_level=4]->.a;(nwr["name"~"${re}",i](area.a););out count;`;
}

/** Count of matching features in one state. Throws on failure. */
export async function countInState(stateCode, keywords) {
  const res = await fetchJson(URL, {
    service: 'overpass',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' },
    body: `data=${encodeURIComponent(buildCountQuery(stateCode, keywords))}`,
    timeoutMs: 15000,
    retry: false,
  });
  if (!res.ok || !res.json) throw new Error(`overpass ${res.status}`);
  const el = (res.json.elements || []).find((e) => e.type === 'count');
  const total = Number(el?.tags?.total);
  if (!Number.isFinite(total)) throw new Error('overpass: no count in response');
  return total;
}
