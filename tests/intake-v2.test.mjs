// Intake v2 — Applicant Research, Domains v2 (candidates, RDAP, five registrars),
// CheapInboxes, the shopping shape the hub reads, and the purchase API.
// Fake KV; every network call is stubbed (io.fetchExt for website pages,
// globalThis.fetch for Places / RDAP / Porkbun). No real network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { renderTemplate } from '@/lib/templates/client';
import { DEFAULTS } from '@/lib/config';
import { createClient, getClient } from '@/lib/db/client';
import { mapBusiness } from '@/lib/ext/places';
import { rdapLookup } from '@/lib/ext/porkbun';
import {
  extractPage, mergeFacts, websiteOut, parseRobots, robotsAllows, findLocations, isServiceLike, customerPhrase, namesMatch,
  pickBusiness, cityStateOf, buildSummary, buildFlags, runResearch, startResearch, researchView, researchLine, yearsFacts,
} from '@/lib/systems/research';
import {
  generateCandidates, scoreCandidate, rankCandidates, brandStems, checkNames, priceRows, pickBest, registrarList, tierPrice,
  inboxPlan, buildOffers, totalsOf, refreshLivePrices, runRegistrarPriceRefresh,
} from '@/lib/systems/domains';
import { runPriceScout, getShopping, shoppingView } from '@/lib/systems/pricescout';
import { submitWebsiteApplication } from '@/lib/systems/webapply';
import { JOBS as STAGE_A_JOBS } from '@/lib/joblist/stage-a';

process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'https://app.test';

const D = DEFAULTS.DOMAINS;
const R = DEFAULTS.RESEARCH;
const TLDS = ['com', 'net', 'co'];
const NOW = new Date('2026-09-25T14:00:00Z');

let emails;
let alerts;
let pageLog;
let fetchLog;
const realFetchExt = io.fetchExt;

beforeEach(async () => {
  __reset();
  emails = [];
  alerts = [];
  pageLog = [];
  fetchLog = [];
  delete process.env.PLACES_API_KEY;
  delete process.env.PORKBUN_API_KEY;
  delete process.env.PORKBUN_SECRET;
  io.notifyClient = async (clientId, key, vars, opts = {}) => {
    const msg = renderTemplate(key, { clientName: 'C', contactName: 'Ann Lee', ...vars });
    emails.push({ clientId, key, vars, opts, msg });
    return { sent: true };
  };
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.sendOwnerEmail = async () => ({ ok: true });
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
});
afterEach(() => { io.fetchExt = realFetchExt; });

// ── website fixtures ─────────────────────────────────────────────────────────

const HOME = `<!doctype html><html><head>
<title>Acme Plumbing | Commercial Plumbers in Charlotte, NC</title>
<meta name="description" content="Commercial plumbing, drain cleaning and water heaters for property managers across the Carolinas.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Acme Plumbing LLC","telephone":"+1 704-555-0142","foundingDate":"2009","sameAs":["https://www.linkedin.com/company/acme-plumbing","https://www.facebook.com/acmeplumbing"],
"address":{"@type":"PostalAddress","streetAddress":"100 Trade St","addressLocality":"Charlotte","addressRegion":"NC","postalCode":"28202","addressCountry":"US"}}</script>
</head><body>
<header><nav><ul class="menu">
  <li><a href="/">Home</a></li><li><a href="/about-us/">About Us</a></li>
  <li><a href="/our-services">Services</a><ul>
    <li><a href="/services/drain-cleaning">Drain Cleaning</a></li>
    <li><a href="/services/water-heater-repair">Water Heater Repair</a></li>
    <li><a href="/services/backflow-testing"></a></li></ul></li>
  <li><a href="/our-team">Our Team</a></li><li><a href="/contact-us">Contact</a></li><li><a href="/service-areas">Service Areas</a></li>
</ul></nav></header>
<main><h1>Charlotte's commercial plumbers</h1>
<h3>Grease Trap Service</h3><h3>Why choose us?</h3><h3>We answer 24/7</h3>
<p>Call <a href="tel:+17045550142">(704) 555-0142</a> or email <a href="mailto:info@acme-plumbing.com">info@acme-plumbing.com</a>.</p>
<a href="https://twitter.com/intent/tweet?text=hi">Share</a>
</main>
<footer><p>100 Trade St, Charlotte, NC 28202</p><p>Serving Charlotte, NC and Rock Hill, SC. © 2026</p></footer>
</body></html>`;

const SERVICES = `<html><body><nav><a href="/">Home</a></nav><main>
<h2>Commercial Plumbing</h2><h2>HVAC Repair</h2><h2>Get a Quote</h2>
<ul><li>Hydro Jetting</li><li>Sewer Line Replacement</li><li>Read more</li><li>We love our customers and it shows every day</li></ul>
</main></body></html>`;

const TEAM = `<html><body><main><h2>Meet Our Team</h2>
<div class="team-member"><h3>Jane Doe</h3><p>Owner</p></div>
<div class="team-member"><h3>Carlos Ruiz</h3><p>Master Plumber</p></div>
<div class="team-member"><h3>Priya Patel</h3><p>Office Manager</p></div>
<div class="team-member"><h3>Tom O'Neil</h3><p>Technician</p></div>
</main></body></html>`;

const ABOUT = '<html><body><p>Family owned since 2009, a team of 12 licensed plumbers.</p></body></html>';
const CONTACT = '<html><body><p>Call (704) 555-0199 or write to <a href="mailto:jane@acme-plumbing.com">Jane</a>. Also sales@example.com</p></body></html>';
const AREAS = '<html><body><p>We serve Charlotte, North Carolina, Matthews, NC, Fort Mill, SC and McKinney, TX. 123 Main St, TX is not a city.</p></body></html>';
const ROBOTS = 'User-agent: *\nDisallow: /private\nDisallow: /contact-us\n\nUser-agent: GPTBot\nDisallow: /';

const SITE = {
  'https://acme-plumbing.com/robots.txt': { status: 301, location: 'https://www.acme-plumbing.com/robots.txt' },
  'https://www.acme-plumbing.com/robots.txt': { status: 200, body: ROBOTS, type: 'text/plain' },
  'https://www.acme-plumbing.com/': { status: 200, body: HOME },
  'https://www.acme-plumbing.com/about-us/': { status: 200, body: ABOUT },
  'https://www.acme-plumbing.com/our-services': { status: 200, body: SERVICES },
  'https://www.acme-plumbing.com/our-team': { status: 200, body: TEAM },
  'https://www.acme-plumbing.com/contact-us': { status: 200, body: CONTACT },
  'https://www.acme-plumbing.com/service-areas': { status: 200, body: AREAS },
};

/** io.fetchExt stub serving SITE (real Response objects, so the 1 MB reader runs). */
function serveSite(site = SITE) {
  io.fetchExt = async (url, opts = {}) => {
    pageLog.push({ url: String(url), ua: opts.headers?.['user-agent'], redirect: opts.redirect, service: opts.service });
    const hit = site[String(url)];
    if (!hit) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (hit.throw) throw new Error(hit.throw);
    const headers = { 'content-type': hit.type || 'text/html; charset=utf-8' };
    if (hit.location) headers.location = hit.location;
    return new Response(hit.status >= 300 && hit.status < 400 ? null : hit.body, { status: hit.status, headers });
  };
}

const PLACE = {
  displayName: { text: 'Acme Plumbing' }, formattedAddress: '100 Trade St, Charlotte, NC 28202, USA', primaryTypeDisplayName: { text: 'Plumber' },
  rating: 4.7, userRatingCount: 128, googleMapsUri: 'https://maps.google.com/?cid=1', nationalPhoneNumber: '(704) 555-0142', websiteUri: 'https://www.acme-plumbing.com/',
};

/** globalThis.fetch stub: Places (business + IDs-only), RDAP, Porkbun pricing. */
function serveApis({ places = [PLACE], idsPages = 3, rdap = {}, registeredAt = '2009-03-01T00:00:00Z', porkbun = { com: { registration: '11.08', renewal: '11.08' }, net: { registration: '12.52', renewal: '12.52' }, co: { registration: '15.76', renewal: '31.20' } } } = {}) {
  let idsCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    fetchLog.push(u);
    if (u.includes('places.googleapis.com')) {
      const mask = init.headers?.['X-Goog-FieldMask'] || '';
      if (mask.includes('displayName')) return new Response(JSON.stringify({ places }), { status: 200 });
      idsCalls++;
      const page = idsCalls;
      const ids = Array.from({ length: 20 }, (_, i) => ({ id: `p${page}-${i}` }));
      return new Response(JSON.stringify({ places: ids, nextPageToken: page % idsPages ? `t${page}` : undefined }), { status: 200 });
    }
    if (u.includes('rdap.org/domain/') || u.includes('rdap.verisign.com/')) { // .com/.net go straight to Verisign
      const name = decodeURIComponent(u.split('/domain/')[1]);
      if (name === 'acme-plumbing.com' || name === 'acme.com') return new Response(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: registeredAt }] }), { status: 200 });
      const st = rdap[name] ?? 404;
      return new Response(st === 200 ? '{}' : 'nope', { status: st });
    }
    if (u.includes('api.porkbun.com') && u.includes('/pricing/get')) return new Response(JSON.stringify({ status: 'SUCCESS', pricing: porkbun }), { status: 200 });
    if (u.includes('overpass-api.de')) return new Response(JSON.stringify({ elements: [{ type: 'count', tags: { total: '140' } }] }), { status: 200 });
    throw new Error(`unexpected network call in test: ${u}`);
  };
}

async function applied(id = 'acme-plumbing', extra = {}) {
  await createClient(id, { name: 'Acme Plumbing', contactName: 'Ann Lee', contactEmail: 'ann@acme-plumbing.com', website: 'https://acme-plumbing.com', mainDomain: 'acme-plumbing.com', state: 'applied', ...extra });
  await kv.hset(`client:${id}:application`, { mainDomain: 'acme-plumbing.com', web_city: 'Charlotte, NC', web_sellsTo: 'Commercial plumbing for property managers in the Carolinas', review: 'pending' });
  return id;
}

// ── research: pure extraction ────────────────────────────────────────────────

test('extraction: title, description, H1, services, locations, phones, emails, socials, team and years', () => {
  const home = extractPage(HOME, { url: 'https://www.acme-plumbing.com/', kind: 'home' });
  assert.equal(home.title, 'Acme Plumbing | Commercial Plumbers in Charlotte, NC');
  assert.match(home.description, /^Commercial plumbing, drain cleaning/);
  assert.equal(home.headline, "Charlotte's commercial plumbers");
  assert.deepEqual(home.services.child, ['Drain Cleaning', 'Water Heater Repair', 'Backflow Testing']); // empty link text → from the slug
  assert.deepEqual(home.services.headings, ['Grease Trap Service']); // "Why choose us?" and "We answer 24/7" are not services
  assert.equal(home.links.about, 'https://www.acme-plumbing.com/about-us/');
  assert.equal(home.links.services, 'https://www.acme-plumbing.com/our-services');
  assert.equal(home.links.team, 'https://www.acme-plumbing.com/our-team');
  assert.equal(home.links.locations, 'https://www.acme-plumbing.com/service-areas');
  assert.ok(home.locations.includes('Charlotte, NC') && home.locations.includes('Rock Hill, SC'));
  assert.deepEqual(home.phones, ['(704) 555-0142']);
  assert.deepEqual(home.emails, ['info@acme-plumbing.com']); // listed, never role-flagged here
  assert.equal(home.socials.linkedin, 'https://www.linkedin.com/company/acme-plumbing');
  assert.equal(home.socials.facebook, 'https://www.facebook.com/acmeplumbing');
  assert.equal(home.socials.x, undefined, 'a share link is not a profile');
  assert.equal(home.yearsHint, 'Founded in 2009'); // schema.org foundingDate
  assert.equal(home.orgName, 'Acme Plumbing LLC');

  const svc = extractPage(SERVICES, { url: 'https://www.acme-plumbing.com/our-services', kind: 'services' });
  assert.deepEqual(svc.services.headings, ['Commercial Plumbing', 'HVAC Repair']);
  assert.deepEqual(svc.services.items, ['Hydro Jetting', 'Sewer Line Replacement']);

  const team = extractPage(TEAM, { url: 'https://www.acme-plumbing.com/our-team', kind: 'team' });
  assert.equal(team.teamCount, 4);
  const about = extractPage(ABOUT, { url: 'https://www.acme-plumbing.com/about-us/', kind: 'about' });
  assert.equal(about.yearsHint, 'Since 2009');
  assert.equal(about.teamText, 'Website says a team of 12');
  const areas = extractPage(AREAS, { url: 'https://www.acme-plumbing.com/service-areas', kind: 'locations' });
  assert.deepEqual(areas.locations, ['Matthews, NC', 'Fort Mill, SC', 'McKinney, TX', 'Charlotte, NC']);

  let acc = null;
  for (const [page, kind] of [[home, 'home'], [svc, 'services'], [team, 'team'], [about, 'about'], [areas, 'locations']]) acc = mergeFacts(acc, page, kind);
  const w = websiteOut(acc, { url: 'https://www.acme-plumbing.com/', pagesRead: 5, limits: R });
  assert.deepEqual(w.services, ['Drain Cleaning', 'Water Heater Repair', 'Backflow Testing', 'Commercial Plumbing', 'HVAC Repair', 'Hydro Jetting', 'Sewer Line Replacement']);
  assert.ok(w.services.length <= 12);
  assert.equal(w.teamHint, '4 people on the team page');
  assert.equal(w.yearsHint, 'Founded in 2009');
  assert.equal(w.pagesRead, 5);
});

test('extraction rules: robots, locations, services, customer phrase, names, years', () => {
  const rules = parseRobots(ROBOTS);
  assert.equal(robotsAllows(rules, '/'), true);
  assert.equal(robotsAllows(rules, '/private/x'), false);
  assert.equal(robotsAllows(rules, '/contact-us'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: AvianceBot\nDisallow: /\n\nUser-agent: *\nAllow: /'), '/about'), false, 'our own group wins');
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /\nAllow: /about$'), '/about'), true, 'longest rule wins');
  assert.equal(robotsAllows(parseRobots(''), '/anything'), true);

  assert.deepEqual(findLocations(['St. Louis, MO', 'Tulsa, OK', 'Tulsa, OK 74103', 'Suite 200, TX', '12 Oak Lane, TX', 'Copyright Acme, NC', 'Austin, Texas']), ['St. Louis, MO', 'Tulsa, OK', 'Austin, TX']);
  assert.equal(findLocations(['Tulsa, OK']).length, 0, 'OK without a ZIP is too ambiguous');

  for (const good of ['Drain Cleaning', 'HVAC Repair', 'Commercial Roofing']) assert.equal(isServiceLike(good), true, good);
  for (const bad of ['Home', 'Contact Us', 'Get a Quote', 'Why choose us?', 'We love our customers', 'Call (704) 555-0142', 'Learn more']) assert.equal(isServiceLike(bad), false, bad);

  assert.equal(customerPhrase('Commercial plumbing for property managers in the Carolinas'), 'property managers');
  assert.equal(customerPhrase('We sell IT support to dental practices across Texas'), 'dental practices');
  assert.equal(customerPhrase('Bookkeeping for the HVAC contractors, plumbers and electricians'), 'HVAC contractors');
  assert.equal(customerPhrase('Software to help grow revenue'), null);
  assert.equal(customerPhrase('We build websites'), null);

  assert.equal(namesMatch('Acme Plumbing & Heating LLC', 'Acme Plumbing'), true);
  assert.equal(namesMatch('Acme Plumbing', 'acme-plumbing'), true);
  assert.equal(namesMatch('Bob’s Burgers', 'Acme Plumbing'), false);
  assert.equal(cityStateOf('Unit 4, 100 Trade St, Charlotte, NC 28202, USA'), 'Charlotte, NC');
  assert.equal(cityStateOf('Colombo 00300, Sri Lanka'), null);
  assert.equal(yearsFacts('Serving the Triangle since 1998', null, { year: 2026 }), 'Since 1998');
  assert.equal(yearsFacts('Established 2031', null, { year: 2026 }), null, 'a year in the future is not a fact');
  assert.equal(yearsFacts('Over 25 years of experience', null, { year: 2026 }), '25 years of experience');
});

test('Places mapping and picking the right business', () => {
  const b = mapBusiness(PLACE);
  assert.deepEqual(b, { name: 'Acme Plumbing', address: '100 Trade St, Charlotte, NC 28202, USA', category: 'Plumber', rating: 4.7, reviews: 128, mapsUrl: 'https://maps.google.com/?cid=1', phone: '(704) 555-0142', website: 'https://www.acme-plumbing.com/' });
  assert.deepEqual(mapBusiness({ displayName: { text: 'No Stars' } }), { name: 'No Stars', address: null, category: null, rating: null, reviews: null, mapsUrl: null, phone: null, website: null }, 'missing values stay null, never 0');
  const other = mapBusiness({ displayName: { text: 'Queen City Drains' }, websiteUri: 'https://qcdrains.com' });
  assert.equal(pickBusiness([other, b], { mainDomain: 'acme-plumbing.com', name: 'Acme Plumbing' }).business.name, 'Acme Plumbing'); // same website
  assert.equal(pickBusiness([other, { ...b, website: null }], { mainDomain: 'acme-plumbing.com', name: 'Acme Plumbing' }).how, 'name');
  const miss = pickBusiness([other], { mainDomain: 'acme-plumbing.com', name: 'Acme Plumbing' });
  assert.equal(miss.matched, false);
  assert.equal(miss.business.name, 'Queen City Drains');
  assert.deepEqual(pickBusiness([], { mainDomain: 'x.com', name: 'X' }), { business: null, matched: false });
});

test('flags: agency, no US address, unreachable, very new, name mismatch, Places skipped', () => {
  const now = new Date('2026-09-25T00:00:00Z');
  const flags = buildFlags({
    name: 'Acme Plumbing', mainDomain: 'acme-plumbing.com', website: { title: 'Pipeline Pros', locations: [] }, business: { name: 'Queen City Drains', address: '1 Main St, Charlotte, NC 28202' }, businessMatched: false,
    placesNote: null, homeError: 'timed out', registeredAt: '2026-06-27T00:00:00Z', agencyHit: 'appointment setting', now, newSiteDays: 365,
  });
  const texts = flags.map((f) => `${f.level}: ${f.text}`);
  assert.ok(texts.includes("warn: Website or application mentions 'appointment setting' — could be an agency"));
  assert.ok(texts.includes('warn: Website did not load (timed out)'));
  assert.ok(texts.includes('warn: No US address found on the website or on Google'), 'a mismatched listing is not their address');
  assert.ok(texts.includes('warn: Very new site: acme-plumbing.com was registered 90 days ago (2026-06-27)'));
  assert.ok(texts.includes('warn: Google\'s closest match is “Queen City Drains”, not “Acme Plumbing” — check it is the same business'));
  assert.ok(texts.includes('info: Website title “Pipeline Pros” does not mention Acme Plumbing'));

  const quiet = buildFlags({ name: 'Acme Plumbing', mainDomain: 'acme-plumbing.com', website: { title: 'Acme Plumbing', locations: ['Charlotte, NC'] }, business: null, businessMatched: false, placesNote: 'no_key', registeredAt: '2009-03-01T00:00:00Z', now });
  assert.deepEqual(quiet, [{ level: 'info', text: 'Google Places lookup skipped — PLACES_API_KEY is not set' }]);
});

test('summary is built only from facts that are present', () => {
  const website = { title: 'Acme Plumbing', description: 'Commercial plumbing in Charlotte.', headline: null, services: ['Drain Cleaning', 'Water Heater Repair', 'Hydro Jetting', 'Other'], locations: ['Charlotte, NC'], yearsHint: 'Since 2009', teamHint: '4 people on the team page', pagesRead: 5 };
  const full = buildSummary({ name: 'Acme Plumbing', host: 'acme-plumbing.com', website, business: mapBusiness(PLACE), businessMatched: true, market: { query: 'property managers in Charlotte, NC', estimate: 360, source: 'places' } });
  assert.equal(full, 'Acme Plumbing is a plumber in Charlotte, NC (4.7★, 128 Google reviews). The website lists services such as Drain Cleaning, Water Heater Repair and Hydro Jetting, names Charlotte, NC, says “Since 2009” and shows 4 people on the team page. A quick Google Maps count suggests about 360 property managers in Charlotte, NC.');

  const noStars = buildSummary({ name: 'Acme', host: 'acme.com', website: { pagesRead: 1, services: [], locations: [] }, business: { name: 'Acme', address: '1 Main St, Dallas, TX 75201', category: null, rating: null, reviews: null }, businessMatched: true, market: null });
  assert.equal(noStars, 'Acme is listed on Google in Dallas, TX.');
  const siteOnly = buildSummary({ name: 'Acme', host: 'acme.com', website: { description: 'We fix pipes.', pagesRead: 1, services: [], locations: [] }, business: { name: 'Other Co' }, businessMatched: false, market: null });
  assert.equal(siteOnly, 'Acme\'s website (acme.com) says: “We fix pipes.”.');
  const nothing = buildSummary({ name: 'Acme', host: 'acme.com', website: { pagesRead: 0, services: [], locations: [] }, business: null, businessMatched: false, market: null });
  assert.equal(nothing, 'The website of Acme (acme.com) could not be read automatically.');
  for (const s of [full, noStars, siteOnly, nothing]) assert.doesNotMatch(s, /undefined|null|NaN/);
});

// ── research: the run ────────────────────────────────────────────────────────

test('research run: crawl (robots honoured), Places, domain age, market preview, prefill, HUB shape', async () => {
  process.env.PLACES_API_KEY = 'k';
  serveSite();
  serveApis();
  const id = await applied();
  await startResearch(id, { now: NOW });
  assert.equal((await getClient(id)).researchStep, 'running');
  assert.deepEqual(await researchView(id), { status: 'pending', at: NOW.toISOString(), error: null, summary: null, website: null, business: null, market: null, flags: [], score: null, deep: null });

  const r = await runResearch(id, { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(r.status, 'done');
  assert.equal((await getClient(id)).researchStep, '');
  // robots.txt first (after a redirect to www), then pages; /contact-us is disallowed and never fetched.
  assert.deepEqual(pageLog.map((p) => p.url).slice(0, 3), ['https://acme-plumbing.com/robots.txt', 'https://www.acme-plumbing.com/robots.txt', 'https://www.acme-plumbing.com/']);
  assert.ok(!pageLog.some((p) => p.url.includes('contact-us')), 'robots.txt disallow honoured');
  assert.ok(pageLog.every((p) => p.ua === 'AvianceBot/1.0 (+aviance.online/bot)' && p.redirect === 'manual' && p.service === 'crawl'));

  const v = await researchView(id);
  assert.deepEqual(Object.keys(v), ['status', 'at', 'error', 'summary', 'website', 'business', 'market', 'flags', 'score', 'deep']);
  assert.deepEqual(Object.keys(v.website), ['url', 'title', 'description', 'headline', 'services', 'locations', 'phones', 'emails', 'socials', 'teamHint', 'yearsHint', 'pagesRead']);
  assert.deepEqual(Object.keys(v.business), ['name', 'address', 'category', 'rating', 'reviews', 'mapsUrl', 'phone']);
  assert.deepEqual(Object.keys(v.market), ['query', 'estimate', 'source']);
  assert.equal(v.website.url, 'https://www.acme-plumbing.com/');
  assert.equal(v.website.pagesRead, 5);
  assert.equal(v.website.teamHint, '4 people on the team page');
  assert.ok(v.website.locations.includes('McKinney, TX'));
  assert.equal(v.business.rating, 4.7);
  assert.deepEqual(v.market, { query: 'property managers in Charlotte, NC', estimate: 360, source: 'places' }); // 2 queries × 60 unique ids × coverage 3
  assert.match(v.summary, /^Acme Plumbing is a plumber in Charlotte, NC \(4\.7★, 128 Google reviews\)\./);
  assert.deepEqual(v.flags, [], 'nothing to warn about');

  // Places business lookup counted once under the Enterprise budget; IDs-only separately.
  const month = NOW.toISOString().slice(0, 7);
  const usage = await kv.hgetall(`usage:places:${new Date().toISOString().slice(0, 7)}`);
  assert.equal(Number(usage.enterprise), 1);
  assert.equal(Number(usage.idsOnly), 6);
  assert.ok(month);

  // Empty onboarding fields were prefilled; nothing the client typed is overwritten.
  const p = await kv.hgetall(`client:${id}:profile`);
  assert.equal(p.companyName, 'Acme Plumbing');
  assert.equal(p.postalAddress, '100 Trade St, Charlotte, NC 28202');
  assert.deepEqual(JSON.parse(p.cities).slice(0, 2), ['Charlotte, NC', 'Rock Hill, SC']);
  assert.equal(p.defaultIcp, 'property managers');

  // Idempotent: a second run does no network work.
  const before = pageLog.length + fetchLog.length;
  assert.equal((await runResearch(id, { now: NOW })).status, 'done');
  assert.equal(pageLog.length + fetchLog.length, before);
  assert.match(researchLine(v), /^Fit score: \d+\/100/);
  assert.match(researchLine(v), /\nResearch: Acme Plumbing is a plumber/);
  // The Fit Score came with the research: six parts, facts only, Google's 4.7★ from 128 reviews counted.
  assert.equal(v.score.parts.length, 6);
  assert.equal(typeof v.score.score, 'number');
  assert.ok(v.score.confidence > 0 && v.score.confidence <= 100);
  const reviews = v.score.parts.find((p) => p.key === 'proof').items.find((i) => /Google/.test(i.text));
  assert.equal(reviews.text, 'Google: 4.7★ from 128 reviews');
  assert.equal(reviews.status, 'good');
});

test('research is bounded per run and resumes where it stopped', async () => {
  serveSite();
  serveApis();
  const id = await applied();
  await startResearch(id, { now: NOW });
  // Too little time for even one page: nothing is lost, the job continues next minute.
  assert.equal((await runResearch(id, { now: NOW, deadline: Date.now() + 1000 })).status, 'pending');
  assert.equal(pageLog.length, 0);
  // Slow site: every page takes a while, so one run reads only part of it.
  const fast = io.fetchExt;
  io.fetchExt = async (u, o) => { await new Promise((r) => setTimeout(r, 30)); return fast(u, o); };
  assert.equal((await runResearch(id, { now: NOW, deadline: Date.now() + 2600 })).status, 'pending');
  const raw = await kv.hgetall(`client:${id}:research`);
  assert.ok(['robots', 'home', 'pages'].includes(raw.step));
  io.fetchExt = fast;
  const done = await runResearch(id, { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(done.status, 'done');
  const v = await researchView(id);
  assert.equal(v.website.pagesRead, 5);
  assert.equal(new Set(pageLog.map((p) => p.url)).size, pageLog.length, 'no page fetched twice across runs');
  assert.ok(v.flags.some((f) => f.text === 'Google Places lookup skipped — PLACES_API_KEY is not set'));
  assert.equal(v.business, null);
});

test('research failure paths: unreachable site is a flag; an internal error marks it failed and alerts once', async () => {
  serveSite({ 'https://down.example/robots.txt': { throw: 'getaddrinfo ENOTFOUND' } });
  io.fetchExt = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  serveApis();
  await createClient('down', { name: 'Down Co', mainDomain: 'down-co.com', state: 'applied' });
  await startResearch('down', { now: NOW });
  const r = await runResearch('down', { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(r.status, 'done');
  const v = await researchView('down');
  assert.equal(v.website.pagesRead, 0);
  assert.ok(v.flags.some((f) => f.level === 'warn' && f.text === 'Website did not load (getaddrinfo ENOTFOUND)'));
  assert.ok(v.flags.some((f) => f.text === 'No US address found on the website'));
  assert.equal(v.summary, 'The website of Down Co (down-co.com) could not be read automatically.');
  assert.equal(alerts.length, 0);

  // An internal error (a broken setting) → failed + error + one non-urgent alert; nothing else changes.
  await kv.hset('system:config', { RESEARCH: JSON.stringify(null) });
  await createClient('boom', { name: 'Boom', mainDomain: 'boom.com', state: 'applied' });
  await startResearch('boom', { now: NOW });
  const f = await runResearch('boom', { now: NOW });
  assert.equal(f.status, 'failed');
  const fv = await researchView('boom');
  assert.equal(fv.status, 'failed');
  assert.match(fv.error, /pageTimeoutMs|null/);
  assert.equal((await getClient('boom')).state, 'applied');
  assert.equal((await getClient('boom')).researchStep, '');
  assert.deepEqual(alerts.map((a) => a.key), ['research_failed']);
  assert.match(researchLine(fv), /^Research: could not finish/);
});

test('a website application alerts the owner at once; the full research and its score follow in one application_scored alert', async () => {
  serveSite();
  serveApis();
  const site = {
    source: 'website', name: 'Ann Lee', email: 'ann@acme-plumbing.com', website: 'https://www.acme-plumbing.com/', city: 'Charlotte, NC',
    sell: 'Commercial plumbing for property managers in the Carolinas', value: '$5,000–$20,000', capacity: '5–10 a week',
    strangers: 'Yes — cold buyers already', calendar: 'Yes', then: 'Growth', notes: '', agree: true,
  };
  const r = await submitWebsiteApplication(site, { fetchText: async () => '' });
  assert.equal(r.outcome, 'review');
  assert.equal(alerts.length, 1, 'the application alert goes out without waiting for the whole-site research');
  assert.equal(alerts[0].key, 'new_application');
  assert.equal(emails.length, 0);
  // The rest runs right after the answer (researchToEnd in the route's after()).
  const { researchToEnd } = await import('@/lib/systems/research');
  assert.equal(await researchToEnd(r.clientId, 60_000), 'done');
  const scored = alerts.filter((a) => a.key === 'application_scored');
  assert.equal(scored.length, 1);
  assert.match(scored[0].body, /\/100/);
  const v = await researchView(r.clientId);
  assert.equal(v.status, 'done');
  assert.match(v.summary, /^Acme Plumbing's website \(acme-plumbing\.com\) says: “Commercial plumbing, drain cleaning/);
  assert.match(v.summary, /OpenStreetMap count suggests about 140 property managers in North Carolina\./); // no Places key → OSM
  assert.deepEqual(v.market, { query: 'property managers in North Carolina', estimate: 140, source: 'overpass' });
  // Owner-created clients get research too (by the job).
  const { applyForTrial } = await import('@/lib/systems/gatekeeper');
  const o = await applyForTrial({ companyName: 'Beta HVAC', contactName: 'Bo', contactEmail: 'bo@beta-hvac.com', website: 'beta-hvac.com' }, { preApproved: true, source: 'owner' });
  assert.equal((await getClient(o.clientId)).researchStep, 'running');
  const job = STAGE_A_JOBS.find((j) => j.name === 'research');
  assert.ok(await job.due({ client: await getClient(o.clientId), now: NOW }));
  assert.equal(await job.due({ client: { ...(await getClient(o.clientId)), id: 'aviance' }, now: NOW }), null);
  assert.equal(await job.due({ client: await getClient(r.clientId), now: NOW }), null, 'done research is not due');
  // A form application declined on the spot is not researched.
  const d = await applyForTrial({ companyName: 'Tiny Co', contactName: 'Tia', contactEmail: 'tia@tiny-co.com', website: 'tiny-co.com', usBased: 'no' }, { source: 'form' });
  assert.equal(d.outcome, 'declined');
  assert.equal(await researchView(d.clientId), null);
});

// ── domains: candidates, scoring, availability ───────────────────────────────

test('candidate generator: brand stems, affixes, ≤ 15 letters, no digits/hyphens, com → net → co, never the main domain', () => {
  assert.deepEqual(brandStems('www.acme-plumbing.com'), [{ stem: 'acmeplumbing', full: true }, { stem: 'acme', full: false }]);
  assert.deepEqual(brandStems('24-7-plumbers.com'), [{ stem: 'plumbers', full: true }]);
  const all = generateCandidates('acme-plumbing.com', D, TLDS);
  assert.ok(all.length > 20);
  for (const c of all) {
    assert.match(c.domain, /^[a-z]+\.(com|net|co)$/);
    assert.ok(c.label.length <= 15, c.domain);
  }
  assert.ok(all.some((c) => c.domain === 'getacmeplumbing.com'));
  assert.ok(!all.some((c) => c.domain === 'acmeplumbingteam.com'), '16 letters is too long');
  assert.ok(!all.some((c) => c.domain === 'acme-plumbing.com'));
  assert.equal(all[0].tld, 'com');
  assert.equal(all.at(-1).tld, 'co');
  // Confusable joins are skipped: 'tech' + 'hq', 'rent' + 'team', 'use' + 'east'.
  const t = generateCandidates('fixtech.com', D, ['com']).map((c) => c.label);
  assert.ok(!t.includes('fixtechhq') && t.includes('fixtechteam'));
  assert.ok(!generateCandidates('rent.com', D, ['com']).some((c) => c.label === 'rentteam'));
  assert.ok(!generateCandidates('east.com', D, ['com']).some((c) => c.label === 'useeast'));
  assert.ok(!generateCandidates('acme.com', D, ['com']).some((c) => c.domain === 'acme.com'));
});

test('scoring: short, .com, company-like affixes win; spammy and big-brand look-alikes lose', () => {
  const ranked = rankCandidates('acme.com', D, TLDS);
  assert.equal(ranked[0].domain, 'getacme.com');
  assert.equal(ranked[0].score, 98);
  assert.equal(ranked[0].why, "short (7), 'get' + brand, .com");
  assert.ok(ranked.findIndex((c) => c.domain === 'getacme.com') < ranked.findIndex((c) => c.domain === 'getacme.net'));
  assert.ok(ranked.find((c) => c.domain === 'acmemail.com').score < ranked.find((c) => c.domain === 'acmehq.com').score);
  const spammy = scoreCandidate({ label: 'freeacme', tld: 'com', stem: 'acme', affix: 'free', position: 'prefix', fullBrand: true }, D);
  assert.equal(spammy.score, 60);
  assert.match(spammy.why, /contains 'free'/);
  const brand = scoreCandidate({ label: 'acmegmail', tld: 'com', stem: 'acme', affix: 'gmail', position: 'suffix', fullBrand: true }, D);
  assert.match(brand.why, /looks like 'gmail'/);
  assert.ok(brand.score <= 50);
  const own = scoreCandidate({ label: 'getfreedom', tld: 'com', stem: 'freedom', affix: 'get', position: 'prefix', fullBrand: true }, D);
  assert.doesNotMatch(own.why, /free/, "the client's own brand is not held against it");
});

test('RDAP: 404 free, 200 taken (+ registration date), 429 limited; cache and polite back-off', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchLog.push(u);
    if (u.endsWith('/free.com')) return new Response('', { status: 404 });
    if (u.endsWith('/taken.com')) return new Response(JSON.stringify({ events: [{ eventAction: 'last changed', eventDate: '2024-01-01T00:00:00Z' }, { eventAction: 'registration', eventDate: '1999-05-03T10:00:00Z' }] }), { status: 200 });
    if (u.endsWith('/busy.com')) return new Response('slow down', { status: 429 });
    return new Response('oops', { status: 503 });
  };
  assert.deepEqual(await rdapLookup('free.com'), { status: 'free', registeredAt: null });
  assert.deepEqual(await rdapLookup('taken.com'), { status: 'taken', registeredAt: '1999-05-03T10:00:00.000Z' });
  assert.deepEqual(await rdapLookup('busy.com'), { status: 'limited', registeredAt: null });
  assert.deepEqual(await rdapLookup('weird.com'), { status: 'unknown', registeredAt: null });

  fetchLog = [];
  const a = await checkNames(['free.com', 'taken.com', 'weird.com'], { D, now: NOW });
  assert.deepEqual(a.results, { 'free.com': { available: true, source: 'rdap' }, 'taken.com': { available: false, source: 'rdap' }, 'weird.com': { available: null, source: 'rdap' } });
  assert.equal(fetchLog.length, 3);
  const b = await checkNames(['free.com', 'taken.com'], { D, now: NOW });
  assert.deepEqual(b.results, { 'free.com': { available: true, source: 'cache' }, 'taken.com': { available: false, source: 'cache' } });
  assert.equal(fetchLog.length, 3, 'answered from the cache');
  // Free answers expire sooner than taken ones.
  const later = new Date(NOW.getTime() + 13 * 3600e3);
  const c = await checkNames(['free.com', 'taken.com'], { D, now: later });
  assert.equal(c.results['free.com'].source, 'rdap');
  assert.equal(c.results['taken.com'].source, 'cache');

  const d = await checkNames(['busy.com', 'other.com'], { D: { ...D, rdapConcurrency: 1 }, now: NOW });
  assert.equal(d.limited, true);
  assert.ok(await kv.get('intake:rdapbackoff'), 'back-off set after a 429');
  const n = fetchLog.length;
  const e = await checkNames(['other.com'], { D, now: NOW });
  assert.equal(e.limited, true);
  assert.equal(fetchLog.length, n, 'nobody asks rdap.org during the back-off');
});

// ── prices, best pick, inboxes, totals ───────────────────────────────────────

test('registrar prices: live beats table while fresh; best = cheapest first year, tie → cheaper renewal', async () => {
  const regs = DEFAULTS.REGISTRARS;
  assert.equal(regs.length, 5);
  const table = priceRows(regs, 'com', { now: NOW, D });
  assert.deepEqual(table.map((r) => [r.registrar, r.firstYear, r.renewal, r.source]), [
    ['Cloudflare', 10.46, 10.46, 'table'], ['Spaceship', 9.08, 10.18, 'table'], ['Dynadot', 10.88, 10.88, 'table'], ['Porkbun', 11.08, 11.08, 'table'], ['Namecheap', 11.48, 18.68, 'table'],
  ]);
  assert.deepEqual(pickBest(table), { registrar: 'Spaceship', firstYear: 9.08, renewal: 10.18, url: regs[1].url, promo: { code: 'COM67', firstYear: 3.8, note: 'limited time, no end date shown' } });
  assert.deepEqual(registrarList(regs, table).map((r) => r.name), ['Spaceship', 'Cloudflare', 'Dynadot', 'Porkbun', 'Namecheap']);

  // Porkbun's keyless price list → live rows (and back to the table when stale).
  globalThis.fetch = async (url) => new Response(JSON.stringify({ status: 'SUCCESS', pricing: { com: { registration: '8.99', renewal: '11.08' }, net: { registration: '12.52', renewal: '12.52' } } }), { status: 200 });
  await refreshLivePrices({ now: NOW });
  const { livePrices } = await import('@/lib/systems/domains');
  const live = await livePrices();
  const rows = priceRows(regs, 'com', { live, now: NOW, D, domain: 'getacme.com' });
  const pb = rows.find((r) => r.registrar === 'Porkbun');
  assert.deepEqual({ ...pb }, { registrar: 'Porkbun', id: 'porkbun', firstYear: 8.99, renewal: 11.08, promo: null, url: 'https://porkbun.com/checkout/search?q=getacme.com', confirmedAt: NOW.toISOString(), source: 'live', stale: false });
  assert.equal(pickBest(rows).registrar, 'Porkbun');
  const old = priceRows(regs, 'com', { live, now: new Date(NOW.getTime() + 41 * 86400e3), D });
  assert.equal(old.find((r) => r.registrar === 'Porkbun').source, 'table');
  assert.ok(old.every((r) => r.stale), 'table rows older than tableMaxAgeDays are marked stale');

  // Ties: same first year → cheaper renewal; unknown prices never win.
  assert.equal(pickBest([{ registrar: 'A', firstYear: 10, renewal: 12 }, { registrar: 'B', firstYear: 10, renewal: 11 }, { registrar: 'C', firstYear: null, renewal: 1 }]).registrar, 'B');
  assert.equal(pickBest([{ registrar: 'C', firstYear: null }]), null);
  assert.equal(priceRows(regs, 'co', { now: NOW, D }).reduce((a, b) => (a.firstYear < b.firstYear ? a : b)).registrar, 'Dynadot');

  // Monthly job: a failed refresh keeps the table.
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.deepEqual(await runRegistrarPriceRefresh({ now: NOW }), { error: 'down', fallback: 'table' });
});

test('CheapInboxes plan and totals', () => {
  const P = DEFAULTS.INBOX_PROVIDER;
  assert.equal(tierPrice(P.tiers, 2), 3.5);
  assert.equal(tierPrice(P.tiers, 100), 3.25);
  assert.equal(tierPrice(P.tiers, 5000), 2.8);
  const plan = inboxPlan(P, { domain: 'getacme.com', mainDomain: 'acme.com', users: [{ name: 'John Smith', email: 'john@getacme.com' }, { name: 'John Smith', email: 'jsmith@getacme.com' }] });
  assert.deepEqual(Object.keys(plan), ['provider', 'url', 'perInbox', 'count', 'monthly', 'notes', 'steps']);
  assert.equal(plan.provider, 'CheapInboxes');
  assert.equal(plan.monthly, 7);
  assert.ok(plan.steps.some((s) => s === 'Add 2 users: John Smith → john@getacme.com; John Smith → jsmith@getacme.com. Skip the sequencer connection.'));
  assert.ok(plan.steps.some((s) => s.includes('forward the website getacme.com to acme.com')));
  assert.ok(plan.steps.some((s) => s.includes('2 × $3.50 = $7.00 a month')));
  assert.ok(plan.steps.every((s) => !/\{\w+\}/.test(s)), 'every slot filled');
  const noNames = inboxPlan(P, { domain: 'getacme.com', mainDomain: 'acme.com', users: [] });
  assert.ok(noNames.steps.some((s) => s.includes('sender name and prefix are not set yet')));
  assert.deepEqual(totalsOf([{ best: { firstYear: 9.08 } }], plan), { domainFirstYear: 9.08, inboxesMonthly: 7, firstMonth: 16.08 });
  assert.deepEqual(totalsOf([], plan), { domainFirstYear: null, inboxesMonthly: 7, firstMonth: null });
});

test('offers: 5–8 available names best first, every registrar priced, unknown availability only to fill up', () => {
  const ranked = rankCandidates('acme.com', D, TLDS);
  const availability = Object.fromEntries(ranked.slice(0, 3).map((c) => [c.domain, { available: true }]));
  availability[ranked[3].domain] = { available: false };
  for (const c of ranked.slice(4, 10)) availability[c.domain] = { available: null };
  const offers = buildOffers(ranked, availability, { registrars: DEFAULTS.REGISTRARS, live: {}, now: NOW, D, min: 5, max: 8 });
  assert.equal(offers.length, 5);
  assert.deepEqual(offers.map((o) => o.available), [true, true, true, null, null]);
  assert.equal(offers[0].domain, 'getacme.com');
  assert.equal(offers[0].prices.length, 5);
  assert.equal(offers[0].best.registrar, 'Spaceship');
});

// ── the shopping list end to end ─────────────────────────────────────────────

async function purchaseClient() {
  await createClient('acme', { state: 'awaiting_purchase', intakeStep: 'pricescout', name: 'Acme', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
  await kv.hset('client:acme:profile', { senderPrefix: 'john', senderName: 'John Smith', marketEstimate: 1800 });
}

test('shopping list: HUB shape, the owner alert, the purchase GET', async () => {
  await purchaseClient();
  serveApis({ rdap: { 'acmehq.com': 200 } });
  const r = await runPriceScout('acme', { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(r.sent, true);
  assert.equal(r.chosenDomain, 'getacme.com');

  const s = await shoppingView('acme');
  assert.equal(s.offers.length, 8);
  assert.ok(!s.offers.some((o) => o.domain === 'acmehq.com'), 'a taken name is never offered');
  for (const o of s.offers) {
    assert.deepEqual(Object.keys(o), ['domain', 'tld', 'available', 'score', 'why', 'prices', 'best']);
    assert.equal(o.prices.length, 5);
    for (const p of o.prices) assert.deepEqual(Object.keys(p), ['registrar', 'firstYear', 'renewal', 'promo', 'url', 'confirmedAt', 'source']);
    assert.ok(['registrar', 'firstYear', 'renewal'].every((k) => k in o.best));
  }
  const pb = s.offers[0].prices.find((p) => p.registrar === 'Porkbun');
  assert.equal(pb.source, 'live');
  assert.equal(pb.url, 'https://porkbun.com/checkout/search?q=getacme.com');
  assert.deepEqual(s.offers[0].best, { registrar: 'Spaceship', firstYear: 9.08, renewal: 10.18, url: 'https://www.spaceship.com/domain-search/?query=getacme.com&tab=domains', promo: { code: 'COM67', firstYear: 3.8, note: 'limited time, no end date shown' } });
  assert.equal(s.registrars.length, 5);
  assert.deepEqual(Object.keys(s.registrars[0]), ['name', 'why', 'url']);
  assert.equal(s.registrars[0].name, 'Spaceship');
  assert.deepEqual(s.offers[0].prices.map((p) => p.registrar), s.registrars.map((r) => r.name), 'one stable order, cheapest .com first');
  assert.deepEqual(s.registrars.map((r) => r.name), ['Spaceship', 'Cloudflare', 'Dynadot', 'Porkbun', 'Namecheap']);
  assert.deepEqual(Object.keys(s.inboxes), ['provider', 'url', 'perInbox', 'count', 'monthly', 'notes', 'steps']);
  assert.equal(s.inboxes.provider, 'CheapInboxes');
  assert.ok(s.inboxes.steps.some((x) => x.includes('John Smith → john@getacme.com; John Smith → jsmith@getacme.com')));
  assert.deepEqual(s.totals, { domainFirstYear: 9.08, inboxesMonthly: 7, firstMonth: 16.08 });
  // v1 fields stay filled from the same data.
  assert.equal(s.chosenDomain, 'getacme.com');
  assert.equal(s.backups.length, 2);
  assert.equal(s.total, 16.08);
  assert.deepEqual(s.inboxQuotes.map((q) => q.id), ['cheapinboxes']);
  assert.equal(s.registrarQuotes[0].registrar, 'spaceship');
  assert.deepEqual(s.senderAddresses, ['john@getacme.com', 'jsmith@getacme.com']);
  assert.equal('scoutRuns' in s, false);

  const alert = alerts.find((a) => a.key === 'shopping_list');
  const lines = alert.body.split('\n');
  assert.equal(lines.filter((l) => /^\d\. /.test(l)).length, 3, 'top three domains');
  assert.match(alert.body, /^1\. getacme\.com — Spaceship \$9\.08, renews \$10\.18 · https:\/\/www\.spaceship\.com/m);
  assert.match(alert.body, /Porkbun \$11\.08\/\$11\.08 \(live\)/);
  assert.match(alert.body, /Inboxes: CheapInboxes — 2 × \$3\.50 = \$7\.00 a month/);
  assert.match(alert.body, /Total: \$16\.08/);
  assert.match(alert.body, /https:\/\/app\.test\/mc\/clients\/acme\/purchase/);

  const { GET } = await import('@/app/api/mc/clients/[id]/purchase/route');
  const res = await GET(new Request('http://x/api/mc/clients/acme/purchase'), { params: { id: 'acme' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body), ['client', 'shopping', 'setup', 'inboxes', 'encKey']);
  assert.deepEqual(body.shopping.offers, JSON.parse(JSON.stringify(s.offers)));
  assert.deepEqual(body.shopping.totals, s.totals);
  assert.equal(body.shopping.inboxes.provider, 'CheapInboxes');
  assert.deepEqual(await getShopping('acme'), s);
});

test('shopping list waits politely when RDAP says 429, then goes out; Porkbun down → table prices', async () => {
  await purchaseClient();
  let limited = true;
  serveApis();
  const apis = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.porkbun.com')) throw new Error('porkbun down');
    if ((u.includes('rdap.org') || u.includes('rdap.verisign.com')) && limited && /try|use/.test(u)) return new Response('slow down', { status: 429 });
    return apis(url, init);
  };
  const first = await runPriceScout('acme', { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(first.status, 'running');
  assert.equal(first.rdapLimited, true);
  assert.equal(alerts.length, 0);
  limited = false;
  await kv.del('intake:rdapbackoff'); // the back-off expired
  const second = await runPriceScout('acme', { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(second.sent, true);
  const s = await getShopping('acme');
  assert.ok(s.offers.every((o) => o.prices.every((p) => p.source === 'table')));
  assert.equal(s.offers.length, 8);
  assert.equal(alerts.filter((a) => a.key === 'shopping_list').length, 1);
});

test('stage A v2 jobs: research every minute while running; registrar prices monthly', async () => {
  const job = (n) => STAGE_A_JOBS.find((j) => j.name === n);
  const at = new Date('2026-10-05T14:03:00Z');
  assert.equal(await job('research').due({ client: { id: 'a', state: 'applied', researchStep: 'running' }, now: at }), '2026-10-05T10:03');
  assert.equal(await job('research').due({ client: { id: 'a', state: 'onboarding', researchStep: '' }, now: at }), null);
  assert.equal(await job('registrar-prices').due({ now: new Date('2026-11-01T14:30:00Z') }), '2026-11');
  assert.equal(await job('registrar-prices').due({ now: at }), null);
});
