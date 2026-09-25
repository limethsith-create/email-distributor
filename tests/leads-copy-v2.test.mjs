// Leads + Copy v2 — Lead Finder v2 (script helpers on HTML fixtures), the
// verification waterfall, the Lead Grader + leadQualityView, the Sanity Check
// on grader reasons, Copy Engine v2 + the new Copy Checker rules, and the
// Sender's week-one rule. Fake KV, stubbed fetch / DNS / SMTP. No network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient } from '@/lib/db/client';
import { saveInbox } from '@/lib/db/inboxes';
import { insertLeads, getLead, getLeads, saveLead } from '@/lib/db/leads';
import { initCounters } from '@/lib/db/counters';
import { setOverride } from '@/lib/config';
import { setDeps, resetDeps } from '@/lib/systems/stagec-common';
import { partsIn } from '@/lib/time';
import * as R from '@/lib/leadquality/rules.mjs';
import { gradeLead, buildContext, isSendable, riskyAllowed, leadQualityView, REJECT_LABELS } from '@/lib/systems/grader';
import { verifyAddress, runVerify, reserve, budgetLeftToday, configuredServices } from '@/lib/systems/verify';
import { handleWebhook, listReady, hostsTaken } from '@/lib/systems/leadfinder';
import { sanityCheck } from '@/lib/systems/sanity';
import { NICHE_TEMPLATES, frameworkTemplate, buildVariant, clientVars, renderVariant, firstLineFor, cleanCompany, nicheOf, chooseFramework, buildSequence, getStoredSequence, buildBackupVariants, subjectBank } from '@/lib/systems/copy';
import { checkEmail, wordCount, selfYouCounts } from '@/lib/systems/copycheck';
import { runSender } from '@/lib/systems/sender';
import { mapHunter } from '@/lib/ext/hunter';
import { mapZeroBounce } from '@/lib/ext/zerobounce';
import { mapQuickEmail } from '@/lib/ext/quickemail';
import { mapVerifalia } from '@/lib/ext/verifalia';
import { mapMailboxValidator } from '@/lib/ext/mailboxvalidator';
import { mapReoon } from '@/lib/ext/reoon';
import * as LF from '../scripts/leadfinder/lib.mjs';
import { filterCandidates, buildLeads } from '../scripts/leadfinder/index.mjs';
import { localCheck, clearMxCache } from '../scripts/leadfinder/verify.mjs';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
const KEY_VARS = ['REOON_API_KEY', 'QUICKEMAILVERIFICATION_API_KEY', 'VERIFALIA_USERNAME', 'VERIFALIA_PASSWORD', 'MAILBOXVALIDATOR_API_KEY', 'ZEROBOUNCE_API_KEY', 'HUNTER_API_KEY', 'TOMBA_API_KEY', 'TOMBA_API_SECRET', 'PROOFY_API_KEY', 'ANYMAILFINDER_API_KEY'];
const clearKeys = () => { for (const k of KEY_VARS) delete process.env[k]; };

const NOW = new Date('2026-10-06T15:00:00Z'); // Tue 11:00 ET
const PROFILE = {
  senderName: 'Sam Carter', companyName: 'Acme IT', postalAddress: '100 Main St, Dallas, TX 75201',
  oneLiner: 'We look after computers, email and backups for small offices in Dallas.', defaultNiche: 'managed IT', defaultIcp: 'dental practices',
  industry: 'dentist, dental practice', titles: 'owner, president, office manager', excludedTitles: 'intern', cities: 'Dallas, TX', states: 'TX',
  sizeMin: '5', sizeMax: '50', calendarUrl: 'https://cal.com/sam',
};
const alerts = async () => (await kv.lrange('system:alerts:log', 0, -1)).map((a) => a.key);
const MX_OK = { verifyEmail: async () => ({ valid: true, reason: 'mx_verified' }) };

async function client(id = 'acme', { state = 'warming', profile = PROFILE, trial = {} } = {}) {
  await createClient(id, { state, name: 'Acme IT', contactName: 'Pat', contactEmail: `pat@${id}.com` });
  await kv.hset(K.profile(id), profile);
  if (Object.keys(trial).length) await kv.hset(K.trial(id), trial);
}

/** A stubbed internet: verifier APIs answer from `answers[service](email)`. */
function stubVerifiers(answers = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const email = decodeURIComponent((/[?&]email=([^&]+)/.exec(u) || [])[1] || (init.body ? JSON.parse(init.body).entries?.[0]?.inputData || JSON.parse(init.body).email : '') || '');
    const svc = u.includes('reoon') ? 'reoon' : u.includes('quickemailverification') ? 'quickemail' : u.includes('hunter.io') ? 'hunter' : u.includes('zerobounce') ? 'zerobounce' : u.includes('verifalia') ? 'verifalia' : u.includes('mailboxvalidator') ? 'mailboxvalidator' : u.includes('anymailfinder') ? 'anymailfinder' : u.includes('proofy') ? 'proofy' : u.includes('tomba') ? 'tomba' : null;
    if (!svc) throw new Error(`unexpected network call: ${u}`);
    calls.push({ svc, email });
    const a = (answers[svc] || (() => ({ status: 200, body: {} })))(email);
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  };
  return calls;
}

beforeEach(() => { __reset(); resetDeps(); setDeps(MX_OK); clearKeys(); clearMxCache(); });

// ── rules + extraction (pure, HTML fixtures) ────────────────────────────────

const TEAM_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<meta name="description" content="Family plumbing in Dallas since 1987.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Bolt Plumbing","foundingDate":"1987","aggregateRating":{"ratingValue":4.9,"reviewCount":88}}</script>
</head><body>
<nav><a href="/about-us">About us</a> <a href="/services/drain-cleaning">Drain Cleaning</a> <a href="/services/water-heaters">Water Heaters</a> <a href="/blog/tips">Blog</a> <a href="/contact">Contact</a></nav>
<h1>Our Team</h1>
<div class="card"><h3>Linda Park</h3><p>Office Manager</p></div>
<div class="card"><h3>Tom Price</h3><span>General Manager</span></div>
<div class="card"><h3>Water Heaters</h3><p>Repair</p></div>
<p>I'm Greg Bolt, the owner and a master plumber.</p>
<p>Email <a href="mailto:linda.park@boltplumbing.com">Linda</a>, or <a href="mailto:info@boltplumbing.com">info@boltplumbing.com</a>, or dispatch@boltplumbing.com.</p>
<a href="https://www.linkedin.com/in/greg-bolt-3a9f1">LinkedIn</a>
<p>We're hiring! Join our team of 12 technicians.</p>
<p>123 Commerce St, Dallas, TX 75201 · (214) 555-0100 · © 2025 Bolt Plumbing</p>
</body></html>`;

test('role accounts are never kept: rules, contact choice, finder, grader', () => {
  for (const e of ['info@x.com', 'sales2@x.com', 'info.dallas@x.com', 'dallasoffice@x.com', 'no-reply@x.com', 'office@x.com', 'dispatch@x.com', 'owner@x.com']) assert.equal(R.isRoleAddress(e), true, e);
  for (const e of ['jane@x.com', 'jsmith@x.com', 'carey@x.com', 'stafford@x.com', 'ismail@x.com', 'jane.smith@x.com']) assert.equal(R.isRoleAddress(e), false, e);
  const found = { mailtos: [{ email: 'info@x.com' }, { email: 'sales@x.com' }], emails: ['office@x.com'], ld: { people: [], orgs: [] }, people: [] };
  assert.deepEqual(LF.pickContacts(found, 'x.com'), []);
  const g = gradeLead({ email: 'info@x.com', first_name: 'Ann', company: 'X', state: 'TX', city: 'Dallas' }, buildContext(PROFILE));
  assert.equal(g.grade, 'rejected');
  assert.equal(g.rejectReason, 'role');
  assert.match(g.reasons[0], /Role address/);
});

test('decision-maker discovery: team cards, "I\'m X, the owner", JSON-LD, LinkedIn hints; best title wins', () => {
  const cards = LF.extractTeamCards(TEAM_PAGE);
  assert.deepEqual(cards.map((c) => [c.name, c.title]), [['Linda Park', 'office manager'], ['Tom Price', 'general manager']]);
  const people = LF.extractPeople(TEAM_PAGE);
  assert.ok(people.some((p) => p.name === 'Greg Bolt' && p.title === 'owner'));
  const facts = LF.extractFacts(TEAM_PAGE);
  assert.equal(facts.copyrightYear, 2025);
  assert.equal(facts.hiring, true);
  assert.equal(facts.viewport, true);
  assert.equal(facts.hasAddress, true);
  assert.deepEqual(facts.linkedinHints, ['Greg Bolt']);
  const ld = LF.extractJsonLd(TEAM_PAGE);
  assert.equal(ld.orgs[0].foundingDate, '1987');
  assert.equal(ld.orgs[0].rating, 4.9);
  const links = LF.extractLinks(TEAM_PAGE, 'boltplumbing.com');
  assert.deepEqual(LF.extractServices(links).map((s) => s.label), ['drain cleaning', 'water heaters']);
  assert.equal(LF.pagesToCrawl(links, 3)[0], '/about-us');
  const found = { mailtos: LF.extractMailtos(TEAM_PAGE), emails: LF.extractPlainEmails(TEAM_PAGE), ld, people, cards, linkedinHints: facts.linkedinHints };
  const [best] = LF.pickContacts(found, 'boltplumbing.com', []);
  // Owner beats general manager and office manager; his address follows the company's pattern.
  assert.equal(best.name, 'Greg Bolt');
  assert.equal(best.tier, 100);
  assert.equal(best.linkedinHint, true);
  assert.equal(best.pattern, 'first.last'); // from linda.park@
  assert.equal(best.email, 'greg.bolt@boltplumbing.com');
  // The client's own title list outranks the tier.
  const [om] = LF.pickContacts(found, 'boltplumbing.com', ['office manager']);
  assert.deepEqual([om.name, om.email, om.emailSource], ['Linda Park', 'linda.park@boltplumbing.com', 'mailto']);
  // More contacts per company only when asked.
  assert.equal(LF.pickContacts(found, 'boltplumbing.com', [], { max: 2 }).length, 2);
});

test('email pattern inference from a known address on the same domain', () => {
  assert.deepEqual(R.inferPattern([{ email: 'dana.reyes@x.com', name: 'Dana Reyes' }], 'x.com'), { pattern: 'first.last', from: 'dana.reyes@x.com' });
  assert.deepEqual(R.inferPattern([{ email: 'dreyes@x.com', name: 'Dana Reyes' }], 'x.com'), { pattern: 'flast', from: 'dreyes@x.com' });
  assert.equal(R.inferPattern([{ email: 'mike@x.com' }], 'x.com').pattern, 'first'); // a known first name alone
  assert.equal(R.inferPattern([{ email: 'info@x.com' }, { email: 'bob@other.com', name: 'Bob Ray' }], 'x.com'), null); // role + other host ignored
  assert.deepEqual(R.candidateEmails('joe', 'bloggs', 'j.com', { pattern: 'first.last', max: 2 }), ['joe.bloggs@j.com', 'joe@j.com']);
  assert.deepEqual(R.candidateEmails('joe', 'bloggs', 'j.com', { max: 3 }), ['joe@j.com', 'jbloggs@j.com', 'joe.bloggs@j.com']);
  assert.equal(R.nameFromEmail('john.smith@x.com'), 'John Smith');
  assert.equal(R.nameFromEmail('sales.team@x.com'), null);
});

test('finder filters: franchise names and disclaimers, location pages, one host on 3+ listings, non-US, outside the area, closed', () => {
  const cands = [
    { company: 'Mr. Rooter Plumbing of Dallas', website: 'https://mrrooterdallas.com', state: 'TX' },
    { company: 'Lone Plumbing', website: 'https://brandx.com/locations/dallas', city: 'Dallas', state: 'TX' },
    ...[1, 2, 3].map((i) => ({ company: `Chain Co ${i}`, website: 'https://chainco.com', state: 'TX', placeId: `c${i}` })),
    { company: 'Maple Leaf', website: 'https://maple.ca', state: 'TX' },
    { company: 'Far Away', website: 'https://far.com', state: 'CA' },
    { company: 'Gone Co', website: 'https://gone.com', state: 'TX', businessStatus: 'CLOSED_PERMANENTLY' },
    { company: 'Good Plumbing', website: 'https://good.com', state: 'TX' },
  ];
  const { kept, dropped } = filterCandidates(cands, { area: LF.areaStates(PROFILE) });
  assert.deepEqual(kept.map((k) => k.host), ['good.com']);
  assert.deepEqual(dropped, { chain: 3, duplicate_host: 2, out_of_area: 2, closed: 1 });
  assert.ok(R.FRANCHISE_TEXT_RE.test('Each franchise is independently owned and operated.'));
  assert.ok(LF.areaStates(PROFILE, { widen: true }).has('OK'));
});

test('finder pipeline: role-only site rejected as "role", no-person site as "no_name", facts + signals posted, pending', async () => {
  const site = (pages) => async (url) => (pages[url] == null
    ? { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' }
    : { ok: true, status: 200, url, headers: { get: () => 'text/html' }, text: async () => pages[url] });
  const mx = async () => [{ exchange: 'mx.test', priority: 1 }];
  const crawl = { delayMs: 0 };
  const role = await buildLeads({ company: 'R', website: 'https://r.com', host: 'r.com', state: 'TX' }, { fetchImpl: site({ 'https://r.com/': '<a href="mailto:info@r.com">x</a>' }), resolveMx: mx, crawl });
  assert.deepEqual([role.leads.length, role.reject], [0, 'role']);
  const none = await buildLeads({ company: 'N', website: 'https://n.com', host: 'n.com', state: 'TX' }, { fetchImpl: site({ 'https://n.com/': '<p>Welcome</p>' }), resolveMx: mx, crawl });
  assert.equal(none.reject, 'no_name');
  const fr = await buildLeads({ company: 'F', website: 'https://f.com', host: 'f.com', state: 'TX' }, { fetchImpl: site({ 'https://f.com/': '<p>Jane Smith, Owner</p><p>Each location is independently owned and operated.</p>' }), resolveMx: mx, crawl });
  assert.equal(fr.reject, 'chain');
  const ok = await buildLeads({ company: 'Bolt Plumbing', website: 'https://boltplumbing.com', host: 'boltplumbing.com', city: 'Dallas', state: 'TX', types: ['plumber'], rating: 4.8, reviews: 120, source: 'places' }, { fetchImpl: site({ 'https://boltplumbing.com/': TEAM_PAGE }), resolveMx: mx, crawl });
  const [lead] = ok.leads;
  assert.equal(lead.email, 'greg.bolt@boltplumbing.com');
  assert.equal(lead.verifyStatus, 'pending');
  assert.equal(lead.isRole, false);
  assert.deepEqual(lead.facts.services.slice(0, 2), ['drain cleaning', 'water heaters']);
  assert.equal(lead.facts.since, 1987);
  assert.deepEqual([lead.facts.rating, lead.facts.reviews, lead.facts.ratingSource], [4.8, 120, 'google']);
  assert.equal(lead.signals.hiring, true);
  assert.equal(lead.signals.https, true);
  // Local checks: bad syntax and throwaway domains never reach the app.
  assert.equal((await localCheck('x@@y.com')).status, 'invalid');
  assert.equal((await localCheck('a@mailinator.com')).reason, 'disposable');
});

test('finder run end to end (stubbed app, Places, sites): Places fields, filters, one contact per company, rejects posted, all pending', async () => {
  const { run } = await import('../scripts/leadfinder/index.mjs');
  const posts = [];
  const place = (id, name, site, addr = '1 Main St, Dallas, TX 75201, USA', extra = {}) => ({ id, displayName: { text: name }, formattedAddress: addr, websiteUri: site, types: ['plumber'], rating: 4.7, userRatingCount: 64, businessStatus: 'OPERATIONAL', ...extra });
  const pages = {
    'https://boltplumbing.com/': TEAM_PAGE,
    'https://roleonly.com/': '<a href="mailto:info@roleonly.com">info</a>',
    'https://jane.com/': '<p>Jane Smith, Owner</p><p>Tom Lee, Office Manager</p>',
  };
  let placesMask = '';
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://app.test/api/clients/acme/profile') {
      return new Response(JSON.stringify({ niche: 'trades', need: 10, profile: { industry: ['plumber'], cities: ['Dallas, TX'], states: ['TX'], titles: [] }, blocklist: { hosts: [], names: [] }, budget: { placesUsed: 0, placesLimit: 1000, placesStopRatio: 0.8 } }), { status: 200 });
    }
    if (u === 'https://app.test/api/webhooks/leadfinder') { const b = JSON.parse(init.body); posts.push(b); return new Response(JSON.stringify(b.type === 'hosts' ? { taken: [] } : { ok: true }), { status: 200 }); }
    if (u.includes('places.googleapis.com')) {
      placesMask = init.headers['X-Goog-FieldMask'];
      return new Response(JSON.stringify({ places: [
        place('p1', 'Bolt Plumbing', 'https://boltplumbing.com/'), place('p2', 'Role Only Plumbing', 'https://roleonly.com'),
        place('p3', 'Jane Plumbing', 'https://jane.com'), place('p4', 'Roto-Rooter Plumbing', 'https://rotorooter.com'),
        place('p5', 'Closed Plumbing', 'https://closed.com', undefined, { businessStatus: 'CLOSED_PERMANENTLY' }),
      ] }), { status: 200 });
    }
    if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
    if (pages[u] != null) return new Response(pages[u], { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404, headers: { 'content-type': 'text/html' } });
  };
  const env = { APP_URL: 'https://app.test', LEADFINDER_TOKEN: 't', PLACES_API_KEY: 'k', CLIENT_PAYLOAD: JSON.stringify({ clientId: 'acme', need: 10, mode: 'initial' }), GITHUB_RUN_ID: '42' };
  const r = await run({ env, fetchImpl, resolveMx: async () => [{ exchange: 'mx.test', priority: 1 }], log: () => {}, crawl: { delayMs: 0 } });
  assert.equal(r.found, 2);
  assert.match(placesMask, /places\.rating,places\.userRatingCount/);
  const batch = posts.find((p) => p.type === 'batch');
  assert.deepEqual(batch.leads.map((l) => l.email).sort(), ['greg.bolt@boltplumbing.com', 'jane@jane.com']);
  assert.ok(batch.leads.every((l) => l.verifyStatus === 'pending' && !l.isRole && l.query === 'plumber in Dallas, TX'));
  const jane = batch.leads.find((l) => l.host === 'jane.com');
  assert.equal(jane.name, 'Jane Smith'); // one contact per company: the owner, not the office manager
  assert.deepEqual(jane.emailCandidates, ['jsmith@jane.com', 'jane.smith@jane.com']);
  const done = posts.find((p) => p.type === 'done');
  const rejects = { ...batch.rejects, ...done.rejects };
  assert.equal(rejects.role, 1);
  assert.equal(rejects.chain, 1);
  assert.equal(rejects.closed, 1);
});

test('search plan: other phrasings after the grid; a saturated query (60 = the cap) is searched cell by cell', async () => {
  const plan = LF.queryPlan({ industry: 'dentist', cities: ['Dallas, TX'] });
  assert.deepEqual(plan.map((p) => p.q), ['dentist in Dallas, TX', 'dental clinic in Dallas, TX', 'family dentistry in Dallas, TX']);
  assert.deepEqual([plan[0].kw, plan[0].city, plan[0].state, plan[1].variant], ['dentist', 'Dallas', 'TX', true]);
  assert.deepEqual(LF.keywordVariants('bakery'), []);
  const { run } = await import('../scripts/leadfinder/index.mjs');
  const { gridCells } = await import('../scripts/leadfinder/sources.mjs');
  assert.equal(gridCells({ low: { latitude: 0, longitude: 0 }, high: { latitude: 3, longitude: 3 } }, 3).length, 9);
  const bodies = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/profile')) return new Response(JSON.stringify({ need: 400, overshoot: 1, profile: { industry: ['dentist'], cities: ['Dallas, TX'], states: ['TX'] }, blocklist: {}, budget: { placesUsed: 0, placesLimit: 1000, placesStopRatio: 0.8 } }), { status: 200 });
    if (u.endsWith('/webhooks/leadfinder')) return new Response(JSON.stringify({ taken: [] }), { status: 200 });
    if (u.includes('places.googleapis.com')) {
      const b = JSON.parse(init.body);
      bodies.push({ ...b, mask: init.headers['X-Goog-FieldMask'] });
      if (b.includedType === 'locality') return new Response(JSON.stringify({ places: [{ id: 'dal', viewport: { low: { latitude: 32.6, longitude: -97 }, high: { latitude: 33, longitude: -96.5 } } }] }), { status: 200 });
      const places = Array.from({ length: 20 }, () => ({ id: `p${++n}`, displayName: { text: `Dentist ${n}` }, formattedAddress: '1 Main St, Dallas, TX 75201, USA' }));
      return new Response(JSON.stringify({ places, nextPageToken: b.pageToken === 't2' ? undefined : (b.pageToken ? 't2' : 't1') }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const env = { APP_URL: 'https://app.test', LEADFINDER_TOKEN: 't', PLACES_API_KEY: 'k', CLIENT_PAYLOAD: JSON.stringify({ clientId: 'acme', need: 400 }), GITHUB_RUN_ID: '7' };
  await run({ env, fetchImpl, resolveMx: async () => [], log: () => {}, crawl: { delayMs: 0 } });
  const grid = bodies.filter((b) => b.locationRestriction);
  assert.equal(bodies.filter((b) => b.includedType === 'locality').length, 1); // one viewport lookup per city (Pro field mask)
  assert.equal(bodies.find((b) => b.includedType === 'locality').mask, 'places.id,places.viewport');
  assert.ok(grid.length >= 9);
  assert.equal(grid[0].textQuery, 'dentist');
  assert.ok(grid[0].locationRestriction.rectangle.low.latitude >= 32.6);
});

// ── verification waterfall ───────────────────────────────────────────────────

test('waterfall: no key → MX only → risky (not sendable)', async () => {
  const calls = stubVerifiers();
  const r = await verifyAddress('ann@acme.com', { now: NOW });
  assert.deepEqual([r.status, r.by], ['risky', 'mx']);
  assert.equal(calls.length, 0);
  setDeps({ verifyEmail: async () => ({ valid: false, reason: 'no_mx' }) });
  assert.deepEqual([(await verifyAddress('ann@dead.com', { now: NOW })).status], ['invalid']);
  assert.equal((await verifyAddress('bad@@x', { now: NOW })).status, 'invalid');
});

test('waterfall: order, skip-without-key, per-service daily budgets, unknown → next, quota → next, all spent → pending', async () => {
  process.env.QUICKEMAILVERIFICATION_API_KEY = 'q';
  process.env.REOON_API_KEY = 'r';
  process.env.HUNTER_API_KEY = 'h';
  await setOverride(null, 'VERIFY.services', { quickemail: { daily: 1 }, reoon: { daily: 1 }, hunter: { monthly: 1 } });
  assert.deepEqual(await configuredServices(), ['quickemail', 'reoon', 'hunter']); // verifalia, mailboxvalidator … have no key
  const calls = stubVerifiers({
    quickemail: () => ({ body: { success: 'true', result: 'unknown', reason: 'timeout' } }),
    reoon: (e) => ({ body: { status: e.startsWith('ann') ? 'safe' : 'invalid' } }),
    hunter: () => ({ body: { data: { status: 'valid' } } }),
  });
  const a = await verifyAddress('ann@acme.com', { now: NOW });
  assert.deepEqual([a.status, a.by], ['valid', 'reoon']); // quickemail said unknown → reoon answered
  assert.deepEqual(calls.map((c) => c.svc), ['quickemail', 'reoon']);
  const b = await verifyAddress('bob@acme.com', { now: NOW });
  assert.deepEqual([b.status, b.by], ['valid', 'hunter']); // daily budgets of the first two spent → hunter
  const c = await verifyAddress('cy@acme.com', { now: NOW });
  assert.equal(c.status, 'pending'); // every budget spent: waits for tomorrow, never guessed
  const left = await budgetLeftToday({ now: NOW });
  assert.deepEqual(left.by, { quickemail: 0, reoon: 0, hunter: 0 });
  // A service that answers "out of credits" is marked spent for the day.
  __reset(); setDeps(MX_OK);
  await setOverride(null, 'VERIFY.services', { quickemail: { daily: 100 }, reoon: { daily: 20 } });
  delete process.env.HUNTER_API_KEY;
  const calls2 = stubVerifiers({ quickemail: () => ({ body: { success: 'false', message: 'Low credit' } }), reoon: () => ({ body: { status: 'safe' } }) });
  assert.equal((await verifyAddress('dee@acme.com', { now: NOW })).by, 'reoon');
  assert.equal((await verifyAddress('eve@acme.com', { now: NOW })).by, 'reoon');
  assert.deepEqual(calls2.map((x) => x.svc), ['quickemail', 'reoon', 'reoon']);
  assert.equal(await reserve('quickemail', NOW), false);
});

test('catch-all: remembered per domain (no second credit), rejected in week one, allowed later only by SEND.allowRiskyAfterDay, resolvable', async () => {
  process.env.REOON_API_KEY = 'r';
  const calls = stubVerifiers({ reoon: () => ({ body: { status: 'catch_all' } }), anymailfinder: () => ({ body: { email_status: 'valid' } }) });
  const a = await verifyAddress('ann@wide.com', { now: NOW });
  assert.deepEqual([a.status, a.by], ['catchall', 'reoon']);
  const b = await verifyAddress('bob@wide.com', { now: NOW });
  assert.equal(b.status, 'catchall');
  assert.match(b.by, /^cache:reoon/);
  assert.equal(calls.length, 1);
  const lead = { email: 'ann@wide.com', first_name: 'Ann', name: 'Ann Lee', title: 'Owner', company: 'Wide Dental', city: 'Dallas', state: 'TX', types: ['dentist'], verifyStatus: 'catchall' };
  assert.equal(gradeLead(lead, buildContext(PROFILE, { sendingDay: 3 })).rejectReason, 'catchall');
  assert.equal(gradeLead(lead, buildContext(PROFILE, { sendingDay: 9 })).rejectReason, 'catchall'); // default: never
  const later = buildContext(PROFILE, { sendingDay: 9, allowRiskyAfterDay: 8 });
  assert.equal(riskyAllowed(later), true);
  assert.notEqual(gradeLead(lead, later).grade, 'rejected');
  assert.equal(riskyAllowed(buildContext(PROFILE, { sendingDay: 5, allowRiskyAfterDay: 2 })), false); // never in week one
  // The one-time catch-all resolver turns a catch-all into a real answer.
  process.env.ANYMAILFINDER_API_KEY = 'a';
  const c = await verifyAddress('cy@wide.com', { now: NOW });
  assert.deepEqual([c.status, c.by], ['valid', 'anymailfinder']);
});

test('verifier adapters map each API to valid / invalid / catchall / risky / unknown', () => {
  assert.equal(mapHunter({ status: 'accept_all' }).status, 'catchall');
  assert.equal(mapHunter({ status: 'disposable' }).status, 'invalid');
  assert.equal(mapHunter({ status: 'webmail' }).status, 'risky');
  assert.equal(mapZeroBounce({ status: 'catch-all' }).status, 'catchall');
  assert.equal(mapZeroBounce({ error: 'Invalid API key or your account ran out of credits' }).error, 'quota');
  assert.equal(mapQuickEmail({ success: 'true', result: 'valid', accept_all: 'true' }).status, 'catchall');
  assert.equal(mapQuickEmail({ success: 'true', result: 'valid', accept_all: 'false', safe_to_send: 'true' }).status, 'valid');
  assert.equal(mapVerifalia({ classification: 'Risky', status: 'ServerIsCatchAll' }).status, 'catchall');
  assert.equal(mapVerifalia({ classification: 'Undeliverable', status: 'MailboxDoesNotExist' }).status, 'invalid');
  assert.equal(mapMailboxValidator({ status: true, is_catchall: false }).status, 'valid');
  assert.equal(mapMailboxValidator({ status: false, is_smtp: false }).status, 'invalid');
  assert.equal(mapReoon({ status: 'inbox_full' }).status, 'risky');
  assert.equal(mapReoon({ status: 'spamtrap' }).status, 'invalid');
});

// ── webhook → queue → verify job → grade → sendable ──────────────────────────

const finderLead = (i, extra = {}) => ({
  email: `owner${i}@dental${i}.com`, first_name: `Ann${i}`, name: `Ann${i} Lee`, title: 'Owner', company: `Smile ${i} Dental`, website: `https://dental${i}.com`,
  city: 'Dallas', state: 'TX', types: ['dentist'], employees: 12, source: 'leadfinder:places', verifyStatus: 'pending',
  facts: { rating: 4.8, reviews: 90, since: 2001, services: ['teeth whitening'] }, signals: { https: true, copyrightYear: 2026, hasAddress: true, viewport: true }, ...extra,
});

test('webhook grades on insert (rejects counted, never stored), queues the best for verification, verify job lands grades', async () => {
  await client('acme');
  await setOverride(null, 'LIST.maxFail', 20); // this batch is bad on purpose; the Sanity Check is tested on its own below
  process.env.REOON_API_KEY = 'r';
  stubVerifiers({ reoon: (e) => ({ body: { status: e.startsWith('owner2@') ? 'invalid' : e === 'ann3@dental3.com' ? 'safe' : 'safe' } }) });
  const leads = [
    finderLead(1),
    finderLead(2, { emailGuessed: true, emailCandidates: ['ann2@dental2.com'] }), // first guess invalid → next candidate
    finderLead(3, { email: 'info@dental3.com' }), // role
    finderLead(4, { state: 'CA', city: 'San Diego' }), // out of area
    finderLead(5, { company: 'Aspen Dental', website: 'https://aspendental5.com' }), // chain
    finderLead(6, { first_name: '', name: '' }), // no name
    finderLead(7, { email: 'office.manager@dental1.com', website: 'https://dental1.com', name: 'Bo Diaz', first_name: 'Bo' }), // role anyway
    finderLead(8, { email: 'bo@dental1.com', website: 'https://dental1.com', name: 'Bo Diaz', first_name: 'Bo', title: 'Office Manager' }), // duplicate company
  ];
  const r = await handleWebhook({ type: 'batch', clientId: 'acme', runId: 'v2', batchNo: 1, leads, rejects: { role: 4, no_name: 2 } });
  assert.equal(r.json.added, 2);
  assert.equal(r.json.skipped['rejected:role'], 2);
  assert.equal(r.json.skipped['rejected:out_of_area'], 1);
  assert.equal(r.json.skipped['rejected:chain'], 1);
  assert.equal(r.json.skipped['rejected:no_name'], 1);
  assert.equal(r.json.skipped['rejected:duplicate_company'], 1);
  const stored = await getLead('acme', 'owner1@dental1.com');
  assert.equal(stored.verifyStatus, 'pending');
  assert.equal(isSendable(stored, buildContext(PROFILE)), false); // pending is never sendable
  assert.ok(['A', 'B'].includes(stored.grade));
  assert.ok(stored.reasons.includes('Email not verified yet'));
  assert.equal((await kv.hgetall(K.client('acme'))).verifyPending, '1');
  assert.equal((await listReady('acme')).unsent, 0); // nothing verified yet
  // The verify job: valid → sendable A; an invalid guess re-keys to the next candidate.
  const run1 = await runVerify('acme', { now: NOW, client: { id: 'acme', state: 'warming' } });
  assert.equal(run1.checked, 2);
  assert.equal(run1.rekeyed, 1);
  const a = await getLead('acme', 'owner1@dental1.com');
  assert.deepEqual([a.verifyStatus, a.verifiedBy, a.riskLevel, a.grade], ['valid', 'reoon', 'safe', 'A']);
  assert.ok(a.reasons.some((x) => /Verified email by reoon/.test(x)));
  assert.equal(await getLead('acme', 'owner2@dental2.com'), null);
  const moved = await getLead('acme', 'ann2@dental2.com');
  assert.equal(moved.verifyStatus, 'pending');
  const run2 = await runVerify('acme', { now: NOW, client: { id: 'acme', state: 'warming' } });
  assert.equal(run2.checked, 1);
  assert.equal((await getLead('acme', 'ann2@dental2.com')).verifyStatus, 'valid');
  const run3 = await runVerify('acme', { now: NOW, client: { id: 'acme', state: 'warming' } });
  assert.equal(run3._clientFields.verifyPending, '0');
  assert.equal((await listReady('acme')).unsent, 2);
});

test('verify job without any key: MX-level risky, owner told once', async () => {
  await client('acme');
  await handleWebhook({ type: 'batch', clientId: 'acme', runId: 'v3', batchNo: 1, leads: [finderLead(1)] });
  const calls = stubVerifiers();
  const r = await runVerify('acme', { now: NOW, client: { id: 'acme', state: 'warming' } });
  assert.equal(r.byStatus.risky, 1);
  assert.equal(calls.length, 0);
  const l = await getLead('acme', 'owner1@dental1.com');
  assert.deepEqual([l.verifyStatus, l.verifiedBy], ['risky', 'mx']);
  assert.equal(isSendable(l, buildContext(PROFILE, { sendingDay: 3 })), false);
  assert.ok((await alerts()).includes('verify_no_keys'));
});

test('daily verify housekeeping: MX-only leads and guessed referrals are re-queued once a key exists; deepVerify uses the waterfall', async () => {
  await client('acme');
  await handleWebhook({ type: 'batch', clientId: 'acme', runId: 'd1', batchNo: 1, leads: [finderLead(1)] });
  stubVerifiers();
  await runVerify('acme', { now: NOW, client: { id: 'acme', state: 'warming' } }); // no key → risky by mx
  await saveLead('acme', { email: 'dana.reyes@dental1.com', first_name: 'Dana', name: 'Dana Reyes', company: 'Smile 1 Dental', city: 'Dallas', state: 'TX', status: 'unsent', source: 'referral', referrerName: 'Ann', riskLevel: 'risky' });
  const { runVerifyDaily } = await import('@/lib/systems/verify');
  assert.equal((await runVerifyDaily('acme', { now: NOW })).queued, 0); // still no key: nothing to gain
  process.env.REOON_API_KEY = 'r';
  stubVerifiers({ reoon: () => ({ body: { status: 'safe' } }) });
  assert.equal((await runVerifyDaily('acme', { now: NOW })).queued, 2);
  await runVerify('acme', { now: NOW, client: { id: 'acme', state: 'warming' } });
  assert.equal((await getLead('acme', 'owner1@dental1.com')).verifyStatus, 'valid');
  const ref = await getLead('acme', 'dana.reyes@dental1.com');
  assert.deepEqual([ref.verifyStatus, ref.grade], ['valid', 'A']);
  assert.ok(ref.reasons.includes('Referred by Ann'));
  const { deepVerify } = await import('@/lib/systems/leadfinder');
  assert.equal((await deepVerify('zed@dental1.com', { now: NOW })).valid, true);
});

// ── grader ───────────────────────────────────────────────────────────────────

test('grader: every hard reject has its plain-language reason', () => {
  const ctx = buildContext(PROFILE, { chains: new Set(['bigchain.com']) });
  const base = finderLead(1, { verifyStatus: 'valid' });
  const cases = [
    [{ email: 'info@dental1.com' }, 'role'],
    [{ verifyStatus: 'invalid' }, 'invalid_email'],
    [{ email: 'x@mailinator.com' }, 'disposable'],
    [{ company: 'Heartland Dental Care' }, 'chain'],
    [{ website: 'https://bigchain.com' }, 'chain'],
    [{ signals: { franchise: true } }, 'chain'],
    [{ state: 'NV' }, 'out_of_area'],
    [{ state: '' }, 'out_of_area'],
    [{ employees: 400 }, 'size'],
    [{ types: ['hospital'] }, 'size'],
    [{ title: 'Intern' }, 'excluded_title'],
    [{ first_name: '', name: '' }, 'no_name'],
    [{ verifyStatus: 'catchall' }, 'catchall'],
  ];
  for (const [patch, reason] of cases) {
    const g = gradeLead({ ...base, ...patch }, ctx);
    assert.deepEqual([g.grade, g.rejectReason], ['rejected', reason], JSON.stringify(patch));
    assert.ok(g.reasons[0].startsWith(REJECT_LABELS[reason]), g.reasons[0]);
  }
  assert.equal(gradeLead(base, ctx, { duplicateCompany: true }).rejectReason, 'duplicate_company');
});

test('grader: scores, reasons and grades A / B / C', () => {
  const ctx = buildContext(PROFILE, { now: NOW, niche: 'msp' });
  const best = gradeLead(finderLead(1, { verifyStatus: 'valid', verifiedBy: 'reoon' }), ctx);
  assert.equal(best.grade, 'A');
  assert.ok(best.score >= 90, String(best.score));
  for (const r of ['Matches your industry (dentist)', 'In Dallas, TX (your city)', 'Size fits (12 staff)', 'Owner-level title (owner)', 'Title is on your list', 'Named person (Ann1 Lee)', 'Verified email by reoon', 'Website uses HTTPS', 'Website updated 2026', '4.8★ from 90 Google reviews', 'Handles regulated client data (health, legal or financial records)']) {
    assert.ok(best.reasons.includes(r), `${r} in ${JSON.stringify(best.reasons)}`);
  }
  assert.ok(best.problems.length >= 1);
  const pending = gradeLead(finderLead(1), ctx);
  assert.equal(pending.score, best.score - 20);
  // Unknown industry, no title, first name only, unverified, bare website → C.
  const weak = gradeLead({ email: 'kim@shop.com', first_name: 'Kim', company: 'Kim Shop', state: 'TX', verifyStatus: 'risky' }, ctx);
  assert.equal(weak.grade, 'C');
  assert.ok(weak.reasons.includes('First name only (Kim)'));
  assert.ok(weak.reasons.includes('No title found'));
  // Thresholds come from GRADE.A / GRADE.B.
  const strict = buildContext(PROFILE, { now: NOW, niche: 'msp', A: 99, B: 98 });
  assert.equal(gradeLead(finderLead(1, { verifyStatus: 'valid' }), strict).grade, 'C');
  // Agency niche sees website problems as the reason to call.
  const agency = gradeLead(finderLead(1, { verifyStatus: 'valid', signals: { https: false, copyrightYear: 2019, viewport: false, pagesRead: 3, metaDescription: false } }), buildContext(PROFILE, { now: NOW, niche: 'agency' }));
  assert.ok(agency.problems.includes('Website not updated since 2019'));
  assert.ok(agency.problems.includes('Website is not mobile-friendly'));
});

test('sanity check rejects a batch on the grader\'s reasons', () => {
  const ctx = buildContext(PROFILE);
  const rows = Array.from({ length: 20 }, (_, i) => finderLead(i, i < 3 ? { first_name: '', name: '' } : i < 5 ? { state: 'NV' } : {}));
  const s = sanityCheck(rows, { titles: PROFILE.titles }, { chains: new Set(), ctx, rng: () => 0.5 });
  assert.equal(s.reject, true);
  assert.ok(s.failures.some((f) => f.reasons.includes('no_name')));
  assert.ok(s.failures.some((f) => f.reasons.includes('state')));
  assert.equal(s.exclude.requireState, true);
  const good = sanityCheck(rows.slice(5), { titles: PROFILE.titles }, { chains: new Set(), ctx });
  assert.equal(good.reject, false);
});

test('leadQualityView matches the HUB-API shape', async () => {
  await client('acme');
  process.env.REOON_API_KEY = 'r';
  stubVerifiers({ reoon: () => ({ body: { status: 'safe' } }) });
  assert.equal(await leadQualityView('acme'), null); // no leads yet
  await handleWebhook({ type: 'batch', clientId: 'acme', runId: 'q', batchNo: 1, leads: [finderLead(1), finderLead(2), finderLead(3, { email: 'info@dental3.com' })], rejects: { role: 5, no_website: 9 } });
  await runVerify('acme', { now: new Date(), client: { id: 'acme', state: 'warming' } });
  await kv.hdel(K.leadQuality('acme'), 'builtAt'); // force a rebuild on the next rollup
  const { maybeRollup } = await import('@/lib/systems/grader');
  await maybeRollup('acme', { force: true });
  const v = await leadQualityView('acme');
  assert.deepEqual(Object.keys(v).slice(0, 7), ['graded', 'grades', 'sendable', 'verification', 'rejectReasons', 'sources', 'sample']);
  assert.deepEqual(Object.keys(v.grades), ['A', 'B', 'C', 'rejected']);
  assert.deepEqual(Object.keys(v.verification), ['valid', 'risky', 'catchall', 'invalid', 'unknown', 'pending', 'budgetLeftToday']);
  assert.equal(v.graded, 2 + 5 + 1); // stored + finder role rejects + the webhook's own role reject (no_website is not a graded company)
  assert.equal(v.grades.rejected, 6);
  assert.equal(v.sendable, 2);
  assert.equal(v.verification.valid, 2);
  assert.equal(v.verification.budgetLeftToday, 18);
  assert.deepEqual(v.rejectReasons[0], { reason: REJECT_LABELS.role, count: 6 });
  assert.deepEqual(v.sources, [{ source: 'google-places', count: 2 }]);
  assert.deepEqual(Object.keys(v.sample[0]), ['email', 'name', 'title', 'company', 'city', 'grade', 'score', 'reasons']);
  assert.equal(v.sample[0].grade, 'A');
});

test('fairness: another client in the niche took the company within 90 days (not after)', async () => {
  await client('acme');
  await client('other');
  const month = (d) => partsIn('UTC', d).monthKey;
  await kv.hset(K.leadHosts('msp', month(new Date(Date.UTC(2026, 7, 10)))), { 'recent.com': 'other' }); // Aug
  await kv.hset(K.leadHosts('msp', month(new Date(Date.UTC(2026, 3, 10)))), { 'old.com': 'other' }); // Apr
  assert.deepEqual(await hostsTaken('acme', 'msp', ['recent.com', 'old.com', 'free.com'], NOW), ['recent.com']);
});

// ── Copy Engine v2 + Copy Checker ───────────────────────────────────────────

const SAMPLES = [
  { first_name: 'Ann', company: 'Smile Dental - Family & Cosmetic Dentistry of North Dallas', city: 'Dallas', types: ['dentist'], facts: { rating: 4.8, reviews: 212, since: 1998, services: ['teeth whitening'], servicePage: { label: 'dental implants' } } },
  { first_name: 'Christopher', company: 'Greater Metropolitan Property Management Group LLC', city: 'San Antonio', types: [] },
  { first_name: 'Bo', company: 'ABC PLUMBING', city: '', types: ['plumber'], facts: { services: ['drain cleaning'] } },
];

test('every niche × framework × variant renders ≤ 80 words, one question CTA, no link in email 1, passes every check', () => {
  const profile = { ...PROFILE, proofLine: 'We look after 30 offices around Dallas, most of them dental and law practices.' };
  let n = 0;
  for (const tpl of Object.values(NICHE_TEMPLATES)) {
    assert.deepEqual(Object.keys(tpl.frameworks).sort(), ['local-proof', 'problem-first', 'question-led', 'quick-idea']);
    for (const fw of Object.keys(tpl.frameworks)) {
      for (const backup of [false, true]) {
        const t = frameworkTemplate(tpl, fw, { backup });
        assert.equal(t.touches.length, 4);
        const [a, b] = t.variants.map((d) => buildVariant(t, d, clientVars({ name: 'Acme IT' }, profile)));
        // A and B differ only in the Day 0 subject and the opener set.
        assert.notEqual(a.touches[0].subject, b.touches[0].subject);
        assert.notEqual(a.firstLineSet, b.firstLineSet);
        assert.deepEqual(a.touches.map((x) => x.body), b.touches.map((x) => x.body));
        for (const v of [a, b]) for (const lead of SAMPLES) for (const r of renderVariant(v, lead)) {
          n++;
          assert.ok(wordCount(r.body) <= 80, `${t.niche}/${fw}/${r.touch}: ${wordCount(r.body)} words`);
          assert.equal((r.body.match(/\?/g) || []).length, 1, `${t.niche}/${fw}/${r.touch}`);
          if (r.touch === 'd0') assert.doesNotMatch(r.text, /https?:|www\./);
          assert.doesNotMatch(r.body, /!/);
          const res = checkEmail(r, profile);
          assert.ok(res.ok, `${t.niche}/${fw}/${v.variantId}/${r.touch}: ${JSON.stringify(res.failures)}`);
        }
      }
    }
    for (const s of subjectBank(tpl.niche)) assert.ok(s.split(' ').length <= 5 && !/FirstName|!/.test(s), s);
  }
  assert.ok(n >= 900);
});

test('first lines: rating / years / service / page facts per set, safe fallback', () => {
  const lead = SAMPLES[0];
  assert.equal(firstLineFor(lead, 'A'), 'Saw Smile Dental has a 4.8-star rating across 212 Google reviews.');
  assert.equal(firstLineFor(lead, 'B'), 'I was reading about the teeth whitening work Smile Dental does in Dallas.');
  assert.equal(firstLineFor(lead, 'C'), 'I was reading the dental implants page on the Smile Dental site.');
  assert.equal(firstLineFor(lead, 'D'), 'Noticed Smile Dental has been serving Dallas since 1998.');
  // Weak rating, a generic "service", no city → next fact or the type line.
  assert.equal(firstLineFor({ company: 'Bolt Co', types: ['plumber'], facts: { rating: 4.1, reviews: 300, services: ['services'] } }, 'A'), 'Saw Bolt Co while looking at plumbing companies in your area.');
  assert.equal(firstLineFor({ company: 'Bolt Co', city: 'Tyler', types: [], facts: { since: 2024 } }, 'D'), 'Noticed Bolt Co while going through local businesses near Tyler.'); // too recent to mention
  // A fact that would break the checker is never used.
  assert.equal(firstLineFor({ company: 'Bolt Co', types: [], facts: { services: ['SEWER REPAIR NOW'] } }, 'B'), 'I was looking at local businesses and Bolt Co came up.');
  assert.equal(cleanCompany('Smile Dental | Best Dentist in Dallas'), 'Smile Dental');
  assert.equal(cleanCompany('ACME ROOFING LLC'), 'Acme Roofing');
  assert.equal(cleanCompany('acmeplumbing.com'), 'acmeplumbing');
  assert.equal(cleanCompany('Joe’s Plumbing & Heating, Inc.'), 'Joe’s Plumbing & Heating');
});

test('niche + framework choice: offer first, then industry; owner pick; proof-only framework needs a proof line; learning', () => {
  assert.equal(nicheOf({ defaultNiche: 'managed IT', industry: 'accounting firm, law firm' }), 'msp');
  assert.equal(nicheOf({ sellsTo: 'We build websites and run Google ads for HVAC companies.' }), 'agency');
  assert.equal(nicheOf({ defaultNiche: 'commercial roofing', defaultIcp: 'property managers' }), 'trades');
  assert.equal(nicheOf({ defaultNiche: 'bookkeeping and tax' }), 'pro-services');
  assert.equal(nicheOf({ defaultNiche: 'custom furniture' }), 'trial-default');
  const tpl = NICHE_TEMPLATES.msp;
  assert.equal(chooseFramework(tpl, {}, null, {}), 'problem-first');
  assert.equal(chooseFramework(tpl, { copyFramework: 'question-led' }, null, {}), 'question-led');
  assert.equal(chooseFramework(tpl, { copyFramework: 'local-proof' }, null, {}), 'problem-first'); // no proof line
  assert.equal(chooseFramework(tpl, { copyFramework: 'local-proof' }, null, { proof: 'We look after 30 offices.' }), 'local-proof');
  assert.equal(chooseFramework(tpl, {}, { 'msp-qi-b1': { sends: 80, replies: 4, positive: 2 }, 'msp-a1': { sends: 80, replies: 1, positive: 0 } }, {}), 'quick-idea');
});

test('copy engine stores the framework; Day 7 backup keeps it with the C/D openers', async () => {
  await client('acme', { profile: { ...PROFILE, copyFramework: 'question-led' } });
  const r = await buildSequence('acme');
  assert.ok(r.ok);
  const s = await getStoredSequence('acme');
  assert.equal(s.framework, 'question-led');
  assert.equal(s.variantA.framework, 'question-led');
  assert.equal(s.variantA.variantId, 'msp-q-a1');
  const b = await buildBackupVariants('acme');
  assert.equal(b.framework, 'question-led');
  assert.deepEqual([b.variantA.firstLineSet, b.variantB.firstLineSet], ['C', 'D']);
  assert.deepEqual(b.variantA.touches.map((t) => t.body), s.variantA.touches.map((t) => t.body));
});

test('copy checker v2 rules: one question, no "!", stale phrases, readability, you-focus, subject length, more spam words', () => {
  const profile = { senderName: 'Sam Carter', postalAddress: '100 Main St, Dallas, TX 75201' };
  const footer = '\n\nSam Carter\n100 Main St, Dallas, TX 75201\n\nNot the right fit? Just reply STOP and I will not email you again.';
  const mk = (body, extra = {}) => ({ touch: 'd3', subject: 'idea for Acme', body, text: `${body}${footer}`, ...extra });
  const rules = (r) => checkEmail(r, profile).failures.map((f) => f.rule);
  assert.deepEqual(rules(mk('Hi Ann,\n\nOne thought for you.\n\nWorth a chat?')), []);
  assert.deepEqual(rules(mk('Hi Ann, how are you?\n\nWorth a chat?')), ['one_question']);
  assert.deepEqual(rules(mk('Hi Ann, great news!\n\nWorth a chat?')), ['no_exclamation']);
  assert.deepEqual(rules(mk('Just following up on this.\n\nWorth a chat?')), ['stale_phrase']);
  assert.deepEqual(rules(mk('Hi Ann,\n\nQuick question about your IT.\n\nWorth a chat?')), ['stale_phrase']);
  assert.deepEqual(rules(mk('We think we can help and we would like to show you what we do because our team is the best at it and we care a lot about it and our work.\n\nWorth a chat?')), ['readability', 'you_focus']);
  assert.deepEqual(rules(mk('We help. We fix. Our team works. I call.\n\nWorth a chat?')), ['you_focus']);
  assert.deepEqual(rules(mk('We help you. We fix yours. Our team works for you. I call you.\n\nWorth a chat?')), []);
  assert.deepEqual(rules(mk('Hi Ann.\n\nWorth a chat?', { subject: 'a much longer subject line than anyone should write' })), ['subject_length']);
  assert.deepEqual(rules(mk('Hi Ann.\n\nWorth a chat?', { subject: 'idea for Greater Metropolitan Property Management Group', exemptWords: ['Greater Metropolitan Property Management Group'] })), []);
  assert.deepEqual(rules(mk('Hi Ann, it is free.\n\nWorth a chat?')), ['spam_word']);
  assert.deepEqual(rules(mk('We streamline it.\n\nWorth a chat?')), ['spam_word']);
  assert.deepEqual(rules(mk('Hi Bo at ABC Plumbing.\n\nWorth a chat?', { exemptWords: ['ABC Plumbing'] })), []);
  assert.deepEqual(selfYouCounts('We help you. US law. us.'), { self: 2, you: 1 });
});

// ── Sender: the week-one rule ────────────────────────────────────────────────

const INBOX = 'sam@acme-team.com';
const SEQ = (tag) => ({
  footer: '{SenderName}\n{postalAddress}\n\nNot the right fit? Just reply STOP and I will not email you again.',
  touches: [
    { touch: 'd0', thread: 'new', subject: `${tag} idea for {Company}`, body: 'Hi {FirstName},\n\nA short note about {Company}.\n\nWorth a chat?' },
    { touch: 'd3', thread: 'd0', body: '{FirstName}, one more note.\n\nWorth a chat?' },
    { touch: 'd7', thread: 'new', subject: 'second idea', body: '{FirstName}, another idea for {Company}.\n\nOpen to it?' },
    { touch: 'd10', thread: 'd7', body: '{FirstName}, closing the file.\n\nShould I?' },
  ],
});

async function sendingClient({ day1Date, leads }) {
  await createClient('acme', { state: 'sending', name: 'Acme IT', contactEmail: 'boss@acmeit.com', mainDomain: 'acmeit.com' });
  await kv.hset(K.profile('acme'), { ...PROFILE, senderName: 'Sam Carter' });
  await kv.hset(K.trial('acme'), { day1Date, firstSendAt: `${day1Date}T13:00:00Z` });
  await saveInbox('acme', { email: INBOX, password: 'app-pass', displayName: 'Sam Carter', enabled: true, dailyCap: '25' });
  await kv.hset(K.sequence('acme'), { variantA: JSON.stringify(SEQ('A')), variantB: JSON.stringify(SEQ('B')), active: 'both', version: 1, approvedAt: '2026-09-20T00:00:00Z' });
  await initCounters('acme');
  await kv.hset(K.sendState('acme'), { smokeClearedAt: '2026-09-29T00:00:00Z' });
  for (const l of leads) await saveLead('acme', { status: 'unsent', tz: 'America/New_York', sequenceVariant: 'A', ...l });
}

async function sendAll(now, max = 10) {
  const sent = [];
  setDeps({ ...MX_OK, sendEmail: async (account, opts) => { sent.push(opts.to); return { success: true, messageId: `<m${sent.length}@t>`, ms: 5 }; }, alertOwner: async () => ({ sent: true }) });
  for (let i = 0; i < max; i++) {
    await kv.del(K.pacing('acme'));
    await kv.hdel(K.client('acme'), 'sendNextDueAt');
    await runSender('acme', { now: new Date(now.getTime() + i * 60_000) });
  }
  return sent.sort();
}

const W1 = [
  { email: 'valid-a@a.com', first_name: 'Val', company: 'Aco', grade: 'A', verifyStatus: 'valid' },
  { email: 'valid-b@b.com', first_name: 'Vib', company: 'Bco', grade: 'B', verifyStatus: 'valid' },
  { email: 'valid-c@c.com', first_name: 'Vic', company: 'Cco', grade: 'C', verifyStatus: 'valid' },
  { email: 'risky-a@d.com', first_name: 'Ria', company: 'Dco', grade: 'A', verifyStatus: 'risky' },
  { email: 'catch-a@e.com', first_name: 'Cat', company: 'Eco', grade: 'A', verifyStatus: 'catchall' },
  { email: 'pend-a@f.com', first_name: 'Pen', company: 'Fco', grade: 'A', verifyStatus: 'pending' },
  { email: 'legacy@g.com', first_name: 'Leg', company: 'Gco', riskLevel: 'safe' }, // Test Mode / v1 record
];

test('sender week one: only verified A/B leads; risky / catch-all / pending / C never', async () => {
  await sendingClient({ day1Date: '2026-10-02', leads: W1 }); // Tue 6 Oct = sending day 3
  const sent = await sendAll(NOW);
  assert.deepEqual(sent, ['legacy@g.com', 'valid-a@a.com', 'valid-b@b.com']);
  assert.equal((await getLead('acme', 'risky-a@d.com')).status, 'unsent'); // waits, not closed
});

test('sender after week one: risky / catch-all only when SEND.allowRiskyAfterDay allows it', async () => {
  const later = new Date('2026-10-16T15:00:00Z'); // Fri 16 Oct
  await sendingClient({ day1Date: '2026-10-02', leads: W1 }); // sending day 10 (Columbus Day skipped)
  assert.deepEqual(await sendAll(later), ['legacy@g.com', 'valid-a@a.com', 'valid-b@b.com']); // default: never
  __reset(); resetDeps(); setDeps(MX_OK); // resetDeps also clears the Sender's 60-second config memo
  await sendingClient({ day1Date: '2026-10-02', leads: W1 });
  await setOverride(null, 'SEND.allowRiskyAfterDay', 8);
  assert.deepEqual(await sendAll(later), ['catch-a@e.com', 'legacy@g.com', 'risky-a@d.com', 'valid-a@a.com', 'valid-b@b.com']);
});
