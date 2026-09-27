/**
 * Deep research on an applicant's website (Research v3, 2026-09-25): the
 * owner asked for "everything about the business, at least ten times more".
 * The first research read 4–10 pages for a summary; this reads the whole site
 * (its sitemap, else every link it can reach, RESEARCH.deepMaxPages at most)
 * and every PDF it links, and keeps what each page says in plain facts:
 *
 *   people (name + title) · named clients · testimonials · case studies ·
 *   certifications, partners, awards, ownership (veteran-, woman-owned …) ·
 *   industries served · published prices · blog activity · open jobs ·
 *   street addresses · the tools the website runs on (CMS, analytics, CRM,
 *   chat, booking, visitor tracking) · documents (PDF titles and text facts)
 *
 * Plain rules only (no AI); every item keeps the page it came from. Pure
 * functions here; systems/research.js fetches and stores.
 */

import { extractPeople, extractTeamCards, extractJsonLd } from '../../../scripts/leadfinder/lib.mjs';
import { looksLikeName, cleanPersonName } from '@/lib/leadquality/rules.mjs';

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = squash(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const decode = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32)).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const textOf = (html) => squash(decode(String(html || '').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')));

/** Caps: what one applicant's deep record may hold (it lives in Redis). */
export const CAPS = { ctas: 25, promos: 25, magnets: 15, plans: 12, people: 60, clients: 60, testimonials: 15, caseStudies: 30, credentials: 40, industries: 30, prices: 15, jobs: 25, addresses: 15, tech: 50, documents: 12, posts: 400, pairs: 200 };

// ── which pages to read ─────────────────────────────────────────────────────

/** Every <loc> in a sitemap; `index` tells a sitemap index (its locs are more sitemaps). `lastmods`: each <url>'s date when it has one. */
export function parseSitemap(xml) {
  const s = String(xml || '');
  const locs = [...s.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1]).trim());
  const lastmods = [...s.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => {
    const loc = (m[1].match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/i) || [])[1];
    const mod = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1];
    return loc ? { url: decode(loc).trim(), lastmod: mod && Number.isFinite(Date.parse(mod)) ? mod : null } : null;
  }).filter(Boolean);
  return { index: /<sitemapindex\b/i.test(s), locs, lastmods };
}

/** "Sitemap:" lines of robots.txt. */
export function robotsSitemaps(text) {
  return [...String(text || '').matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
}

const SKIP_PATH = /\/(?:wp-login|xmlrpc)\.php|\/(wp-json|wp-admin|wp-login|xmlrpc|feed|rss|tag|tags|category|categories|author|page\/\d+|cart|checkout|my-account|login|signin|sign-in|register|search|cdn-cgi|wp-content\/uploads\/(?!.*\.pdf$))(\/|$)|\.(jpe?g|png|gif|webp|svg|ico|css|js|json|xml|zip|mp4|mp3|mov|avi|woff2?|ttf|eot)(\?|$)|[?&](replytocom|share|utm_)/i;
const PRIORITY = [
  [/\/(about|about-us|who-we-are|our-story|company|our-company|history)(\/|$)/i, 100],
  [/\/(team|our-team|leadership|people|staff|meet|management|our-people|who-we-are\/team)(\/|$)/i, 98],
  [/\/(services?|solutions?|what-we-do|capabilities|offerings?)(\/|$)/i, 95],
  [/\/(industries|who-we-serve|sectors|markets|verticals|clients-we-serve)(\/|$)/i, 94],
  [/\/(case-stud(y|ies)|success-stories|results|portfolio|our-work|work|projects)(\/|$)/i, 92],
  [/\/(testimonials?|reviews|clients|our-clients|customers)(\/|$)/i, 90],
  [/\/(partners?|certifications?|awards?|credentials|accreditations?|compliance|security)(\/|$)/i, 88],
  [/\/(pricing|plans|packages|rates)(\/|$)/i, 86],
  [/\/(careers?|jobs|join-us|join-our-team|work-with-us|employment)(\/|$)/i, 84],
  [/\/(contact|contact-us|locations?|offices?|service-areas?|areas-we-serve)(\/|$)/i, 82],
  [/\/(faq|faqs|how-it-works|process|approach|why-us|why-choose-us)(\/|$)/i, 70],
  [/\/(blog|news|insights|resources|articles|press|media)(\/|$)/i, 40],
];

/** A URL's reading priority (higher first); blog posts come after the company pages. */
export function pagePriority(url) {
  let path = '/';
  try { path = new URL(url).pathname.toLowerCase(); } catch {}
  for (const [re, p] of PRIORITY) if (re.test(path)) return path.split('/').filter(Boolean).length > 2 && p < 90 ? p - 20 : p;
  return 55 - Math.min(20, path.split('/').filter(Boolean).length * 5);
}

/** A blog / news article path ("/blog/why-backups-fail", "/2024/05/…"). */
export const POST_PATH = /\/(blog|news|insights|articles|resources|press|posts?|\d{4}\/\d{2})\/[^/]+/i;

/**
 * Same-site, readable, not already read, best first, at most `max`.
 * Speed rule (Research v4): when there are more pages than the budget, pages
 * whose sitemap `lastmod` (`lastmod`: normUrl → date) is older than
 * `staleYears` are skipped — blog posts first; the core company pages
 * (about, team, services, industries) are always kept.
 */
export function pickPages(urls, { origin, done = [], max = 60, lastmod = null, staleYears = 0, now = Date.now() } = {}) {
  const host = (() => { try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const seen = new Set(done.map(normUrl));
  const out = [];
  for (const raw of urls) {
    let u;
    try { u = new URL(raw, origin); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host) continue;
    u.hash = '';
    const key = normUrl(u.href);
    if (seen.has(key) || SKIP_PATH.test(u.pathname + u.search)) continue;
    seen.add(key);
    out.push(u.href);
  }
  // Blog posts: keep the company pages first and at most a third of the budget for posts.
  let ranked = out.map((url, i) => ({ url, p: pagePriority(url), i })).sort((a, b) => b.p - a.p || a.i - b.i);
  const postCap = Math.floor(max / 3);
  const fits = (list) => list.filter((r) => r.p >= 45).length + Math.min(postCap, list.filter((r) => r.p < 45).length) <= max;
  if (staleYears > 0 && lastmod && ranked.length > max) {
    const cutoff = Number(now) - staleYears * 365.25 * 86400e3;
    const stale = (r) => { const t = Date.parse(lastmod[normUrl(r.url)] || ''); return Number.isFinite(t) && t < cutoff; };
    ranked = ranked.filter((r) => !(r.p < 45 && stale(r)));
    if (!fits(ranked)) ranked = ranked.filter((r) => !(r.p >= 45 && r.p < 94 && stale(r)));
  }
  const posts = ranked.filter((r) => r.p < 45).slice(0, postCap);
  const rest = ranked.filter((r) => r.p >= 45);
  return [...rest, ...posts].slice(0, max).map((r) => r.url);
}

/**
 * How many pages to fetch at once (Research v4 speed rule): RESEARCH.deepConcurrency
 * (5), raised to deepConcurrencyFast (8) once the site has answered at least 3
 * pages with a median under deepFastMs (800 ms). The page budget stays the same.
 */
export function crawlConcurrency(times = [], { deepConcurrency = 5, deepConcurrencyFast = 8, deepFastMs = 800 } = {}) {
  const t = (times || []).map(Number).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (t.length < 3) return deepConcurrency;
  const mid = t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
  return mid < deepFastMs ? Math.max(deepConcurrency, deepConcurrencyFast) : deepConcurrency;
}

export function normUrl(u) {
  try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '') || '/'}${x.search}`.toLowerCase(); } catch { return String(u).toLowerCase(); }
}

/** Every same-site link and every document link on a page. */
export function pageLinks(html, pageUrl) {
  const links = [];
  const docs = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = (m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || []).slice(1).find(Boolean);
    if (!href || /^(mailto|tel|javascript|#)/i.test(href)) continue;
    let u;
    try { u = new URL(decode(href), pageUrl); } catch { continue; }
    if (/\.pdf(\?|$)/i.test(u.pathname)) docs.push({ url: u.href, text: clip(textOf(m[2]), 100) });
    else links.push(u.href);
  }
  return { links: [...new Set(links)], docs };
}

// ── what a page says ────────────────────────────────────────────────────────

const JOB_WORD = /\b(engineer|technician|manager|director|specialist|analyst|coordinator|administrator|consultant|officer|lead|architect|developer|support|sales|account|marketing|operations|partner|associate|attorney|accountant|assistant|advisor|adviser|president|founder|owner|ceo|cto|cfo|coo|cio|ciso|vp|principal|executive|representative|strategist|designer|controller|bookkeeper|paralegal|estimator|foreman|superintendent|dispatcher|receptionist|recruiter|trainer|scientist|project)\b/i;

/** People: schema.org, "Name, Title" text, and team cards (name line + short title line). */
export function peopleOn(html) {
  const out = [];
  const add = (name, title) => {
    const { clean } = cleanPersonName(String(name || ''));
    const n = squash(clean);
    const t = clip(String(title || '').replace(/^[\s,|:;–—-]+/, ''), 80);
    if (!n || n.split(' ').length < 2 || !looksLikeName(n)) return;
    const cur = out.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (cur) { if (!cur.title && t) cur.title = t; return; }
    out.push({ name: n, title: t });
  };
  const ld = extractJsonLd(html);
  for (const p of ld.people) add(p.name, p.title);
  // Team cards first (they keep the title as written: "Founder & CEO"), then the text patterns.
  const lines = decode(String(html || '').replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|span|a|strong|b|em|td|figcaption)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map(squash).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const nm = lines[i].replace(/^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+/, '');
    if (nm.length > 40 || !looksLikeName(nm, { strict: true })) continue;
    const t = lines[i + 1];
    if (t.length > 70 || t.split(/\s+/).length > 8 || /[.!?]$/.test(t) || !JOB_WORD.test(t)) continue;
    add(nm, t);
  }
  for (const p of extractPeople(html)) add(p.name, p.title);
  for (const p of extractTeamCards(html)) add(p.name, p.title);
  return out;
}

/** Named clients: logo alt texts in client/partner areas and "clients include A, B and C". */
export function clientsOn(html) {
  const out = new Set();
  const h = String(html || '');
  const areas = [...h.matchAll(/<(section|div|ul)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(client|customer|logo|trusted|partner|brand)[^"']*["'][^>]*>([\s\S]{0,20000}?)<\/\1>/gi)].map((m) => m[3]);
  for (const area of areas) {
    for (const m of area.matchAll(/<img\b[^>]*\balt\s*=\s*["']([^"']{2,60})["']/gi)) {
      const name = squash(decode(m[1])).replace(/\s*(logo|icon|image|img)\s*$/i, '').trim();
      if (name.length >= 2 && !/^(logo|client|partner|image|icon|photo|picture|home|menu|search|close|back|next|previous|arrow|play|placeholder|banner|slide|hero|background|img|untitled|default)s?\b/i.test(name) && !/\.(png|jpe?g|svg|webp)$/i.test(name) && !/^\d+$/.test(name)) out.add(name);
    }
  }
  const text = textOf(h);
  for (const m of text.matchAll(/\b(?:clients|customers) (?:include|such as|like)\s+([^.:;]{5,220})/gi)) {
    for (const part of m[1].split(/,\s*|\s+and\s+/)) { const p = squash(part).replace(/^(and|the)\s+/i, ''); if (/^[A-Z0-9]/.test(p) && p.length <= 50 && p.split(' ').length <= 6) out.add(p); }
  }
  return [...out];
}

/** Testimonials: quote blocks with who said it. */
export function testimonialsOn(html, page) {
  const out = [];
  const h = String(html || '');
  const blocks = [
    ...[...h.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi)].map((m) => m[1]),
    ...[...h.matchAll(/<(div|figure|li|article)\b[^>]*class\s*=\s*["'][^"']*(testimonial|review|quote)[^"']*["'][^>]*>([\s\S]{0,4000}?)<\/\1>/gi)].map((m) => m[3]),
  ];
  for (const b of blocks) {
    const t = textOf(b);
    if (t.length < 40) continue;
    const by = (t.match(/[—–-]\s*([A-Z][^—–\n]{2,80})$/) || [])[1] || '';
    const quote = clip(by ? t.slice(0, t.lastIndexOf(by)).replace(/[\s—–-]+$/, '') : t, 220);
    if (!out.some((x) => x.quote === quote)) out.push({ quote, by: clip(by, 80), page });
  }
  return out;
}

/** Certifications, partner programmes, awards, ownership status. [name, rule] */
const CREDENTIALS = [
  ['Microsoft Partner', /\bmicrosoft (?:solutions |gold |silver |certified |cloud )?partner\b|\bmicrosoft partner network\b/i],
  ['Microsoft Solutions Partner', /\bsolutions partner for (?:modern work|security|infrastructure|data & ai|business applications)/i],
  ['Microsoft 365 / Azure', /\b(?:microsoft 365|office 365|azure)\b/i],
  ['Google Cloud / Workspace partner', /\bgoogle (?:cloud|workspace) partner\b/i],
  ['AWS Partner', /\baws (?:partner|select|advanced|consulting) ?(?:tier|partner)?\b|\bamazon web services partner\b/i],
  ['Cisco Partner', /\bcisco (?:select|premier|gold|certified)? ?partner\b/i],
  ['Dell Technologies Partner', /\bdell (?:technologies )?partner\b/i],
  ['HP / HPE Partner', /\bhpe? (?:amplify |gold |silver )?partner\b/i],
  ['Fortinet', /\bfortinet\b/i], ['SonicWall', /\bsonicwall\b/i], ['Palo Alto Networks', /\bpalo alto networks\b/i], ['Sophos', /\bsophos\b/i],
  ['CrowdStrike', /\bcrowdstrike\b/i], ['SentinelOne', /\bsentinelone\b/i], ['Huntress', /\bhuntress\b/i], ['Datto', /\bdatto\b/i],
  ['Kaseya', /\bkaseya\b/i], ['ConnectWise', /\bconnectwise\b/i], ['N-able', /\bn-able\b/i], ['NinjaOne', /\bninja ?one\b/i], ['Veeam', /\bveeam\b/i],
  ['CompTIA', /\bcomptia\b/i], ['CISSP', /\bcissp\b/i], ['CCNA / CCNP', /\bccn[ap]\b/i],
  ['SOC 2', /\bsoc ?2\b/i], ['HIPAA', /\bhipaa\b/i], ['CMMC', /\bcmmc\b/i], ['NIST', /\bnist\b/i], ['ISO 27001', /\biso[ /-]?27001\b/i], ['ISO 9001', /\biso[ /-]?9001\b/i],
  ['PCI DSS', /\bpci(?:[ -]dss)?\b/i], ['FINRA / SEC', /\b(?:finra|sec compliance)\b/i], ['ITAR', /\bitar\b/i],
  ['MSP 501', /\bmsp ?501\b/i], ['Inc. 5000', /\binc\.? ?5000\b/i], ['Best Places to Work', /\bbest places? to work\b/i], ['Clutch award', /\bclutch (?:top|leader|award|champion)/i],
  ['BBB accredited', /\bbbb (?:accredited|a\+)|\bbetter business bureau\b/i], ['Chamber of Commerce member', /\bchamber of commerce\b/i],
  ['Veteran-owned', /\b(?:service-disabled )?veteran[- ]owned\b/i], ['Woman-owned', /\bwom[ae]n[- ]owned\b/i], ['Minority-owned', /\bminority[- ]owned\b/i],
  ['Family-owned', /\bfamily[- ]owned\b/i], ['Locally owned', /\blocally owned\b/i], ['HUBZone', /\bhubzone\b/i], ['SBA 8(a)', /\b8\(a\)/i], ['GSA schedule', /\bgsa (?:schedule|contract)\b/i],
  ['Licensed and insured', /\blicensed(?:,)? (?:bonded )?(?:and|&) insured\b/i],
];

/** Industries they serve (the words after "we serve / industries / for"). */
const INDUSTRY_WORDS = ['law firms', 'legal', 'accounting', 'cpa firms', 'healthcare', 'medical practices', 'dental', 'financial services', 'banks', 'credit unions', 'insurance', 'manufacturing', 'construction', 'architecture', 'engineering', 'real estate', 'property management', 'nonprofits', 'non-profits', 'education', 'schools', 'government', 'municipalities', 'retail', 'hospitality', 'restaurants', 'logistics', 'transportation', 'automotive', 'energy', 'oil and gas', 'utilities', 'technology', 'saas', 'startups', 'professional services', 'veterinary', 'pharmaceutical', 'biotech', 'churches', 'wealth management', 'agriculture', 'aerospace', 'defense', 'government contractors', 'distribution', 'wholesale', 'e-commerce', 'media', 'marketing agencies', 'staffing', 'senior living', 'home health', 'behavioral health', 'dealerships', 'hotels', 'property managers', 'hoas', 'franchises', 'small businesses', 'mid-sized businesses', 'enterprises'];

export function industriesOn(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  return INDUSTRY_WORDS.filter((w) => new RegExp(`[^a-z]${w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}[^a-z]`).test(t));
}

/** Published prices: "$99 per user per month", "starting at $1,500/month". */
export function pricesOn(text, page) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:starting (?:at|from)\s+|from\s+|only\s+)?\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:\/|per\s)\s*(?:user|seat|device|endpoint|month|mo|year|yr|hour|hr|project|employee|computer|server)(?:\s*(?:\/|per\s)\s*(?:month|mo|year|yr))?/gi)) {
    const s = squash(m[0]);
    if (!out.some((x) => x.text === s)) out.push({ text: s, page });
  }
  return out;
}

/** Street addresses: "123 Main St, Suite 4, Charlotte, NC 28202". */
export function addressesOn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pkwy|Parkway|Ct|Court|Pl|Place|Hwy|Highway|Cir|Circle|Trl|Trail|Sq|Square)\.?(?:,?\s+(?:Suite|Ste\.?|Unit|#|Floor|Fl\.?)\s*[\w-]+)?,?\s+[A-Z][A-Za-z .'-]{2,30},?\s+(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\.?\s+\d{5}(?:-\d{4})?\b/g)) out.add(squash(m[0]));
  return [...out];
}

/** Open jobs on a careers page: short headings / list items with a job word. */
export function jobsOn(html, page) {
  const out = [];
  for (const m of String(html || '').matchAll(/<(h[2-5]|li|a|strong)\b[^>]*>([\s\S]{3,200}?)<\/\1>/gi)) {
    const t = textOf(m[2]);
    if (t.length < 4 || t.length > 70 || t.split(/\s+/).length > 9 || /[.!?]$/.test(t)) continue;
    if (!JOB_WORD.test(t) || /\b(our|we|you|your|about|contact|home|services|blog|read|learn|apply now|view all)\b/i.test(t)) continue;
    if (!out.some((j) => j.title.toLowerCase() === t.toLowerCase())) out.push({ title: t, page, sales: /\b(sales|account executive|business development|bdr|sdr|account manager)\b/i.test(t) });
  }
  return out.slice(0, 15);
}

/** Blog post date from the page (article:published_time, JSON-LD datePublished, <time datetime>). */
export function postDateOf(html) {
  const h = String(html || '');
  const m = h.match(/property\s*=\s*["']article:published_time["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || h.match(/content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']article:published_time["']/i)
    || h.match(/"datePublished"\s*:\s*"([^"]+)"/i)
    || h.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) && t > Date.parse('1995-01-01') && t < Date.now() + 86400e3 ? new Date(t).toISOString().slice(0, 10) : null;
}

/** The tools a website runs on, from its HTML (script hosts, generator tags, markup). [name, kind, rule] */
const TECH = [
  ['WordPress', 'website', /wp-content\/|wp-includes\/|name=["']generator["'][^>]*wordpress/i], ['Wix', 'website', /static\.wixstatic\.com|wix\.com\/|x-wix/i],
  ['Squarespace', 'website', /squarespace\.com|static1\.squarespace/i], ['Webflow', 'website', /webflow\.(?:com|io)|data-wf-site/i], ['Duda', 'website', /dudamobile|multiscreensite|irp\.cdn-website\.com/i],
  ['GoDaddy Website Builder', 'website', /img1\.wsimg\.com|godaddy\.com\/websites/i], ['HubSpot CMS', 'website', /hs-sites\.com|hubspot\.net\/hub\/|hs-banner/i], ['Shopify', 'e-commerce', /cdn\.shopify\.com|myshopify\.com/i],
  ['WooCommerce', 'e-commerce', /woocommerce/i], ['Elementor', 'website', /elementor/i], ['Divi', 'website', /et_pb_|divi/i],
  ['Google Analytics', 'analytics', /google-analytics\.com|gtag\(|googletagmanager\.com\/gtag/i], ['Google Tag Manager', 'analytics', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/], ['Microsoft Clarity', 'analytics', /clarity\.ms/i],
  ['Hotjar', 'analytics', /hotjar\.com|hjid/i], ['Meta Pixel', 'ads', /connect\.facebook\.net\/[^"']*fbevents|fbq\(/i], ['LinkedIn Insight', 'ads', /snap\.licdn\.com|_linkedin_partner_id/i],
  ['Google Ads', 'ads', /googleadservices\.com|AW-\d{6,}/], ['HubSpot', 'crm / marketing', /js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics|hubspot\.com\/_hcms/i], ['Salesforce / Pardot', 'crm / marketing', /pi\.pardot\.com|pardot\.com|force\.com|salesforce/i],
  ['Marketo', 'crm / marketing', /munchkin|marketo\.(?:com|net)/i], ['ActiveCampaign', 'crm / marketing', /activecampaign|trackcmp\.net/i], ['Mailchimp', 'email marketing', /list-manage\.com|chimpstatic\.com|mailchimp/i],
  ['Constant Contact', 'email marketing', /constantcontact\.com|ctctcdn/i], ['Zoho', 'crm / marketing', /zoho\.(?:com|eu)|salesiq\.zoho/i], ['Pipedrive', 'crm / marketing', /pipedrive/i], ['Keap / Infusionsoft', 'crm / marketing', /infusionsoft|keap\.(?:com|app)/i],
  ['GoHighLevel', 'crm / marketing', /leadconnectorhq|msgsndr\.com|highlevel/i], ['Intercom', 'chat', /widget\.intercom\.io|intercomcdn/i], ['Drift', 'chat', /js\.driftt\.com|drift\.com/i], ['Tawk.to', 'chat', /embed\.tawk\.to/i],
  ['LiveChat', 'chat', /cdn\.livechatinc\.com/i], ['Zendesk', 'support', /zdassets\.com|zendesk/i], ['Freshdesk / Freshworks', 'support', /freshdesk|freshworks|freshchat/i], ['Olark', 'chat', /olark/i],
  ['Calendly', 'booking', /calendly\.com/i], ['Chili Piper', 'booking', /chilipiper/i], ['Acuity Scheduling', 'booking', /acuityscheduling/i], ['Microsoft Bookings', 'booking', /outlook\.office365\.com\/owa\/calendar|bookings/i],
  ['CallRail', 'call tracking', /callrail|cdn\.callrail/i], ['Leadfeeder / Dealfront', 'visitor tracking', /leadfeeder|lfeeder|dealfront/i], ['ZoomInfo WebSights', 'visitor tracking', /ws\.zoominfo\.com|zi-scripts/i],
  ['Apollo.io', 'visitor tracking', /assets\.apollo\.io|apollo\.io\/micro/i], ['Clearbit', 'visitor tracking', /clearbit/i], ['RB2B', 'visitor tracking', /rb2b/i], ['Albacross', 'visitor tracking', /albacross/i],
  ['Stripe', 'payments', /js\.stripe\.com/i], ['PayPal', 'payments', /paypal\.com\/sdk|paypalobjects/i], ['reCAPTCHA', 'forms', /recaptcha/i], ['Gravity Forms', 'forms', /gform_|gravityforms/i],
  ['Typeform', 'forms', /typeform\.com/i], ['Jotform', 'forms', /jotform/i], ['Cloudflare', 'hosting', /cdnjs\.cloudflare\.com|cloudflareinsights|__cf_bm|cf-ray/i], ['YouTube embeds', 'video', /youtube\.com\/embed|youtube-nocookie/i], ['Vimeo', 'video', /player\.vimeo\.com/i],
  ['Trustpilot widget', 'reviews', /widget\.trustpilot\.com/i], ['Google reviews widget', 'reviews', /elfsight|trustindex|embedsocial/i], ['Birdeye / Podium', 'reviews', /birdeye|podium\.com/i],
];

export function techOn(html) {
  const h = String(html || '');
  return TECH.filter(([, , re]) => re.test(h)).map(([name, kind]) => ({ name, kind }));
}

// ── the offers they run ─────────────────────────────────────────────────────

const CTA_RE = /^(?:get|book|schedule|request|claim|download|start|try|call|contact|talk|see|watch|join|sign up|register|reserve|grab|take|let's talk|speak|chat)\b.{0,50}$/i;
const CTA_OBJ = /\b(free|quote|assessment|audit|consultation|consult|demo|trial|estimate|call|guide|checklist|e-?book|whitepaper|report|webinar|pricing|proposal|meeting|strategy|review|evaluation|analysis|scan|test|started|expert|specialist|team|us)\b/i;
const PROMO_RE = /\b(\d{1,3}% off|save \$\d[\d,]*|free (?:month|trial|assessment|audit|consultation|estimate|quote|network assessment|security assessment|risk assessment|dark web scan|onboarding|installation|migration|setup|inspection)|no (?:long-term |annual )?contracts?|month-to-month|money[- ]back guarantee|satisfaction guarantee|\d+% satisfaction|price match(?:ing)?|limited[- ]time|special offer|first month free|\d+[- ]day (?:free )?trial|flat[- ]rate(?: pricing)?|fixed[- ](?:fee|price|monthly)|all[- ]inclusive|unlimited (?:support|help desk|calls)|24\/7(?:\/365)? (?:support|monitoring|help desk)|(?:guaranteed )?response times? (?:of |under |within |in )?(?:less than )?\d+ ?(?:min|minutes|hours?)|\d+[- ]minute (?:response|guarantee)|same[- ]day service|no hidden fees|transparent pricing|guaranteed (?:uptime|results|savings)|\d{2,3}(?:\.\d+)?% uptime)\b/gi;
const MAGNET_RE = /\b(guide|checklist|e-?book|whitepaper|white paper|report|toolkit|template|webinar|playbook|cheat ?sheet|buyer'?s guide|case study pdf)\b/i;
const PLAN_RE = /^(?:the )?(basic|standard|pro|professional|premium|enterprise|essentials?|advanced|complete|plus|gold|silver|bronze|platinum|starter|growth|core|elite|ultimate|total|comprehensive|foundation|managed|proactive|reactive|break[- ]fix|a la carte|custom)\b[\w &+-]{0,30}$/i;

/** Their offers: calls to action, promotions and guarantees, lead magnets, named packages. */
export function offersOn(html, page) {
  const h = String(html || '');
  const ctas = [];
  for (const m of h.matchAll(/<(a|button)\b[^>]*>([\s\S]{2,300}?)<\/\1>/gi)) {
    const t = textOf(m[2]);
    if (t.length >= 6 && t.length <= 60 && CTA_RE.test(t) && CTA_OBJ.test(t) && !ctas.some((c) => c.toLowerCase() === t.toLowerCase())) ctas.push(t);
  }
  const text = textOf(h);
  const promos = [];
  for (const m of text.matchAll(PROMO_RE)) {
    const quote = clip(text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 60), 150);
    if (!promos.some((p) => p.offer.toLowerCase() === m[0].toLowerCase())) promos.push({ offer: squash(m[0]), quote, page });
  }
  const magnets = [];
  for (const m of h.matchAll(/<a\b[^>]*>([\s\S]{3,200}?)<\/a>/gi)) {
    const t = textOf(m[1]);
    if (t.length >= 8 && t.length <= 90 && MAGNET_RE.test(t) && /\b(free|download|get|grab|read|your|the)\b/i.test(t) && !magnets.some((x) => x.title === t)) magnets.push({ title: t, page });
  }
  const plans = [];
  if (/\/(pricing|plans|packages|rates|services?)(\/|$)/i.test(page)) {
    for (const m of h.matchAll(/<(h[2-5]|strong|b)\b[^>]*>([\s\S]{2,80}?)<\/\1>/gi)) {
      const t = textOf(m[2]);
      if (!PLAN_RE.test(t) || plans.some((p) => p.name === t)) continue;
      const after = textOf(h.slice(m.index, m.index + 1500));
      const price = (after.match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*(?:\/|per)\s*[a-z]+(?:\s*(?:\/|per)\s*[a-z]+)?)?/i) || [])[0] || null;
      plans.push({ name: t, price: price ? squash(price) : null, page });
    }
  }
  return { ctas: ctas.slice(0, 12), promos: promos.slice(0, 12), magnets: magnets.slice(0, 8), plans: plans.slice(0, 8) };
}

// ── the page's own words (menus and footers out) ────────────────────────────

/**
 * The words of the page's content: the <article>, else <main>, else <body>;
 * menus, footers, side bars and forms dropped (a menu link "Law firms" on
 * every page is not every page talking about law firms). Block ends become
 * " . " so a word pair never runs across a heading and a paragraph.
 */
export function mainText(html) {
  let h = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  const article = h.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const main = h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (article || main) h = (article || main)[1].replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  else h = (h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [null, h])[1].replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  return squash(decode(h.replace(/<br\s*\/?>/gi, ' . ').replace(/<\/(p|div|li|h[1-6]|td|th|tr|section|article|blockquote|figcaption|time|a|span|button|dt|dd)>/gi, ' . ').replace(/<[^>]+>/g, ' ')));
}

// ── who buys from them ──────────────────────────────────────────────────────

/** Customer segments named in a text: [label, rule]. Business nouns only ("law firms", not "law"). */
export const SEGMENTS = [
  ['law firms', /\b(law (?:firms?|offices?|practices?|groups?)|attorneys|lawyers|legal (?:practices|professionals|teams|departments|industry|sector))\b/i],
  ['accounting firms', /\b(accounting (?:firms?|practices?|offices?)|cpa (?:firms?|practices?|offices?)|cpas|accountants|tax (?:firms?|practices?|preparers|professionals)|bookkeepers|bookkeeping firms?)\b/i],
  ['medical practices', /\b(medical (?:practices?|offices?|groups?|clinics?)|healthcare (?:practices?|providers?|organizations?|clinics?)|physicians|(?<!(?:veterinary|vet|dental|animal) )clinics|(?<!animal )hospitals|urgent care (?:centers?|clinics?)|home health (?:agencies|providers))\b/i],
  ['dental practices', /\b(dental (?:practices?|offices?|groups?|clinics?)|dentists|orthodontists)\b/i],
  ['financial firms', /\b(financial (?:services firms?|advisors|advisers|planners|firms?|institutions)|wealth (?:management firms?|managers)|investment (?:firms?|advisors|advisers)|banks|community banks?|credit unions?|ria firms?|broker-?dealers)\b/i],
  ['insurance agencies', /\b(insurance (?:agenc(?:y|ies)|brokers?|brokerages?|companies|carriers|agents))\b/i],
  ['manufacturers', /\b(manufacturers|manufacturing (?:companies|firms|businesses|plants|facilities|clients))\b/i],
  ['construction companies', /\b(construction (?:companies|firms|clients|businesses)|general contractors|home ?builders|subcontractors)\b/i],
  ['architecture and engineering firms', /\b(architects|architecture firms?|engineering firms?|a\/e firms?|aec firms?)\b/i],
  ['property managers', /\b(property manag(?:ers|ement (?:companies|firms))|real estate (?:firms?|brokerages?|agencies|investors|developers|companies)|realtors|landlords|hoas|apartment communities)\b/i],
  ['nonprofits', /\b(non-?profits?(?: organizations)?|charities)\b/i],
  ['schools', /\b(schools|school districts|universities|colleges|k-12)\b/i],
  ['government agencies', /\b(municipalities|local governments?|government agencies|public sector (?:agencies|organizations)|state agencies|federal agencies)\b/i],
  ['retailers', /\b(retailers|retail (?:stores|businesses|chains|clients)|e-?commerce (?:brands|businesses|stores))\b/i],
  ['restaurants and hotels', /\b(restaurants|hotels|hospitality (?:businesses|groups|companies|clients))\b/i],
  ['logistics companies', /\b(logistics (?:companies|firms|providers)|trucking companies|freight (?:companies|brokers)|warehouses|distributors)\b/i],
  ['car dealerships', /\b(auto(?:motive)? dealers(?:hips)?|car dealerships?|dealerships)\b/i],
  ['energy companies', /\b(energy companies|utility companies|oil and gas (?:companies|operators))\b/i],
  ['software companies', /\b(saas companies|software companies|tech(?:nology)? companies|startups)\b/i],
  ['professional services firms', /\b(professional services (?:firms|companies|businesses)|consulting firms|consultancies)\b/i],
  ['churches', /\b(churches|ministries|faith-based organizations)\b/i],
  ['senior living', /\b(senior living (?:communities|facilities)|assisted living (?:facilities|communities)|nursing homes)\b/i],
  ['veterinary practices', /\b(veterinary (?:practices?|clinics?|hospitals?)|veterinarians|animal hospitals)\b/i],
  ['staffing firms', /\b(staffing (?:firms?|agenc(?:y|ies)|companies))\b/i],
  ['marketing agencies', /\b(marketing agencies|ad agencies|advertising agencies|digital agencies)\b/i],
  ['small businesses', /\b(small (?:and (?:mid|medium)-?sized )?businesses|smbs)\b/i],
];

/** Words in a client's NAME that tell its trade ("Hollis & Grant Law", "Carolina Tax Partners"). */
const NAME_HINTS = [
  ['law firms', /\b(law|legal|attorneys?|lawyers?)\b/i],
  ['accounting firms', /\b(cpas?|tax|accounting|accountants?|bookkeeping)\b/i],
  ['dental practices', /\b(dental|dentistry|orthodontics)\b/i],
  ['medical practices', /\b(medical|clinic|pediatrics|physicians|hospital|healthcare|urgent care)\b/i],
  ['financial firms', /\b(bank|bancorp|credit union|wealth|financial|investments)\b/i],
  ['insurance agencies', /\binsurance\b/i],
  ['construction companies', /\b(construction|builders|contracting)\b/i],
  ['property managers', /\b(realty|real estate|properties|property management)\b/i],
  ['architecture and engineering firms', /\b(architects?|architecture|engineering)\b/i],
  ['manufacturers', /\b(manufacturing|fabrication)\b/i],
  ['schools', /\b(school|academy|university|college)\b/i],
  ['churches', /\b(church|parish)\b/i],
  ['veterinary practices', /\b(veterinary|animal hospital)\b/i],
  ['logistics companies', /\b(logistics|trucking|freight)\b/i],
];

/** Technology vendors and badges: partners they show, not clients who buy from them. */
const VENDOR = /\b(microsoft|google|amazon|aws|apple|cisco|dell|hpe?|lenovo|intel|fortinet|sonicwall|sophos|crowdstrike|sentinelone|huntress|datto|kaseya|connectwise|n-able|ninjaone|veeam|vmware|citrix|intuit|quickbooks|adobe|salesforce|hubspot|zoom|comptia|bbb|better business bureau|chamber of commerce|inc\.? ?5000|clutch|meta|facebook|linkedin|yelp|knowbe4)\b/i;

/** The segments a text names (each once). */
export function segmentsIn(text) {
  const t = String(text || '');
  return SEGMENTS.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/** The segments a client's name tells (vendors never count). */
export function segmentsOfName(name) {
  const n = String(name || '');
  if (!n || VENDOR.test(n)) return [];
  return NAME_HINTS.filter(([, re]) => re.test(n)).map(([label]) => label);
}

/** The company in a testimonial's "by" ("Renee Hollis, Hollis & Grant Law" → "Hollis & Grant Law"), else null. */
export function companyOf(by) {
  const parts = String(by || '').split(/\s*,\s*/).map(squash).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (!/^[A-Z0-9]/.test(last) || last.length > 60 || JOB_WORD.test(last) || /^(inc|llc|ltd|pc|pllc|llp)\.?$/i.test(last)) return null;
  return last;
}

const listText = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);

/**
 * Who buys from them (Research v4): segments counted over every place that
 * names one — a page's own words (one count a page), each testimonial, each
 * case study and each named client — with up to 3 pages each; up to
 * `maxExamples` named clients with the page; and one plain line. Only what the
 * site says: an empty site gives no segments, no examples and a null line.
 */
export function customersFrom(d = {}, { maxExamples = 8, maxSegments = 6 } = {}) {
  const segs = new Map();
  const add = (name, n, pages) => {
    const s = segs.get(name) || { count: 0, pages: [] };
    s.count += n;
    for (const p of pages) if (p && !s.pages.includes(p) && s.pages.length < 3) s.pages.push(p);
    segs.set(name, s);
  };
  for (const [name, v] of Object.entries(d.segs || {})) add(name, Number(v?.n) || 0, v?.pages || []);
  for (const t of d.testimonials || []) for (const name of new Set([...segmentsIn(`${t.quote} ${t.by}`), ...segmentsOfName(companyOf(t.by))])) add(name, 1, [t.page]);
  for (const c of d.caseStudies || []) for (const name of new Set(c.segments || segmentsIn(c.title))) add(name, 1, [c.page]);
  for (const c of d.clients || []) for (const name of segmentsOfName(c.name)) add(name, 1, [c.page]);
  const segments = [...segs.entries()].filter(([, v]) => v.count > 0).map(([name, v]) => ({ name, count: v.count, pages: v.pages }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, maxSegments);

  const examples = [];
  const addEx = (name, page, how) => {
    const n = squash(name);
    if (!n || n.length < 2 || VENDOR.test(n) || examples.length >= maxExamples) return;
    if (examples.some((e) => e.name.toLowerCase() === n.toLowerCase())) return;
    examples.push({ name: n, page: page || null, how });
  };
  for (const c of d.clients || []) addEx(c.name, c.page, 'client list');
  for (const t of d.testimonials || []) { const co = companyOf(t.by); if (co) addEx(co, t.page, 'testimonial'); }

  let who = '';
  if (segments.length) {
    const [a, b] = segments;
    const second = b && b.count >= Math.max(2, Math.ceil(a.count / 2)) ? b : null;
    who = a.count >= 2 ? `they mostly serve ${a.name}${second ? ` and ${second.name}` : ''}` : `they mention serving ${a.name}`;
  }
  const named = examples.length ? `named clients include ${listText(examples.slice(0, 3).map((e) => e.name))}` : '';
  const line = [who, named].filter(Boolean).join('; ');
  return { segments, examples, line: line ? `${line[0].toUpperCase()}${line.slice(1)}.` : null };
}

// ── what they talk about ────────────────────────────────────────────────────

const STOP_WORDS = new Set(`a about above across after again against all almost along already also although always am among an and another any anyone anything anyway are aren't around as ask at away back be became because become becomes been before behind being below best better between beyond both bring but by can can't cannot come comes could couldn't did didn't do does doesn't doing don't done down during each easy either else enough even ever every everything few find first for from full further get gets getting give given go goes going gone good got great had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've if in inside into is isn't it it's its itself just keep kind know known last least less let let's like likely little look looking lot lots made make makes making many may maybe me might more most much must my myself need needs never new next no nor not nothing now of off often on once one only onto or other others otherwise our ours ourselves out over own part per perhaps put quite rather re really right said same say says see seem seems set several she should shouldn't show since so some something sometimes still such sure take takes than that that's the their theirs them themselves then there there's these they they'd they'll they're they've thing things think this those though through thus to together too took toward towards under until up upon us use used uses using very via want wants was wasn't way ways we we'd we'll we're we've well went were weren't what what's when where where's whether which while who who's whole whom whose why will with within without won't work works would wouldn't yes yet you you'd you'll you're you've your yours yourself
  read more click share post posts posted blog article articles comment comments reply min mins minute minutes author category categories tag tags related previous home page contact learn subscribe newsletter email facebook twitter linkedin instagram youtube copyright rights reserved privacy policy terms cookie cookies menu search skip content view story source photo image video updated published continue
  january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday
  zero two three four five six seven eight nine ten eleven twelve hundred thousand million year years month months week weeks day days time times today ago top`.split(/\s+/).filter(Boolean));

/** A word that can be half of a topic: a real word (not a stop word) or a short product number ("365", "4557"), never a year. */
function topicWord(w, acronym) {
  if (/^\d+$/.test(w)) return w.length >= 3 && w.length <= 4 && !/^(19|20)\d{2}$/.test(w);
  if (!/[a-z]/.test(w)) return false;
  if (acronym) return true;
  return w.length >= 3 && !STOP_WORDS.has(w);
}

/**
 * Two-word phrases in a text, counted: Map(key → { n, text }). Both words
 * must be meaningful (stop words out) and next to each other in the same
 * sentence — "backup is not recovery" gives no "backup recovery". Short
 * capitals (IT, HR, CPA) are kept as acronyms.
 */
export function wordPairs(text) {
  const out = new Map();
  for (const chunk of String(text || '').replace(/[‘’]/g, "'").split(/[.!?;:,()[\]{}"“”|•·—–\n\r\t/]+|\s-\s|\s'|'\s/)) {
    const lowerChunk = /[a-z]/.test(chunk);
    const words = chunk.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+]+$/g, '').replace(/'s$/i, '')).filter(Boolean)
      .map((w) => ({ key: w.toLowerCase(), show: lowerChunk && /^[A-Z]{2,5}$/.test(w) ? w : w.toLowerCase(), acronym: lowerChunk && /^[A-Z]{2,5}$/.test(w) }));
    for (let i = 0; i + 1 < words.length; i++) {
      const [a, b] = [words[i], words[i + 1]];
      if (a.key === b.key || !topicWord(a.key, a.acronym) || !topicWord(b.key, b.acronym)) continue;
      const key = `${a.key} ${b.key}`;
      const cur = out.get(key) || { n: 0, text: `${a.show} ${b.show}` };
      cur.n += 1;
      out.set(key, cur);
    }
  }
  return out;
}

/** A post's top pairs as [key, count, text] (at most `max`). */
export function postPairs(html, { h1 = '', max = 40 } = {}) {
  const body = mainText(html);
  const text = h1 && !body.includes(h1) ? `${h1} . ${body}` : body;
  return [...wordPairs(text).entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, max).map(([k, v]) => [k, v.n, v.text]);
}

/**
 * The most frequent pairs across the posts read (`pairs`: key → [count, posts, text]),
 * at most `max`. Only pairs seen at least twice; pairs with the company's own
 * name in them are dropped (`exclude`: name words; any word inside `label`,
 * their domain's first part, too).
 */
export function topPairs(pairs = {}, { max = 8, exclude = [], label = '' } = {}) {
  const ex = new Set((exclude || []).map((w) => String(w).toLowerCase()));
  const lab = String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const own = (w) => ex.has(w) || (lab && w.length >= 4 && lab.includes(w));
  const ranked = Object.entries(pairs || {})
    .filter(([k, v]) => Array.isArray(v) && v[0] >= 2 && !k.split(' ').some(own))
    .sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0] || a[0].localeCompare(b[0]));
  // A run of three words gives two pairs ("phishing emails pretend"): a pair that continues
  // another ("emails pretend" after "phishing emails") no more often than it is the tail of
  // the same phrase — dropped; the head stays.
  const tail = ([k, v]) => { const first = k.split(' ')[0]; return ranked.some(([kk, vv]) => kk !== k && kk.split(' ')[1] === first && vv[0] >= v[0]); };
  return ranked.filter((e) => !tail(e)).slice(0, max).map(([k, v]) => ({ text: v[2] || k, count: v[0], posts: v[1] }));
}

const agoText = (d) => (d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : d < 730 ? `${Math.round(d / 30.44)} months ago` : `${Math.floor(d / 365.25)} years ago`);

/**
 * How often they post, from the dated posts read: "about 2 posts a month,
 * last one 12 days ago". `known` = post pages their site lists; when more were
 * listed than read, the count is a floor ("at least"). null without a date.
 */
export function postingRhythm(posts = [], { now = new Date(), known = 0 } = {}) {
  const day = 86400e3;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const dates = (posts || []).map((p) => Date.parse(p?.date || '')).filter((t) => Number.isFinite(t) && t <= nowMs + day).sort((a, b) => a - b);
  if (!dates.length) return null;
  const last = dates[dates.length - 1];
  const lastDays = Math.max(0, Math.floor((nowMs - last) / day));
  const yearAgo = nowMs - 365 * day;
  const inLastYear = dates.filter((t) => t >= yearAgo).length;
  const months = dates[0] < yearAgo ? 12 : Math.max(1, (nowMs - dates[0]) / (30.44 * day));
  const perMonth = Math.round((inLastYear / months) * 10) / 10;
  const atLeast = Number(known) > (posts || []).length;
  const about = atLeast ? 'at least' : 'about';
  let rate;
  if (!inLastYear) rate = 'no posts in the last year';
  else if (perMonth >= 0.95) { const n = Math.round(perMonth); rate = `${about} ${n} post${n === 1 ? '' : 's'} a month`; }
  else { const n = Math.max(1, Math.round(perMonth * 12)); rate = `${about} ${n} post${n === 1 ? '' : 's'} a year`; }
  return { text: `${rate}, last one ${agoText(lastDays)}`, perMonth, inLastYear, last: new Date(last).toISOString().slice(0, 10), lastDays, atLeast };
}

/** Everything one page says, in facts. */
export function deepFactsOf(html, { url, text = null } = {}) {
  let page = '/';
  try { page = new URL(url).pathname || '/'; } catch {}
  const t = text ?? textOf(html);
  const credentials = CREDENTIALS.filter(([, re]) => re.test(t)).map(([name, re]) => {
    const m = re.exec(t);
    const i = m ? m.index : 0;
    return { name, quote: clip(t.slice(Math.max(0, i - 60), i + 90), 160), page };
  });
  const isCase = /\/(case-stud(y|ies)|success-stories|results|our-work|work|projects|portfolio)\/[^/]+/i.test(page);
  const title = squash(decode((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));
  const h1 = textOf((String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const isPost = POST_PATH.test(page) || /"@type"\s*:\s*"(BlogPosting|NewsArticle|Article)"/.test(String(html || ''));
  // An article talks about the industry, not about what they sell: it only adds its date, its word pairs (what they talk about) and the site's tools.
  if (isPost) {
    return { page, title: clip(title, 120), words: (t.match(/[A-Za-z]{2,}/g) || []).length, post: { page, date: postDateOf(html), title: clip(h1 || title, 120) }, pairs: postPairs(html, { h1 }), tech: techOn(html), people: [], clients: [], testimonials: [], caseStudy: null, credentials: [], industries: [], segments: [], prices: [], addresses: [], jobs: [], forms: 0, org: null, offers: null, isPost: true };
  }
  const isJobs = /\/(careers?|jobs|join-us|join-our-team|work-with-us|employment)(\/|$)/i.test(page);
  // An industry page ("/industries/law-firms") names its segment in its address too.
  const industrySlug = (page.match(/\/(?:industries|who-we-serve|sectors|markets|verticals|clients-we-serve)\/([a-z0-9-]+)/i) || [])[1] || '';
  return {
    page,
    title: clip(title, 120),
    words: (t.match(/[A-Za-z]{2,}/g) || []).length,
    people: peopleOn(html).map((p) => ({ ...p, page })),
    clients: clientsOn(html).map((name) => ({ name, page })),
    testimonials: testimonialsOn(html, page),
    caseStudy: isCase ? { title: clip(h1 || title, 120), page, segments: segmentsIn(`${h1} . ${title}`) } : null,
    segments: [...new Set([...segmentsIn(mainText(html)), ...segmentsIn(industrySlug.replace(/-/g, ' '))])],
    credentials,
    industries: industriesOn(t),
    prices: pricesOn(t, page),
    addresses: addressesOn(t),
    jobs: isJobs ? jobsOn(html, page) : [],
    post: isPost ? { page, date: postDateOf(html), title: clip(h1 || title, 120) } : null,
    tech: techOn(html),
    forms: (String(html || '').match(/<form\b/gi) || []).length,
    org: (extractJsonLd(html).orgs || [])[0] || null,
    offers: offersOn(html, page),
  };
}

// ── running totals ──────────────────────────────────────────────────────────

const pushUniq = (arr, items, key, cap) => {
  for (const it of items || []) {
    if (arr.length >= cap) break;
    const k = String(key(it)).toLowerCase();
    if (k && !arr.some((x) => String(key(x)).toLowerCase() === k)) arr.push(it);
  }
  return arr;
};

export function emptyDeep() {
  return { offers: { ctas: [], promos: [], magnets: [], plans: [] }, pages: [], words: 0, people: [], clients: [], testimonials: [], caseStudies: [], credentials: [], industries: [], prices: [], addresses: [], jobs: [], posts: [], tech: [], forms: 0, org: null, orgPage: null, documents: [], segs: {}, pairs: {} };
}

/** Fold one page's facts into the running deep record (caps applied). */
export function mergeDeep(acc, f) {
  const a = acc && typeof acc === 'object' ? acc : emptyDeep();
  for (const k of Object.keys(emptyDeep())) if (a[k] === undefined) a[k] = emptyDeep()[k];
  if (!f) return a;
  if (f.page && !a.pages.includes(f.page) && a.pages.length < 200) a.pages.push(f.page);
  a.words += f.words || 0;
  pushUniq(a.people, f.people, (p) => p.name, CAPS.people);
  pushUniq(a.clients, f.clients, (c) => c.name, CAPS.clients);
  pushUniq(a.testimonials, f.testimonials, (t) => t.quote.slice(0, 60), CAPS.testimonials);
  if (f.caseStudy) pushUniq(a.caseStudies, [f.caseStudy], (c) => c.page, CAPS.caseStudies);
  pushUniq(a.credentials, f.credentials, (c) => c.name, CAPS.credentials);
  pushUniq(a.industries, f.industries, (x) => x, CAPS.industries);
  pushUniq(a.prices, f.prices, (p) => p.text, CAPS.prices);
  pushUniq(a.addresses, f.addresses, (x) => x.replace(/\W/g, ''), CAPS.addresses);
  pushUniq(a.jobs, f.jobs, (j) => j.title, CAPS.jobs);
  if (f.post) pushUniq(a.posts, [f.post], (p) => p.page, CAPS.posts);
  pushUniq(a.tech, f.tech, (t) => t.name, CAPS.tech);
  a.forms += f.forms || 0;
  if (f.offers) {
    a.offers = a.offers || { ctas: [], promos: [], magnets: [], plans: [] };
    pushUniq(a.offers.ctas, f.offers.ctas, (x) => x, CAPS.ctas);
    pushUniq(a.offers.promos, f.offers.promos, (x) => x.offer, CAPS.promos);
    pushUniq(a.offers.magnets, f.offers.magnets, (x) => x.title, CAPS.magnets);
    pushUniq(a.offers.plans, f.offers.plans, (x) => x.name, CAPS.plans);
  }
  if (!a.org && f.org && (f.org.name || f.org.foundingDate || f.org.employees)) { a.org = f.org; a.orgPage = f.page || null; }
  // Who buys from them: one count per page that names a segment (its first 3 pages kept).
  for (const name of f.segments || []) {
    const s = a.segs[name] || (a.segs[name] = { n: 0, pages: [] });
    s.n += 1;
    if (f.page && !s.pages.includes(f.page) && s.pages.length < 3) s.pages.push(f.page);
  }
  // What they talk about: word pairs over the posts read ([count, posts, text]); the long tail is pruned.
  if (f.pairs?.length) {
    for (const [key, n, text] of f.pairs) {
      const cur = a.pairs[key] || [0, 0, text];
      a.pairs[key] = [cur[0] + n, cur[1] + 1, cur[2] || text];
    }
    const keys = Object.keys(a.pairs);
    if (keys.length > CAPS.pairs) {
      const keep = keys.sort((x, y) => a.pairs[y][1] - a.pairs[x][1] || a.pairs[y][0] - a.pairs[x][0] || x.localeCompare(y)).slice(0, CAPS.pairs);
      a.pairs = Object.fromEntries(keep.map((k) => [k, a.pairs[k]]));
    }
  }
  return a;
}

// ── documents (PDF) ─────────────────────────────────────────────────────────

/**
 * Text of a PDF without a PDF library: the (Flate-)compressed content streams
 * are inflated and the strings shown with Tj / TJ are joined. Good for most
 * brochures and capability statements; scanned or encrypted PDFs give ''.
 * `inflate` is zlib.inflateSync (passed in so this file stays pure).
 */
export function pdfText(buf, { inflate, maxChars = 20000 } = {}) {
  const bin = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const raw = bin.toString('latin1');
  const title = ((raw.match(/\/Title\s*\(([^)]{1,200})\)/) || [])[1] || '').replace(/\\([()\\])/g, '$1');
  const pages = (raw.match(/\/Type\s*\/Page(?!s)\b/g) || []).length || null;
  const parts = [];
  const re = /(<<[^>]*?>>)\s*stream\r?\n/g;
  let m;
  let total = 0;
  while ((m = re.exec(raw)) && total < maxChars) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let data = bin.subarray(start, end);
    if (/\/Subtype\s*\/Image|\/XObject/.test(dict)) continue;
    if (/\/FlateDecode/.test(dict)) { try { data = inflate(data); } catch { continue; } } else if (/\/Filter/.test(dict)) continue;
    const s = data.toString('latin1');
    if (!/T[Jj]/.test(s)) continue;
    const txt = [];
    for (const t of s.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|(T\*|Td|TD|')/g)) {
      if (t[1] !== undefined) txt.push([...t[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]).join(''));
      else if (t[2] !== undefined) txt.push(t[2]);
      else txt.push('\n');
    }
    const out = txt.join('').replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\n', t: ' ', b: '', f: '' }[c] ?? c)).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    const clean = out.replace(/[^\x20-\x7e\n -ÿ]/g, ' ').replace(/[ \t]+/g, ' ');
    if (/[a-z]{3,}/i.test(clean)) { parts.push(clean); total += clean.length; }
  }
  return { title: squash(title) || null, pages, text: squash(parts.join('\n')).slice(0, maxChars) };
}

/** Facts from a document's text (same rules as a page). */
export function docFacts({ url, linkText, title, pages, text }) {
  const t = String(text || '');
  let path = url;
  try { path = new URL(url).pathname; } catch {}
  return {
    url,
    title: clip(title || linkText || decodeURIComponent(path.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' '), 120),
    pages,
    words: (t.match(/[A-Za-z]{2,}/g) || []).length,
    credentials: CREDENTIALS.filter(([, re]) => re.test(t)).map(([name]) => name),
    industries: industriesOn(t),
    excerpt: clip(t, 240) || null,
  };
}

/** How many separate facts the deep record holds (the "10× more" count). */
export function countFacts(d) {
  if (!d) return 0;
  return (d.people?.length || 0) * 2 + (d.clients?.length || 0) + (d.testimonials?.length || 0) + (d.caseStudies?.length || 0) + (d.credentials?.length || 0)
    + (d.industries?.length || 0) + (d.prices?.length || 0) + (d.addresses?.length || 0) + (d.jobs?.length || 0) + (d.posts?.length || 0) + (d.tech?.length || 0)
    + (d.documents || []).reduce((s, x) => s + 1 + (x.credentials?.length || 0) + (x.industries?.length || 0), 0)
    + (d.org ? Object.values(d.org).filter((v) => v !== null && v !== '').length : 0)
    + (d.offers ? d.offers.ctas.length + d.offers.promos.length + d.offers.magnets.length + d.offers.plans.length : 0)
    + (d.pages?.length || 0);
}
