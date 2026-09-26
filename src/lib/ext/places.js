/**
 * Google Places API (New) — Text Search with the IDs-only field mask
 * (`places.id,nextPageToken`). IDs-only requests are the free Essentials SKU,
 * so the Market Counter never spends the Enterprise quota the Lead Finder
 * needs (SPEC §6.3, §13). Every call is counted under usage:places:{month}
 * field `idsOnly`.
 *
 * The key: env PLACES_API_KEY wins, else the one the owner pasted in the hub
 * (lib/secrets.js, Settings › Keys).
 */

import { fetchJson } from '@/lib/ext/http';
import { secretOf } from '@/lib/secrets';

const URL = 'https://places.googleapis.com/v1/places:searchText';

/** Is a Places key there at all (env or the hub's)? */
export const placesConfigured = async () => Boolean(await secretOf('PLACES_API_KEY'));

async function keyOrThrow() {
  const key = await secretOf('PLACES_API_KEY');
  if (!key) throw new Error('PLACES_API_KEY not set');
  return key;
}

/**
 * One page of place ids for a text query.
 * @returns {Promise<{ids: string[], nextPageToken: string|null}>}
 * Throws on any non-2xx so the caller can fall back to Overpass.
 */
export async function textSearchIds(textQuery, { pageToken = null, pageSize = 20, timeoutMs = 8000 } = {}) {
  const key = await keyOrThrow();
  const body = { textQuery, pageSize };
  if (pageToken) body.pageToken = pageToken;
  const res = await fetchJson(URL, {
    service: 'places',
    usageField: 'idsOnly',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,nextPageToken' },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!res.ok || !res.json) throw new Error(`places ${res.status}: ${String(res.json?.error?.message || res.text || '').slice(0, 160)}`);
  return {
    ids: (res.json.places || []).map((p) => p && p.id).filter(Boolean),
    nextPageToken: res.json.nextPageToken || null,
  };
}

/**
 * Field mask for the Applicant Research business lookup. rating,
 * userRatingCount, nationalPhoneNumber and websiteUri are Enterprise-SKU
 * fields, so every call is counted under usage:places field `enterprise`
 * (the monthly budget the Lead Finder and the Usage Meter watch). websiteUri
 * is only used to pick the right result (same SKU, no extra cost).
 */
export const BUSINESS_FIELDS = [
  'places.displayName', 'places.formattedAddress', 'places.primaryTypeDisplayName', 'places.rating',
  'places.userRatingCount', 'places.googleMapsUri', 'places.nationalPhoneNumber', 'places.websiteUri',
].join(',');

/**
 * Up to `pageSize` businesses for a text query, as plain objects
 * { name, address, category, rating, reviews, mapsUrl, phone, website }.
 * Missing values stay null (never 0). Throws on any non-2xx.
 */
export async function textSearchBusiness(textQuery, { pageSize = 3, timeoutMs = 8000 } = {}) {
  const key = await keyOrThrow();
  const res = await fetchJson(URL, {
    service: 'places',
    usageField: 'enterprise',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': BUSINESS_FIELDS },
    body: JSON.stringify({ textQuery, pageSize }),
    timeoutMs,
    retry: false,
  });
  if (!res.ok || !res.json) throw new Error(`places ${res.status}: ${String(res.json?.error?.message || res.text || '').slice(0, 160)}`);
  return (res.json.places || []).filter(Boolean).map(mapBusiness);
}

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const textOf = (v) => (v && typeof v === 'object' ? v.text || null : typeof v === 'string' && v ? v : null);

/** One Places (New) result → the research `business` shape (+ website, used for matching only). */
export function mapBusiness(p = {}) {
  return {
    name: textOf(p.displayName),
    address: p.formattedAddress || null,
    category: textOf(p.primaryTypeDisplayName),
    rating: numOrNull(p.rating),
    reviews: numOrNull(p.userRatingCount),
    mapsUrl: p.googleMapsUri || null,
    phone: p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
  };
}
