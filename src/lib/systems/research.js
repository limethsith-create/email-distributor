/**
 * Applicant Research (Intake v2) — "get me an idea more about the actual
 * product / actual customer" without the owner opening a browser.
 *
 * When an application arrives (website form held for review, the plain form,
 * or the owner's New client button) this builds `client:{id}:research`:
 *
 *  1. robots.txt  — honoured for every page (UA AvianceBot/1.0).
 *  2. website     — home, about, services, team, contact, locations (links
 *                   found on the home page first, else the plain paths);
 *                   10 s timeout and 1 MB cap per page, public http(s) only,
 *                   redirects re-checked hop by hop. Extracted by rules only:
 *                   title, meta description, H1, services, US locations
 *                   ("City, ST" + schema.org PostalAddress), phones, emails,
 *                   social links, team-size and years-in-business hints.
 *  3. domain age  — RDAP registration date of their main domain (free).
 *  4. business    — one Google Places Text Search (name + city), Enterprise
 *                   field mask, counted under usage:places `enterprise`.
 *  5. market      — a quick IDs-only count of "{their customers} in {their
 *                   city/state}" with the Market Counter's own query logic,
 *                   when their "what you sell and to whom" gives a customer
 *                   phrase (text after " for " / " to ").
 *  6. flags + a 2–3 sentence summary assembled from the facts above only.
 *
 * No AI anywhere: every value is a string found on a page or an API field;
 * anything not found stays null. Bounded per tick and resumable: progress
 * lives in the research hash and the `research` job continues it every
 * minute while `client.researchStep = 'running'`. Research never blocks an
 * application: website problems are flags, an internal error marks the
 * research `failed` (+ one non-urgent owner alert) and the owner still
 * reviews as before.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, getTrial, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { placesConfigured, textSearchIds, textSearchBusiness } from '@/lib/ext/places';
import { countInState } from '@/lib/ext/overpass';
import { rdapLookup } from '@/lib/ext/porkbun';
import { isThrottled } from '@/lib/systems/usage';
import { buildQueries, estimateFrom } from '@/lib/systems/market';
import { detectAgency } from '@/lib/systems/gatekeeper';
import { io, asArray, asObject, isPublicUrl } from '@/lib/systems/intake-io';
import { STATES, stateCode, stateOfCity, isUsPostalAddress } from '@/lib/systems/usgeo';
import { pageSignals, mergeSignals } from '@/lib/systems/fitsignals';
import { scoreFit, fitScoreLine } from '@/lib/systems/fitscore';

const SYSTEM = 'research';
const KINDS = ['home', 'about', 'services', 'team', 'contact', 'locations', 'industries', 'proof', 'pricing', 'careers'];
/** Read only when the home page links to them (no blind guesses at /proof or /pricing). */
const LINKED_ONLY = new Set(['industries', 'proof', 'pricing', 'careers']);
/** After this many runs the research finishes with whatever it has (a site that always times out cannot loop forever). */
const MAX_RUNS = 15;
const ROBOTS_BLOCKED = 'robots.txt does not allow reading the site';

// ── small text helpers ───────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Visible text of an HTML fragment (scripts, styles, svg and comments dropped). */
export function textOf(html) {
  return squash(decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|address)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')));
}

/** Text with line breaks kept (for "City, ST" and phone scans). */
function linesOf(html) {
  return decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|section|article|header|footer|address|span|a)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')).split('\n').map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim()).filter(Boolean);
}

const attr = (attrs, name) => {
  const m = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
};

function metaContent(html, key) {
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    const n = (attr(a, 'name') || attr(a, 'property') || '').toLowerCase();
    if (n === key) return squash(attr(a, 'content') || '');
  }
  return '';
}

function tagTexts(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html))) { const t = textOf(m[1]); if (t) out.push(t); }
  return out;
}

function anchors(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ href: attr(m[1], 'href') || '', text: textOf(m[2]), title: attr(m[1], 'title') || attr(m[1], 'aria-label') || '' });
  return out;
}

/** Trim bullets; a SHOUTED heading becomes Title Case (acronyms in normal text are kept). */
const tidy = (s) => {
  const v = squash(s).replace(/^[\s•·\-–—>|»:]+|[\s•·\-–—>|»:]+$/g, '');
  return v === v.toUpperCase() && /[A-Z]{4,}/.test(v) ? v.split(' ').map((w) => (w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w)).join(' ') : v;
};

// ── robots.txt ───────────────────────────────────────────────────────────────

/**
 * Rules that apply to AvianceBot: the group naming it, else the `*` group.
 * { allow: [prefix], disallow: [prefix] } (empty = everything allowed).
 */
export function parseRobots(text, agent = 'aviancebot') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'disallow' && value) cur.disallow.push(value);
    if (field === 'allow' && value) cur.allow.push(value);
  }
  const own = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a.replace(/\/.*$/, ''))));
  const any = groups.find((g) => g.agents.includes('*'));
  const g = own || any;
  return g ? { allow: g.allow, disallow: g.disallow } : { allow: [], disallow: [] };
}

function ruleMatch(rule, path) {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

/** Longest matching rule wins; allow wins a tie (RFC 9309). */
export function robotsAllows(rules, path) {
  if (!rules) return true;
  let best = { len: -1, allow: true };
  for (const r of rules.disallow || []) if (ruleMatch(r, path) && r.length > best.len) best = { len: r.length, allow: false };
  for (const r of rules.allow || []) if (ruleMatch(r, path) && r.length >= best.len) best = { len: r.length, allow: true };
  return best.allow;
}

// ── page extraction (rules only) ────────────────────────────────────────────

const GENERIC = new Set(['home', 'homepage', 'about', 'about us', 'contact', 'contact us', 'blog', 'news', 'careers', 'jobs', 'team', 'our team', 'meet the team', 'faq', 'faqs',
  'reviews', 'testimonials', 'gallery', 'portfolio', 'projects', 'our work', 'privacy', 'privacy policy', 'terms', 'terms of service', 'terms and conditions', 'login', 'log in', 'sign in',
  'sign up', 'register', 'menu', 'search', 'locations', 'location', 'service areas', 'service area', 'areas we serve', 'areas served', 'services', 'our services', 'all services', 'what we do',
  'get a quote', 'free quote', 'request a quote', 'get started', 'schedule', 'schedule now', 'book now', 'book online', 'call now', 'call us', 'learn more', 'read more', 'view all',
  'see all', 'more', 'shop', 'store', 'cart', 'resources', 'partners', 'why choose us', 'who we are', 'our story', 'our process', 'how it works', 'financing', 'coupons', 'specials',
  'sitemap', 'accessibility', 'english', 'español', 'espanol', 'skip to content', 'toggle navigation', 'close', 'next', 'previous', 'back to top', 'industries', 'solutions', 'company',
  'leadership', 'our people', 'staff', 'employees', 'support', 'help', 'events', 'media', 'press', 'newsletter', 'subscribe', 'follow us', 'connect with us', 'get in touch', 'hours',
  'directions', 'map', 'payments', 'pay online', 'pay your bill', 'client portal', 'customer portal', 'referrals', 'community', 'mission', 'values', 'history', 'awards', 'certifications']);
const PRONOUN = /\b(we|we're|our|ours|us|you|you're|your|yours|i|my|me|they|their|them)\b/i;

/** Could this short text be the name of a service? (rules; see docs/assumptions/stage-a.md) */
export function isServiceLike(t) {
  const s = squash(t);
  if (s.length < 3 || s.length > 60) return false;
  const words = s.split(' ');
  if (words.length > 6) return false;
  const lower = s.toLowerCase().replace(/[.:]+$/, '');
  if (GENERIC.has(lower)) return false;
  if (/[?!@]|https?:|www\.|©|\|/.test(s) || /\.\s*$/.test(s)) return false;
  if (PRONOUN.test(s)) return false;
  if ((s.match(/\d/g) || []).length > 2) return false;
  if (!/[a-z]/i.test(s)) return false;
  if (/^(call|click|contact|get|see|view|read|learn|schedule|book|request|find|meet|visit|follow|download|subscribe|sign|log|join|apply|start|explore|discover|check)\b/i.test(s)) return false;
  return true;
}

const SERVICE_CHILD = /\/(services?|our-services|what-we-do|solutions|practice-areas?|specialties|capabilities)\/[a-z0-9][a-z0-9-]*\/?(?:[?#].*)?$/i;
const slugText = (href) => { const m = String(href).match(/\/([a-z0-9-]+)\/?(?:[?#].*)?$/i); return m ? m[1].split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : '')).join(' ') : ''; };

const STATE_CODES = Object.keys(STATES);
// Two-letter codes that are also everyday capitalised words: only taken with a ZIP after them.
const AMBIGUOUS = new Set(['IN', 'ME', 'OR', 'OK', 'HI', 'OH', 'ID']);
const STREET_END = new Set(['st', 'street', 'rd', 'road', 'ave', 'avenue', 'blvd', 'boulevard', 'dr', 'drive', 'lane', 'ln', 'way', 'ct', 'court', 'pkwy', 'parkway', 'hwy', 'highway',
  'suite', 'ste', 'floor', 'fl', 'unit', 'box', 'building', 'plaza', 'center', 'centre', 'circle', 'cir', 'place', 'pl', 'square', 'sq', 'trail', 'terrace']);
const BAD_WORD = new Set(['inc', 'llc', 'ltd', 'copyright', 'hello', 'welcome', 'thanks', 'thank', 'yes', 'no', 'best', 'fast', 'call', 'email', 'phone', 'fax', 'rights', 'reserved',
  'hours', 'open', 'closed', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'the', 'and', 'or', 'our', 'offices', 'office', 'headquarters',
  'located', 'serving', 'contact', 'address', 'mailing', 'corporate', 'privacy', 'policy', 'terms', 'suite', 'ste', 'unit', 'floor', 'box']);
// A city word: Charlotte, St., McKinney, LaGrange (at least one lower-case letter).
const CW = '[A-Z][a-z]+(?:[A-Z][a-z]+)?\\.?';
const CITY_ST = new RegExp(`(?:^|[^A-Za-z])(${CW}(?:[ '-]${CW}){0,2}),[ \\t]*(${STATE_CODES.join('|')})(?![A-Za-z])([ \\t]+\\d{5})?`, 'g');
const STATE_NAME_RE = new RegExp(`(?:^|[^A-Za-z])(${CW}(?:[ '-]${CW}){0,2}),[ \\t]*(${Object.values(STATES).join('|')})(?![A-Za-z])`, 'g');

/** "City, ST" pairs in a text line list. */
export function findLocations(lines) {
  const out = [];
  const push = (city, code) => {
    const c = squash(city);
    const words = c.toLowerCase().split(/[ '-]/).map((w) => w.replace(/\.$/, ''));
    if (!c || words.some((w) => BAD_WORD.has(w)) || STREET_END.has(words[words.length - 1])) return;
    const v = `${c}, ${code}`;
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  for (const line of lines) {
    let m;
    CITY_ST.lastIndex = 0;
    while ((m = CITY_ST.exec(line))) { if (!AMBIGUOUS.has(m[2]) || m[3]) push(m[1], m[2]); }
    STATE_NAME_RE.lastIndex = 0;
    while ((m = STATE_NAME_RE.exec(line))) { const code = stateCode(m[2]); if (code) push(m[1], code); }
  }
  return out;
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1].trim())); } catch {} }
  return out;
}

function walk(node, fn, depth = 0) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn, depth + 1); return; }
  if (typeof node !== 'object') return;
  fn(node);
  for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, fn, depth + 1);
}

const typeOf = (n) => [].concat(n['@type'] || []).map((t) => String(t).toLowerCase());

/** schema.org facts: addresses, founding year, people, employees, phones, emails, sameAs. */
export function schemaFacts(html) {
  const f = { locations: [], founding: null, people: 0, employees: null, phones: [], emails: [], sameAs: [], name: null };
  for (const block of jsonLdBlocks(html)) {
    walk(block, (n) => {
      const types = typeOf(n);
      if (n.addressLocality && n.addressRegion) {
        const code = stateCode(n.addressRegion);
        const country = String(n.addressCountry?.name || n.addressCountry || 'US').toUpperCase();
        if (code && ['US', 'USA', 'UNITED STATES', ''].includes(country)) { const v = `${squash(n.addressLocality)}, ${code}`; if (!f.locations.includes(v)) f.locations.push(v); }
      }
      if (n.foundingDate && !f.founding) { const y = String(n.foundingDate).match(/(18|19|20)\d{2}/); if (y) f.founding = Number(y[0]); }
      if (types.includes('person')) f.people++;
      if (n.numberOfEmployees != null && f.employees == null) {
        const v = typeof n.numberOfEmployees === 'object' ? (n.numberOfEmployees.value ?? n.numberOfEmployees.maxValue ?? n.numberOfEmployees.minValue) : n.numberOfEmployees;
        if (Number.isFinite(Number(v)) && Number(v) > 0) f.employees = Number(v);
      }
      if (typeof n.telephone === 'string') f.phones.push(n.telephone);
      if (typeof n.email === 'string') f.emails.push(n.email.replace(/^mailto:/i, ''));
      for (const s of [].concat(n.sameAs || [])) if (typeof s === 'string') f.sameAs.push(s);
      if (!f.name && typeof n.name === 'string' && types.some((t) => /organization|business|corporation|localbusiness|service|store|contractor|plumber|electrician|dentist|attorney|legalservice|accounting/.test(t))) f.name = squash(n.name);
    });
  }
  // Microdata: itemprop="addressLocality">Charlotte< … itemprop="addressRegion">NC<
  const loc = [...String(html).matchAll(/itemprop\s*=\s*["']addressLocality["'][^>]*>([^<]{2,60})</gi)].map((m) => squash(decodeEntities(m[1])));
  const reg = [...String(html).matchAll(/itemprop\s*=\s*["']addressRegion["'][^>]*>([^<]{2,30})</gi)].map((m) => stateCode(squash(decodeEntities(m[1]))));
  loc.forEach((city, i) => { if (reg[i]) { const v = `${city}, ${reg[i]}`; if (!f.locations.includes(v)) f.locations.push(v); } });
  return f;
}

const PHONE_RE = /(?<![\d-])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?![\d-])/g;
export function normPhone(s) {
  PHONE_RE.lastIndex = 0;
  const m = PHONE_RE.exec(String(s || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JUNK_EMAIL_DOMAIN = /(^|\.)(example\.(com|org)|domain\.com|email\.com|yourdomain\.com|yoursite\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com|godaddy\.com|squarespace\.com|test\.com)$/i;
const cleanEmail = (e) => {
  const v = String(e || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(v) || JUNK_EMAIL_DOMAIN.test(v.split('@')[1])) return null;
  return v;
};

const SOCIAL = [
  ['linkedin', /^https?:\/\/([a-z]+\.)?linkedin\.com\/(company|in|school)\/[^/?#\s]+/i],
  ['facebook', /^https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr[/?]|login)[^?#\s]+/i],
  ['instagram', /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|share)[^/?#\s]+/i],
  ['x', /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share|home)[^/?#\s]+/i],
  ['youtube', /^https?:\/\/(www\.)?youtube\.com\/(channel|c|user|@)[^?#\s]*/i],
  ['tiktok', /^https?:\/\/(www\.)?tiktok\.com\/@[^/?#\s]+/i],
  ['yelp', /^https?:\/\/(www\.)?yelp\.com\/biz\/[^/?#\s]+/i],
];
export function socialOf(href) {
  const h = String(href || '').trim();
  for (const [key, re] of SOCIAL) { const m = h.match(re); if (m) return [key, m[0].replace(/\/+$/, '')]; }
  return null;
}

const TEAM_CLASS = /\bclass\s*=\s*["'][^"']*?\b(team[-_]?member|staff[-_]?member|team[-_]?card|member[-_]?card|person[-_]?card|staff[-_]?card|bio[-_]?card|team[-_]?item|staff[-_]?item|profile[-_]?card|employee[-_]?card)(?![\w-])/gi;
const NOT_NAME = new Set(['our', 'team', 'meet', 'the', 'leadership', 'staff', 'about', 'contact', 'services', 'service', 'get', 'in', 'touch', 'why', 'us', 'values', 'mission',
  'story', 'careers', 'join', 'company', 'board', 'directors', 'management', 'office', 'offices', 'people', 'culture', 'history', 'who', 'we', 'are', 'what', 'do', 'call', 'today',
  'free', 'estimate', 'quote', 'repair', 'repairs', 'cleaning', 'installation', 'maintenance', 'commercial', 'residential', 'emergency', 'plumbing', 'heating', 'cooling', 'roofing']);
const PERSON_NAME = /^(?:Dr\.\s)?[A-Z][a-z]+(?:\s[A-Z]\.)?(?:\s(?:[A-Z][a-z'’]+|Mc[A-Z][a-z]+|O'[A-Z][a-z]+)(?:-[A-Z][a-z]+)?){1,2}(?:,?\s(?:Jr\.|Sr\.|II|III|CPA|PE|MD|DDS|Esq\.))?$/;

/** { teamCount: n|null, teamText: 'Website says 25 employees'|null } */
export function teamFacts(html, text, kind, schema) {
  let teamText = null;
  const m = String(text).match(/\b(\d{1,4})\+?\s+(?:full[- ]time\s+)?(employees|staff members|team members|professionals|technicians|specialists|experts|people)\b/i)
    || String(text).match(/\bteam of (\d{1,4})\+?\b/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 10000) teamText = m[2] ? `Website says ${m[0].replace(/\s+/g, ' ').trim()}` : `Website says a team of ${m[1]}${/\+/.test(m[0]) ? '+' : ''}`;
  }
  if (!teamText && schema.employees) teamText = `Website lists ${schema.employees} employees (schema.org)`;
  let teamCount = null;
  if (kind === 'team') {
    const counts = {};
    let c;
    TEAM_CLASS.lastIndex = 0;
    while ((c = TEAM_CLASS.exec(html))) { const k = c[1].toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
    const byClass = Math.max(0, ...Object.values(counts));
    const names = new Set([...tagTexts(html, 'h2'), ...tagTexts(html, 'h3'), ...tagTexts(html, 'h4'), ...tagTexts(html, 'strong')]
      .filter((t) => PERSON_NAME.test(t) && !t.toLowerCase().split(/\s+/).some((w) => NOT_NAME.has(w.replace(/[.,]$/, '')))));
    const n = Math.max(byClass, names.size, schema.people || 0);
    if (n >= 2) teamCount = n;
  }
  return { teamCount, teamText };
}

/** "Since 2009" | "Founded in 2009" | "25+ years in business" | null. */
export function yearsFacts(text, schema, { year = new Date().getUTCFullYear() } = {}) {
  const ok = (y) => y >= 1850 && y <= year;
  const t = String(text || '');
  let m = t.match(/\b(founded|established|est\.)\s*(?:in\s+)?((?:18|19|20)\d{2})\b/i);
  if (m && ok(Number(m[2]))) return `Founded in ${m[2]}`;
  m = t.match(/\b(?:since|in business since|serving [^.]{0,40}?since)\s+((?:18|19|20)\d{2})\b/i);
  if (m && ok(Number(m[1]))) return `Since ${m[1]}`;
  if (schema?.founding && ok(schema.founding)) return `Founded in ${schema.founding}`;
  m = t.match(/\b(\d{1,3})\+?\s+years?\s+(?:of\s+)?(experience|in business|serving)/i);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 150) return `${m[0].replace(/\s+/g, ' ').trim()}`;
  return null;
}

const LINK_PATTERNS = {
  about: /^\/(about|about-us|who-we-are|our-story|our-company|company)\/?$/i,
  services: /^\/(services|our-services|what-we-do|solutions|service)\/?$/i,
  team: /^\/(team|our-team|staff|our-staff|our-people|people|leadership|meet-the-team|meet-our-team|about\/team|about-us\/team|about\/our-team)\/?$/i,
  contact: /^\/(contact|contact-us|contactus)\/?$/i,
  locations: /^\/(locations?|service-areas?|areas-we-serve|areas-served|where-we-serve|our-locations)\/?$/i,
  industries: /^\/(industries|industries-we-serve|who-we-serve|sectors|markets|clients-we-serve)\/?$/i,
  proof: /^\/(testimonials?|reviews|case-studies|case-study|success-stories|our-clients|clients|portfolio|our-work)\/?$/i,
  pricing: /^\/(pricing|plans|plans-and-pricing|packages|rates)\/?$/i,
  careers: /^\/(careers?|jobs|join-us|join-our-team|work-with-us)\/?$/i,
};

const sameSite = (a, b) => String(a).replace(/^www\./, '') === String(b).replace(/^www\./, '');

/** Everything one page gives. `url` is the page's final URL. */
export function extractPage(html, { url, kind = 'home' } = {}) {
  const base = new URL(url);
  const text = textOf(html);
  const lines = linesOf(html);
  const as = anchors(html);
  const schema = schemaFacts(html);
  const services = { child: [], headings: [], items: [] };
  const links = {};
  const socials = {};
  const phones = [];
  const emails = [];

  for (const a of as) {
    let abs = null;
    try { abs = new URL(a.href, base); } catch { continue; }
    if (/^mailto:/i.test(a.href)) { const e = cleanEmail(a.href); if (e) emails.push(e); continue; }
    if (/^tel:/i.test(a.href)) { const p = normPhone(a.href.replace(/^tel:/i, '')); if (p) phones.push(p); continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    const social = socialOf(abs.href);
    if (social && !socials[social[0]]) { socials[social[0]] = social[1]; continue; }
    if (!sameSite(abs.hostname, base.hostname)) continue;
    const path = abs.pathname.replace(/\/{2,}/g, '/');
    for (const [k, re] of Object.entries(LINK_PATTERNS)) if (!links[k] && re.test(path)) links[k] = `${abs.origin}${path}`;
    if (SERVICE_CHILD.test(path)) {
      const t = a.text && isServiceLike(a.text) ? a.text : slugText(path);
      if (isServiceLike(t)) services.child.push(tidy(t));
    }
  }
  for (const s of schema.sameAs) { const social = socialOf(s); if (social && !socials[social[0]]) socials[social[0]] = social[1]; }

  const h2h3 = [...tagTexts(html, 'h2'), ...tagTexts(html, 'h3')].map(tidy).filter(isServiceLike);
  if (kind === 'services') {
    services.headings.push(...h2h3);
    const main = (html.match(/<main\b[\s\S]*?<\/main>/i) || [html])[0].replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
    services.items.push(...tagTexts(main, 'li').map(tidy).filter(isServiceLike));
  } else if (kind === 'home') {
    services.headings.push(...tagTexts(html, 'h3').map(tidy).filter(isServiceLike));
  }

  for (const line of lines) {
    PHONE_RE.lastIndex = 0;
    let m;
    while ((m = PHONE_RE.exec(line))) phones.push(`(${m[1]}) ${m[2]}-${m[3]}`);
    for (const e of line.match(EMAIL_RE) || []) { const c = cleanEmail(e); if (c) emails.push(c); }
  }
  for (const p of schema.phones) { const n = normPhone(p); if (n) phones.push(n); }
  for (const e of schema.emails) { const c = cleanEmail(e); if (c) emails.push(c); }

  const { teamCount, teamText } = teamFacts(html, text, kind, schema);
  const signals = pageSignals(lines.join('\n'), { hrefs: as.map((a) => a.href), page: base.pathname || '/' });
  return {
    title: squash(decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')) || null,
    description: metaContent(html, 'description') || metaContent(html, 'og:description') || null,
    headline: tagTexts(html, 'h1')[0] || null,
    orgName: schema.name,
    services,
    locations: [...schema.locations, ...findLocations(lines)],
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    socials,
    links,
    teamCount,
    teamText,
    yearsHint: yearsFacts(text, schema),
    signals,
  };
}

const uniqCI = (arr) => { const seen = new Set(); const out = []; for (const v of arr) { const k = String(v).toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } } return out; };

/** Fold one page into the accumulated facts (first value wins for single fields). */
export function mergeFacts(acc, page, kind) {
  const a = acc || { title: null, description: null, headline: null, orgName: null, svcChild: [], svcHead: [], svcItems: [], svcHome: [], locations: [], phones: [], emails: [], socials: {}, teamCount: null, teamText: null, yearsHint: null };
  if (kind === 'home') { a.title = a.title || page.title; a.description = a.description || page.description; a.headline = a.headline || page.headline; }
  a.orgName = a.orgName || page.orgName;
  a.svcChild = uniqCI([...a.svcChild, ...page.services.child]);
  if (kind === 'services') { a.svcHead = uniqCI([...a.svcHead, ...page.services.headings]); a.svcItems = uniqCI([...a.svcItems, ...page.services.items]); }
  if (kind === 'home') a.svcHome = uniqCI([...a.svcHome, ...page.services.headings]);
  a.locations = uniqCI([...a.locations, ...page.locations]);
  a.phones = uniqCI([...a.phones, ...page.phones]);
  a.emails = uniqCI([...a.emails, ...page.emails]);
  for (const [k, v] of Object.entries(page.socials || {})) if (!a.socials[k]) a.socials[k] = v;
  if (page.teamCount && !a.teamCount) a.teamCount = page.teamCount;
  a.teamText = a.teamText || page.teamText;
  a.yearsHint = a.yearsHint || page.yearsHint;
  a.signals = mergeSignals(a.signals || {}, page.signals || {});
  return a;
}

/** The HUB `website` object from accumulated facts. */
export function websiteOut(acc, { url, pagesRead, limits }) {
  const a = acc || {};
  const services = uniqCI([...(a.svcChild || []), ...(a.svcHead || []), ...(a.svcItems || []), ...((a.svcChild || []).length + (a.svcHead || []).length < 3 ? (a.svcHome || []) : [])]).slice(0, limits.maxServices);
  return {
    url,
    title: a.title || null,
    description: a.description || null,
    headline: a.headline || null,
    services,
    locations: (a.locations || []).slice(0, limits.maxLocations),
    phones: (a.phones || []).slice(0, limits.maxPhones),
    emails: (a.emails || []).slice(0, limits.maxEmails),
    socials: a.socials || {},
    teamHint: a.teamCount ? `${a.teamCount} people on the team page` : a.teamText || null,
    yearsHint: a.yearsHint || null,
    pagesRead: pagesRead || 0,
  };
}

// ── customer phrase, names, summary, flags ──────────────────────────────────

const VERB_STOP = new Set(['grow', 'get', 'help', 'make', 'find', 'win', 'book', 'increase', 'boost', 'save', 'reduce', 'improve', 'be', 'do', 'keep', 'run', 'stay', 'scale', 'generate',
  'drive', 'reach', 'sell', 'fill', 'land', 'close', 'hire', 'manage', 'build', 'you', 'your', 'our', 'their', 'them', 'us', 'me', 'anyone', 'everyone', 'whoever', 'whom', 'who', 'about']);
const CUT = /\s(?:in|across|throughout|around|near|within|who|that|which|with|from|so|by|at|on|to|for|and help|looking|wanting|needing|needs|seeking|located|based)\s|,|;|\s[-–—]\s|\.|\(/i;

/**
 * Their customers from "what you sell and to whom": the words after the first
 * " for " / " to " that read like a customer group. null when none does.
 * 'Commercial plumbing for property managers in the Carolinas' → 'property managers'.
 */
export function customerPhrase(text) {
  const s = ` ${squash(text)} `;
  const re = /\s(?:for|to)\s+/gi;
  let m;
  let tries = 0;
  while ((m = re.exec(s)) && tries++ < 4) {
    let rest = s.slice(m.index + m[0].length);
    const cut = rest.search(CUT);
    if (cut >= 0) rest = rest.slice(0, cut);
    let words = squash(rest).split(' ').filter(Boolean);
    while (words.length && /^(the|a|an|all|any|other|their|local)$/i.test(words[0])) words = words.slice(1);
    words = words.slice(0, 5).map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase())).map((w) => w.replace(/[^\w&'’/–-]+$/g, ''));
    if (!words.length || VERB_STOP.has(words[0].toLowerCase())) continue;
    const phrase = words.join(' ').trim();
    if (phrase.replace(/[^a-z]/gi, '').length >= 3) return phrase;
  }
  return null;
}

const NAME_STOP = new Set(['inc', 'llc', 'ltd', 'co', 'company', 'corp', 'corporation', 'the', 'and', 'of', 'group', 'services', 'service', 'solutions', 'usa', 'us', 'pllc', 'pc', 'llp', 'lp', 'www', 'com', 'net', 'org']);
export const nameTokens = (s) => String(s || '').toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !NAME_STOP.has(t));

/** Do two business names (or a name and a domain label) share a real word? */
export function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const ja = ta.join('');
  const jb = tb.join('');
  return ta.some((t) => jb.includes(t)) || tb.some((t) => ja.includes(t));
}

const hostOfUrl = (u) => { try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

/** The Places result that is this business: same website, else a shared name word, else the first (flagged). */
export function pickBusiness(results, { mainDomain, name }) {
  const list = (results || []).filter((r) => r && r.name);
  if (!list.length) return { business: null, matched: false };
  const byWeb = list.find((r) => r.website && hostOfUrl(r.website) === String(mainDomain || '').replace(/^www\./, ''));
  if (byWeb) return { business: byWeb, matched: true, how: 'website' };
  const label = String(mainDomain || '').split('.')[0];
  const byName = list.find((r) => namesMatch(r.name, name) || namesMatch(r.name, label));
  if (byName) return { business: byName, matched: true, how: 'name' };
  return { business: list[0], matched: false, how: 'first' };
}

/** 'Unit 4, 123 Main St, Charlotte, NC 28202, USA' → 'Charlotte, NC'. */
export function cityStateOf(address) {
  const m = String(address || '').match(/([A-Za-z][A-Za-z .'-]+),\s*([A-Z]{2})\s+\d{5}/);
  if (m && STATES[m[2]]) return `${m[1].trim()}, ${m[2]}`;
  return null;
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const listText = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
const clip = (s, n) => { const v = squash(s); return v.length > n ? `${v.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : v; };

/**
 * Two or three plain sentences, only from facts that are present. Never a
 * guessed category, count or place: a missing fact drops its clause.
 */
export function buildSummary({ name, host, website, business, businessMatched, market }) {
  const out = [];
  const b = businessMatched ? business : null;
  if (b) {
    const where = cityStateOf(b.address);
    const stats = b.rating != null ? ` (${b.rating}★${b.reviews != null ? `, ${b.reviews.toLocaleString('en-US')} Google review${b.reviews === 1 ? '' : 's'}` : ''})` : b.reviews != null ? ` (${b.reviews.toLocaleString('en-US')} Google reviews)` : '';
    if (b.category) out.push(`${b.name} is ${article(b.category)} ${b.category.toLowerCase()}${where ? ` in ${where}` : ''}${stats}.`);
    else out.push(`${b.name} is listed on Google${where ? ` in ${where}` : b.address ? ` at ${b.address}` : ''}${stats}.`);
  } else if (website?.description || website?.headline || website?.title) {
    out.push(`${name}'s website (${host}) says: “${clip(website.description || website.headline || website.title, 150)}”.`);
  } else if (!website?.pagesRead) {
    out.push(`The website of ${name} (${host}) could not be read automatically.`);
  }
  const bits = [];
  if (website?.services?.length) bits.push(`lists services such as ${listText(website.services.slice(0, 3))}`);
  if (website?.locations?.length) bits.push(`names ${listText(website.locations.slice(0, 3))}`);
  if (website?.yearsHint) bits.push(`says “${website.yearsHint}”`);
  if (website?.teamHint) bits.push(/^\d/.test(website.teamHint) ? `shows ${website.teamHint}` : website.teamHint.replace(/^Website /, '').replace(/^says/, 'says'));
  if (bits.length) out.push(`The website ${listText(bits)}.`);
  if (market && Number.isFinite(market.estimate)) {
    out.push(`A quick ${market.source === 'overpass' ? 'OpenStreetMap' : 'Google Maps'} count suggests about ${market.estimate.toLocaleString('en-US')} ${market.query}.`);
  }
  return out.slice(0, 3).join(' ');
}

// ── storage ─────────────────────────────────────────────────────────────────

const J = (v) => JSON.stringify(v ?? null);

async function loadState(clientId) {
  const raw = (await kv.hgetall(K.research(clientId)).catch(() => null)) || {};
  return {
    status: raw.status || null,
    step: raw.step || 'robots',
    startedAt: raw.startedAt || null,
    at: raw.at || null,
    origin: raw.origin || null,
    robots: asObject(raw.robots),
    queue: asArray(raw.queue),
    tried: asArray(raw.tried),
    homeTried: asArray(raw.homeTried),
    acc: asObject(raw.acc),
    pagesRead: Number(raw.pagesRead) || 0,
    homeError: raw.homeError || null,
    registeredAt: raw.registeredAt || null,
    business: asObject(raw.business),
    businessMatched: raw.businessMatched === '1' || raw.businessMatched === 1 || raw.businessMatched === true,
    placesNote: raw.placesNote || null,
    mkt: asObject(raw.mkt),
    market: asObject(raw.market),
    attempts: Number(raw.attempts) || 0,
  };
}

async function saveState(clientId, s, extra = {}) {
  await kv.hset(K.research(clientId), {
    status: s.status, step: s.step, startedAt: s.startedAt || '', at: s.at || '', origin: s.origin || '',
    robots: J(s.robots), queue: J(s.queue), tried: J(s.tried), homeTried: J(s.homeTried), acc: J(s.acc), pagesRead: s.pagesRead,
    homeError: s.homeError || '', registeredAt: s.registeredAt || '', business: J(s.business), businessMatched: s.businessMatched ? '1' : '0',
    placesNote: s.placesNote || '', mkt: J(s.mkt), market: J(s.market), attempts: s.attempts,
    ...extra,
  });
}

// ── fetching ────────────────────────────────────────────────────────────────

async function readCapped(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= maxBytes) { try { await reader.cancel(); } catch {} break; }
      }
    } catch {}
    const buf = new Uint8Array(Math.min(size, maxBytes));
    let off = 0;
    for (const c of chunks) { const part = c.subarray(0, Math.max(0, buf.length - off)); buf.set(part, off); off += part.length; if (off >= buf.length) break; }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  return String(await res.text()).slice(0, maxBytes);
}

/**
 * GET a public page, following up to 3 redirects by hand so every hop is
 * re-checked with isPublicUrl. Never throws: { ok, status, url, html, error }.
 */
export async function fetchPage(url, { timeoutMs, maxBytes, userAgent, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }) {
  let current = url;
  try {
    for (let hop = 0; hop < 4; hop++) {
      if (!isPublicUrl(current)) return { ok: false, status: null, url: current, error: 'not a public web address' };
      const res = await io.fetchExt(current, { service: 'crawl', usageField: 'pages', timeoutMs, retry: false, redirect: 'manual', publicOnly: true, headers: { 'user-agent': userAgent, accept } });
      const status = Number(res.status) || 0;
      if (status >= 300 && status < 400) {
        const loc = res.headers?.get?.('location');
        if (!loc) return { ok: false, status, url: current, error: `redirect without a location (${status})` };
        current = new URL(loc, current).href;
        continue;
      }
      if (status < 200 || status >= 300) return { ok: false, status, url: current, error: `HTTP ${status}` };
      const type = String(res.headers?.get?.('content-type') || '');
      if (type && !/html|xml|text\/plain/i.test(type)) return { ok: false, status, url: current, error: `not a web page (${type.split(';')[0]})` };
      const html = await readCapped(res, maxBytes);
      return { ok: true, status, url: res.url && isPublicUrl(res.url) ? res.url : current, html };
    }
    return { ok: false, status: null, url: current, error: 'too many redirects' };
  } catch (err) {
    return { ok: false, status: null, url: current, error: String(err?.name === 'TimeoutError' ? 'timed out' : err?.message || err).slice(0, 120) };
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

/** Mark research as wanted for a client (idempotent; a finished one is left alone unless `force`). */
export async function startResearch(clientId, { now = io.now(), force = false } = {}) {
  const cur = await kv.hget(K.research(clientId), 'status').catch(() => null);
  if (!force && (cur === 'done' || cur === 'pending')) return { started: false, status: cur };
  if (force) await kv.del(K.research(clientId));
  await kv.hset(K.research(clientId), { status: 'pending', step: 'robots', startedAt: now.toISOString(), at: now.toISOString() });
  await updateClient(clientId, { researchStep: 'running' });
  await logEvent(clientId, SYSTEM, 'started', {});
  return { started: true, status: 'pending' };
}

/** Owner's "Re-run research" (for /api/mc/clients/{id}/intake). */
export async function rerunResearch(clientId, { now = io.now(), deadline = Date.now() + 15000 } = {}) {
  await startResearch(clientId, { now, force: true });
  return runResearch(clientId, { now, deadline });
}

const pageUrlFor = (origin, kind) => (kind === 'home' ? `${origin}/` : `${origin}/${kind}`);

/**
 * Advance the research while time remains. Returns { status: 'pending' |
 * 'done' | 'failed' | 'skipped' }. `alertOnFail` false: the caller reports
 * a failure itself (the new_application alert carries it).
 */
export async function runResearch(clientId, { now = io.now(), deadline = Date.now() + 15000, alertOnFail = true } = {}) {
  const lockKey = K.onceClaim('research', clientId, 'lock');
  const locked = await kv.set(lockKey, now.toISOString(), { nx: true, ex: 40 });
  if (locked !== 'OK') return { status: 'skipped', reason: 'another run is working on it' };
  let s = null;
  try {
    const client = await getClient(clientId);
    if (!client) return { status: 'skipped', reason: 'no client' };
    s = await loadState(clientId);
    if (s.status === 'done' || s.status === 'failed') { await updateClient(clientId, { researchStep: '' }); return { status: s.status }; }
    s.status = 'pending';
    s.attempts += 1;
    const R = await cfg(clientId, 'RESEARCH');
    const domain = client.mainDomain;
    const left = () => deadline - Date.now();
    const timeoutFor = () => Math.min(R.pageTimeoutMs, left() - 400);
    const opts = () => ({ timeoutMs: timeoutFor(), maxBytes: R.maxBytes, userAgent: R.userAgent });

    if (s.attempts > MAX_RUNS && s.step !== 'finish') { await logEvent(clientId, SYSTEM, 'gave_up_waiting', { step: s.step, attempts: s.attempts }); s.step = 'finish'; }

    // 1. find the site and its robots.txt, then read the home page
    if (s.step === 'robots') {
      if (!domain) { s.homeError = 'no website on the application'; s.step = 'rdap'; }
      for (const u of domain ? [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`] : []) {
        if (s.step !== 'robots') break;
        if (s.homeTried.includes(u)) continue;
        if (timeoutFor() < 2500) { await saveState(clientId, s); return { status: 'pending' }; }
        s.homeTried.push(u);
        const rb = await fetchPage(`${u}robots.txt`, { ...opts(), timeoutMs: Math.min(5000, timeoutFor()), accept: 'text/plain,*/*;q=0.5' });
        if (!rb.ok && !rb.status) { s.homeError = rb.error || 'no answer'; await saveState(clientId, s); continue; }
        s.origin = new URL(rb.url).origin;
        s.robots = rb.ok ? parseRobots(rb.html) : { allow: [], disallow: [] };
        s.homeError = null;
        s.step = 'home';
      }
      if (s.step === 'robots') s.step = 'rdap'; // every address tried and none answered: homeError says why
      await saveState(clientId, s);
    }
    if (s.step === 'home') {
      if (!robotsAllows(s.robots, '/')) { s.homeError = ROBOTS_BLOCKED; s.step = 'rdap'; }
      else {
        if (timeoutFor() < 2500) { await saveState(clientId, s); return { status: 'pending' }; }
        const home = await fetchPage(`${s.origin}/`, opts());
        s.tried = ['home'];
        if (!home.ok) { s.homeError = home.error || 'no answer'; s.step = 'rdap'; }
        else {
          const page = extractPage(home.html, { url: home.url, kind: 'home' });
          s.acc = mergeFacts(s.acc, page, 'home');
          s.pagesRead = 1;
          s.queue = (R.pages || KINDS).filter((k) => k !== 'home' && KINDS.includes(k) && (!LINKED_ONLY.has(k) || page.links[k])).map((k) => ({ kind: k, url: page.links[k] || pageUrlFor(s.origin, k) }));
          s.step = 'pages';
        }
      }
      await saveState(clientId, s);
    }

    // 2. the other pages
    while (s.step === 'pages') {
      const next = s.queue[0];
      if (!next) { s.step = 'rdap'; await saveState(clientId, s); break; }
      if (timeoutFor() < 2500) { await saveState(clientId, s); return { status: 'pending' }; }
      s.queue = s.queue.slice(1);
      s.tried = [...new Set([...s.tried, next.kind])];
      let path = '/';
      try { path = new URL(next.url).pathname; } catch {}
      if (robotsAllows(s.robots, path)) {
        const res = await fetchPage(next.url, opts());
        if (res.ok) { s.acc = mergeFacts(s.acc, extractPage(res.html, { url: res.url, kind: next.kind }), next.kind); s.pagesRead += 1; }
      }
      await saveState(clientId, s);
    }

    // 3. domain age (RDAP, free)
    if (s.step === 'rdap') {
      if (domain) {
        if (left() < 2500) { await saveState(clientId, s); return { status: 'pending' }; }
        const d = await cfg(clientId, 'DOMAINS');
        const r = await rdapLookup(domain, { base: d.rdapBase, timeoutMs: Math.min(6000, left() - 500) });
        s.registeredAt = r.registeredAt || null;
      }
      s.step = 'places';
      await saveState(clientId, s);
    }

    // 4. Google Places: the business itself (one Enterprise-SKU call)
    if (s.step === 'places') {
      const application = (await kv.hgetall(K.application(clientId)).catch(() => null)) || {};
      const city = application.web_city || (s.acc?.locations || [])[0] || '';
      if (!placesConfigured()) { s.business = null; s.placesNote = 'no_key'; }
      else if (await isThrottled('places')) { s.business = null; s.placesNote = 'throttled'; }
      else if (left() < 3000) { await saveState(clientId, s); return { status: 'pending' }; }
      else {
        try {
          const name = client.name || s.acc?.orgName || domain;
          const results = await textSearchBusiness(squash(`${name} ${city}`), { pageSize: R.placesPageSize, timeoutMs: Math.min(8000, left() - 500) });
          const pick = pickBusiness(results, { mainDomain: domain, name });
          s.business = pick.business ? { name: pick.business.name, address: pick.business.address, category: pick.business.category, rating: pick.business.rating, reviews: pick.business.reviews, mapsUrl: pick.business.mapsUrl, phone: pick.business.phone } : null;
          s.businessMatched = Boolean(pick.matched);
          s.placesNote = pick.business ? null : 'no_result';
        } catch (err) {
          s.business = null;
          s.placesNote = `failed: ${String(err?.message || err).slice(0, 120)}`;
        }
      }
      s.step = 'market';
      await saveState(clientId, s);
    }

    // 5. quick market preview (IDs-only, free)
    if (s.step === 'market') {
      const r = await marketStep(clientId, client, s, { deadline });
      if (r === 'pending') { await saveState(clientId, s); return { status: 'pending' }; }
      s.step = 'finish';
      await saveState(clientId, s);
    }

    // 6. flags, summary, prefill
    if (s.step === 'finish') return finish(clientId, client, s, { now, R });
    return { status: 'pending' };
  } catch (err) {
    const error = String(err?.message || err).slice(0, 300);
    try {
      await kv.hset(K.research(clientId), { status: 'failed', error, at: now.toISOString() });
      await updateClient(clientId, { researchStep: '' });
    } catch {}
    await logEvent(clientId, SYSTEM, 'failed', { error });
    if (alertOnFail) {
      await io.alertOwner('research_failed', {
        clientId, vars: { clientId },
        body: `The automatic research on ${clientId} stopped with an error: ${error}`,
        did: 'Nothing about the application changed — review it as usual. The research panel shows what was found before the error.',
      }).catch(() => {});
    }
    return { status: 'failed', error };
  } finally {
    await kv.del(lockKey).catch(() => {});
  }
}

async function marketStep(clientId, client, s, { deadline }) {
  const profile = await getProfile(clientId);
  const application = (await kv.hgetall(K.application(clientId)).catch(() => null)) || {};
  const phrase = customerPhrase(profile.sellsTo || application.web_sellsTo || '');
  if (!phrase) { s.market = null; return 'done'; }
  const city = application.web_city && stateOfCity(application.web_city) ? application.web_city : cityStateOf(s.business?.address) || (s.acc?.locations || [])[0] || null;
  const code = (application.web_state && stateCode(application.web_state)) || stateOfCity(city) || null;
  const locs = [city, code ? STATES[code] : null].filter(Boolean);
  if (!locs.length) { s.market = null; return 'done'; }
  const R = await cfg(clientId, 'RESEARCH');
  const M = await cfg(clientId, 'MARKET');

  if (placesConfigured() && !(s.mkt && s.mkt.source === 'overpass')) {
    // The Market Counter's own query builder and estimate (IDs-only, free).
    const m = s.mkt || { source: 'places', queries: buildQueries([phrase], [...new Set(locs)].map((l) => `in ${l}`), { min: 1, max: R.marketQueries }), idx: 0, pageToken: null, ids: [], perQuery: {} };
    s.mkt = m;
    while (m.idx < m.queries.length) {
      if (deadline - Date.now() < 3000) return 'pending';
      const q = m.queries[m.idx];
      try {
        const { ids, nextPageToken } = await textSearchIds(q, { pageToken: m.pageToken, pageSize: M.pageSize, timeoutMs: Math.min(8000, deadline - Date.now() - 500) });
        m.ids = [...new Set([...m.ids, ...ids])];
        m.perQuery[q] = (m.perQuery[q] || 0) + ids.length;
        if (nextPageToken && ids.length && m.perQuery[q] < M.maxPerQuery) m.pageToken = nextPageToken;
        else { m.idx += 1; m.pageToken = null; }
      } catch (err) {
        await logEvent(clientId, SYSTEM, 'market_places_failed', { error: String(err?.message || err).slice(0, 160) });
        s.mkt = { source: 'overpass' };
        return marketStep(clientId, client, s, { deadline });
      }
      await saveState(clientId, s);
    }
    s.market = { query: m.queries[0], estimate: estimateFrom({ source: 'places', unique: m.ids.length }, M), source: 'places' };
    s.mkt = null;
    return 'done';
  }
  if (!code) { s.market = null; s.mkt = null; return 'done'; }
  // OpenStreetMap fallback (same count the Market Counter uses), with the time
  // this run has left; a timeout is retried once on a later run.
  const left = deadline - Date.now();
  if (left < 4000) return 'pending';
  const tries = (s.mkt?.tries || 0) + 1;
  s.mkt = { source: 'overpass', tries };
  try {
    const n = await overpassCount(code, [phrase], Math.min(15000, left - 500));
    s.market = { query: `${phrase} in ${STATES[code]}`, estimate: estimateFrom({ source: 'overpass', count: n }, M), source: 'overpass' };
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'market_overpass_failed', { error: String(err?.message || err).slice(0, 160), tries });
    if (tries < 2) return 'pending';
    s.market = null;
  }
  s.mkt = null;
  return 'done';
}

/** ext/overpass countInState (main server, then mirrors) within the time this run has left. */
function overpassCount(stateCode, keywords, timeoutMs) {
  return countInState(stateCode, keywords, { timeoutMs });
}

/**
 * The company's own spelling of its name, when the site shows one that is the
 * domain's letters ("pivitstrategy.com" + "PivIT | PivIT Strategy: Managed IT"
 * → "PivIT Strategy"). null when nothing matches — never a guess.
 */
export function nameFromSite(domain, { title = '', orgName = '' } = {}) {
  const label = String(domain || '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (label.length < 3) return null;
  const letters = (t) => String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  const pieces = [orgName, ...String(title || '').split(/\s+[|–—:-]\s+|\s*[|:]\s*/)].map((t) => squash(decodeEntities(t))).filter((t) => t && t.length <= 60);
  for (const p of pieces) {
    const l = letters(p);
    if (l === label || l.replace(/(inc|llc|co|corp|ltd)$/, '') === label) return p.replace(/,?\s+(inc|llc|corp|ltd)\.?$/i, '');
  }
  return null;
}

/** Flags from the facts (warn = the owner should look; info = context). */
export function buildFlags({ name, mainDomain, website, business, businessMatched, placesNote, homeError, registeredAt, agencyHit, now = new Date(), newSiteDays = 365, robotsBlocked = false }) {
  const flags = [];
  if (agencyHit) flags.push({ level: 'warn', text: `Website or application mentions '${agencyHit}' — could be an agency` });
  if (homeError) flags.push({ level: 'warn', text: `Website did not load (${homeError})` });
  if (robotsBlocked) flags.push({ level: 'info', text: 'robots.txt asks bots not to read this site, so it was not read' });
  const usBusiness = businessMatched && business?.address && (cityStateOf(business.address) || isUsPostalAddress(business.address));
  if (!(website?.locations || []).length && !usBusiness) flags.push({ level: 'warn', text: `No US address found on the website${placesNote === 'no_key' || placesNote === 'throttled' ? '' : ' or on Google'}` });
  if (registeredAt) {
    const days = Math.floor((now.getTime() - Date.parse(registeredAt)) / 86400e3);
    if (days >= 0 && days < newSiteDays) flags.push({ level: 'warn', text: `Very new site: ${mainDomain} was registered ${days} day${days === 1 ? '' : 's'} ago (${registeredAt.slice(0, 10)})` });
  }
  if (business && !businessMatched) flags.push({ level: 'warn', text: `Google's closest match is “${business.name}”, not “${name}” — check it is the same business` });
  const siteName = website?.title || '';
  if (siteName && !namesMatch(siteName, name) && !namesMatch(siteName, String(mainDomain || '').split('.')[0])) flags.push({ level: 'info', text: `Website title “${clip(siteName, 80)}” does not mention ${name}` });
  if (placesNote === 'no_key') flags.push({ level: 'info', text: 'Google Places lookup skipped — PLACES_API_KEY is not set' });
  else if (placesNote === 'throttled') flags.push({ level: 'info', text: 'Google Places lookup skipped — the monthly Places budget is nearly used' });
  else if (placesNote === 'no_result') flags.push({ level: 'info', text: 'Google Places found no listing for this business' });
  else if (placesNote && placesNote.startsWith('failed')) flags.push({ level: 'info', text: `Google Places lookup ${placesNote}` });
  return flags;
}

async function finish(clientId, client, s, { now, R }) {
  const application = (await kv.hgetall(K.application(clientId)).catch(() => null)) || {};
  const keywords = await cfg(clientId, 'INTAKE.agencyKeywords');
  const website = websiteOut(s.acc, { url: s.origin ? `${s.origin}/` : client.mainDomain ? `https://${client.mainDomain}/` : null, pagesRead: s.pagesRead, limits: R });
  const agencyHit = detectAgency([website.title, website.description, website.headline, ...website.services, application.web_sellsTo, application.notes].filter(Boolean).join(' '), keywords);
  // A website application has no company field: the name was made from the
  // domain ("Pivitstrategy"). The site's own spelling wins ("PivIT Strategy").
  let name = client.name || client.mainDomain || clientId;
  const siteName = application.web_companyNameFromDomain === 'yes' ? nameFromSite(client.mainDomain, { title: website.title, orgName: s.acc?.orgName }) : null;
  if (siteName && siteName !== name) {
    await updateClient(clientId, { name: siteName });
    await logEvent(clientId, SYSTEM, 'name_from_site', { from: name, to: siteName });
    name = siteName;
  }
  const flags = buildFlags({
    name, mainDomain: client.mainDomain, website, business: s.business, businessMatched: s.businessMatched, placesNote: s.placesNote,
    homeError: s.homeError && s.homeError !== ROBOTS_BLOCKED ? s.homeError : null, robotsBlocked: s.homeError === ROBOTS_BLOCKED,
    registeredAt: s.registeredAt, agencyHit, now, newSiteDays: R.newSiteDays,
  });
  const summary = buildSummary({ name, host: client.mainDomain, website, business: s.business, businessMatched: s.businessMatched, market: s.market });
  const profile = await getProfile(clientId);
  const customers = customerPhrase(profile.sellsTo || application.web_sellsTo || '');
  const prefilled = R.prefill ? await prefill(clientId, { business: s.businessMatched ? s.business : null, website, customers }) : [];
  // Fit Score: their answers + what the site says, against the owner's fit gate.
  let score = null;
  try {
    score = scoreFit({
      now, application, customers, website, signals: s.acc?.signals || {}, teamCount: s.acc?.teamCount, teamText: s.acc?.teamText,
      business: s.businessMatched ? s.business : null, placesNote: s.placesNote, market: s.market, registeredAt: s.registeredAt, agencyHit,
      homeError: s.homeError, fit: await cfg(clientId, 'FIT'),
    }, await cfg(clientId, 'FITSCORE'));
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'score_failed', { error: String(err?.message || err).slice(0, 200) });
  }
  await kv.hset(K.research(clientId), {
    status: 'done', step: 'done', at: now.toISOString(), error: '', summary,
    website: J(website), business: J(s.business), market: J(s.market), flags: J(flags), prefilled: J(prefilled), score: J(score),
    acc: '', queue: '', mkt: '',
  });
  await updateClient(clientId, { researchStep: '' });
  await logEvent(clientId, SYSTEM, 'done', { pagesRead: s.pagesRead, business: Boolean(s.business), market: s.market?.estimate ?? null, flags: flags.length, prefilled, score: score?.score ?? null, grade: score?.grade ?? null });
  // The owner already had the application alert without the score (research ran past the request): send the score now.
  if (score && application.alertedAt && application.review === 'pending' && client.state === 'applied') {
    await io.alertOwner('application_scored', {
      clientId,
      scope: `${clientId}:score`,
      vars: { company: name, score: typeof score.score === 'number' ? `${score.score}/100 (${score.label})` : score.label },
      body: `${score.summary}${score.dealbreakers.length ? `\n\nDealbreakers:\n${score.dealbreakers.map((d) => `- ${d.text}`).join('\n')}` : ''}${score.questions.length ? `\n\nAsk them:\n${score.questions.slice(0, 4).map((q) => `- ${q}`).join('\n')}` : ''}`,
      did: 'The full scorecard is on the application in the hub. Nothing was sent to them.',
    }).catch(() => {});
  }
  return { status: 'done', summary, flags, score };
}

/**
 * Fill onboarding fields the client has not filled yet (never overwrites):
 * company name and postal address from a matched Google listing, cities from
 * the website, "your customers" from their own sell-to sentence. Only before
 * the agreement is signed.
 */
export async function prefill(clientId, { business, website, customers }) {
  try {
    const client = await getClient(clientId);
    if (!['applied', 'queued', 'onboarding'].includes(client?.state)) return [];
    const trial = await getTrial(clientId);
    if (trial.agreementAcceptedAt) return [];
    const profile = await getProfile(clientId);
    const empty = (k) => { const v = profile[k]; return v == null || v === '' || v === '[]' || (Array.isArray(v) && !v.length); };
    const set = {};
    if (business?.name && empty('companyName')) set.companyName = business.name;
    const addr = String(business?.address || '').replace(/,\s*(USA|United States)$/i, '');
    if (addr && isUsPostalAddress(addr) && empty('postalAddress')) set.postalAddress = addr;
    if ((website?.locations || []).length && empty('cities')) set.cities = JSON.stringify(website.locations.slice(0, 5));
    if (customers && empty('defaultIcp')) set.defaultIcp = customers;
    if (!Object.keys(set).length) return [];
    await kv.hset(K.profile(clientId), set);
    await logEvent(clientId, SYSTEM, 'prefilled', { fields: Object.keys(set) });
    return Object.keys(set);
  } catch {
    return [];
  }
}

// ── the hub's view ──────────────────────────────────────────────────────────

/** docs/HUB-API.md `application.research`, or null when research never started. */
export function researchFromHash(raw) {
  if (!raw || !Object.keys(raw).length || !raw.status) return null;
  return {
    status: raw.status === 'done' || raw.status === 'failed' ? raw.status : 'pending',
    at: raw.at || raw.startedAt || null,
    error: raw.error || null,
    summary: raw.summary || null,
    website: asObject(raw.website),
    business: asObject(raw.business),
    market: asObject(raw.market),
    flags: asArray(raw.flags).filter((f) => f && typeof f === 'object'),
    score: raw.score ? asObject(raw.score) : null,
  };
}

export async function researchView(clientId) {
  return researchFromHash(await kv.hgetall(K.research(clientId)).catch(() => null));
}

/** One line for the owner's new_application alert ('' while research is not done). */
export function researchLine(view) {
  if (!view) return '';
  if (view.status === 'failed') return `Research: could not finish (${view.error || 'error'}) — see the hub.`;
  if (view.status !== 'done') return '';
  const warns = (view.flags || []).filter((f) => f.level === 'warn').map((f) => f.text);
  return [fitScoreLine(view.score), `Research: ${view.summary || 'nothing found automatically.'}`, warns.length ? `Watch: ${warns.join('; ')}` : ''].filter(Boolean).join('\n');
}
