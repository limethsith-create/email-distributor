/**
 * Customer Blocklist Keeper (SPEC §7.3). Parses pasted customers /
 * competitors / partners (names, domains, emails, CSV) into
 * client:{id}:blocklist, and checks every lead on insert (Stage C re-checks
 * before each send with isBlocked from db/leads.js).
 *
 * Set members: an email, a bare host (`acme.com`), or `name:{normalised
 * company name}` for companies pasted by name only. Names are confirmed with
 * a cheap Places Text Search (field mask places.id,places.displayName — no
 * website, so no Enterprise charge) and both the pasted and the canonical
 * name are stored; a lead whose company name matches is dropped.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { addToBlocklist, isBlocked, hostOf } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { countUsage, isThrottled } from '@/lib/systems/usage';

const HEADER_WORDS = new Set(['name', 'names', 'email', 'emails', 'company', 'companies', 'website', 'domain', 'domains', 'customer', 'customers', 'competitor', 'competitors', 'partner', 'partners', 'url']);
const EMAIL_RE = /^[^\s@<>"]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;

/** Company name → comparison key (lower case, no punctuation, no legal suffix). */
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|inc|incorporated|llc|l l c|ltd|limited|co|corp|corporation|company|pllc|pc|lp|llp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pasted text or CSV → { emails, domains, names }. */
export function parseBlocklistInput(text) {
  const emails = new Set();
  const domains = new Set();
  const names = new Set();
  const tokens = String(text || '')
    .split(/[\r\n,;\t|]+/)
    .map((t) => t.trim().replace(/^["'<(]+|["'>)]+$/g, '').trim())
    .filter(Boolean);
  for (const tok of tokens) {
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(tok);
    const candidate = m ? m[1] : tok;
    if (EMAIL_RE.test(candidate)) { emails.add(candidate.toLowerCase()); continue; }
    if (DOMAIN_RE.test(tok) && !/\s/.test(tok)) { domains.add(hostOf(tok)); continue; }
    if (HEADER_WORDS.has(tok.toLowerCase())) continue;
    if (/[a-z]/i.test(tok) && normName(tok).length >= 3) names.add(tok.replace(/\s+/g, ' '));
  }
  return { emails: [...emails], domains: [...domains], names: [...names] };
}

/**
 * Confirm company names with Places (IDs + displayName only). Returns
 * { name → canonicalDisplayName|null }. Skipped (null) without an API key or
 * when Places is throttled.
 */
export async function resolveNames(names, { apiKey = process.env.PLACES_API_KEY, fetchImpl = globalThis.fetch, max = 25 } = {}) {
  const out = {};
  if (!apiKey || (await isThrottled('places'))) {
    for (const n of names) out[n] = null;
    return out;
  }
  for (const n of names.slice(0, max)) {
    try {
      const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName' },
        body: JSON.stringify({ textQuery: n, pageSize: 1 }),
        signal: AbortSignal.timeout(8000),
      });
      await countUsage('places', 'idsOnly', 1);
      const j = res.ok ? await res.json() : null;
      out[n] = j?.places?.[0]?.displayName?.text || null;
    } catch {
      out[n] = null;
    }
  }
  for (const n of names.slice(max)) out[n] = null;
  return out;
}

/**
 * Add pasted input to the client's blocklist.
 * @returns {{emails, domains, names, resolved}}
 */
export async function addBlocklistInput(clientId, text, { source = 'paste', resolve = true, deps = {} } = {}) {
  const parsed = parseBlocklistInput(text);
  let n = 0;
  if (parsed.emails.length || parsed.domains.length) n += await addToBlocklist(clientId, ...parsed.emails, ...parsed.domains);
  let resolved = {};
  if (parsed.names.length) {
    if (resolve) resolved = await resolveNames(parsed.names, deps);
    const keys = new Set();
    for (const name of parsed.names) {
      keys.add(`name:${normName(name)}`);
      if (resolved[name]) keys.add(`name:${normName(resolved[name])}`);
    }
    const vals = [...keys].filter((k) => k.length > 7);
    if (vals.length) { await kv.sadd(K.blocklist(clientId), ...vals); n += vals.length; }
  }
  await logEvent(clientId, 'blocklist', 'added', { source, emails: parsed.emails.length, domains: parsed.domains.length, names: parsed.names.length, resolvedNames: Object.values(resolved).filter(Boolean).length });
  return { ...parsed, resolved, added: n };
}

/**
 * Reason a lead must not be inserted/sent for this client, else null.
 * Checks the email (suppression + blocklist), the email host, the website
 * host and the company name.
 */
export async function checkLead(clientId, lead) {
  const byEmail = await isBlocked(clientId, lead.email);
  if (byEmail) return byEmail;
  const p = kv.pipeline();
  const site = lead.website ? hostOf(lead.website) : '';
  const nameKey = lead.company ? `name:${normName(lead.company)}` : '';
  p.sismember(K.blocklist(clientId), site || '__none__');
  p.sismember(K.blocklist(clientId), nameKey || '__none__');
  const [s, nm] = await p.exec();
  if (site && s === 1) return 'blocklist:website';
  if (nameKey && nm === 1) return 'blocklist:name';
  return null;
}

/** Hosts in the blocklist (for the Lead Finder profile payload). */
export async function blockedHosts(clientId) {
  const all = (await kv.smembers(K.blocklist(clientId))) || [];
  return {
    hosts: all.filter((x) => !x.includes('@') && !x.startsWith('name:')),
    names: all.filter((x) => x.startsWith('name:')).map((x) => x.slice(5)),
  };
}
