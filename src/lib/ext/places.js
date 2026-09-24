/**
 * Google Places API (New) — Text Search with the IDs-only field mask
 * (`places.id,nextPageToken`). IDs-only requests are the free Essentials SKU,
 * so the Market Counter never spends the Enterprise quota the Lead Finder
 * needs (SPEC §6.3, §13). Every call is counted under usage:places:{month}
 * field `idsOnly`.
 */

import { fetchJson } from '@/lib/ext/http';

const URL = 'https://places.googleapis.com/v1/places:searchText';

export const placesConfigured = () => Boolean(process.env.PLACES_API_KEY);

/**
 * One page of place ids for a text query.
 * @returns {Promise<{ids: string[], nextPageToken: string|null}>}
 * Throws on any non-2xx so the caller can fall back to Overpass.
 */
export async function textSearchIds(textQuery, { pageToken = null, pageSize = 20 } = {}) {
  const key = process.env.PLACES_API_KEY;
  if (!key) throw new Error('PLACES_API_KEY not set');
  const body = { textQuery, pageSize };
  if (pageToken) body.pageToken = pageToken;
  const res = await fetchJson(URL, {
    service: 'places',
    usageField: 'idsOnly',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,nextPageToken' },
    body: JSON.stringify(body),
    timeoutMs: 8000,
  });
  if (!res.ok || !res.json) throw new Error(`places ${res.status}: ${String(res.json?.error?.message || res.text || '').slice(0, 160)}`);
  return {
    ids: (res.json.places || []).map((p) => p && p.id).filter(Boolean),
    nextPageToken: res.json.nextPageToken || null,
  };
}
