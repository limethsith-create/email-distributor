/**
 * Ava's web search (docs/HUB-API.md "Ava (AI helper)") for current or
 * outside facts: Tavily first (TAVILY_API_KEY; free 1,000 searches a month,
 * no training), Exa second (EXA_API_KEY). Only the question's words go out —
 * email addresses, phone numbers, links and the clients' contact names are
 * taken out first. The results come back as title + site + a short snippet
 * (no links: the answer names the site).
 */

import { secretOf, secretsSnapshot } from '@/lib/secrets';
import { cleanText } from '@/lib/ava/text';

export const SEARCH_IO = {
  fetch: (...a) => globalThis.fetch(...a),
  timeoutMs: 6000,
};
export const TAVILY_URL = 'https://api.tavily.com/search';
export const EXA_URL = 'https://api.exa.ai/search';

/** Which search keys exist → ['tavily', 'exa'] (in the order they are tried). */
export async function searchProviders() {
  const snap = await secretsSnapshot();
  const out = [];
  if (await secretOf('TAVILY_API_KEY', snap)) out.push('tavily');
  if (await secretOf('EXA_API_KEY', snap)) out.push('exa');
  return out;
}

/** The query with no personal data: no emails, phones, links or contact names; ≤ 300 chars. */
export function scrubQuery(q, names = []) {
  return cleanText(String(q || ''), names)
    .replace(/\[(?:email|phone|link)\]/g, ' ')
    .replace(/\bthe client\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const snip = (s, n = 320) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function post(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEARCH_IO.timeoutMs);
  try {
    const res = await SEARCH_IO.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: ctl.signal.aborted ? 'timed out' : 'could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

async function tavily(query, key) {
  const r = await post(TAVILY_URL, { authorization: `Bearer ${key}` }, { query, max_results: 5, search_depth: 'basic', include_answer: true, include_raw_content: false, include_images: false });
  if (!r.ok) return { ok: false, error: `Tavily ${r.error || `said ${r.status}`}` };
  const results = (r.json?.results || []).slice(0, 5).map((x) => ({ title: snip(x.title, 120), site: host(x.url), snippet: snip(x.content), date: x.published_date || null }));
  return { ok: true, via: 'tavily', answer: r.json?.answer ? snip(r.json.answer, 500) : null, results };
}

async function exa(query, key) {
  const r = await post(EXA_URL, { 'x-api-key': key }, { query, numResults: 5, type: 'auto', contents: { text: { maxCharacters: 600 } } });
  if (!r.ok) return { ok: false, error: `Exa ${r.error || `said ${r.status}`}` };
  const results = (r.json?.results || []).slice(0, 5).map((x) => ({ title: snip(x.title, 120), site: host(x.url), snippet: snip(x.text || x.summary || (x.highlights || []).join(' ')), date: x.publishedDate ? String(x.publishedDate).slice(0, 10) : null }));
  return { ok: true, via: 'exa', answer: null, results };
}

/**
 * Search the web → { query, via, answer, results: [{ title, site, snippet, date }] }
 * | { error, noKey? }. `names` = words to hide (the clients' contact names).
 */
export async function webSearch(rawQuery, { names = [] } = {}) {
  const query = scrubQuery(rawQuery, names);
  if (!query || query.length < 2) return { error: 'Nothing to search for.' };
  const snap = await secretsSnapshot();
  const keys = { tavily: await secretOf('TAVILY_API_KEY', snap), exa: await secretOf('EXA_API_KEY', snap) };
  if (!keys.tavily && !keys.exa) return { error: 'No web search key yet (Tavily or Exa in Settings › Keys) — answer from what you know and say it may be out of date.', noKey: true };
  const errors = [];
  for (const [name, run] of [['tavily', tavily], ['exa', exa]]) {
    if (!keys[name]) continue;
    const r = await run(query, keys[name]);
    if (r.ok && r.results.length) return { query, via: r.via, answer: r.answer, results: r.results };
    errors.push(r.ok ? `${name}: nothing found` : r.error);
  }
  return { query, error: `The web search did not work just now (${errors.join('; ')}). Answer from what you know and say it may be out of date.` };
}
