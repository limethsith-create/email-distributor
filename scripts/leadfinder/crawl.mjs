// Lead Finder — polite crawler (SPEC §7.2 step 3, Leads v2): the home page
// first, then up to `maxPages − 1` pages it links to that look like people
// pages (about / team / leadership / staff) or the contact page, falling back
// to the usual paths. 10 s timeout, 1 MB cap per page, robots.txt honoured,
// UA AvianceBot/1.0 (+aviance.online/bot), a short pause between pages of one
// site. LinkedIn / Facebook are never fetched (their links are only read off
// the company's own pages as name hints).
import {
  USER_AGENT, CRAWL_PATHS, parseRobots, robotsAllows, extractMailtos, extractPlainEmails, extractJsonLd, extractPeople,
  extractTeamCards, extractEmployeeHint, extractLinks, extractServices, extractFacts, mergeFacts, pagesToCrawl,
} from './lib.mjs';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readCapped(res, maxBytes = MAX_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return t.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch {}
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8');
}

export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status, html: '' };
    const type = res.headers?.get?.('content-type') || 'text/html';
    if (!/html|text\/plain/i.test(type)) return { ok: false, status: res.status, html: '' };
    return { ok: true, status: res.status, html: await readCapped(res), finalUrl: res.url || url };
  } catch (err) {
    return { ok: false, status: 0, html: '', error: err.message };
  }
}

/**
 * Crawl one company site. Returns the merged findings plus which page each
 * came from (for the "how it slipped" log of the Blocklist Keeper).
 */
export async function crawlSite(host, { fetchImpl = fetch, paths = null, maxPages = 7, delayMs = Number(process.env.LEADFINDER_PAGE_DELAY_MS ?? 250) } = {}) {
  let base = `https://${host}`;
  const robots = await fetchPage(`${base}/robots.txt`, { fetchImpl });
  const rules = robots.ok ? parseRobots(robots.html, 'AvianceBot') : [];
  const out = {
    host, pages: [], mailtos: [], emails: [], ld: { people: [], orgs: [] }, people: [], cards: [], employees: null,
    blockedByRobots: [], links: [], services: [], facts: {}, https: null, linkedinHints: [],
  };
  const read = (path, html) => {
    out.pages.push(path);
    for (const m of extractMailtos(html)) if (!out.mailtos.some((x) => x.email === m.email)) out.mailtos.push({ ...m, page: path });
    for (const e of extractPlainEmails(html)) if (!out.emails.includes(e)) out.emails.push(e);
    const ld = extractJsonLd(html);
    out.ld.people.push(...ld.people.filter((p) => !out.ld.people.some((q) => q.name === p.name)));
    out.ld.orgs.push(...ld.orgs);
    for (const p of extractPeople(html)) if (!out.people.some((q) => q.name === p.name)) out.people.push({ ...p, page: path });
    for (const p of extractTeamCards(html)) if (!out.cards.some((q) => q.name === p.name)) out.cards.push({ ...p, page: path });
    if (out.employees == null) out.employees = extractEmployeeHint(html) ?? ld.orgs.map((o) => Number(o.employees)).find((n) => Number.isFinite(n) && n > 0) ?? null;
    out.facts = mergeFacts(out.facts, extractFacts(html));
  };

  // Home page first (https, then plain http when https does not answer at all).
  const want = paths ? [...paths] : ['/'];
  let home = null;
  if (want[0] === '/') {
    want.shift();
    if (robotsAllows(rules, '/')) {
      home = await fetchPage(`${base}/`, { fetchImpl });
      if (home.ok) out.https = !/^http:/i.test(home.finalUrl || '');
      else if (home.status === 0) {
        const plain = await fetchPage(`http://${host}/`, { fetchImpl });
        if (plain.ok) { home = plain; out.https = /^https:/i.test(plain.finalUrl || ''); if (!out.https) base = `http://${host}`; }
      }
      if (home.ok) {
        read('/', home.html);
        out.links = extractLinks(home.html, host);
        out.services = extractServices(out.links);
      }
    } else out.blockedByRobots.push('/');
  }
  const next = paths ? want : pagesToCrawl(out.links, Math.max(0, maxPages - 1));
  for (const path of next) {
    if (out.pages.length >= maxPages) break;
    if (!robotsAllows(rules, path)) { out.blockedByRobots.push(path); continue; }
    if (delayMs > 0) await sleep(delayMs);
    const page = await fetchPage(`${base}${path}`, { fetchImpl });
    if (!page.ok) continue;
    read(path, page.html);
    if (!out.services.length) out.services = extractServices(extractLinks(page.html, host));
  }
  out.linkedinHints = out.facts.linkedinHints || [];
  const org = out.ld.orgs.find((o) => o.foundingDate || o.rating) || {};
  if (!out.facts.since && /^(1[89]\d\d|20[0-2]\d)/.test(org.foundingDate || '')) out.facts.since = Number(org.foundingDate.slice(0, 4));
  if (org.rating && !out.facts.siteRating) { out.facts.siteRating = org.rating; out.facts.siteReviews = org.reviews || null; }
  return out;
}

/** Back-compat alias used by v1 callers (fixed path list, no link discovery). */
export const DEFAULT_PATHS = CRAWL_PATHS;
