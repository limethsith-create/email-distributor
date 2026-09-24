// Lead Finder — pure helpers (SPEC §7.2). No network, no dependencies, so
// every function here is unit-tested on HTML fixtures (tests/stage-b.test.mjs).

export const USER_AGENT = 'AvianceBot/1.0 (+aviance.online/bot)';
export const CRAWL_PATHS = ['/', '/about', '/about-us', '/contact', '/team', '/our-team'];

export const APPROVED_TITLE_WORDS = [
  'owner', 'co-owner', 'founder', 'co-founder', 'president', 'ceo', 'chief executive officer', 'managing partner',
  'principal', 'managing director', 'general manager', 'partner', 'director', 'vice president', 'vp', 'coo', 'cfo',
  'cto', 'chief operating officer', 'chief financial officer', 'chief technology officer', 'office manager', 'operations manager',
];
const OWNER_TITLES = ['owner', 'co-owner', 'founder', 'co-founder', 'president', 'ceo', 'chief executive officer', 'principal', 'managing partner'];
const ROLE_LOCALS = new Set(['info', 'hello', 'contact', 'office', 'admin', 'sales', 'support', 'team', 'mail', 'enquiries', 'inquiries', 'help', 'service', 'reception', 'frontdesk', 'billing', 'accounts', 'careers', 'jobs', 'hr', 'marketing']);
const BAD_EMAIL_RE = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|sentry|wixpress|sentry-next)\.|^(u00|x22)/i;

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
  if (!type.includes('person') && type.length && (node.email || node.telephone || node.address || node.numberOfEmployees || type.some((t) => /organization|business|corporation|service/.test(t)))) {
    out.orgs.push({ name: node.name ? String(node.name) : '', email: node.email ? cleanEmail(node.email) : '', employees: node.numberOfEmployees?.value ?? node.numberOfEmployees ?? null });
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

const NAME = "([A-Z][a-z]+(?:[ -][A-Z]\\.?)?(?:\\s(?:Mc|Mac|O')?[A-Z][a-z'’-]+){1,2})";
// Case-insensitive title words inside a case-SENSITIVE pattern (names must be Capitalised).
const ci = (s) => s.replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
const TITLE_ALT = APPROVED_TITLE_WORDS.slice().sort((a, b) => b.length - a.length).map((t) => ci(t).replace(/-/g, '[- ]?')).join('|');
const CO = ci('co') + '-?';
const BY = `(?:${['founded', 'owned', 'started', 'run', 'led'].map(ci).join('|')})\\s+${ci('by')}`;

/** Owner / president / founder names near title words in visible text → [{name, title}] */
export function extractPeople(html) {
  const text = htmlToText(html);
  const out = [];
  const push = (name, title) => {
    let n = name.trim().replace(/\s+/g, ' ');
    // "Meet Jane Smith, Owner" — drop leading filler words, keep the name.
    while (/^(Our|The|Meet|About|Contact|Team|Home|Hi|Hello|Welcome|Read|Learn|Call|Email|Owner|Founder|President|Director|Partner)\s/.test(n)) n = n.replace(/^\S+\s/, '');
    if (n.split(' ').length < 2) return;
    if (!out.some((p) => p.name === n)) out.push({ name: n, title: title.trim().toLowerCase().replace(/\s+/g, ' ') });
  };
  const p0 = new RegExp(`${NAME}\\s*(?:,|–|—|-|\\||\\()\\s*((?:${CO})?(?:${TITLE_ALT})(?:\\s*(?:&|and|/)\\s*(?:${TITLE_ALT}))?)(?![a-z])`, 'g');
  const p1 = new RegExp(`(?<![A-Za-z])((?:${CO})?(?:${TITLE_ALT}))\\s*(?::|,|–|—|-)\\s*${NAME}`, 'g');
  const p2 = new RegExp(`(?<![A-Za-z])${BY}\\s+${NAME}`, 'g');
  for (const line of text.split('\n')) {
    let m;
    p0.lastIndex = 0;
    while ((m = p0.exec(line))) push(m[1], m[2]);
    p1.lastIndex = 0;
    while ((m = p1.exec(line))) push(m[2], m[1]);
    p2.lastIndex = 0;
    while ((m = p2.exec(line))) push(m[1], 'founder');
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

export function splitName(name) {
  const parts = String(name || '').replace(/\b[A-Z]\.\s*/g, '').trim().split(/\s+/).filter(Boolean);
  const clean = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  return { first: clean(parts[0] || ''), last: clean(parts[parts.length - 1] || ''), firstDisplay: parts[0] || '' };
}

/** first@, first.last@, flast@, firstl@, f.last@ — in that order (SPEC §7.2 step 4). */
export function guessPatterns(first, last, host) {
  if (!first || !host) return [];
  const f = first.toLowerCase();
  const l = (last || '').toLowerCase();
  const out = [`${f}@${host}`];
  if (l && l !== f) out.push(`${f}.${l}@${host}`, `${f[0]}${l}@${host}`, `${f}${l[0]}@${host}`, `${f[0]}.${l}@${host}`);
  return [...new Set(out)];
}

export function isRoleAddress(email) {
  return ROLE_LOCALS.has(String(email || '').split('@')[0].toLowerCase());
}

export function titleApproved(title, approvedTitles = []) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  const list = (approvedTitles.length ? approvedTitles : OWNER_TITLES).map((x) => String(x).toLowerCase());
  return list.some((a) => t.includes(a) || a.includes(t));
}

/**
 * Pick the best contact from one site's findings (SPEC §7.2 step 3):
 * named person with an approved title → named person → role address.
 * @returns {{kind: 'person'|'role'|'email', name?, title?, email?, source}} | null
 */
export function pickContact({ mailtos = [], emails = [], ld = { people: [], orgs: [] }, people = [] }, host, approvedTitles = []) {
  const onHost = (e) => hostOf(e) === host || hostOf(e).endsWith(`.${host}`);
  const found = new Map(); // email → source
  for (const m of mailtos) found.set(m.email, 'mailto');
  for (const p of ld.people) if (p.email && !found.has(p.email)) found.set(p.email, 'jsonld');
  for (const o of ld.orgs) if (o.email && !found.has(o.email)) found.set(o.email, 'jsonld');
  for (const e of emails) if (!found.has(e)) found.set(e, 'text');
  const persons = [...ld.people.map((p) => ({ ...p, from: 'jsonld' })), ...people.map((p) => ({ ...p, email: '', from: 'text' }))]
    .filter((p) => p.name && splitName(p.name).first);
  // A person's own address: listed on the person, or first-name-ish on the host.
  const emailFor = (p) => {
    if (p.email && validEmail(p.email)) return p.email;
    const { first, last } = splitName(p.name);
    for (const e of found.keys()) {
      const local = e.split('@')[0];
      if (onHost(e) && !isRoleAddress(e) && (local === first || local.startsWith(`${first}.`) || local === `${first[0]}${last}` || local === `${first}${last[0] || ''}`)) return e;
    }
    return '';
  };
  const ranked = persons
    .map((p) => ({ ...p, approved: titleApproved(p.title, approvedTitles), email: emailFor(p) }))
    .sort((a, b) => (b.approved - a.approved) || (Boolean(b.email) - Boolean(a.email)));
  if (ranked.length) {
    const p = ranked[0];
    return { kind: 'person', name: p.name, title: p.title || '', email: p.email || '', source: p.email ? (found.get(p.email) || p.from) : 'guess', titleApproved: p.approved };
  }
  const personal = [...found.keys()].filter((e) => onHost(e) && !isRoleAddress(e));
  if (personal.length) return { kind: 'email', email: personal[0], source: found.get(personal[0]) };
  const roles = [...found.keys()].filter((e) => isRoleAddress(e)).sort((a, b) => ['info', 'hello', 'contact'].indexOf(b.split('@')[0]) - ['info', 'hello', 'contact'].indexOf(a.split('@')[0]));
  const role = roles.find(onHost) || roles[0];
  if (role) return { kind: 'role', email: role, source: found.get(role) };
  const any = [...found.keys()][0];
  return any ? { kind: 'email', email: any, source: found.get(any) } : null;
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

/** SPEC §7.2 step 6. */
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
