// Stage A (intake) — Gatekeeper, onboarding, Market Counter, Price Scout,
// Setup Checker, Auth Guard parsers, Booking Link Tester. Every network, DNS,
// SMTP and IMAP call is stubbed through `io` or globalThis.fetch.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { createClient, getClient, getTrial, getProfile } from '@/lib/db/client';
import { saveInbox, getInboxRecords } from '@/lib/db/inboxes';
import { readToken } from '@/lib/pagetokens';
import { TEMPLATES as STAGE_A_TEMPLATES } from '@/lib/templates/client/stage-a';
import { fill } from '@/lib/templates/render';
import { renderAgreement } from '@/lib/templates/agreement';
import { FIT_RULES, evaluateFit, detectAgency, normaliseApplication, normaliseDomain, applyForTrial, runOnboardingNudge, promoteFromQueue } from '@/lib/systems/gatekeeper';
import { buildQueries, estimateFrom, runMarketCount, keywordsOf } from '@/lib/systems/market';
import { candidateDomains, allowedTlds, registrarQuotes, inboxQuotes, buildShoppingList, runPriceScout, runPurchaseNudge, parseCloudflareCom } from '@/lib/systems/pricescout';
import { computeDates, dnsblQueries, reverseIp, isListedAnswer, evalSpf, evalDkim, evalDmarc, evalMx, parseAuthResults, runSetupCheck, startSetupCheck } from '@/lib/systems/setupcheck';
import { parseDmarcXml, attachmentXml, unzipFirst } from '@/lib/systems/authguard';
import { evaluateBooking, detectHost, parseEmbedded } from '@/lib/systems/bookingtest';
import { validateFields, saveOnboarding, acceptAgreement } from '@/lib/systems/onboarding';
import { isUsPostalAddress, neighboursOf } from '@/lib/systems/usgeo';
import { DEFAULTS } from '@/lib/config';

// templates/client/index.js uses relative imports the test loader cannot
// resolve, so render Stage A templates directly with the same fill().
function renderTemplate(key, vars) {
  const t = STAGE_A_TEMPLATES[key];
  if (!t) throw new Error(`unknown template ${key}`);
  return { subject: fill(key, t.subject, vars), text: fill(key, t.body, vars) };
}

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'https://app.test';

let emails;
let alerts;
let fetchLog;

function stubIo() {
  emails = [];
  alerts = [];
  io.notifyClient = async (clientId, key, vars, opts = {}) => {
    const msg = renderTemplate(key, { clientName: 'C', contactName: 'Ann Lee', ...vars }); // throws on any empty slot
    emails.push({ clientId, key, vars, opts, msg });
    return { sent: true };
  };
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.sendOwnerEmail = async () => ({ ok: true });
  io.fetchExt = async () => ({ ok: true, status: 200, url: 'https://example.com/', text: async () => '<title>Acme Plumbing</title>' });
}

async function signer() {
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
}

beforeEach(async () => {
  __reset();
  stubIo();
  fetchLog = [];
  delete process.env.PLACES_API_KEY;
  await signer();
});

const GOOD = {
  companyName: 'Acme Plumbing', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', website: 'https://www.acme.com/about',
  usBased: 'yes', employees: '12', dealValue: '$5,000', soldToStrangers: 'yes', dreamCustomers: ['A Co', 'B Co', 'C Co'],
  meetWithin5Days: 'yes', slotsPerWeek: '6', nobodyElseEmailing: 'yes', reviewAgreed: 'yes',
};

// ── Gatekeeper ─────────────────────────────────────────────────────────────

test('domains normalise from websites and emails', () => {
  assert.equal(normaliseDomain('https://www.Acme.com/about?x=1'), 'acme.com');
  assert.equal(normaliseDomain('bob@acme-plumbing.co.uk'), 'acme-plumbing.co.uk');
  assert.equal(normaliseDomain('not a site'), null);
});

test('each fit rule fails on its own', () => {
  const fit = DEFAULTS.FIT;
  const base = normaliseApplication(GOOD);
  assert.deepEqual(evaluateFit(base, fit, { agencyHit: null }), { ok: true });
  const breakers = {
    us_based: { usBased: 'no' },
    employees: { employees: '51' },
    deal_value: { dealValue: '1999' },
    sold_to_strangers: { soldToStrangers: 'no' },
    dream_customers: { dreamCustomers: ['Only one'] },
    meet_within_5_days: { meetWithin5Days: 'no' },
    slots_per_week: { slotsPerWeek: '4' },
    nobody_else_emailing: { nobodyElseEmailing: 'no' },
    review_agreed: { reviewAgreed: 'no' },
  };
  for (const rule of FIT_RULES) {
    if (rule.id === 'not_agency') {
      const v = evaluateFit(base, fit, { agencyHit: 'lead generation' });
      assert.equal(v.rule, 'not_agency');
      continue;
    }
    const app = normaliseApplication({ ...GOOD, ...breakers[rule.id] });
    const v = evaluateFit(app, fit, { agencyHit: null });
    assert.equal(v.ok, false, rule.id);
    assert.equal(v.rule, rule.id);
    assert.ok(v.reason.length > 10);
  }
  assert.equal(evaluateFit(normaliseApplication({ ...GOOD, employees: '5' }), fit, {}).ok, true);
  assert.equal(evaluateFit(normaliseApplication({ ...GOOD, employees: '4' }), fit, {}).rule, 'employees');
  assert.equal(detectAgency('Top B2B Lead Generation agency in Ohio', DEFAULTS.INTAKE.agencyKeywords), 'lead generation');
  assert.equal(detectAgency('We fix leaky pipes; no outbound nonsense', DEFAULTS.INTAKE.agencyKeywords), null);
});

test('happy path: fit passes → one accepted_call email with the onboarding link, token, promise', async () => {
  const r = await applyForTrial(GOOD, { now: new Date('2026-10-05T14:00:00Z') });
  assert.equal(r.outcome, 'onboarding');
  const c = await getClient(r.clientId);
  assert.equal(c.state, 'onboarding');
  assert.equal(c.mainDomain, 'acme.com');
  assert.deepEqual(emails.map((e) => e.key), ['accepted_call'], 'one email on a yes (docs/ONBOARD-CALL.md)');
  const mail = emails.find((e) => e.key === 'accepted_call');
  const token = mail.vars.onboardingLink.match(/\/c\/([^/]+)\/onboard$/)[1];
  assert.equal((await readToken(token, { purpose: 'onboarding' })).clientId, r.clientId);
  const promises = Object.values(await kv.hgetall(`client:${r.clientId}:promises`));
  assert.ok(promises[0].doneAt);
  // Double submit inside the claim window is swallowed, not declined.
  const again = await applyForTrial(GOOD);
  assert.equal(again.duplicate, true);
});

test('repeat domain is declined, including a deleted client; a declined one is not a repeat', async () => {
  await createClient('acme', { mainDomain: 'acme.com', state: 'deleted' });
  const r = await applyForTrial(GOOD);
  assert.equal(r.outcome, 'declined');
  assert.equal(r.reason, 'one_trial_ever');
  assert.equal(emails.at(-1).key, 'decline_repeat');
  assert.equal((await getClient(r.clientId)).state, 'declined');

  __reset(); stubIo(); await signer();
  await createClient('acme', { mainDomain: 'acme.com', state: 'declined' });
  const r2 = await applyForTrial(GOOD);
  assert.equal(r2.outcome, 'onboarding');
  assert.equal(r2.clientId, 'acme-2');
});

test('a fit failure is declined with the reason; an agency website is caught', async () => {
  const r = await applyForTrial({ ...GOOD, employees: '3' });
  assert.equal(r.outcome, 'declined');
  assert.equal(emails.at(-1).key, 'decline_fit');
  assert.match(emails.at(-1).vars.reason, /5 to 50 people/);

  __reset(); stubIo(); await signer();
  io.fetchExt = async () => ({ ok: true, status: 200, text: async () => '<title>Pipeline Pros | Appointment Setting for B2B</title>' });
  const r2 = await applyForTrial({ ...GOOD, website: 'pipelinepros.com', contactEmail: 'x@pipelinepros.com' });
  assert.equal(r2.reason, 'fit:not_agency');
});

test('cap reached → queued with position and expected date; extension → queued', async () => {
  for (const [id, d30] of [['t1', '2026-11-20'], ['t2', '2026-11-10'], ['t3', '2026-12-01']]) {
    await createClient(id, { state: 'sending', mainDomain: `${id}.com` });
    await kv.hset(`client:${id}:trial`, { day30Date: d30 });
  }
  const r = await applyForTrial(GOOD);
  assert.equal(r.outcome, 'queued');
  assert.equal(r.position, 1);
  assert.equal(r.expectedDate, '2026-11-26'); // earliest day30 (Nov 10) + 16
  const q = emails.find((e) => e.key === 'queued_position');
  assert.match(q.vars.expectedLine, /Thursday 26 November/);
  assert.deepEqual(await kv.lrange('queue:trial', 0, -1), [r.clientId]);

  __reset(); stubIo(); await signer();
  await createClient('ext', { state: 'extension', mainDomain: 'ext.com' });
  const r2 = await applyForTrial(GOOD);
  assert.equal(r2.outcome, 'queued');
  assert.match(emails.at(-1).vars.expectedLine, /firm date/);
});

test('gatekeeper failure leaves the client applied and alerts gatekeeper_error', async () => {
  io.notifyClient = async () => { throw new Error('smtp down'); };
  const r = await applyForTrial(GOOD);
  assert.equal(r.outcome, 'manual');
  assert.equal((await getClient(r.clientId)).state, 'applied');
  assert.equal(alerts.at(-1).key, 'gatekeeper_error');
  assert.equal(alerts.at(-1).vars.email, 'ann@acme.com');
});

test('owner New client skips the fit rules', async () => {
  const r = await applyForTrial({ companyName: 'Beta', contactName: 'Bo Chen', contactEmail: 'bo@beta.io', website: 'beta.io' }, { preApproved: true });
  assert.equal(r.outcome, 'onboarding');
});

test('onboarding nudge: day +2 and +4 reminders, day +7 closed_silent and the queue pops', async () => {
  const sentAt = new Date('2026-10-05T14:00:00Z'); // Mon 10:00 ET
  await createClient('late', { state: 'onboarding', contactName: 'Lu Late', contactEmail: 'lu@late.com', mainDomain: 'late.com' });
  await kv.hset('client:late:trial', { onboardingSentAt: sentAt.toISOString() });
  const at = (d) => new Date(sentAt.getTime() + d * 864e5);
  assert.equal((await runOnboardingNudge({ clientId: 'late', now: at(1) })).sent, null);
  assert.equal((await runOnboardingNudge({ clientId: 'late', now: at(2) })).sent, 2);
  assert.equal((await runOnboardingNudge({ clientId: 'late', now: at(3) })).sent, null);
  assert.equal((await runOnboardingNudge({ clientId: 'late', now: at(4) })).sent, 4);
  assert.equal((await runOnboardingNudge({ clientId: 'late', now: at(5) })).sent, null);
  assert.deepEqual(emails.map((e) => e.key), ['onboarding_reminder', 'onboarding_reminder']);
  assert.match(emails[0].vars.link, /\/onboard$/);
  assert.equal(emails[0].vars.closeDate, 'Monday 12 October');

  // A queued applicant waits for the slot.
  await createClient('waiting', { state: 'queued', contactName: 'Wu Wait', contactEmail: 'wu@wait.com', mainDomain: 'wait.com' });
  await kv.rpush('queue:trial', 'waiting');
  const r = await runOnboardingNudge({ clientId: 'late', now: at(7) });
  assert.equal(r.closed, true);
  assert.equal((await getClient('late')).state, 'closed_silent');
  assert.deepEqual(r.promoted, ['waiting']);
  assert.equal((await getClient('waiting')).state, 'onboarding');
  assert.deepEqual(emails.slice(-2).map((e) => e.key), ['closed_silent', 'accepted_call']);
});

test('a client who signed is never closed silent', async () => {
  await createClient('signed', { state: 'onboarding', contactName: 'Si Gned', contactEmail: 's@signed.com' });
  await kv.hset('client:signed:trial', { onboardingSentAt: '2026-10-01T14:00:00Z', agreementAcceptedAt: '2026-10-02T14:00:00Z' });
  assert.equal((await runOnboardingNudge({ clientId: 'signed', now: new Date('2026-10-20T14:00:00Z') })).skipped, 'accepted');
});

test('queue promotion respects the cap', async () => {
  for (const id of ['a1', 'a2', 'a3']) await createClient(id, { state: 'warming' });
  await createClient('q1', { state: 'queued', contactName: 'Q One', contactEmail: 'q@one.com' });
  await kv.rpush('queue:trial', 'q1');
  assert.deepEqual((await promoteFromQueue()).promoted, []);
  // Owner promote overrides the cap.
  assert.deepEqual((await promoteFromQueue({ clientId: 'q1' })).promoted, ['q1']);
  assert.equal((await getClient('q1')).state, 'onboarding');
});

// ── Onboarding ─────────────────────────────────────────────────────────────

test('onboarding validation: prefix, US address, calendar URL answers 200', async () => {
  io.fetchExt = async (url) => ({ status: url.includes('good') ? 200 : 404, ok: url.includes('good'), text: async () => '' });
  const { values, errors, blocklist } = await validateFields({
    senderPrefix: 'John_Smith', postalAddress: '12 Main St, Springfield', calendarUrl: 'https://cal.example/bad',
    suppressCustomers: 'Big Customer Inc\nbigcustomer.com\nceo@other.com', states: 'TX, Oklahoma',
  });
  assert.ok(errors.senderPrefix && errors.postalAddress && errors.calendarUrl);
  assert.deepEqual(JSON.parse(values.states), ['TX', 'OK']);
  assert.deepEqual(blocklist, ['bigcustomer.com', 'ceo@other.com']);
  const ok = await validateFields({ senderPrefix: 'john.smith', postalAddress: '12 Main St, Dallas, TX 75201', calendarUrl: 'https://calendly.com/good/30min' });
  assert.deepEqual(ok.errors, {});
  assert.ok(ok.values.calendarUrlCheckedAt);
  assert.ok(isUsPostalAddress('1 Road, Austin, Texas 78701'));
  assert.ok(!isUsPostalAddress('1 Road, Colombo 00300, Sri Lanka'));
});

async function fullProfile(id) {
  io.fetchExt = async () => ({ status: 200, ok: true, text: async () => '' });
  const r = await saveOnboarding(id, {
    companyName: 'Acme Plumbing', senderName: 'John Smith', senderTitle: 'Owner', senderPrefix: 'john',
    calendarUrl: 'https://calendly.com/acme/30min', postalAddress: '12 Main St, Dallas, TX 75201', hotLeadEmail: 'john@acme.com',
    suppressCustomers: 'bigcustomer.com\nJoe\'s Diner', sellsTo: 'We fix pipes for restaurants.', defaultNiche: 'commercial plumbing', defaultIcp: 'restaurants', industry: 'restaurant, cafe',
    cities: 'Dallas, TX\nHouston, TX', sizeMin: '5', sizeMax: '50', titles: 'Owner\nGeneral Manager',
    dreamCustomers: [{ name: 'A', website: 'a.com' }, { name: 'B', website: 'b.com' }, { name: 'C', website: 'c.com' }],
    capacityPerWeek: '5', winCondition: 'Two good calls.',
  });
  assert.deepEqual(r.errors, {});
}

test('onboarding: signer missing blocks the agreement; accept → market passes → awaiting_purchase', async () => {
  await createClient('acme', { state: 'onboarding', name: 'Acme Plumbing', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
  await fullProfile('acme');
  assert.equal(await kv.sismember('client:acme:blocklist', 'bigcustomer.com'), 1);

  await kv.hdel('system:config', 'OWNER.signerName');
  const blocked = await acceptAgreement('acme', { name: 'Ann Lee', title: 'CEO', agree: true, ip: '1.2.3.4' });
  assert.equal(blocked.ok, false);
  assert.ok(alerts.some((a) => a.key === 'config_missing'));
  await signer();

  process.env.PLACES_API_KEY = 'k';
  let n = 0;
  globalThis.fetch = async (url) => {
    fetchLog.push(String(url));
    n++;
    const ids = Array.from({ length: 20 }, (_, i) => ({ id: `p${n}-${i}` }));
    return new Response(JSON.stringify({ places: ids, nextPageToken: 'more' }), { status: 200 });
  };
  const r = await acceptAgreement('acme', { name: 'Ann Lee', title: 'CEO', agree: true, ip: '1.2.3.4', now: new Date('2026-10-05T14:00:00Z'), deadline: Date.now() + 60000 });
  assert.equal(r.ok, true);
  assert.equal(r.market.status, 'passed');
  const trial = await getTrial('acme');
  assert.equal(trial.agreementName, 'Ann Lee');
  assert.equal(trial.agreementIp, '1.2.3.4');
  assert.match(trial.agreementText, /Signed for Aviance: Limeth Sith/);
  assert.match(trial.agreementText, /Working hours in your time zone: 09:00–17:00 US Eastern/);
  assert.equal((await getClient('acme')).state, 'awaiting_purchase');
  assert.equal((await getClient('acme')).intakeStep, 'pricescout');
  assert.ok(emails.some((e) => e.key === 'agreement_copy'));
  // Blocklist Keeper ran on submit: the bare company name is in the client blocklist.
  assert.equal(await kv.sismember('client:acme:blocklist', 'name:joe s diner'), 1);
  // 5 queries × 3 pages of 20 = 300 unique ids × 3 = 900 < 1000 → widened once and passed.
  assert.equal(Number((await getProfile('acme')).marketEstimate) >= 1000, true);
  assert.ok(fetchLog.every((u) => u.includes('places.googleapis.com')));
  // Accepting again is a no-op.
  assert.equal((await acceptAgreement('acme', { name: 'Ann Lee', title: 'CEO', agree: true })).ok, false); // page closed
});

// ── Market Counter ─────────────────────────────────────────────────────────

test('market queries and estimate math', () => {
  const q = buildQueries(['managed IT services', 'IT support'], ['Dallas, TX', 'Houston, TX', 'Texas'], { min: 3, max: 5 });
  assert.deepEqual(q, ['managed IT services Dallas, TX', 'IT support Dallas, TX', 'managed IT services Houston, TX', 'IT support Houston, TX', 'managed IT services Texas']);
  assert.equal(estimateFrom({ source: 'places', unique: 334 }, { coverageFactor: 3, overpassFactor: 1 }), 1002);
  assert.equal(estimateFrom({ source: 'overpass', count: 812 }, { coverageFactor: 3, overpassFactor: 1 }), 812);
  assert.deepEqual(keywordsOf({ industry: 'plumbing, HVAC ,  plumbing' }), ['plumbing', 'HVAC']);
  assert.deepEqual(neighboursOf(['TX']), ['AR', 'LA', 'NM', 'OK']);
});

async function marketClient() {
  await createClient('mk', { state: 'onboarding', name: 'MK', contactName: 'Mo Kay', contactEmail: 'mo@mk.com', mainDomain: 'mk.com' });
  await kv.hset('client:mk:profile', { industry: 'plumbing', industryKeywords: JSON.stringify(['plumbing']), states: JSON.stringify(['TX']) });
}

test('market falls back to Overpass when Places fails, widens, then passes', async () => {
  await marketClient();
  process.env.PLACES_API_KEY = 'k';
  globalThis.fetch = async (url) => {
    fetchLog.push(String(url));
    if (String(url).includes('places.googleapis.com')) return new Response('{"error":{"message":"denied"}}', { status: 403 });
    return new Response(JSON.stringify({ elements: [{ type: 'count', tags: { total: '700' } }] }), { status: 200 });
  };
  const r = await runMarketCount('mk', { deadline: Date.now() + 60000, now: new Date('2026-10-05T14:00:00Z') });
  assert.equal(r.status, 'passed');
  assert.equal(r.estimate, 700 * 5); // TX + AR, LA, NM, OK
  assert.equal(fetchLog.filter((u) => u.includes('overpass')).length, 5);
});

test('market still small after widening → declined, decline_market, market_small; owner override', async () => {
  await marketClient();
  globalThis.fetch = async () => new Response(JSON.stringify({ elements: [{ type: 'count', tags: { total: '100' } }] }), { status: 200 });
  const r = await runMarketCount('mk', { deadline: Date.now() + 60000, now: new Date('2026-10-05T14:00:00Z') });
  assert.equal(r.status, 'declined');
  assert.equal(r.estimate, 500);
  assert.equal((await getClient('mk')).state, 'declined');
  assert.equal(emails.at(-1).key, 'decline_market');
  assert.match(emails.at(-1).vars.widenedLine, /neighbouring states/);
  assert.equal(alerts.at(-1).key, 'market_small');

  const { overrideMarket } = await import('@/lib/systems/market');
  await overrideMarket('mk', { note: 'I know this niche' });
  assert.equal((await getClient('mk')).state, 'awaiting_purchase');
});

// ── Price Scout ────────────────────────────────────────────────────────────

test('candidates, TLD rules, registrar and inbox ranking', async () => {
  const tlds = allowedTlds(['com', 'xyz', 'net', 'co'], DEFAULTS.BANNED_TLDS);
  assert.deepEqual(tlds, ['com', 'net', 'co']);
  const names = candidateDomains('www.acme.com', DEFAULTS.PRICE.candidatePatterns, tlds);
  assert.deepEqual(names.slice(0, 8), ['acme-team.com', 'getacme.com', 'acmehq.com', 'tryacme.com', 'acme-co.com', 'acmemail.com', 'hello-acme.com', 'acme-us.com']);
  assert.equal(names[8], 'acme-team.net');
  assert.ok(!names.some((n) => /\.(xyz|shop|info|top|club|site)$/.test(n)));

  const now = new Date('2026-10-05T14:00:00Z');
  const promos = [
    { registrar: 'spaceship', tld: 'com', code: 'NEWCOM', firstYearPrice: 5.99, expiresAt: '2026-12-31' },
    { registrar: 'porkbun', tld: 'com', code: 'OLD', firstYearPrice: 1.99, expiresAt: '2026-01-01' },
  ];
  const quotes = await registrarQuotes('com', { livePorkbun: { com: { registration: 9.73 } }, registrars: DEFAULTS.registrars, promos, today: '2026-10-05', now });
  assert.deepEqual(quotes.map((q) => [q.registrar, q.price]), [['spaceship', 5.99], ['porkbun', 9.73], ['cloudflare', 10.44]]);
  // Porkbun down → cached price, marked unconfirmed.
  const later = await registrarQuotes('com', { livePorkbun: null, registrars: DEFAULTS.registrars, promos: [], today: '2026-10-05', now });
  assert.deepEqual(later.find((q) => q.registrar === 'porkbun'), { registrar: 'porkbun', name: 'Porkbun', price: 9.73, seenAt: now.toISOString(), source: 'porkbun api', unconfirmed: true });

  const inboxes = inboxQuotes(DEFAULTS.inboxProviders, 2);
  assert.deepEqual(inboxes.map((i) => i.id), ['premiuminboxes', 'inboxkit']); // Zapmail min 10, unknown app passwords excluded

  const list = buildShoppingList({
    availability: [{ name: 'acme-team.com', available: false }, { name: 'getacme.com', available: true }, { name: 'acmehq.com', available: null }, { name: 'tryacme.com', available: true }],
    quotesByTld: { com: quotes }, inboxes, profile: { senderPrefix: 'john', senderName: 'John Smith' },
  });
  assert.equal(list.chosenDomain, 'getacme.com');
  assert.deepEqual(list.backups, ['tryacme.com', 'acmehq.com']);
  assert.equal(list.total, 12.99); // 5.99 + 2 × 3.50
  assert.deepEqual(list.senderAddresses, ['john@getacme.com', 'jsmith@getacme.com']);
});

test('price scout sends the list once, then the 12 h / 48 h nudges', async () => {
  await createClient('acme', { state: 'awaiting_purchase', intakeStep: 'pricescout', name: 'Acme', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
  await kv.hset('client:acme:profile', { senderPrefix: 'john', senderName: 'John Smith', marketEstimate: 1800 });
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchLog.push(u);
    if (u.includes('/pricing/get')) return new Response(JSON.stringify({ status: 'SUCCESS', pricing: { com: { registration: '9.73', renewal: '10.99' } } }), { status: 200 });
    if (u.includes('rdap.org')) return new Response('', { status: u.includes('acme-team.com') ? 200 : 404 });
    return new Response('', { status: 500 });
  };
  const t0 = new Date('2026-10-05T14:00:00Z');
  const r = await runPriceScout('acme', { now: t0, deadline: Date.now() + 60000 });
  assert.equal(r.sent, true);
  assert.equal(r.chosenDomain, 'getacme.com');
  const list = alerts.find((a) => a.key === 'shopping_list');
  assert.match(list.body, /getacme\.com/);
  assert.match(list.body, /Porkbun \$9\.73/);
  assert.match(list.body, /https:\/\/app\.test\/mc\/clients\/acme\/purchase/);
  assert.ok(emails.some((e) => e.key === 'setup_in_progress'));
  assert.equal((await runPriceScout('acme', { now: t0 })).skipped, 'already sent');

  const h = (n) => new Date(t0.getTime() + n * 3600e3);
  assert.deepEqual(await runPurchaseNudge({ clientId: 'acme', now: h(11) }), { hours: 11 });
  assert.equal((await runPurchaseNudge({ clientId: 'acme', now: h(12) })).reminded, true);
  assert.deepEqual(await runPurchaseNudge({ clientId: 'acme', now: h(13) }), { hours: 13 });
  assert.equal((await runPurchaseNudge({ clientId: 'acme', now: h(48) })).escalated, true);
  assert.equal(alerts.filter((a) => a.key === 'purchase_reminder').length, 2);
});

test('Cloudflare .com price parser', () => {
  assert.equal(parseCloudflareCom('<tr><td>.com</td><td>Register</td><td>$10.44</td></tr>'), 10.44);
  assert.equal(parseCloudflareCom('<p>nothing here</p>'), null);
});

// ── Setup Checker ──────────────────────────────────────────────────────────

test('Day 1 moves to the next US business day (weekend and federal holiday)', () => {
  assert.deepEqual(computeDates('2026-10-02'), { signedDay: '2026-10-02', day1Date: '2026-10-16', day30Date: '2026-11-14' });
  assert.equal(computeDates('2026-10-03').day1Date, '2026-10-19'); // Sat 17 Oct → Mon 19 Oct
  assert.equal(computeDates('2026-09-28').day1Date, '2026-10-13'); // Mon 12 Oct is Columbus Day
});

test('DNS evaluators', () => {
  assert.equal(evalSpf([['v=spf1 include:_spf.google.com ~all']]).status, 'pass');
  assert.equal(evalSpf([['v=spf1 include:mailgun.org ~all']]).status, 'fail');
  assert.equal(evalSpf([['v=spf1 include:_spf.google.com ?all']]).status, 'fail');
  assert.equal(evalSpf([]).status, 'fail');
  assert.equal(evalDkim([['v=DKIM1; k=rsa; p=MIIB', 'AQAB']]).status, 'pass');
  assert.equal(evalDmarc([['v=DMARC1; p=none; rua=mailto:dmarc@x.com']], 'x.com').status, 'pass');
  assert.equal(evalDmarc([['v=DMARC1; p=none; rua=mailto:reports@elsewhere.com']], 'x.com').status, 'fail');
  assert.equal(evalDmarc([['v=DMARC1; p=none; rua=mailto:me@owner.com']], 'x.com', 'me@owner.com').status, 'pass');
  assert.equal(evalMx([{ exchange: 'smtp.google.com', priority: 1 }]).status, 'pass');
  assert.equal(evalMx([{ exchange: 'mx.zoho.com', priority: 1 }]).status, 'fail');
  assert.deepEqual(parseAuthResults('Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@x.com;\r\n       spf=pass (google.com: domain of a@x.com)'), { present: true, dkim: 'pass', spf: 'pass' });
  assert.deepEqual(parseAuthResults('Subject: hi'), { present: false, dkim: null, spf: null });
});

test('DNSBL query building', () => {
  assert.equal(reverseIp('203.0.113.5'), '5.113.0.203');
  const q = dnsblQueries(['203.0.113.5', 'not-an-ip'], DEFAULTS.SETUP.dnsbl);
  assert.deepEqual(q.map((x) => x.name), ['5.113.0.203.bl.spamcop.net', '5.113.0.203.b.barracudacentral.org', '5.113.0.203.dnsbl.sorbs.net', '5.113.0.203.spam.dnsbl.sorbs.net']);
  assert.ok(!DEFAULTS.SETUP.dnsbl.some((l) => /spamhaus/.test(l)));
  assert.equal(isListedAnswer(['127.0.0.2']), true);
  assert.equal(isListedAnswer(['127.255.255.254']), false);
  assert.equal(isListedAnswer([]), false);
});

function notFound() { return Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); }

async function setupClient({ spf = 'v=spf1 include:_spf.google.com ~all' } = {}) {
  await createClient('acme', { state: 'setup_check', name: 'Acme', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
  await kv.hset('client:acme:domain', { name: 'getacme.com', autoRenew: 'false' });
  await saveInbox('acme', { email: 'john@getacme.com', password: 'abcdefghijklmnop', displayName: 'John Smith' });
  await saveInbox('acme', { email: 'jsmith@getacme.com', password: 'bcdefghijklmnopq', displayName: 'John Smith' });
  const txt = {
    'getacme.com': [[spf]],
    'google._domainkey.getacme.com': [['v=DKIM1; k=rsa; p=MIIB']],
    '_dmarc.getacme.com': [['v=DMARC1; p=none; rua=mailto:dmarc@getacme.com']],
  };
  io.dns = {
    resolveTxt: async (n) => { if (txt[n]) return txt[n]; throw notFound(); },
    resolveMx: async () => [{ exchange: 'smtp.google.com', priority: 1 }],
    resolve4: async (n) => { if (n === 'getacme.com') return ['203.0.113.5']; if (n === 'smtp.google.com') return ['198.51.100.7']; throw notFound(); },
  };
  io.fetchExt = async () => ({ status: 200, ok: true, url: 'https://www.acme.com/', text: async () => '' });
  io.smtpVerify = async () => ({ success: true });
  io.imapLogin = async () => ({ ok: true, spamFolderExists: true });
  io.sendEmail = async (acct, m) => { emails.push({ key: 'loopback', from: acct.email, to: m.to, subject: m.subject }); return { success: true }; };
  io.imapFindMessage = async (acct, token) => ({ found: true, folder: 'INBOX', headers: `Subject: Setup check ${token}\r\nAuthentication-Results: mx.google.com; dkim=pass header.i=@getacme.com; spf=pass smtp.mailfrom=john@getacme.com` });
}

test('setup checker: all pass → warming, dates, inboxes on, welcome email', async () => {
  await setupClient();
  const now = new Date('2026-10-03T15:00:00Z'); // Saturday → Day 1 lands on Monday 19 Oct
  await startSetupCheck('acme', { all: true, now });
  const first = await runSetupCheck('acme', { now, deadline: Date.now() + 60000 });
  assert.equal(first.phase, 'running');
  assert.deepEqual(first.pending, ['loopback']);
  const lb = emails.find((e) => e.key === 'loopback');
  assert.equal(lb.from, 'john@getacme.com');
  assert.equal(lb.to, 'jsmith@getacme.com');

  const second = await runSetupCheck('acme', { now: new Date(now.getTime() + 60000), deadline: Date.now() + 60000 });
  assert.equal(second.phase, 'passed');
  assert.equal(second.day1Date, '2026-10-19');
  assert.equal((await getClient('acme')).state, 'warming');
  const trial = await getTrial('acme');
  assert.equal(trial.signedDay, '2026-10-03');
  assert.equal(trial.day30Date, '2026-11-17');
  assert.ok(trial.welcomeSentAt);
  const inboxes = await getInboxRecords('acme');
  assert.ok(inboxes.every((i) => i.enabled === '1' && i.warmupStartedAt && i.twoStepVerified === '1'));
  assert.equal(Number((await kv.hgetall('client:acme:counters:total')).sent), 0);
  const welcome = emails.find((e) => e.key === 'welcome_two_dates');
  assert.equal(welcome.vars.day1Date, 'Monday 19 October');
  assert.equal(welcome.vars.approvalDate, 'Saturday 10 October');
  const dom = await kv.hgetall('client:acme:domain');
  assert.equal(dom.spf, 'pass');
  assert.equal(dom.blacklist, 'clean');
  assert.ok(!alerts.some((a) => ['dns_fail', 'inbox_auth_fail', 'loopback_fail', 'blacklisted'].includes(a.key)));
});

test('setup checker: a wrong SPF record keeps setup_check and names the exact record', async () => {
  await setupClient({ spf: 'v=spf1 include:mailgun.org ~all' });
  const now = new Date('2026-10-03T15:00:00Z');
  await startSetupCheck('acme', { all: true, now });
  await runSetupCheck('acme', { now, deadline: Date.now() + 60000 });
  const r = await runSetupCheck('acme', { now: new Date(now.getTime() + 60000), deadline: Date.now() + 60000 });
  assert.equal(r.phase, 'failed');
  assert.deepEqual(r.failed, ['spf']);
  assert.equal((await getClient('acme')).state, 'setup_check');
  const a = alerts.find((x) => x.key === 'dns_fail');
  assert.match(a.body, /v=spf1 include:_spf\.google\.com ~all/);
  // Hourly re-run only repeats what failed; fixing DNS lets it pass.
  io.dns.resolveTxt = async (n) => {
    if (n === 'getacme.com') return [['v=spf1 include:_spf.google.com ~all']];
    if (n === 'google._domainkey.getacme.com') return [['v=DKIM1; p=x']];
    if (n === '_dmarc.getacme.com') return [['v=DMARC1; p=none; rua=mailto:dmarc@getacme.com']];
    throw notFound();
  };
  let smtpCalls = 0;
  io.smtpVerify = async () => { smtpCalls++; return { success: true }; };
  const again = await runSetupCheck('acme', { now: new Date(now.getTime() + 3600e3), deadline: Date.now() + 60000 });
  assert.equal(again.phase, 'passed');
  assert.equal(smtpCalls, 0);
});

test('setup checker: SMTP login failure disables the inbox and alerts', async () => {
  await setupClient();
  io.smtpVerify = async (acct) => (acct.email.startsWith('jsmith') ? { success: false, error: '535 bad credentials' } : { success: true });
  const now = new Date('2026-10-03T15:00:00Z');
  await startSetupCheck('acme', { all: true, now });
  const r = await runSetupCheck('acme', { now, deadline: Date.now() + 60000 });
  assert.equal(r.phase, 'failed');
  assert.ok(r.failed.includes('smtp'));
  const a = alerts.find((x) => x.key === 'inbox_auth_fail');
  assert.equal(a.vars.email, 'jsmith@getacme.com');
  assert.equal((await getInboxRecords('acme')).find((i) => i.email === 'jsmith@getacme.com').enabled, '0');
});

// ── Auth Guard parsers ─────────────────────────────────────────────────────

const DMARC_XML = `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><report_id>123</report_id><date_range><begin>1791158400</begin><end>1791244799</end></date_range></report_metadata><policy_published><domain>getacme.com</domain></policy_published>
<record><row><source_ip>1.2.3.4</source_ip><count>9</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>getacme.com</header_from></identifiers></record>
<record><row><source_ip>5.6.7.8</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>getacme.com</header_from></identifiers></record></feedback>`;

function makeZip(name, data) {
  const comp = zlib.deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, comp, central, n, eocd]);
}

test('DMARC reports: xml, gzip and zip attachments parse to pass counts', () => {
  const rep = parseDmarcXml(DMARC_XML);
  assert.equal(rep.reportId, '123');
  assert.equal(rep.records.length, 2);
  assert.deepEqual(rep.records.map((r) => [r.count, r.pass, r.headerFrom]), [[9, true, 'getacme.com'], [1, false, 'getacme.com']]);
  const data = Buffer.from(DMARC_XML);
  assert.equal(attachmentXml('r.xml.gz', zlib.gzipSync(data)), DMARC_XML);
  assert.equal(attachmentXml('r.zip', makeZip('r.xml', data)), DMARC_XML);
  assert.equal(unzipFirst(makeZip('r.xml', data)).toString(), DMARC_XML);
  assert.throws(() => attachmentXml('x.bin', Buffer.from('hello')));
});

test('DMARC scan stores the 7-day pass rate and pauses a sending client under 80%', async () => {
  process.env.OWNER_INBOX = 'owner@aviance.online:abcdefghijklmnop:Owner';
  await createClient('acme', { state: 'sending', mainDomain: 'acme.com' });
  await kv.hset('client:acme:domain', { name: 'getacme.com' });
  io.imapFetchAttachments = async () => ({ ok: true, maxUid: 7, more: false, messages: [{ uid: 7, subject: 'Report domain: getacme.com', attachments: [{ filename: 'r.xml.gz', content: zlib.gzipSync(Buffer.from(DMARC_XML.replace('<count>9</count>', '<count>3</count>'))) }] }] });
  const { runDmarcScan } = await import('@/lib/systems/authguard');
  const r = await runDmarcScan({ now: new Date('2026-10-06T11:00:00Z') });
  assert.equal(r.reports, 1);
  assert.equal(r.rates.acme, 0.75);
  assert.equal((await getClient('acme')).state, 'paused');
  assert.equal(alerts.at(-1).key, 'dmarc_degraded');
  // Same report again is not counted twice.
  const again = await runDmarcScan({ now: new Date('2026-10-06T11:00:00Z') });
  assert.equal(again.reports, 0);
  delete process.env.OWNER_INBOX;
});

// ── Booking Link Tester ────────────────────────────────────────────────────

test('booking link rules: host detection, slots, length; unknown is not a failure', () => {
  const rules = DEFAULTS.BOOKTEST;
  const now = new Date('2026-10-05T14:00:00Z'); // Monday
  assert.equal(detectHost('https://calendly.com/acme/30min'), 'calendly');
  assert.equal(detectHost('https://acme.com/book', '<form action="/x">'), 'form');
  assert.equal(detectHost('https://acme.com/', '<p>hello</p>'), null);
  const slots = Array.from({ length: 12 }, (_, i) => new Date(Date.parse('2026-10-06T14:00:00Z') + Math.floor(i / 3) * 864e5 + (i % 3) * 3600e3).toISOString());
  assert.deepEqual(evaluateBooking({ status: 200, host: 'calendly', slots, lengthMin: 30 }, rules, now).problems, []);
  const few = evaluateBooking({ status: 200, host: 'calendly', slots: slots.slice(0, 4), lengthMin: 60 }, rules, now);
  assert.equal(few.problems.length, 2);
  assert.match(few.problems[0], /only 4 open slots/);
  assert.match(few.problems[1], /60 minutes/);
  const far = evaluateBooking({ status: 200, host: 'calendly', slots: ['2026-10-20T14:00:00Z', '2026-10-21T14:00:00Z', '2026-10-22T14:00:00Z'], lengthMin: null }, rules, now);
  assert.match(far.problems[0], /business days away/);
  assert.deepEqual(evaluateBooking({ status: 200, host: 'google', slots: null, lengthMin: null }, rules, now), { problems: [], firstSlotDays: null, slots7d: null, lengthMin: null });
  assert.match(evaluateBooking({ status: 404, host: null, slots: null }, rules, now).problems[0], /status 404/);
  assert.deepEqual(parseEmbedded('{"duration":30,"start_time":"2026-10-06T14:00:00Z"}'), { lengthMin: 30, slots: null });
});

test('booking test sends the one-tap request; the tap sets bookingTested', async () => {
  await createClient('acme', { state: 'warming', name: 'Acme', contactName: 'Ann Lee', contactEmail: 'ann@acme.com' });
  await kv.hset('client:acme:trial', { signedDay: '2026-10-02', day1Date: '2026-10-16' });
  await kv.hset('client:acme:profile', { calendarUrl: 'https://tidycal.com/acme/30' });
  io.fetchExt = async () => ({ status: 200, ok: true, url: 'https://tidycal.com/acme/30', text: async () => '<html>TidyCal</html>' });
  const { runBookingTest, confirmBookingOk } = await import('@/lib/systems/bookingtest');
  assert.equal((await runBookingTest('acme', { now: new Date('2026-10-11T14:00:00Z') })).skipped, 'not due');
  const r = await runBookingTest('acme', { now: new Date('2026-10-12T14:00:00Z') });
  assert.equal(r.ok, true);
  const mail = emails.find((e) => e.key === 'booking_test_request');
  const token = mail.vars.link.match(/\/c\/([^/]+)\/booking-ok$/)[1];
  assert.equal((await confirmBookingOk(token)).ok, true);
  assert.equal((await getProfile('acme')).bookingTested, '1');
});

// ── Templates ──────────────────────────────────────────────────────────────

test('every Stage A template renders with sample data; the agreement fills all brackets', () => {
  const sample = {
    firstName: 'Ann', ownerName: 'Limeth', link: 'https://x/c/t/onboard', closeDate: 'Monday 12 October', position: 2,
    expectedLine: 'Soon.', reason: 'because.', minMarket: '1,000', estimate: '500', widenedLine: ' in the areas you gave me', mainDomain: 'acme.com',
    agreementText: 'TEXT', agreementName: 'Ann Lee', agreementTitle: 'CEO', companyName: 'Acme', acceptedAt: '2026-10-05 14:00', agreementIp: '1.2.3.4',
    day1Date: 'Monday 19 October', day30Date: 'Tuesday 17 November', approvalDate: 'Saturday 10 October', calendarUrl: 'https://cal', problem: 'broken.',
    // Onboarding call (accepted_call, accepted_call_reminder, onboard_call_tomorrow, onboard_owner_reply)
    callMinutes: 30, bookingLine: 'Book a time that suits you: https://cal.com/limeth/onboarding', onboardingLink: 'https://x/c/t/onboard',
    threadSubject: "You're in — let's book your onboarding call", when: 'Tuesday, October 13 at 11:00 AM EDT', callDay: 'tomorrow', text: 'Tuesday works.\n\nLimeth',
  };
  for (const key of Object.keys(STAGE_A_TEMPLATES)) {
    const m = renderTemplate(key, sample);
    assert.ok(m.subject && m.text && !/\{[A-Za-z]/.test(m.text), key);
  }
  const text = renderAgreement({ company: 'Acme', date: '5 October 2026', usHours: ['09:00', '17:00'], signerName: 'Limeth Sith' });
  assert.ok(!/\[|\{/.test(text.replace(/\[Company\]/g, '')));
  assert.match(text, /Between Aviance \(“we”\) and Acme \(“you”\)\. Effective 5 October 2026\./);
  assert.throws(() => renderAgreement({ company: 'Acme', date: 'x', usHours: ['09:00', '17:00'], signerName: null }));
});

// ── Jobs and guards ────────────────────────────────────────────────────────

test('stage A jobs respect state, skip aviance, and pick the right period', async () => {
  const { JOBS } = await import('@/lib/joblist/stage-a');
  const job = (n) => JOBS.find((j) => j.name === n);
  const at10 = new Date('2026-10-05T14:30:00Z'); // 10:30 ET
  const at9 = new Date('2026-10-05T13:30:00Z'); // 09:30 ET
  assert.equal(await job('onboarding-nudge').due({ client: { id: 'acme', state: 'onboarding' }, now: at10 }), '2026-10-05');
  assert.equal(await job('onboarding-nudge').due({ client: { id: 'acme', state: 'onboarding' }, now: at9 }), null);
  assert.equal(await job('onboarding-nudge').due({ client: { id: 'aviance', state: 'onboarding' }, now: at10 }), null);
  assert.equal(await job('onboarding-nudge').due({ client: { id: 'acme', state: 'queued' }, now: at10 }), null);
  assert.equal(await job('setup-check').due({ client: { id: 'acme', state: 'setup_check', intakeStep: 'setup_running' }, now: at10 }), '2026-10-05T10:30');
  assert.equal(await job('setup-check').due({ client: { id: 'acme', state: 'setup_check', intakeStep: '' }, now: at10 }), '2026-10-05T10');
  assert.equal(await job('market').due({ client: { id: 'acme', state: 'onboarding', intakeStep: '' }, now: at10 }), null);
  assert.equal(await job('market').due({ client: { id: 'acme', state: 'onboarding', intakeStep: 'market' }, now: at10 }), '2026-10-05T10:30');
  assert.equal(await job('pricescout').due({ client: { id: 'acme', state: 'onboarding', intakeStep: 'pricescout' }, now: at10 }), null);
  assert.equal(await job('auth').due({ client: { id: 'acme', state: 'sending' }, now: at10 }), '2026-10-05');
  assert.equal(await job('auth').due({ client: { id: 'acme', state: 'declined' }, now: at10 }), null);
  assert.equal(await job('booking-reminder').due({ client: { id: 'acme', state: 'sending' }, now: at10 }), null);
  assert.equal(await job('promo-check').due({ now: new Date('2026-11-01T14:30:00Z') }), '2026-11');
  assert.equal(await job('promo-check').due({ now: at10 }), null);
});

test('server-side fetches only go to public hosts', async () => {
  const { isPublicUrl } = await import('@/lib/systems/intake-io');
  assert.ok(isPublicUrl('https://calendly.com/acme/30min'));
  for (const bad of ['http://localhost:3000', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'https://10.0.0.2', 'http://192.168.1.1', 'ftp://x.com', 'https://user:pw@x.com', 'http://metadata.internal', 'http://[::1]/']) {
    assert.equal(isPublicUrl(bad), false, bad);
  }
});
