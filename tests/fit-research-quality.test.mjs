// Fit score and research quality (fitscore.js, research.js, deepsite.js, researchbrief.js, gatekeeper.js):
// the competitor rule needs strong evidence, a dealbreaker caps the score, research drops site furniture,
// and age / revenue say how sure they are. Fixture HTML only (example.com / .test domains), no live sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFit, fitScoreLine, ageFrom, competitorCheck, outreachOffer } from '@/lib/systems/fitscore';
import { pageSignals, mergeSignals, copyrightFrom } from '@/lib/systems/fitsignals';
import { detectAgency } from '@/lib/systems/gatekeeper';
import { extractPage, mergeFacts, websiteOut, yearsFacts, isServiceLike, customerCountFacts, yearlyPrice, revenueEstimate } from '@/lib/systems/research';
import { clientsOn, isSiteJunk } from '@/lib/systems/deepsite';
import { buildBrief } from '@/lib/systems/researchbrief';
import { revenueRange, BENCHMARKS } from '@/lib/systems/bizintel';
import { DEFAULTS } from '@/lib/config';

const NOW = new Date('2026-11-19T12:00:00Z');
const LIMITS = { maxServices: 12, maxLocations: 10, maxPhones: 5, maxEmails: 5 };
const KEYWORDS = DEFAULTS.INTAKE.agencyKeywords;
const APP = {
  web_city: 'Denver, CO', web_state: 'CO', dealValue: '6000', web_valueBand: '$5,000–$20,000', slotsPerWeek: '6', web_capacityBand: '5–10 a week',
  soldToStrangers: 'yes', web_strangersAnswer: 'Yes', meetWithin5Days: 'yes', web_calendarAnswer: 'Yes', web_ifItWorks: 'Move to Growth',
};
const filler = (line, n = 60) => Array.from({ length: n }, () => line).join('\n');

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A field-service software company: says "leads" and "lead generation" all over, sells scheduling software. */
const FIELD_HOME = `<!doctype html><html><head>
<title>FieldPro | Scheduling, Dispatch and Invoicing Software for HVAC Contractors</title>
<meta name="description" content="Scheduling, dispatching, invoicing and lead generation tools for HVAC and plumbing contractors. Turn more leads into booked jobs.">
</head><body>
<nav><a href="/">Home</a><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/login">Login</a><a href="/signup">Get started</a></nav>
<main><h1>Run your field service business from one app</h1>
<h2>What we do</h2>
<h3>Scheduling</h3><h3>Dispatching</h3><h3>Invoicing</h3><h3>Lead Generation</h3><h3>Inventory Tracking</h3>
<h2>Loved by contractors</h2>
<div class="badges"><img alt="G2 Leader Winter 2026"><img alt="Capterra Best Value"></div>
<h3>Capterra</h3><h3>G2 High Performer</h3>
<p>Trusted by 2,500+ contractors across the US. Request a demo for your business owners and dispatch managers.</p>
<p>Lead generation for contractors starts with fast quotes. Lead generation, lead generation, lead generation and more lead generation tips on our blog.</p>
${filler('Schedule jobs, dispatch technicians and send invoices from the field for commercial customers.')}
</main><footer>© 2009–2026 FieldPro Software Inc.</footer></body></html>`;

/** A commercial cleaning company whose pages talk about "marketing" and "leads". */
const CLEAN_HOME = `<html><head><title>Sparkle Commercial Cleaning | Office Janitorial in Denver</title>
<meta name="description" content="Commercial cleaning and janitorial services for offices, clinics and property managers in Denver."></head><body><main>
<h1>Commercial cleaning for Denver offices</h1>
<p>Our marketing team answers new leads within an hour. We follow up on every lead and every outbound inquiry.</p>
<p>Family owned since 2004. Serving property managers and facility managers with nightly janitorial contracts.</p>
${filler('Office cleaning, floor care and day porter service for commercial buildings under annual contracts.')}
</main></body></html>`;

/** A real competitor: an appointment-setting agency. */
const AGENCY_HOME = `<html><head><title>Pipeline Partners | B2B Appointment Setting Agency</title>
<meta name="description" content="We book qualified sales meetings for B2B companies with cold email and LinkedIn outreach."></head><body><main>
<h1>Outsourced SDRs who fill your calendar</h1>
<h2>Our services</h2><h3>Cold Email Outreach</h3><h3>Appointment Setting</h3><h3>LinkedIn Outreach</h3>
${filler('Cold email campaigns, appointment setting and lead generation for B2B companies and SaaS firms.')}
</main></body></html>`;

const site = (html, url = 'https://www.fieldpro.test/') => {
  const page = extractPage(html, { url, kind: 'home' });
  const acc = mergeFacts(null, page, 'home');
  return { page, acc, website: websiteOut(acc, { url, pagesRead: 1, limits: LIMITS }) };
};
const scoreOf = (html, url, sellsTo, customers) => {
  const { acc, website } = site(html, url);
  const agencyHit = detectAgency([website.title, website.description, website.headline, sellsTo].filter(Boolean).join('\n'), KEYWORDS);
  return scoreFit({
    now: NOW, application: { ...APP, web_sellsTo: sellsTo }, customers, website: { ...website, phones: ['(303) 555-0100'], locations: ['Denver, CO'] }, signals: acc.signals,
    business: { rating: 4.7, reviews: 40, address: '1 Main St, Denver, CO 80202' }, market: { estimate: 3000, query: 'x', source: 'places' }, registeredAt: '2009-01-01T00:00:00Z', teamText: 'Website says a team of 20', agencyHit,
  });
};

// ── 1. competitor: strong evidence only ─────────────────────────────────────

test('competitor false positive: a field-service software company that says "lead generation" is not an agency', () => {
  const sells = 'Scheduling, invoicing and lead generation software for HVAC and plumbing contractors';
  const f = scoreOf(FIELD_HOME, 'https://www.fieldpro.test/', sells, 'HVAC and plumbing contractors');
  assert.ok(!f.dealbreakers.some((d) => /competitor|agency|cold outreach|everyone already emails/i.test(d.text)), JSON.stringify(f.dealbreakers));
  assert.notEqual(f.label, 'Not a fit');
  // The words are still worth a question: a warning, never a dealbreaker.
  assert.ok(f.warnings.some((w) => /check they are not a competitor/.test(w.text)), JSON.stringify(f.warnings));
  assert.ok(f.questions.includes('Do you sell lead generation, cold email or appointment setting to your own clients?'));
  assert.equal(detectAgency('FieldPro | Scheduling, dispatching, invoicing and lead generation for HVAC contractors', KEYWORDS), null);
  // Before: any of these words anywhere made a dealbreaker.
  assert.equal(detectAgency('We tried a lead generation agency before and it did not work', KEYWORDS), null, 'their notes about a past agency');
});

test('competitor false positive: a cleaning company whose pages mention marketing and leads', () => {
  const f = scoreOf(CLEAN_HOME, 'https://www.sparkle-clean.test/', 'Commercial cleaning for offices and property managers in Denver', 'offices and property managers');
  assert.deepEqual(f.dealbreakers, []);
  assert.ok(['Strong fit', 'Good fit'].includes(f.label), `${f.score} ${f.label}`);
  assert.equal(competitorCheck({ sells: 'Commercial cleaning for offices', website: { title: 'Sparkle Commercial Cleaning' }, signals: {} }).hard, undefined);
});

test('competitor true positive: an appointment-setting agency is a dealbreaker, and the score is capped', () => {
  const f = scoreOf(AGENCY_HOME, 'https://www.pipeline-partners.test/', 'Appointment setting and cold email outreach for B2B companies', 'B2B companies');
  assert.ok(f.dealbreakers.some((d) => /competitor/.test(d.text)), JSON.stringify(f.dealbreakers));
  assert.equal(f.label, 'Not a fit');
  assert.equal(f.grade, 'D');
  assert.ok(f.score <= 40, `score ${f.score}`);
  // Each way the evidence can come in.
  assert.ok(competitorCheck({ sells: 'Lead generation for roofing companies', signals: {} }).hard, 'their answer opens with it');
  assert.ok(competitorCheck({ sells: 'IT', website: { title: 'Acme | Outsourced SDR services' }, signals: {} }).hard, 'their title names it');
  assert.ok(competitorCheck({ sells: 'B2B growth', website: { services: ['Cold Email', 'Appointment Setting', 'Lead Generation', 'Copywriting'] }, signals: {} }).hard, 'most services are outreach');
  assert.ok(!competitorCheck({ sells: 'Field software', website: { services: ['Scheduling', 'Dispatching', 'Invoicing', 'Lead Generation'] }, signals: {} }).hard, 'one outreach feature among many');
  assert.equal(outreachOffer('We book meetings for SaaS founders'), 'we book meetings for');
  assert.equal(outreachOffer('Scheduling, invoicing and lead generation for HVAC'), null);
  assert.equal(detectAgency('Pipeline Partners | B2B Appointment Setting Agency', KEYWORDS), 'appointment setting');
});

// ── 2. score and verdict agree ──────────────────────────────────────────────

test('a dealbreaker caps the score: never "100/100 — not a fit"', () => {
  const ok = scoreOf(CLEAN_HOME, 'https://www.sparkle-clean.test/', 'Commercial cleaning for offices and property managers in Denver', 'offices and property managers');
  const { acc, website } = site(CLEAN_HOME, 'https://www.sparkle-clean.test/');
  const bad = scoreFit({
    now: NOW, application: { ...APP, web_sellsTo: 'Commercial cleaning for offices and property managers in Denver', soldToStrangers: 'no', web_strangersAnswer: 'Referrals only' },
    customers: 'offices and property managers', website: { ...website, phones: ['1'], locations: ['Denver, CO'] }, signals: acc.signals,
    business: { rating: 4.9, reviews: 80 }, market: { estimate: 3000, query: 'x', source: 'places' }, registeredAt: '2004-01-01T00:00:00Z', teamText: 'Website says a team of 20',
  });
  assert.ok(ok.score > 40, 'the same company without the dealbreaker scores high');
  assert.equal(bad.label, 'Not a fit');
  assert.equal(bad.score, 40);
  assert.equal(bad.capped, true);
  assert.ok(bad.pointsScore > 40, `points ${bad.pointsScore}`);
  assert.match(bad.summary, /^40\/100 — not a fit: Has never sold to strangers.*Capped at 40 by the dealbreaker; the other checks came to \d+\/100\.$/);
  assert.match(fitScoreLine(bad), /^Fit score: 40\/100 \(D\) — Not a fit.*\(Capped; the other checks came to \d+\/100\.\)$/);
  // Invariant over many variants: "Not a fit" never shows a high score.
  for (const over of [{ soldToStrangers: 'no' }, { meetWithin5Days: 'no', web_calendarAnswer: 'No' }, { dealValue: '500' }, { usBased: 'no' }, { web_sellsTo: 'Cold email agency for SaaS' }]) {
    const f = scoreFit({ now: NOW, application: { ...APP, web_sellsTo: 'Commercial cleaning for offices', ...over }, customers: 'offices', website: { ...website, phones: ['1'], locations: ['Denver, CO'] }, signals: acc.signals, business: { rating: 4.9, reviews: 80 }, market: { estimate: 3000, query: 'x', source: 'places' }, teamText: 'Website says a team of 20' });
    assert.equal(f.label, 'Not a fit', JSON.stringify(over));
    assert.ok(f.score === null || f.score <= 40, `${JSON.stringify(over)} → ${f.score}`);
  }
});

// ── 3. junk out of the research ─────────────────────────────────────────────

test('services: menu words, buttons and badges are dropped; a "What we do" section is the list', () => {
  const { page, website } = site(FIELD_HOME);
  assert.deepEqual(page.services.headings, ['Scheduling', 'Dispatching', 'Invoicing', 'Lead Generation', 'Inventory Tracking']);
  assert.ok(!website.services.some((s) => /capterra|g2|home|login|get started|pricing/i.test(s)), JSON.stringify(website.services));
  for (const junk of ['Capterra', 'G2 High Performer', 'BBB A+', 'Home', 'Login', 'Get started', 'Pricing', 'Request a demo', 'Download on the App Store', 'Winter 2026 Leader']) assert.equal(isServiceLike(junk), false, junk);
  for (const real of ['Drain Cleaning', 'Managed IT Services', 'Review Management', 'Floor Care']) assert.equal(isServiceLike(real), true, real);
  // No services section and no real headings: nothing, never padded.
  const empty = site('<html><head><title>X</title></head><body><nav><a href="/">Home</a><a href="/about">About</a></nav><main><h3>Capterra</h3><h3>Get started</h3><h3>Contact</h3></main></body></html>', 'https://www.example.com/');
  assert.deepEqual(empty.website.services, []);
  const brief = buildBrief({ name: 'Example Co', origin: 'https://www.example.com', website: { ...empty.website, title: null, description: null, headline: null } });
  assert.equal(brief.sentences[0].text, 'Their website does not clearly list what Example Co sells — ask on the call.');
});

test('clients: only real client sections; badges, partner strips, payment and social logos are not clients; deduped', () => {
  const html = `<html><body>
<nav><ul class="client-menu"><li>Home</li><li>About</li><li>Contact</li><li>Login</li></ul></nav>
<main>
<h2>Trusted by</h2>
<img alt="Northwind Traders logo"><img alt="Contoso Dental"><img alt="G2 Leader Winter 2026"><img alt="Capterra"><img alt="logo"><img alt="northwind traders">
<h2>Our awards</h2><img alt="Inc. 5000"><img alt="Best Places to Work 2025">
<section class="partner-logos"><img alt="Microsoft Partner"><img alt="AWS"></section>
<div class="badge-strip"><img alt="BBB A+ Rating"><img alt="Trustpilot 5 stars"></div>
<section class="client-logos"><img alt="Fabrikam Manufacturing"><img alt="Home"><img alt="Get started"><img alt="Visa"><img alt="LinkedIn"></section>
<p>Our clients include Tailspin Toys, Hollis & Grant Law and many more.</p>
</main>
<footer><div class="logos"><img alt="Mastercard"><img alt="PayPal"><img alt="Northwind Traders"></div></footer>
</body></html>`;
  assert.deepEqual(clientsOn(html), ['Fabrikam Manufacturing', 'Northwind Traders', 'Contoso Dental', 'Tailspin Toys', 'Hollis & Grant Law']);
  assert.deepEqual(clientsOn('<main><h2>Trusted by</h2><img alt="G2 Leader"><img alt="Capterra"><img alt="BBB"></main>'), [], 'nothing solid: none (never padded)');
  for (const junk of ['G2 Leader Winter 2026', 'Capterra', 'BBB', 'Home', 'Get started', 'Login', 'img_0423.png', 'Download on the App Store']) assert.equal(isSiteJunk(junk), true, junk);
  assert.equal(isSiteJunk('Northwind Traders'), false);
});

// ── 4. age and revenue: the signals, and how sure ───────────────────────────

test('age: the oldest stated year wins, © years and other floors read "at least"', () => {
  assert.equal(yearsFacts('Since 2020 we have added HVAC service. Founded in 1998 by Ann Lee.', null, { year: 2026 }), 'Founded in 1998', 'before: "Since 2020" would not have been beaten');
  assert.equal(yearsFacts('Serving Denver since 2011. In business since 2004.', null, { year: 2026 }), 'Since 2004');
  assert.equal(yearsFacts('We have served Denver for over 20 years.', null, { year: 2026 }), 'for over 20 years');
  assert.equal(copyrightFrom('© 1998–2026 Acme Inc. All rights reserved.'), 1998);
  // Over the pages: home "since 2020", about "founded in 1998" → 1998 (the old rule kept the first page's).
  let acc = mergeFacts(null, extractPage('<html><body><p>New: since 2020 we install heat pumps.</p></body></html>', { url: 'https://www.example.com/', kind: 'home' }), 'home');
  acc = mergeFacts(acc, extractPage('<html><body><p>Founded in 1998 in Denver.</p></body></html>', { url: 'https://www.example.com/about', kind: 'about' }), 'about');
  assert.equal(acc.yearsHint, 'Founded in 1998');
  assert.equal(acc.src.years, '/about');

  assert.deepEqual(ageFrom({ yearsHint: 'Founded in 2005', now: NOW }), { years: 21, sure: 'about', source: 'website: Founded in 2005', year: 2005 });
  assert.deepEqual(ageFrom({ copyrightFrom: 1998, now: NOW }), { years: 28, sure: 'at least', source: '© 1998 on their website', year: 1998 });
  const older = ageFrom({ yearsHint: 'Since 2022', registeredAt: '2003-05-01T00:00:00Z', now: NOW });
  assert.equal(older.years, 23, 'a domain from 2003 beats a stated "since 2022"');
  assert.equal(older.sure, 'at least');
  assert.equal(ageFrom({ now: NOW }), null, 'nothing: unknown, not zero');

  // In the score: the FieldPro © 2009 line counts when nothing else does.
  const { acc: f } = site(FIELD_HOME);
  const s = scoreFit({ now: NOW, application: APP, website: { pagesRead: 1 }, signals: f.signals });
  const ageLine = s.parts.find((p) => p.key === 'size').items.find((i) => /business/.test(i.text));
  assert.equal(ageLine.text, 'In business at least 17 years (© 2009 on their website)');
  const b = buildBrief({ name: 'FieldPro', origin: 'https://www.fieldpro.test', website: { pagesRead: 1, services: ['Scheduling'] }, signals: f.signals, now: NOW });
  assert.ok(b.sentences.some((x) => x.text === 'FieldPro has been around since at least 2009 (the © line on their website).'), JSON.stringify(b.sentences));
});

test('revenue: customer counts, prices and headcounts as floors; "about", "at least" or "unknown"', () => {
  assert.deepEqual(customerCountFacts('Trusted by 2,500+ contractors across the US.'), { n: 2500, quote: 'Trusted by 2,500+ contractors' });
  assert.deepEqual(customerCountFacts('Over 500 businesses use Acme.'), { n: 500, quote: 'Over 500 businesses' });
  assert.equal(customerCountFacts('We answer 10 calls a day.'), null);
  assert.equal(yearlyPrice('$49/mo'), 588);
  assert.equal(yearlyPrice('$29 per user / month'), 348);
  assert.equal(yearlyPrice('$1,200 per year'), 1200);
  assert.equal(yearlyPrice('Custom'), null);

  // 4 named people on a team page (a floor) said "$560k–$1M" before. Their 2,500 customers on a $49/mo plan say far more.
  const team = revenueRange({ headcount: 4, headcountExact: false, bench: BENCHMARKS['trial-default'] });
  const { acc } = site(FIELD_HOME);
  assert.deepEqual(acc.customerCount, { n: 2500, quote: 'Trusted by 2,500+ contractors', page: '/' });
  const est = revenueEstimate({ ranges: team, customers: acc.customerCount, plans: [{ name: 'Starter', price: '$49/mo', page: '/pricing' }] });
  assert.equal(est.sure, 'at least');
  assert.equal(est.low, 1470000);
  assert.equal(est.text, 'at least $1.5M a year');
  assert.match(est.basis[0], /Trusted by 2,500\+ contractors.*Starter, \$49\/mo/);
  // An exact headcount gives a range ("about"); nothing gives "unknown" (never a made-up low number).
  const exact = revenueEstimate({ ranges: revenueRange({ headcount: 20, headcountExact: true, bench: BENCHMARKS['trial-default'] }) });
  assert.deepEqual([exact.sure, exact.text], ['about', 'about $3M–$5M a year']);
  assert.deepEqual([revenueEstimate({}).sure, revenueEstimate({}).text], ['unknown', 'unknown']);
  // In the brief.
  const brief = (estimate) => buildBrief({ name: 'FieldPro', origin: 'https://www.fieldpro.test', website: { pagesRead: 1, services: ['Scheduling'] }, deep: { pagesRead: 1, offers: { plans: [{ name: 'Starter', price: '$49/mo', page: '/pricing' }] }, tech: [], money: { revenue: team, estimate } }, max: 20 }).sentences.map((s) => s.text);
  assert.ok(brief(est).some((t) => /^Revenue is at least \$1\.5M a year \(“Trusted by 2,500\+ contractors” × their cheapest plan/.test(t)), JSON.stringify(brief(est)));
  assert.ok(brief(revenueEstimate({})).includes('Revenue is unknown (no headcount, payroll or customer count found) — ask them.'));
  assert.ok(!brief(est).some((t) => /\$560k–\$1M/.test(t)), 'the old low floor is not shown as the size');
});
