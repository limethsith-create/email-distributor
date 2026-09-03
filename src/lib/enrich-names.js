/**
 * Name-Enrichment Bot — Aviance
 *
 * Finds the owner/decision-maker's first name for leads that don't have one,
 * completely hands-off:
 *   1. Takes a small batch of pending leads with no first_name.
 *   2. Visits the lead's own website (homepage + about page, in parallel).
 *   3. Asks Gemini (free tier) to extract the owner/founder/CEO's name
 *      from the page text — with a strict "return null if unsure" rule.
 *   4. Writes first_name (+ full name) back onto the lead, so the sending
 *      engine automatically switches to named subjects + "Hi <name>," openers.
 *
 * Runs piggybacked on the auto-send heartbeat (throttled, capped, fail-safe):
 * it can never delay or break a send. Without GEMINI_API_KEY it is a no-op.
 *
 * Results are cached per company domain (`name_by_domain`), so two leads at
 * the same company cost one crawl. A Gemini / network failure is recorded as
 * `name_enrich_error` and retried on a later run (up to 3 tries); only a
 * completed crawl that found nothing marks the lead `name_enrich_tried`.
 */

import { kv } from '@vercel/kv';
import { geminiGenerate } from '@/lib/gemini';
import { getAllLeads, patchLead } from '@/lib/leads-db';
import { isFreeMailDomain, leadScore, normalizeEmail, UNSENT_STATUSES } from '@/lib/metrics';

const THROTTLE_KEY = 'enrich_names_last_run';
const DOMAIN_CACHE_KEY = 'name_by_domain';     // Hash: domain -> { first_name, name, checkedAt }
const THROTTLE_MS = 3 * 60 * 60 * 1000;         // every ~3h
const BATCH_SIZE = 5;                            // leads per run — keeps it light
const FETCH_TIMEOUT_MS = 6000;
const RUN_BUDGET_MS = 20000;                     // wall-clock cap for the whole run
const MAX_TRIES = 3;                             // transient failures before giving up
const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000; // "nothing found" is re-checked after 30 days

// A real first name: capitalised, letters / apostrophes / hyphens, 2-20 chars
// (DeShawn, McKenzie, Jean-Luc, O'Neil).
const NAME_RE = /^[A-Z][A-Za-z'’-]{1,19}$/;
const NAME_STOPLIST = new Set([
  'team', 'home', 'about', 'contact', 'sales', 'info', 'support', 'admin', 'hello', 'welcome',
  'careers', 'blog', 'news', 'login', 'privacy', 'terms', 'menu', 'search', 'services', 'products',
  'company', 'office', 'marketing', 'staff', 'customer', 'client', 'dear', 'hi', 'hey',
]);

function validFirstName(s) {
  const first = String(s || '').trim();
  return NAME_RE.test(first) && !NAME_STOPLIST.has(first.toLowerCase());
}

/** Strip HTML to readable text, capped. */
function htmlToText(html, cap = 5000) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/** Fetch one page: { ok (host answered), text }. Never throws. */
async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AvianceBot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: true, text: '' };
    return { ok: true, text: htmlToText(await res.text()) };
  } catch {
    return { ok: false, text: '' };
  }
}

/** Homepage + about page in parallel; www. retry only if the bare host never answered. */
async function fetchSite(domain) {
  const [home, about] = await Promise.all([
    fetchPage(`https://${domain}`),
    fetchPage(`https://${domain}/about`),
  ]);
  let answered = home.ok || about.ok;
  let text = home.text;
  if (!home.ok) {
    const www = await fetchPage(`https://www.${domain}`);
    answered = answered || www.ok;
    text += ' ' + www.text;
  }
  return { answered, text: (text + ' ' + about.text).slice(0, 6000) };
}

/**
 * Ask Gemini to extract the owner's name from website text.
 * Returns { ok: false } on a Gemini/network failure, { ok: true, result }
 * otherwise (result null when no confident name was found).
 */
async function extractName(apiKey, company, siteText) {
  const prompt = `Below is text from the website of a company called "${company}".
Identify the OWNER, FOUNDER, CEO or PRESIDENT of this company — the main decision-maker.

Rules:
- Answer ONLY with strict JSON: {"first_name": "...", "full_name": "..."}
- The name must clearly belong to the owner/founder/CEO/president of THIS company.
- It must be a real human first name (not a company name, not a job title).
- If you are not confident, answer exactly: null

Website text:
${siteText}`;

  const text = await geminiGenerate(apiKey, prompt, { temperature: 0.1, maxOutputTokens: 1024 });
  if (text === null || text === undefined) return { ok: false, error: 'gemini_unavailable' };
  try {
    if (String(text).trim().toLowerCase() === 'null') return { ok: true, result: null };
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return { ok: true, result: null };
    const parsed = JSON.parse(match[0]);
    const first = String(parsed.first_name || '').trim();
    if (!validFirstName(first)) return { ok: true, result: null };
    let full = String(parsed.full_name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!full || !full.toLowerCase().startsWith(first.toLowerCase())) full = first;
    return { ok: true, result: { first_name: first, full_name: full } };
  } catch {
    return { ok: true, result: null };
  }
}

function domainOf(email) {
  return (normalizeEmail(email).split('@')[1] || '').toLowerCase();
}

/**
 * Main entry — throttled, capped, never throws.
 * Called from the auto-send heartbeat.
 */
export async function maybeEnrichNames() {
  const summary = { ran: false, checked: 0, enriched: 0, cached: 0, errors: 0, details: [] };
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return summary; // no key yet — silent no-op

    const now = Date.now();
    const last = Number(await kv.get(THROTTLE_KEY)) || 0;
    if (now - last < THROTTLE_MS) return summary;
    await kv.set(THROTTLE_KEY, now);
    summary.ran = true;
    const deadline = now + RUN_BUDGET_MS;

    const allLeads = await getAllLeads();
    const candidates = allLeads
      .filter((l) => {
        const st = String(l.status || '').toLowerCase();
        const fresh = UNSENT_STATUSES.has(st) && !l.sent_at && !l.account_used;
        const noName = !String(l.first_name || '').trim();
        const notTried = !l.name_enrich_tried && (Number(l.name_enrich_tries) || 0) < MAX_TRIES;
        const domain = domainOf(l.email);
        return fresh && noName && notTried && domain && !isFreeMailDomain(l.email);
      })
      .sort((a, b) => leadScore(b) - leadScore(a));

    // Cheap win first: a full name already on the lead gives the first name
    // without any crawl.
    const toCrawl = [];
    for (const lead of candidates) {
      if (toCrawl.length >= BATCH_SIZE) break;
      const fromName = String(lead.name || '').trim().split(/\s+/)[0] || '';
      if (validFirstName(fromName)) {
        summary.checked++;
        try {
          await patchLead(lead.email, { first_name: fromName, name_source: lead.name_source || 'from-name', name_enrich_tried: new Date().toISOString() });
          summary.enriched++;
          summary.details.push({ email: normalizeEmail(lead.email), first_name: fromName, via: 'name' });
        } catch {}
        continue;
      }
      toCrawl.push(lead);
    }
    if (!toCrawl.length) return summary;

    // One crawl per company domain; the cache serves repeat domains for free.
    const byDomain = new Map();
    for (const lead of toCrawl) {
      const d = domainOf(lead.email);
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(lead);
    }
    const domains = [...byDomain.keys()];
    let cache = {};
    try {
      const res = await kv.hmget(DOMAIN_CACHE_KEY, ...domains);
      if (res && typeof res === 'object') cache = res;
    } catch {}

    for (const domain of domains) {
      const leads = byDomain.get(domain);
      const company = leads[0].company_name || leads[0].company || domain;
      summary.checked += leads.length;
      const nowIso = new Date().toISOString();

      // Serve from the per-domain cache when it is fresh enough.
      const hit = cache[domain] && typeof cache[domain] === 'object' ? cache[domain] : null;
      const hitAge = hit && hit.checkedAt ? Date.now() - new Date(hit.checkedAt).getTime() : Infinity;
      let result = null;
      let outcome = null; // 'found' | 'none' | 'error'
      if (hit && hit.first_name && validFirstName(hit.first_name)) {
        result = { first_name: hit.first_name, full_name: hit.name || hit.first_name };
        outcome = 'found';
        summary.cached += leads.length;
      } else if (hit && !hit.first_name && hitAge < NEGATIVE_CACHE_MS) {
        outcome = 'none';
        summary.cached += leads.length;
      } else if (Date.now() > deadline) {
        // Out of time: leave these leads untouched for the next run.
        summary.checked -= leads.length;
        continue;
      } else {
        const site = await fetchSite(domain);
        if (!site.answered) {
          outcome = 'error';
        } else if (site.text.trim().length > 200) {
          const ai = await extractName(apiKey, company, site.text);
          if (!ai.ok) outcome = 'error';
          else { result = ai.result; outcome = result ? 'found' : 'none'; }
        } else {
          outcome = 'none';
        }
        if (outcome !== 'error') {
          try {
            await kv.hset(DOMAIN_CACHE_KEY, { [domain]: { first_name: result ? result.first_name : null, name: result ? result.full_name : null, checkedAt: nowIso } });
          } catch {}
        }
      }

      for (const lead of leads) {
        const email = normalizeEmail(lead.email);
        try {
          if (outcome === 'found' && result) {
            // Re-read before write: never clobber what the sender wrote meanwhile.
            await patchLead(email, (existing) => ({
              first_name: result.first_name.split(/\s+/)[0],
              name: result.full_name || existing.name || result.first_name,
              name_source: 'auto-enriched',
              name_enrich_tried: nowIso,
            }));
            summary.enriched++;
            summary.details.push({ email, first_name: result.first_name, via: hit && hit.first_name ? 'cache' : 'crawl' });
          } else if (outcome === 'none') {
            await patchLead(email, { name_enrich_tried: nowIso });
          } else {
            // Transient failure: record it and retry on a later run.
            summary.errors++;
            await patchLead(email, (existing) => ({
              name_enrich_error: 'site_or_gemini_unavailable',
              name_enrich_error_at: nowIso,
              name_enrich_tries: (Number(existing.name_enrich_tries) || 0) + 1,
            }));
          }
        } catch {}
      }
    }

    console.log(`[diag] name-enrich ran checked=${summary.checked} enriched=${summary.enriched} cached=${summary.cached} errors=${summary.errors}`);
    return summary;
  } catch (err) {
    console.log(`[diag] name-enrich error: ${err.message}`);
    return summary;
  }
}
