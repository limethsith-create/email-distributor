// Fit Score: the applicant against the owner's fit gate, facts only (systems/fitscore.js, fitsignals.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFit, fitScoreLine, yearsFrom, teamFrom } from '@/lib/systems/fitscore';
import { pageSignals, mergeSignals, copyrightYear } from '@/lib/systems/fitsignals';

const NOW = new Date('2026-09-25T12:00:00Z');
const GOOD_APP = {
  web_sellsTo: 'Managed IT support for 10–50 person law and accounting firms in Austin', web_city: 'Austin, TX', web_state: 'TX',
  dealValue: '5000', web_valueBand: '$5,000–$20,000', slotsPerWeek: '5', web_capacityBand: '5–10 a week',
  soldToStrangers: 'yes', web_strangersAnswer: 'Yes — cold buyers already', meetWithin5Days: 'yes', web_calendarAnswer: 'Yes',
  web_ifItWorks: 'Move to Growth — 20 calls a month',
};
const SITE = [
  'Managed IT services for law firms and accounting firms across Austin.',
  'We look after 40 professional services firms with a flat monthly plan per user.',
  'Request a quote or book a call with our team. Testimonials: "They fixed everything."',
  'Our team of 18 engineers has served Austin since 2011. We are hiring. © 2011–2026 Hill IT',
  ...Array.from({ length: 80 }, () => 'Backups, security, email and help desk support for offices.'),
].join('\n');
const signals = () => pageSignals(SITE, { hrefs: ['https://calendly.com/hill-it/15min', '/careers', '/case-studies'], page: '/' });
const base = (over = {}) => ({
  now: NOW, application: GOOD_APP, customers: '10–50 person law and accounting', signals: signals(),
  website: { pagesRead: 4, phones: ['(512) 555-0100'], locations: ['Austin, TX'], yearsHint: 'Since 2011' },
  business: { rating: 4.8, reviews: 52, address: '1 Congress Ave, Austin, TX 78701' },
  market: { estimate: 2400, query: 'law firms in Austin, TX', source: 'places' }, registeredAt: '2011-02-01T00:00:00Z', teamText: 'Website says a team of 18', ...over,
});

test('signals: words on the page with a quote and the page it came from', () => {
  const s = signals();
  assert.ok(s.b2b.n >= 3);
  assert.equal(s.b2b.ev[0].page, '/');
  assert.match(s.b2b.ev[0].quote, /law firms/);
  assert.ok(s.highTicket.n >= 2);
  assert.ok(s.booking.ev.some((e) => /calendly\.com/.test(e.quote)));
  assert.ok(s.careersPage && s.proofPage);
  assert.equal(s.copyrightYear, 2026);
  assert.equal(copyrightYear('Copyright 2019 Acme'), 2019);
  const merged = mergeSignals(s, pageSignals('Our clients include manufacturers.', { page: '/about' }));
  assert.equal(merged.b2b.n, s.b2b.n + 2);
  assert.equal(merged.words, s.words + 4);
});

test('a strong applicant: A, every part explained, most points checked', () => {
  const f = scoreFit(base());
  assert.equal(f.grade, 'A');
  assert.equal(f.label, 'Strong fit');
  assert.ok(f.score >= 80, `score ${f.score}`);
  assert.ok(f.confidence >= 80, `confidence ${f.confidence}`);
  assert.deepEqual(f.parts.map((p) => p.key), ['b2b', 'deal', 'size', 'proof', 'market', 'ready']);
  assert.equal(f.parts.reduce((s, p) => s + p.max, 0), 100);
  for (const p of f.parts) for (const i of p.items) assert.doesNotMatch(i.text, /undefined|null|NaN/);
  const team = f.parts.find((p) => p.key === 'size').items[0];
  assert.equal(team.text, 'About 18 people (Website says a team of 18) — inside 5–50');
  assert.deepEqual(f.dealbreakers, []);
  assert.match(fitScoreLine(f), /^Fit score: \d+\/100 \(A\) — Strong fit/);
});

test('unknowns are never guessed or punished: they are left out and become questions', () => {
  const f = scoreFit(base({ business: null, placesNote: 'no_key', market: null, application: { ...GOOD_APP, soldToStrangers: undefined } }));
  const unknown = f.parts.flatMap((p) => p.items).filter((i) => i.status === 'unknown');
  assert.ok(unknown.length >= 3);
  for (const i of unknown) assert.equal(i.points, null);
  assert.ok(f.questions.includes('Has anyone outside your network ever bought from you?'));
  assert.ok(f.questions.includes('Roughly how many companies could buy from you in your area?'));
  assert.ok(f.confidence < scoreFit(base()).confidence);
  assert.ok(f.score >= 80, 'facts that were checked still carry the score');
});

test('dealbreakers from the fit gate make it D / Not a fit, the worst first', () => {
  const agency = scoreFit(base({ application: { ...GOOD_APP, web_sellsTo: 'Cold email software for agencies' } }));
  assert.equal(agency.grade, 'D');
  assert.equal(agency.label, 'Not a fit');
  assert.match(agency.dealbreakers[0].text, /Sells cold outreach themselves/);
  const cheap = scoreFit(base({ application: { ...GOOD_APP, dealValue: '0', web_valueBand: 'Under $2,000' } }));
  assert.ok(cheap.dealbreakers.some((d) => /worth under \$2,000/.test(d.text)));
  const referrals = scoreFit(base({ application: { ...GOOD_APP, soldToStrangers: 'no' } }));
  assert.ok(referrals.dealbreakers.some((d) => /never sold to strangers/.test(d.text)));
  const consumers = scoreFit(base({ application: { ...GOOD_APP, web_sellsTo: 'Pool cleaning for homeowners in Austin' }, customers: 'homeowners' }));
  assert.ok(consumers.dealbreakers.some((d) => /consumers/.test(d.text)));
  const slow = scoreFit(base({ application: { ...GOOD_APP, meetWithin5Days: 'no', web_calendarAnswer: 'No — my calendar is tight' } }));
  assert.ok(slow.dealbreakers.some((d) => /five business days/.test(d.text)));
  const banned = scoreFit(base({ signals: mergeSignals(signals(), pageSignals('CBD and cannabis dispensary supplies. Cannabis delivery.', { page: '/' })) }));
  assert.ok(banned.dealbreakers.some((d) => /not allowed/.test(d.text)));
  const small = scoreFit(base({ market: { estimate: 300, query: 'x', source: 'places' } }));
  assert.ok(small.dealbreakers.some((d) => /Market too small/.test(d.text)));
  // The rough OpenStreetMap name count never turns anyone down.
  const rough = scoreFit(base({ market: { estimate: 12, query: 'x', source: 'overpass' } }));
  assert.equal(rough.dealbreakers.length, 0);
  const agencies = scoreFit(base({ application: { ...GOOD_APP, web_sellsTo: 'Web design for marketing agencies' }, customers: 'marketing agencies' }));
  assert.ok(agencies.dealbreakers.some((d) => /everyone already emails/.test(d.text)));
});

test('a blank or unreadable website is "Needs a look", never a grade on answers alone', () => {
  const blank = scoreFit(base({ signals: pageSignals('Example Domain. This domain is for use in examples.', { page: '/' }), website: { pagesRead: 1 } }));
  assert.equal(blank.label, 'Needs a look');
  assert.match(blank.summary, /website says almost nothing/);
  const down = scoreFit(base({ homeError: 'timed out', website: { pagesRead: 0 }, signals: {} }));
  assert.equal(down.label, 'Needs a look');
  assert.match(down.summary, /could not be read/);
});

test('helpers: years and team size are read, not guessed', () => {
  assert.equal(yearsFrom('Since 2011', NOW), 15);
  assert.equal(yearsFrom('25+ years in business', NOW), 25);
  assert.equal(yearsFrom(null, NOW), null);
  assert.deepEqual(teamFrom({ teamCount: 4 }), { n: 4, source: '4 people on their team page', exact: false });
  assert.equal(teamFrom({}), null);
  const f = scoreFit(base({ teamText: null, teamCount: 4 }));
  assert.equal(f.parts.find((p) => p.key === 'size').items[0].status, 'unknown', 'a short team page is a minimum, not the size');
});
