/**
 * Name-Enrichment Bot — Aviance
 *
 * Finds the owner/decision-maker's first name for leads that don't have one,
 * completely hands-off:
 *   1. Takes a small batch of pending leads with no first_name.
 *   2. Visits the lead's own website (homepage + about/team page).
 *   3. Asks Gemini (free tier) to extract the owner/founder/CEO's name
 *      from the page text — with a strict "return null if unsure" rule.
 *   4. Writes first_name back onto the lead, so the sending engine
 *      automatically switches to named subjects + "Hi <name>," openers.
 *
 * Runs piggybacked on the auto-send heartbeat (throttled, capped, fail-safe):
 * it can never delay or break a send. Without GEMINI_API_KEY it is a no-op.
 */

import { kv } from '@vercel/kv';
import { geminiGenerate } from '@/lib/gemini';

const LEADS_KEY = 'leads';
const THROTTLE_KEY = 'enrich_names_last_run';
const THROTTLE_MS = 3 * 60 * 60 * 1000; // every ~3h
const BATCH_SIZE = 5;                    // leads per run — keeps it light
const FETCH_TIMEOUT_MS = 6000;
const FREE_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'bellsouth.net', 'comcast.net']);

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

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AvianceBot/1.0)' },
    });
    if (!res.ok) return '';
    return htmlToText(await res.text());
  } catch {
    return '';
  }
}

/** Ask Gemini to extract the owner's name from website text. */
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

  try {
    const text = await geminiGenerate(apiKey, prompt, { temperature: 0.1, maxOutputTokens: 100 });
    if (!text || text === 'null') return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const first = String(parsed.first_name || '').trim();
    // Sanity: a single capitalised word, 2-15 letters, nothing weird.
    if (!/^[A-Z][a-z]{1,14}$/.test(first)) return null;
    return { first_name: first, full_name: String(parsed.full_name || '').trim().slice(0, 60) };
  } catch {
    return null;
  }
}

/**
 * Main entry — throttled, capped, never throws.
 * Called from the auto-send heartbeat.
 */
export async function maybeEnrichNames() {
  const summary = { ran: false, checked: 0, enriched: 0, details: [] };
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return summary; // no key yet — silent no-op

    const now = Date.now();
    const last = Number(await kv.get(THROTTLE_KEY)) || 0;
    if (now - last < THROTTLE_MS) return summary;
    await kv.set(THROTTLE_KEY, now);
    summary.ran = true;

    const allLeads = (await kv.hgetall(LEADS_KEY)) || {};
    const candidates = Object.values(allLeads)
      .filter((l) => {
        const st = (l.status || '').toLowerCase();
        const fresh = (st === 'pending' || st === 'new' || st === 'qualified') && !l.sent_at;
        const noName = !(l.first_name || '').trim();
        const notTried = !l.name_enrich_tried;
        const domain = ((l.email || '').split('@')[1] || '').toLowerCase();
        return fresh && noName && notTried && domain && !FREE_DOMAINS.has(domain);
      })
      .sort((a, b) => (Number(b.quality_score) || 0) - (Number(a.quality_score) || 0))
      .slice(0, BATCH_SIZE);

    for (const lead of candidates) {
      summary.checked++;
      const email = (lead.email || '').toLowerCase();
      const domain = email.split('@')[1];
      const company = lead.company_name || lead.company || domain;

      // Homepage + one about-ish page.
      let text = await fetchPage(`https://${domain}`);
      if (text.length < 400) text += ' ' + (await fetchPage(`https://www.${domain}`));
      const aboutText = await fetchPage(`https://${domain}/about`);
      const combined = (text + ' ' + aboutText).slice(0, 6000);

      let result = null;
      if (combined.trim().length > 200) {
        result = await extractName(apiKey, company, combined);
      }

      const updated = {
        ...lead,
        name_enrich_tried: new Date().toISOString(),
        ...(result
          ? {
              first_name: result.first_name,
              name: lead.name || result.full_name || result.first_name,
              name_source: 'auto-enriched',
            }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      try {
        await kv.hset(LEADS_KEY, { [email]: updated });
      } catch {}

      if (result) {
        summary.enriched++;
        summary.details.push({ email, first_name: result.first_name });
      }
    }

    console.log(`[diag] name-enrich ran checked=${summary.checked} enriched=${summary.enriched}`);
    return summary;
  } catch (err) {
    console.log(`[diag] name-enrich error: ${err.message}`);
    return summary;
  }
}
