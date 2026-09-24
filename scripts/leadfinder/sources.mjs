// Lead Finder — search sources (SPEC §7.2 step 1). `fetchImpl` is injectable.
import { parseUsAddress, hostOf } from './lib.mjs';

export const PLACES_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.types,nextPageToken';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Google Places Text Search (New), Enterprise field mask. Each page is one
 * Enterprise request. Returns { places, requests, error }.
 */
export async function placesTextSearch(query, { apiKey, fetchImpl = fetch, maxPages = 3, budgetLeft = Infinity } = {}) {
  const places = [];
  let requests = 0;
  let pageToken = null;
  for (let page = 0; page < maxPages && requests < budgetLeft; page++) {
    const body = { textQuery: query, pageSize: 20, regionCode: 'US', ...(pageToken ? { pageToken } : {}) };
    let res;
    try {
      res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACES_FIELD_MASK },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      return { places, requests, error: err.message };
    }
    requests++;
    if (!res.ok) return { places, requests, error: `places ${res.status}` };
    const j = await res.json();
    for (const p of j.places || []) places.push(placeToCandidate(p));
    pageToken = j.nextPageToken || null;
    if (!pageToken) break;
    await sleep(1500); // a next-page token needs a moment to become valid
  }
  return { places, requests, error: null };
}

export function placeToCandidate(p) {
  const addr = parseUsAddress(p.formattedAddress);
  return {
    placeId: p.id,
    company: p.displayName?.text || '',
    address: p.formattedAddress || '',
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    website: p.websiteUri || '',
    host: p.websiteUri ? hostOf(p.websiteUri) : '',
    phone: p.nationalPhoneNumber || '',
    types: p.types || [],
    source: 'places',
  };
}

/**
 * OpenStreetMap Overpass fallback (1 request / 5 s). One query per city:
 * offices, shops and crafts with a website whose name or tag matches the keyword.
 */
export function overpassQuery(keyword, city, state) {
  const kw = String(keyword).replace(/["\\]/g, '').split(/\s+/).filter((w) => w.length > 2).join('|') || keyword;
  return `[out:json][timeout:60];
area["ISO3166-2"="US-${state}"]->.s;
area["name"="${String(city).replace(/["\\]/g, '')}"]["boundary"="administrative"](area.s)->.a;
(
  nwr["office"~"${kw}",i]["website"](area.a);
  nwr["shop"~"${kw}",i]["website"](area.a);
  nwr["craft"~"${kw}",i]["website"](area.a);
  nwr["name"~"${kw}",i]["website"](area.a);
);
out tags center 300;`;
}

let lastOverpassAt = 0;

export async function overpassSearch(keyword, city, state, { fetchImpl = fetch, minGapMs = 5000 } = {}) {
  const wait = lastOverpassAt + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastOverpassAt = Date.now();
  try {
    const res = await fetchImpl('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' },
      body: `data=${encodeURIComponent(overpassQuery(keyword, city, state))}`,
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return { places: [], error: `overpass ${res.status}` };
    const j = await res.json();
    const places = (j.elements || []).map((el) => {
      const t = el.tags || {};
      const website = t.website || t['contact:website'] || '';
      return {
        placeId: `osm:${el.type}/${el.id}`,
        company: t.name || '',
        address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
        city: t['addr:city'] || city,
        state: t['addr:state'] || state,
        zip: t['addr:postcode'] || '',
        website,
        host: website ? hostOf(website) : '',
        phone: t.phone || t['contact:phone'] || '',
        types: [t.office, t.shop, t.craft].filter(Boolean),
        email: t.email || t['contact:email'] || '',
        source: 'osm',
      };
    }).filter((p) => p.company && p.host);
    return { places, error: null };
  } catch (err) {
    return { places: [], error: err.message };
  }
}
