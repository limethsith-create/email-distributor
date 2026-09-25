/**
 * OpenStreetMap Overpass API — the free fallback for counting businesses
 * when Google Places is unavailable (SPEC §6.3, §13). One request counts
 * every node/way/relation in a US state whose name matches any keyword.
 */

import { fetchJson } from '@/lib/ext/http';

/** The main server is often busy; the public mirrors serve the same data. */
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

/** Overpass QL that counts name matches for `keywords` inside one state (2-letter code). */
export function buildCountQuery(stateCode, keywords) {
  const re = keywords.map((k) => escapeRe(String(k).trim())).filter(Boolean).join('|');
  return `[out:json][timeout:25];area["ISO3166-2"="US-${String(stateCode).toUpperCase()}"][admin_level=4]->.a;(nwr["name"~"${re}",i](area.a););out count;`;
}

/** Count of matching features in one state. Throws on failure. */
export async function countInState(stateCode, keywords, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'overpass unreachable';
  for (const url of OVERPASS_URLS) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    const res = await fetchJson(url, {
      service: 'overpass',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' },
      body: `data=${encodeURIComponent(buildCountQuery(stateCode, keywords))}`,
      timeoutMs: Math.min(15000, left),
      retry: false,
    }).catch((err) => ({ ok: false, status: 0, error: err?.message }));
    const el = res.ok ? (res.json?.elements || []).find((e) => e.type === 'count') : null;
    const total = Number(el?.tags?.total);
    if (Number.isFinite(total)) return total;
    last = res.ok ? 'overpass: no count in response' : `overpass ${res.status || res.error || 'error'}`;
  }
  throw new Error(last);
}
