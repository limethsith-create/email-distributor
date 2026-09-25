// Lead Finder — pure helpers (SPEC §7.2, Leads v2). No network, no npm
// dependencies, so every function here is unit-tested on HTML fixtures
// (tests/stage-b.test.mjs, tests/leads-copy-v2.test.mjs).
//
// v2: decision-maker discovery (JSON-LD Person, "Name, Title" patterns, team
// cards, "I'm Jane, the owner", LinkedIn profile links as name hints only —
// LinkedIn itself is never fetched), facts for the first line (services,
// years in business, a named service page), website quality and intent
// signals, email pattern inference, and role addresses never kept.

import {
  TITLE_WORDS, titleTier, titleFits, looksLikeName, cleanPersonName, splitName as splitNameRule, isRoleAddress as isRoleRule, isFreemail,
  inferPattern, candidateEmails, nameFromEmail, nameFromLinkedinSlug, FRANCHISE_TEXT_RE, FIRST_NAMES, normState,
} from '../../src/lib/leadquality/rules.mjs';

export const USER_AGENT = 'AvianceBot/1.0 (+aviance.online/bot)';
/** Fallback paths when the home page links to nothing useful (the home page is always read first). */
export const CRAWL_PATHS = ['/', '/about', '/about-us', '/contact', '/team', '/our-team'];
export const EXTRA_PATHS = ['/contact-us', '/leadership', '/staff', '/meet-the-team', '/our-staff', '/company', '/who-we-are'];

export const APPROVED_TITLE_WORDS = TITLE_WORDS;
const OWNER_TITLES = ['owner', 'co-owner', 'founder', 'co-founder', 'president', 'ceo', 'chief executive officer', 'principal', 'managing partner', 'proprietor'];
const BAD_EMAIL_RE = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|sentry|wixpress|sentry-next|yourdomain|company|mysite|website)\.|^(u00|x22)|^[0-9a-f]{16,}@/i;

export const splitName = splitNameRule;
export const isRoleAddress = isRoleRule;

// ── hosts, states, tz ────────────────────────────────────────────────────────

export function hostOf(urlOrEmail) {
  const s = String(urlOrEmail || '').trim().toLowerCase();
  if (s.includes('@') && !s.includes('/')) return s.split('@')[1];
  return s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
}

const STATE_CODES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
const TZ = {
  'America/Chicago': 'AL AR IA IL KS LA MN MO MS ND NE OK SD TN TX WI',
  'America/Denver': 'AZ CO ID MT NM UT WY',
  'America/Los_Angeles': 'CA NV OR WA',
};

/** Same mapping as src/lib/time.js tzForState (duplicated: this script runs without the app's module aliases). */
export function tzForState(state) {
  const code = String(state || '').trim().toUpperCase();
  for (const [tz, list] of Object.entries(TZ)) if (list.split(' ').includes(code)) return tz;
  return 'America/New_York';
}

/** "123 Main St, Dallas, TX 75201, USA" → { city: 'Dallas', state: 'TX', zip: '75201' } */
export function parseUsAddress(formatted) {
  const parts = String(formatted || '').split(',').map((s) => s.trim()).filter(Boolean);
  let city = '';
  let state = '';
  let zip = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/.exec(parts[i]);
    if (m && STATE_CODES.includes(m[1])) { state = m[1]; zip = m[2] || ''; city = parts[i - 1] || ''; break; }
  }
  return { city, state, zip };
}

// ── robots.txt ───────────────────────────────────────────────────────────────

/** Parse robots.txt → disallow/allow rules for our agent (falls back to `*`). */
export function parseRobots(text, agent = 'avianceBot') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (k === 'disallow' || k === 'allow')) {
      cur.rules.push({ allow: k === 'allow', path: v });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const a = agent.toLowerCase();
  const mine = groups.find((g) => g.agents.some((x) => x !== '*' && a.startsWith(x.replace(/\/.*$/, ''))));
  const star = groups.find((g) => g.agents.includes('*'));
  return (mine || star || { rules: [] }).rules;
}

/** Longest-match wins; empty Disallow allows everything. */
export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules || []) {
    if (!r.path) continue;
    const re = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

// ── extraction ───────────────────────────────────────────────────────────────

const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|span)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Finer lines than htmlToText (also split at cells, links, bold): one card field per line. */
export function htmlToLines(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article|span|header|footer|figcaption|dt|dd|strong|b|a|em|i)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const cleanEmail = (e) => safeDecode(String(e || '')).trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
const validEmail = (e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) && !BAD_EMAIL_RE.test(e);

/** mailto: links → [{email, label}] */
export function extractMailtos(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']\s*mailto:([^"'?\s>]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const email = cleanEmail(decodeEntities(m[1]));
    if (validEmail(email) && !out.some((x) => x.email === email)) out.push({ email, label: htmlToText(m[2]).slice(0, 80) });
  }
  return out;
}

/** Plain-text emails (also "name [at] domain [dot] com"). */
export function extractPlainEmails(html) {
  const text = htmlToText(html).replace(/\s*\[\s*at\s*\]\s*|\s+\(at\)\s+/gi, '@').replace(/\s*\[\s*dot\s*\]\s*|\s+\(dot\)\s+/gi, '.');
  const set = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = cleanEmail(m[0]);
    if (validEmail(e)) set.add(e);
  }
  return [...set];
}

function walkLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walkLd(n, out)); return; }
  const type = [].concat(node['@type'] || []).map((t) => String(t).toLowerCase());
  if (type.includes('person') && node.name) {
    out.people.push({ name: String(node.name).trim(), title: node.jobTitle ? String(node.jobTitle).trim() : '', email: node.email ? cleanEmail(node.email) : '' });
  }
  // Organization / LocalBusiness and its many subtypes (Dentist, Plumber, LegalService…): any non-Person node with contact facts.
  if (!type.includes('person') && type.length && (node.email || node.telephone || node.address || node.numberOfEmployees || node.foundingDate || node.aggregateRating || type.some((t) => /organization|business|corporation|service/.test(t)))) {
    const rating = node.aggregateRating || {};
    out.orgs.push({
      name: node.name ? String(node.name) : '',
      email: node.email ? cleanEmail(node.email) : '',
      employees: node.numberOfEmployees?.value ?? node.numberOfEmployees ?? null,
      foundingDate: node.foundingDate ? String(node.foundingDate) : '',
      rating: Number(rating.ratingValue) || null,
      reviews: Number(rating.reviewCount || rating.ratingCount) || null,
    });
  }
  for (const [k, v] of Object.entries(node)) {
    if (['founder', 'employee', 'employees', 'member', 'members', 'author', '@graph', 'contactPoint', 'owns', 'subOrganization'].includes(k) || typeof v === 'object') walkLd(v, out);
  }
}

/** schema.org JSON-LD Person / Organization blocks → { people, orgs } */
export function extractJsonLd(html) {
  const out = { people: [], orgs: [] };
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    try { walkLd(JSON.parse(m[1].trim()), out); } catch { /* malformed block */ }
  }
  out.people = out.people.filter((p, i, a) => a.findIndex((q) => q.name === p.name) === i);
  return out;
}

const NAME = "([A-Z][a-z]+(?:[ -][A-Z]\\.?)?(?:\\s(?:Mc|Mac|O'|De|Van |Di|La)?[A-Z][a-z'’-]+){1,2})";
// Case-insensitive title words inside a case-SENSITIVE pattern (names must be Capitalised).
const ci = (s) => s.replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
const TITLE_ALT = TITLE_WORDS.slice().sort((a, b) => b.length - a.length).map((t) => ci(t).replace(/[/]/g, '\\/').replace(/-/g, '[- ]?')).join('|');
const CO = ci('co') + '-?';
const BY = `(?:${['founded', 'owned', 'started', 'run', 'led', 'established'].map(ci).join('|')})\\s+${ci('by')}`;
const CRED = ',?\\s*(?:DDS|DMD|MD|DVM|CPA|Esq\\.?|PhD|PE|EA|CFP|Jr\\.?|Sr\\.?|II|III)';
const TITLE_GROUP = `((?:${CO})?(?:${TITLE_ALT})(?:\\s*(?:&|and|/)\\s*(?:${TITLE_ALT}))?)`;

function pushPerson(out, name, title) {
  let n = name.trim().replace(/\s+/g, ' ');
  // "Meet Jane Smith, Owner" — drop leading filler words, keep the name.
  while (/^(Our|The|Meet|About|Contact|Team|Home|Hi|Hello|Welcome|Read|Learn|Call|Email|Owner|Founder|President|Director|Partner|By|And|With)\s/.test(n)) n = n.replace(/^\S+\s/, '');
  if (n.split(' ').length < 2 || !looksLikeName(n)) return;
  if (!out.some((p) => p.name === n)) out.push({ name: n, title: title.trim().toLowerCase().replace(/\s+/g, ' ') });
}

/** Owner / president / founder names near title words in visible text → [{name, title}] */
export function extractPeople(html) {
  const text = htmlToText(html);
  const out = [];
  const p0 = new RegExp(`${NAME}(?:${CRED})?\\s*(?:,|–|—|-|\\||\\()\\s*${TITLE_GROUP}(?![a-z])`, 'g');
  const p1 = new RegExp(`(?<![A-Za-z])${TITLE_GROUP}\\s*(?::|,|–|—|-)\\s*(?:${ci('dr')}\\.?\\s+)?${NAME}`, 'g');
  const p2 = new RegExp(`(?<![A-Za-z])${BY}\\s+(?:${ci('dr')}\\.?\\s+)?${NAME}`, 'g');
  const p3 = new RegExp(`(?:I'm|I am|My name is)\\s+${NAME},?\\s+(?:and I(?:'m| am)\\s+)?(?:the |a |your )?(?:proud )?${TITLE_GROUP}(?![a-z])`, 'g');
  const p4 = new RegExp(`${NAME}\\s+(?:is|has been|serves as)\\s+(?:the |our )?(?:proud )?${TITLE_GROUP}\\s+(?:of|at|and)\\b`, 'g');
  for (const line of text.split('\n')) {
    let m;
    for (const [re, ni, ti] of [[p0, 1, 2], [p1, 2, 1], [p3, 1, 2], [p4, 1, 2]]) {
      re.lastIndex = 0;
      while ((m = re.exec(line))) pushPerson(out, m[ni], m[ti]);
    }
    p2.lastIndex = 0;
    while ((m = p2.exec(line))) pushPerson(out, m[1], 'founder');
  }
  return out;
}

/**
 * Team cards: a line that is only a person's name, followed by a line that is
 * only a title ("<h3>Jane Smith</h3><p>Owner</p>").
 */
export function extractTeamCards(html) {
  const lines = htmlToLines(html);
  const out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const nameLine = lines[i].replace(/^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+/, '');
    if (nameLine.length > 40 || !looksLikeName(nameLine)) continue;
    const t = lines[i + 1];
    if (t.split(/\s+/).length > 7 || /[.!?]$/.test(t)) continue;
    const tier = titleTier(t);
    if (tier <= 25) continue;
    const { clean } = cleanPersonName(nameLine);
    if (!out.some((p) => p.name === clean)) out.push({ name: clean, title: t.toLowerCase().replace(/\s+/g, ' ') });
  }
  return out;
}

/** "a team of 25", "25 employees", "over 40 staff" → 25 / 40, else null */
export function extractEmployeeHint(html) {
  const text = htmlToText(html);
  const m = /\b(?:team of|over|more than|nearly|about)?\s*(\d{1,4})\+?\s+(?:full[- ]time\s+)?(?:employees|staff|team members|professionals|technicians|people on our team)\b/i.exec(text)
    || /\bteam of\s+(\d{1,4})\b/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

/** Same-site links with their text: [{path, text}] (no fragments, no files). */
export function extractLinks(html, host) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let href = decodeEntities(m[1]).trim();
    if (/^(mailto|tel|javascript|sms):/i.test(href)) continue;
    if (/^https?:\/\//i.test(href)) {
      if (hostOf(href) !== host) continue;
      href = href.replace(/^https?:\/\/[^/]+/i, '') || '/';
    } else if (href.startsWith('//')) continue;
    else if (!href.startsWith('/')) href = `/${href.replace(/^\.\//, '')}`;
    href = href.split('?')[0].replace(/\/+$/, '') || '/';
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mov)$/i.test(href) || href.length > 120) continue;
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!out.some((l) => l.path === href)) out.push({ path: href, text });
  }
  return out;
}

const PEOPLE_PAGE_RE = /(^|\/)(about|about-us|our-story|who-we-are|team|our-team|meet|staff|our-staff|leadership|management|people|owners?|founders?|our-people|company|history)(\/|-|$)/i;
const PEOPLE_TEXT_RE = /\b(about|team|staff|leadership|meet|our story|who we are|our people|management|owner|founder)\b/i;
const CONTACT_PAGE_RE = /(^|\/)(contact|contact-us|get-in-touch|reach-us)(\/|-|$)/i;

/** The pages worth reading after the home page, best first (people pages, then contact), max `max`. */
export function pagesToCrawl(links = [], max = 6) {
  const scored = [];
  for (const l of links) {
    if (l.path === '/') continue;
    let s = 0;
    if (PEOPLE_PAGE_RE.test(l.path)) s += 3;
    if (PEOPLE_TEXT_RE.test(l.text)) s += 2;
    if (CONTACT_PAGE_RE.test(l.path) || /\bcontact\b/i.test(l.text)) s += 1;
    if (/blog|news|post|article|tag|category|privacy|terms|login|cart|shop/i.test(l.path)) s -= 5;
    if (s > 0) scored.push({ path: l.path, s, depth: l.path.split('/').length });
  }
  scored.sort((a, b) => b.s - a.s || a.depth - b.depth);
  const picked = scored.slice(0, max).map((x) => x.path);
  for (const p of [...CRAWL_PATHS.slice(1), ...EXTRA_PATHS]) {
    if (picked.length >= max) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked.slice(0, max);
}

const SERVICE_STOP = /^(services?|our services|home|about|contact|blog|faq|reviews?|gallery|careers|financing|specials|coupons|areas? served|service areas?|locations?|residential|commercial|more|view all|learn more|read more|get a quote|free estimate|schedule|book now|call now|menu|portfolio|projects|testimonials|resources|team|privacy policy|terms)$/i;

/** Call-to-action and filler words that mean a link label is a button, not a service name. */
export const SERVICE_CTA = /\b(now|today|call|free|here|more|click|book|get|schedule|learn|view|read|contact|quote|estimate|near me|24\/7|best|top|cheap|affordable|#1|us)\b/i;

/** Service names from /services/… links and nav text: ['drain cleaning', 'water heaters'] (lower-case, ≤ 4 words). */
export function extractServices(links = []) {
  const out = [];
  for (const l of links) {
    if (!/\/(services?|what-we-do|solutions|practice-areas?|specialties)\/[a-z0-9-]+/i.test(l.path)) continue;
    const label = (l.text || l.path.split('/').pop().replace(/-/g, ' ')).toLowerCase().replace(/[^a-z0-9 &'-]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = label.split(' ');
    if (!label || words.length > 4 || label.length < 4 || SERVICE_STOP.test(label) || SERVICE_CTA.test(label) || /\d{3,}/.test(label)) continue;
    if (!out.some((s) => s.label === label)) out.push({ label, path: l.path });
  }
  return out.slice(0, 12);
}

/**
 * Facts and signals from one page: copyright year, founding year, hiring,
 * expansion, viewport, street address, franchise disclaimer, LinkedIn
 * profile slugs (name hints only), meta description.
 */
export function extractFacts(html) {
  const raw = String(html || '');
  const text = htmlToText(raw);
  const facts = {};
  const years = [...text.matchAll(/(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1])).filter((y) => y > 1990 && y < 2100);
  if (years.length) facts.copyrightYear = Math.max(...years);
  const since = /\b(?:since|established in|est\.?|founded in|serving (?:[A-Z][a-z]+(?: [A-Z][a-z]+)? )?since|in business since)\s+(19[0-9]{2}|20[0-2][0-9])\b/i.exec(text);
  if (since) facts.since = Number(since[1]);
  const yrs = /\b(?:over|more than|nearly|for)?\s*(\d{1,3})\+?\s+years\s+(?:of\s+)?(?:experience|in business|serving|of service)/i.exec(text);
  if (yrs && Number(yrs[1]) >= 2 && Number(yrs[1]) <= 150) facts.yearsClaim = Number(yrs[1]);
  facts.viewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(raw);
  const desc = /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']{10,300})["']/i.exec(raw);
  if (desc) facts.metaDescription = decodeEntities(desc[1]).trim();
  facts.hiring = /\b(now hiring|we(?:'re| are) hiring|join our team|open positions|career opportunities|apply now|job openings)\b/i.test(text);
  facts.expansion = /\b(new location|now open in|grand opening|now serving|second location|newest location|expanded to)\b/i.test(text);
  facts.hasAddress = /\b\d{2,6}\s+[A-Z0-9][A-Za-z0-9.' ]{2,40}\s(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pkwy|Parkway|Hwy|Highway|Ct|Court|Pl|Place|Cir|Circle|Trl|Suite)\b/.test(text);
  facts.hasPhone = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(text);
  facts.franchise = FRANCHISE_TEXT_RE.test(text);
  facts.linkedinHints = [...new Set([...raw.matchAll(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[A-Za-z0-9-]+/gi)].map((m) => nameFromLinkedinSlug(m[0])).filter(Boolean))].slice(0, 10);
  return facts;
}

/** Merge per-page facts (first seen wins, flags OR-ed, newest copyright). */
export function mergeFacts(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v == null || v === '') continue;
    if (typeof v === 'boolean') out[k] = Boolean(out[k] || v);
    else if (k === 'copyrightYear') out[k] = Math.max(Number(out[k]) || 0, v);
    else if (k === 'linkedinHints') out[k] = [...new Set([...(out[k] || []), ...v])].slice(0, 10);
    else if (out[k] == null || out[k] === '') out[k] = v;
  }
  return out;
}

/** first@, first.last@, flast@, firstl@, f.last@ — in that order (SPEC §7.2 step 4; v1 order, kept for reference). */
export function guessPatterns(first, last, host) {
  if (!first || !host) return [];
  const f = first.toLowerCase();
  const l = (last || '').toLowerCase();
  const out = [`${f}@${host}`];
  if (l && l !== f) out.push(`${f}.${l}@${host}`, `${f[0]}${l}@${host}`, `${f}${l[0]}@${host}`, `${f[0]}.${l}@${host}`);
  return [...new Set(out)];
}

export function titleApproved(title, approvedTitles = []) {
  if (!String(title || '').trim()) return false;
  return titleFits(title, approvedTitles.length ? approvedTitles : OWNER_TITLES);
}

// ── contact choice ───────────────────────────────────────────────────────────

const onHostOf = (host) => (e) => hostOf(e) === host || hostOf(e).endsWith(`.${host}`);

/**
 * Every named person on the site, ranked best first: approved title (client
 * profile) → decision-maker tier → has an own address → name source.
 * Returns [{name, title, tier, approved, email, emailSource, nameSource}].
 */
export function rankPeople(found, host, approvedTitles = []) {
  const { mailtos = [], emails = [], ld = { people: [], orgs: [] }, people = [], cards = [], linkedinHints = [] } = found;
  const onHost = onHostOf(host);
  const addr = new Map(); // email → source
  for (const m of mailtos) addr.set(m.email, 'mailto');
  for (const p of ld.people) if (p.email && !addr.has(p.email)) addr.set(p.email, 'jsonld');
  for (const o of ld.orgs) if (o.email && !addr.has(o.email)) addr.set(o.email, 'jsonld');
  for (const e of emails) if (!addr.has(e)) addr.set(e, 'text');
  const src = [
    ...ld.people.map((p) => ({ ...p, from: 'jsonld' })),
    ...people.map((p) => ({ ...p, email: '', from: 'text' })),
    ...cards.map((p) => ({ ...p, email: '', from: 'team' })),
  ].filter((p) => p.name && looksLikeName(p.name));
  const byName = new Map();
  for (const p of src) {
    const key = cleanPersonName(p.name).clean.toLowerCase();
    const prev = byName.get(key);
    if (!prev || (!prev.title && p.title) || (!prev.email && p.email)) byName.set(key, { ...prev, ...p, name: cleanPersonName(p.name).clean, title: p.title || prev?.title || '', email: p.email || prev?.email || '' });
  }
  const hints = new Set(linkedinHints.map((h) => h.toLowerCase()));
  const emailFor = (p) => {
    if (p.email && validEmail(p.email) && !isRoleAddress(p.email)) return { email: p.email, source: addr.get(p.email) || 'jsonld' };
    const { first, last } = splitName(p.name);
    for (const [e, s] of addr) {
      const local = e.split('@')[0];
      const mine = !isRoleAddress(e) && (local === first || local === `${first}.${last}` || local === `${first}${last}` || local === `${first}_${last}`
        || local === `${first[0]}${last}` || local === `${first}${last[0] || ''}` || local === `${first[0]}.${last}`);
      if (mine && (onHost(e) || isFreemail(e))) return { email: e, source: s };
    }
    return { email: '', source: '' };
  };
  return [...byName.values()]
    .map((p) => {
      const own = emailFor(p);
      return {
        name: p.name, title: p.title || '', tier: titleTier(p.title), approved: titleApproved(p.title, approvedTitles),
        email: own.email, emailSource: own.source, nameSource: p.from, linkedinHint: hints.has(p.name.toLowerCase()),
      };
    })
    .sort((a, b) => (Number(b.approved) - Number(a.approved)) || (b.tier - a.tier) || (Boolean(b.email) - Boolean(a.email))
      || (Number(b.linkedinHint) - Number(a.linkedinHint)) || ((a.nameSource === 'jsonld' ? 0 : 1) - (b.nameSource === 'jsonld' ? 0 : 1)));
}

/**
 * Pick the contact(s) for one company (SPEC §7.2 step 3, v2): a named
 * person, best-titled first; a personal address on the host with no name
 * found (the first name is taken from the address when it is one); never a
 * role address. Returns up to `max` contacts or [].
 *  {kind: 'person'|'email', name, title, tier, email, emailSource, candidates[], pattern, patternFrom}
 */
export function pickContacts(found, host, approvedTitles = [], { max = 1 } = {}) {
  const ranked = rankPeople(found, host, approvedTitles);
  const onHost = onHostOf(host);
  const known = [];
  const all = new Set([...(found.mailtos || []).map((m) => m.email), ...(found.emails || []), ...(found.ld?.people || []).map((p) => p.email).filter(Boolean)]);
  for (const p of ranked) if (p.email) known.push({ email: p.email, name: p.name });
  for (const e of all) if (onHost(e) && !isRoleAddress(e) && !known.some((k) => k.email === e)) known.push({ email: e, name: nameFromEmail(e) || '' });
  const inferred = inferPattern(known, host);
  const out = [];
  for (const p of ranked) {
    if (out.length >= max) break;
    // A title the client did not ask for would fail the List Sanity Check and sink the whole batch: skip that person.
    if (p.title && approvedTitles.length && !p.approved) continue;
    if (p.email) { out.push({ kind: 'person', ...p, candidates: [p.email], pattern: null, patternFrom: null }); continue; }
    // Guessing an address costs a verifier credit and risks a bounce: only for a
    // real person's name (known first name) — never "Sweco Norway"-style org names.
    if (!looksLikeName(p.name, { strict: true })) continue;
    const { first, last } = splitName(p.name);
    // Inferred pattern + one fallback; else the three patterns that cover
    // ~90 % of small US companies (each candidate costs a verifier credit).
    const candidates = candidateEmails(first, last, host, { pattern: inferred?.pattern || null, max: inferred ? 2 : 3 });
    if (!candidates.length) continue;
    out.push({ kind: 'person', ...p, email: candidates[0], emailSource: inferred ? 'pattern' : 'guess', candidates, pattern: inferred?.pattern || null, patternFrom: inferred?.from || null });
  }
  if (out.length) return out;
  // No named person: a personal address on the host (first name from the address when it is one).
  const personal = [...all].filter((e) => onHost(e) && !isRoleAddress(e));
  for (const e of personal) {
    if (out.length >= max) break;
    const local = e.split('@')[0];
    const fromEmail = nameFromEmail(e);
    const firstOnly = FIRST_NAMES.has(local) ? local[0].toUpperCase() + local.slice(1) : '';
    out.push({ kind: 'email', name: fromEmail || '', firstName: fromEmail ? fromEmail.split(' ')[0] : firstOnly, title: '', tier: 0, approved: false, email: e, emailSource: (found.mailtos || []).some((m) => m.email === e) ? 'mailto' : 'text', candidates: [e], pattern: null, patternFrom: null, nameSource: fromEmail ? 'email' : (firstOnly ? 'email-first' : '') });
  }
  return out;
}

/**
 * v1 compatibility: the single best contact, or null. Role addresses are
 * never returned (v2 rule).
 */
export function pickContact(found, host, approvedTitles = []) {
  const [c] = pickContacts(found, host, approvedTitles, { max: 1 });
  if (!c) return null;
  if (c.kind === 'person') return { kind: 'person', name: c.name, title: c.title || '', email: c.emailSource === 'guess' || c.emailSource === 'pattern' ? '' : c.email, source: c.emailSource === 'guess' || c.emailSource === 'pattern' ? 'guess' : c.emailSource, titleApproved: c.approved };
  return { kind: 'email', email: c.email, source: c.emailSource };
}

// ── scoring ──────────────────────────────────────────────────────────────────

const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/**
 * dreamMatch 0–3: dream customers this company resembles. A dream counts
 * only on the facts we actually have for it (industry keyword, state, size
 * band); a dream with none of those recorded never matches (no guessing).
 */
export function dreamMatch(lead, dreams = []) {
  let n = 0;
  const leadWords = new Set([...words(lead.company), ...[].concat(lead.types || []).flatMap((t) => [...words(String(t).replace(/_/g, ' '))])]);
  for (const d of (dreams || []).slice(0, 3)) {
    if (!d || typeof d !== 'object') continue;
    const checks = [];
    if (d.industry) checks.push([...words(d.industry)].some((w) => leadWords.has(w)));
    if (d.state) checks.push(String(d.state).toUpperCase() === String(lead.state || '').toUpperCase());
    if (d.sizeBand) checks.push(String(d.sizeBand) === String(lead.sizeBand || ''));
    if (checks.length && checks.every(Boolean)) n++;
  }
  return n;
}

/** SPEC §7.2 step 6 (the v1 score; the app's Lead Grader gives the 0–100 grade). */
export function scoreLead(lead) {
  return (Number(lead.dreamMatch) || 0) + (lead.hasNamedPerson ? 2 : 0) + (lead.titleApproved ? 2 : 0) - (lead.isRole ? 3 : 0) - (lead.riskLevel === 'catchall' ? 2 : 0);
}

// ── search grid ──────────────────────────────────────────────────────────────

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/)).map((s) => String(s).trim()).filter(Boolean);

/**
 * Places query grid: "{keyword} in {city}, {state}" per city, plus
 * "{keyword} near {zip}" for up to 5 zips per city when the profile lists
 * them (profile.zips = {city: [zip…]}); widen mode adds the extra states.
 */
export function buildQueries(profile = {}, { widen = false } = {}) {
  const keywords = list(profile.industry).slice(0, 3);
  const cities = list(profile.cities);
  const states = list(profile.states);
  const zips = profile.zips && typeof profile.zips === 'object' ? profile.zips : {};
  const out = [];
  for (const kw of keywords) {
    for (const c of cities) {
      const [city, st] = c.includes('|') ? c.split('|') : [c.replace(/,\s*[A-Z]{2}$/, ''), (/,\s*([A-Z]{2})$/.exec(c) || [])[1] || states[0] || ''];
      out.push(`${kw} in ${city.trim()}${st ? `, ${st.trim()}` : ''}`);
      for (const z of list(zips[c] || zips[city]).slice(0, 5)) out.push(`${kw} near ${z}`);
    }
    if (!cities.length) for (const st of states) out.push(`${kw} in ${st}, USA`);
    if (widen) for (const st of adjacentStates(states.length ? states : cities.map((c) => (/,\s*([A-Z]{2})$/.exec(c) || [])[1]).filter(Boolean))) out.push(`${kw} in ${st}, USA`);
  }
  return [...new Set(out)];
}

// Other words people and Google use for the same kind of business: a second
// phrasing returns a different top 60 (Text Search's cap per query).
const KEYWORD_VARIANTS = [
  [/dent/, ['dentist', 'dental clinic', 'family dentistry']],
  [/law|attorney|lawyer/, ['law firm', 'attorney', 'lawyer']],
  [/account|cpa|bookkeep|tax/, ['accounting firm', 'CPA firm', 'bookkeeping service']],
  [/insurance/, ['insurance agency', 'insurance broker']],
  [/real estate|realt/, ['real estate agency', 'real estate broker']],
  [/property manag/, ['property management company', 'HOA management company']],
  [/medical|clinic|doctor|physician/, ['medical clinic', 'family practice', 'doctor office']],
  [/chiropract/, ['chiropractor', 'chiropractic clinic']],
  [/veterinar|vet /, ['veterinarian', 'animal hospital']],
  [/restaurant/, ['restaurant', 'cafe']],
  [/manufactur/, ['manufacturer', 'machine shop', 'fabrication shop']],
  [/construct|contractor|builder/, ['general contractor', 'construction company', 'home builder']],
  [/plumb/, ['plumber', 'plumbing company']],
  [/roof/, ['roofing contractor', 'roofer']],
  [/hvac|heating|air condition/, ['HVAC contractor', 'heating and air conditioning']],
  [/electric/, ['electrician', 'electrical contractor']],
  [/marketing|advertis/, ['marketing agency', 'advertising agency']],
  [/\bit\b|managed it|msp|computer/, ['IT services', 'managed IT services', 'computer repair']],
  [/logistic|trucking|freight/, ['trucking company', 'logistics company']],
  [/salon|spa/, ['hair salon', 'day spa']],
  [/gym|fitness/, ['gym', 'fitness studio']],
  [/church/, ['church']],
  [/school|daycare|child care/, ['private school', 'daycare']],
];

/** Up to `max` other phrasings of an industry keyword (never the keyword itself). */
export function keywordVariants(kw, max = 2) {
  const k = String(kw || '').toLowerCase();
  const hit = KEYWORD_VARIANTS.find(([re]) => re.test(k));
  return hit ? hit[1].filter((v) => v.toLowerCase() !== k).slice(0, max) : [];
}

/**
 * The search plan: the buildQueries grid (city / zip / state queries) with
 * the city each belongs to, then the same cities with other phrasings of the
 * keyword. Returns [{ q, kw, city, state, variant }].
 */
export function queryPlan(profile = {}, { widen = false } = {}) {
  const keywords = list(profile.industry).slice(0, 3);
  const cities = list(profile.cities);
  const states = list(profile.states);
  const cityOf = (c) => (c.includes('|') ? c.split('|') : [c.replace(/,\s*[A-Z]{2}$/, ''), (/,\s*([A-Z]{2})$/.exec(c) || [])[1] || states[0] || '']).map((s) => String(s).trim());
  const byQuery = new Map();
  for (const kw of keywords) for (const c of cities) { const [city, st] = cityOf(c); byQuery.set(`${kw} in ${city}${st ? `, ${st}` : ''}`, { kw, city, state: st }); }
  const out = buildQueries(profile, { widen }).map((q) => ({ q, ...(byQuery.get(q) || { kw: '', city: '', state: '' }), variant: false }));
  const seen = new Set(out.map((x) => x.q.toLowerCase()));
  for (const kw of keywords) {
    for (const v of keywordVariants(kw)) {
      for (const c of cities) {
        const [city, st] = cityOf(c);
        const q = `${v} in ${city}${st ? `, ${st}` : ''}`;
        if (!seen.has(q.toLowerCase())) { seen.add(q.toLowerCase()); out.push({ q, kw: v, city, state: st, variant: true }); }
      }
    }
  }
  return out;
}

/** The states a lead may be in: the profile's states + the states of its cities (+ neighbours when widened). */
export function areaStates(profile = {}, { widen = false } = {}) {
  const out = new Set(list(profile.states).map(normState).filter(Boolean));
  for (const c of list(profile.cities)) {
    const st = c.includes('|') ? c.split('|')[1] : (/,\s*([A-Za-z]{2})\s*$/.exec(c) || [])[1];
    if (normState(st)) out.add(normState(st));
  }
  if (widen) for (const s of adjacentStates([...out])) out.add(s);
  return out;
}

// US state neighbours (for the one-time "widen to adjacent states" retry).
const NEIGHBORS = {
  AL: 'FL GA MS TN', AZ: 'CA CO NM NV UT', AR: 'LA MO MS OK TN TX', CA: 'AZ NV OR', CO: 'AZ KS NE NM OK UT WY',
  CT: 'MA NY RI', DE: 'MD NJ PA', DC: 'MD VA', FL: 'AL GA', GA: 'AL FL NC SC TN', ID: 'MT NV OR UT WA WY',
  IL: 'IA IN KY MO WI', IN: 'IL KY MI OH', IA: 'IL MN MO NE SD WI', KS: 'CO MO NE OK', KY: 'IL IN MO OH TN VA WV',
  LA: 'AR MS TX', ME: 'NH', MD: 'DC DE PA VA WV', MA: 'CT NH NY RI VT', MI: 'IN OH WI', MN: 'IA ND SD WI',
  MS: 'AL AR LA TN', MO: 'AR IA IL KS KY NE OK TN', MT: 'ID ND SD WY', NE: 'CO IA KS MO SD WY', NV: 'AZ CA ID OR UT',
  NH: 'MA ME VT', NJ: 'DE NY PA', NM: 'AZ CO OK TX UT', NY: 'CT MA NJ PA VT', NC: 'GA SC TN VA', ND: 'MN MT SD',
  OH: 'IN KY MI PA WV', OK: 'AR CO KS MO NM TX', OR: 'CA ID NV WA', PA: 'DE MD NJ NY OH WV', RI: 'CT MA',
  SC: 'GA NC', SD: 'IA MN MT ND NE WY', TN: 'AL AR GA KY MO MS NC VA', TX: 'AR LA NM OK', UT: 'AZ CO ID NM NV WY',
  VT: 'MA NH NY', VA: 'DC KY MD NC TN WV', WA: 'ID OR', WV: 'KY MD OH PA VA', WI: 'IA IL MI MN', WY: 'CO ID MT NE SD UT',
};

/** States next to the profile's states, not already in it. */
export function adjacentStates(states = []) {
  const have = new Set(list(states).map((s) => s.toUpperCase()));
  const out = new Set();
  for (const s of have) for (const n of String(NEIGHBORS[s] || '').split(' ').filter(Boolean)) if (!have.has(n)) out.add(n);
  return [...out];
}
