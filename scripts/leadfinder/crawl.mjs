// Lead Finder — polite crawler (SPEC §7.2 step 3): 6 paths, 10 s timeout,
// 1 MB cap, robots.txt honoured, UA AvianceBot/1.0 (+aviance.online/bot).
import {
  USER_AGENT, CRAWL_PATHS, parseRobots, robotsAllows, extractMailtos, extractPlainEmails,
  extractJsonLd, extractPeople, extractEmployeeHint,
} from './lib.mjs';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

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
    return { ok: true, status: res.status, html: await readCapped(res) };
  } catch (err) {
    return { ok: false, status: 0, html: '', error: err.message };
  }
}

/**
 * Crawl one company site. Returns the merged findings plus which page each
 * came from (for the "how it slipped" log of the Blocklist Keeper).
 */
export async function crawlSite(host, { fetchImpl = fetch, paths = CRAWL_PATHS } = {}) {
  const base = `https://${host}`;
  const robots = await fetchPage(`${base}/robots.txt`, { fetchImpl });
  const rules = robots.ok ? parseRobots(robots.html, 'AvianceBot') : [];
  const out = { host, pages: [], mailtos: [], emails: [], ld: { people: [], orgs: [] }, people: [], employees: null, blockedByRobots: [] };
  for (const path of paths) {
    if (!robotsAllows(rules, path)) { out.blockedByRobots.push(path); continue; }
    const page = await fetchPage(`${base}${path}`, { fetchImpl });
    if (!page.ok) continue;
    out.pages.push(path);
    const html = page.html;
    for (const m of extractMailtos(html)) if (!out.mailtos.some((x) => x.email === m.email)) out.mailtos.push({ ...m, page: path });
    for (const e of extractPlainEmails(html)) if (!out.emails.includes(e)) out.emails.push(e);
    const ld = extractJsonLd(html);
    out.ld.people.push(...ld.people.filter((p) => !out.ld.people.some((q) => q.name === p.name)));
    out.ld.orgs.push(...ld.orgs);
    for (const p of extractPeople(html)) if (!out.people.some((q) => q.name === p.name)) out.people.push({ ...p, page: path });
    if (out.employees == null) out.employees = extractEmployeeHint(html) ?? ld.orgs.map((o) => Number(o.employees)).find((n) => Number.isFinite(n) && n > 0) ?? null;
  }
  return out;
}
