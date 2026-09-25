// Lead Finder — search sources (SPEC §7.2 step 1). `fetchImpl` is injectable.
import { parseUsAddress, hostOf } from './lib.mjs';

// Enterprise SKU because of websiteUri / nationalPhoneNumber. rating and
// userRatingCount are Enterprise fields too, businessStatus and primaryType
// Pro fields — a request is billed once, at the highest SKU its field mask
// needs, so the extra fields cost nothing more (docs/research/v2-leads-copy.md).
export const PLACES_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.types,places.primaryType,places.businessStatus,places.rating,places.userRatingCount,nextPageToken';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Google Places Text Search (New), Enterprise field mask. Each page is one
 * Enterprise request. Returns { places, requests, error }. `rectangle`
 * ({low:{latitude,longitude}, high:{…}}) restricts a categorical query to
 * one cell of a city grid (Text Search returns at most 60 results a query,
 * so a busy city is searched cell by cell).
 */
export async function placesTextSearch(query, { apiKey, fetchImpl = fetch, maxPages = 3, budgetLeft = Infinity, rectangle = null } = {}) {
  const places = [];
  let requests = 0;
  let pageToken = null;
  for (let page = 0; page < maxPages && requests < budgetLeft; page++) {
    const body = { textQuery: query, pageSize: 20, regionCode: 'US', ...(rectangle ? { locationRestriction: { rectangle } } : {}), ...(pageToken ? { pageToken } : {}) };
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

/**
 * A city's map viewport from Places (field mask places.viewport — a Pro
 * field: billed to the Pro SKU's 5,000 free a month, not the Enterprise
 * quota). Returns { viewport, requests } (viewport null when not found).
 */
export async function placesCityViewport(city, state, { apiKey, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.viewport' },
      body: JSON.stringify({ textQuery: `${city}, ${state}`, pageSize: 1, regionCode: 'US', includedType: 'locality' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { viewport: null, requests: 1 };
    const j = await res.json();
    const v = j.places?.[0]?.viewport;
    const ok = v && [v.low?.latitude, v.low?.longitude, v.high?.latitude, v.high?.longitude].every((x) => Number.isFinite(Number(x)));
    return { viewport: ok ? v : null, requests: 1 };
  } catch {
    return { viewport: null, requests: 0 };
  }
}

/** Split a viewport into n × n rectangles (row by row, south-west first). */
export function gridCells(viewport, n = 3) {
  const { low, high } = viewport;
  const dLat = (high.latitude - low.latitude) / n;
  const dLng = (high.longitude - low.longitude) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({
        low: { latitude: low.latitude + i * dLat, longitude: low.longitude + j * dLng },
        high: { latitude: low.latitude + (i + 1) * dLat, longitude: low.longitude + (j + 1) * dLng },
      });
    }
  }
  return out;
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

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
    primaryType: p.primaryType || '',
    businessStatus: p.businessStatus || '',
    rating: num(p.rating),
    reviews: num(p.userRatingCount),
    source: 'places',
  };
}

// Industry words → the OSM tags businesses of that kind carry
// (wiki.openstreetmap.org Key:craft / Key:office / Key:healthcare).
const OSM_TAGS = [
  [/plumb/, ['craft', 'plumber']], [/roof/, ['craft', 'roofer']], [/electric/, ['craft', 'electrician']], [/hvac|heating|air condition/, ['craft', 'hvac']],
  [/carpent/, ['craft', 'carpenter']], [/paint/, ['craft', 'painter']], [/landscap|gardener/, ['craft', 'gardener']], [/clean/, ['craft', 'cleaning']],
  [/\bit\b|managed it|msp|computer|tech support/, ['office', 'it']], [/account|bookkeep|cpa/, ['office', 'accountant']], [/law|attorney|legal/, ['office', 'lawyer']],
  [/insurance/, ['office', 'insurance']], [/real estate|realtor/, ['office', 'estate_agent']], [/architect/, ['office', 'architect']],
  [/engineer/, ['office', 'engineer']], [/consult/, ['office', 'consulting']], [/marketing|advertis|agency/, ['office', 'advertising_agency']],
  [/financ|wealth|advis/, ['office', 'financial_advisor']], [/employment|staffing|recruit/, ['office', 'employment_agency']],
  [/property manag/, ['office', 'property_management']], [/dent/, ['healthcare', 'dentist']], [/chiropract/, ['healthcare', 'chiropractor']],
  [/veterinar|vet clinic|animal hospital/, ['amenity', 'veterinary']], [/physio|physical therap/, ['healthcare', 'physiotherapist']],
  [/logistic|freight|trucking/, ['office', 'logistics']], [/construct|contractor|builder/, ['craft', 'builder']],
];

export function osmTagsFor(keyword) {
  const k = String(keyword || '').toLowerCase();
  return OSM_TAGS.filter(([re]) => re.test(k)).map(([, t]) => t);
}

/**
 * OpenStreetMap Overpass fallback (1 request / 5 s). One query per city:
 * the OSM tags for the industry, plus offices, shops and crafts with a
 * website whose name or tag matches the keyword.
 */
export function overpassQuery(keyword, city, state) {
  const kw = String(keyword).replace(/["\\]/g, '').split(/\s+/).filter((w) => w.length > 2).join('|') || keyword;
  const tagged = osmTagsFor(keyword).map(([k, v]) => `  nwr["${k}"="${v}"]["website"](area.a);\n  nwr["${k}"="${v}"]["contact:website"](area.a);`).join('\n');
  return `[out:json][timeout:60];
area["ISO3166-2"="US-${state}"]->.s;
area["name"="${String(city).replace(/["\\]/g, '')}"]["boundary"="administrative"](area.s)->.a;
(
${tagged ? `${tagged}\n` : ''}  nwr["office"~"${kw}",i]["website"](area.a);
  nwr["shop"~"${kw}",i]["website"](area.a);
  nwr["craft"~"${kw}",i]["website"](area.a);
  nwr["name"~"${kw}",i]["website"](area.a);
);
out tags center 300;`;
}

let lastOverpassAt = 0;

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export async function overpassSearch(keyword, city, state, { fetchImpl = fetch, minGapMs = 5000 } = {}) {
  const wait = lastOverpassAt + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastOverpassAt = Date.now();
  try {
    // The main Overpass server is often busy (429/504); the public mirrors serve the same data.
    let res = null;
    let lastErr = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' },
          body: `data=${encodeURIComponent(overpassQuery(keyword, city, state))}`,
          signal: AbortSignal.timeout(90000),
        });
        if (res.ok) break;
        lastErr = `overpass ${res.status}`;
        if (![429, 502, 503, 504].includes(res.status)) break;
      } catch (err) {
        lastErr = `overpass ${err?.name === 'TimeoutError' ? 'timeout' : 'unreachable'}`;
        res = null;
      }
    }
    if (!res || !res.ok) return { places: [], error: lastErr || 'overpass unreachable' };
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
        types: [t.office, t.shop, t.craft, t.healthcare].filter(Boolean),
        email: t.email || t['contact:email'] || '',
        brand: t.brand || '',
        source: 'osm',
      };
    }).filter((p) => p.company && p.host);
    return { places, error: null };
  } catch (err) {
    return { places: [], error: err.message };
  }
}
