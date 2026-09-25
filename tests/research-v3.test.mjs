// Research v3: the whole site, documents, offers, email setup, money on the public record, history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseSitemap, pickPages, deepFactsOf, mergeDeep, emptyDeep, pdfText, docFacts, offersOn, countFacts, techOn } from '@/lib/systems/deepsite';
import { emailSetupFrom, historyFrom, lookalikeCandidates, outboundSignal } from '@/lib/systems/webintel';
import { payrollFromPpp, sameCompany, revenueRange, benchmarkFor, BENCHMARKS, yearlyCaptures, snapshotFacts, federalMoney } from '@/lib/systems/bizintel';
import { io } from '@/lib/systems/intake-io';

const ORIGIN = 'https://www.hill-it.com';

test('sitemap: pages and indexes; company pages first, posts capped, junk skipped', () => {
  const idx = parseSitemap('<sitemapindex><sitemap><loc>https://www.hill-it.com/page-sitemap.xml</loc></sitemap></sitemapindex>');
  assert.equal(idx.index, true);
  assert.deepEqual(idx.locs, ['https://www.hill-it.com/page-sitemap.xml']);
  const urls = ['/blog/a', '/blog/b', '/blog/c', '/blog/d', '/about-us/', '/team', '/wp-login.php', '/tag/x/', '/services/cloud', '/image.png', 'https://other.com/about', '/case-studies/law-firm'].map((p) => new URL(p, ORIGIN).href);
  const pick = pickPages(urls, { origin: ORIGIN, done: ['https://hill-it.com/team'], max: 6 });
  assert.equal(pick[0], `${ORIGIN}/about-us/`);
  assert.ok(!pick.some((u) => /wp-login|tag\/|image\.png|other\.com|\/team$/.test(u)));
  assert.ok(pick.filter((u) => u.includes('/blog/')).length <= 2, 'posts get at most a third of the budget');
});

const PAGE = `<html><head><title>Hill IT | Managed IT for Law Firms</title>
<script src="https://js.hs-scripts.com/123.js"></script><script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>gtag('config','G-1')</script>
<script type="application/ld+json">{"@type":"Organization","name":"Hill IT","foundingDate":"2011","numberOfEmployees":{"value":18}}</script></head><body>
<h1>IT that law firms trust</h1>
<div class="team"><h3>Jane Hill</h3><p>Founder &amp; CEO</p><h3>Mark Stone</h3><p>Network Engineer</p></div>
<section class="clients-logos"><img alt="Smith &amp; Lowe Law logo"><img alt="Carolina CPA Group"></section>
<blockquote>They answered in ten minutes and fixed our server the same day. — Ann Lowe, Smith &amp; Lowe Law</blockquote>
<p>Proud Microsoft Solutions Partner for Modern Work. SOC 2 aligned. Veteran-owned since 2011. We serve law firms and accounting firms.</p>
<p>Plans from $129 per user per month. No long-term contracts. 15-minute response time guaranteed.</p>
<a href="/contact" class="btn">Get a free network assessment</a><a href="/downloads/it-buyers-guide.pdf">Download the free IT buyer's guide</a>
<address>100 Main St, Suite 200, Charlotte, NC 28202</address>
</body></html>`;

test('one page gives people, clients, testimonials, credentials, industries, prices, offers, address, tools and company data', () => {
  const f = deepFactsOf(PAGE, { url: `${ORIGIN}/about` });
  assert.deepEqual(f.people.map((p) => [p.name, p.title]), [['Jane Hill', 'Founder & CEO'], ['Mark Stone', 'Network Engineer']]);
  assert.deepEqual(f.clients.map((c) => c.name), ['Smith & Lowe Law', 'Carolina CPA Group']);
  assert.equal(f.testimonials[0].by, 'Ann Lowe, Smith & Lowe Law');
  const creds = f.credentials.map((c) => c.name);
  for (const c of ['Microsoft Solutions Partner', 'SOC 2', 'Veteran-owned']) assert.ok(creds.includes(c), c);
  assert.ok(f.industries.includes('law firms') && f.industries.includes('accounting'));
  assert.equal(f.prices[0].text, 'from $129 per user per month');
  assert.deepEqual(f.addresses, ['100 Main St, Suite 200, Charlotte, NC 28202']);
  assert.ok(f.offers.ctas.includes('Get a free network assessment'));
  assert.ok(f.offers.promos.some((p) => /no long-term contracts/i.test(p.offer)));
  assert.ok(f.offers.promos.some((p) => /15-minute response/i.test(p.offer)));
  assert.equal(f.offers.magnets[0].title, "Download the free IT buyer's guide");
  const tools = f.tech.map((t) => t.name);
  for (const t of ['HubSpot', 'Meta Pixel', 'Google Analytics']) assert.ok(tools.includes(t), t);
  assert.equal(f.org.name, 'Hill IT');
  assert.equal(f.org.foundingDate, '2011');
  const acc = mergeDeep(mergeDeep(emptyDeep(), f), deepFactsOf(PAGE, { url: `${ORIGIN}/team` }));
  assert.equal(acc.people.length, 2, 'the same person twice is one person');
  assert.ok(countFacts(acc) > 25);
  assert.deepEqual(techOn('<div>plain</div>'), []);
});

test('offers: named packages with their price on a pricing page', () => {
  const o = offersOn('<h3>Essentials</h3><p>$99 per user / month</p><h3>Complete</h3><p>$149 per user / month</p>', '/pricing');
  assert.deepEqual(o.plans.map((p) => [p.name, p.price]), [['Essentials', '$99 per user / month'], ['Complete', '$149 per user / month']]);
});

test('PDF text without a library: Flate streams and Tj/TJ strings', () => {
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (Capability Statement) Tj T* [(CMMC Level 2 ) (and HIPAA compliant)] TJ ET'));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Title (Hill IT Capabilities) >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Length 99 /Filter /FlateDecode >> stream\n'), content, Buffer.from('\nendstream endobj\n%%EOF')]);
  const t = pdfText(pdf, { inflate: zlib.inflateSync });
  assert.equal(t.title, 'Hill IT Capabilities');
  assert.equal(t.pages, 1);
  assert.match(t.text, /Capability Statement/);
  const d = docFacts({ url: `${ORIGIN}/cap.pdf`, ...t });
  assert.deepEqual(d.credentials.sort(), ['CMMC', 'HIPAA']);
});

test('email setup from DNS: provider, sending tools, DMARC, verified tools', () => {
  const e = emailSetupFrom({
    mx: [{ exchange: 'hillit-com.mail.protection.outlook.com' }],
    txt: [['v=spf1 include:spf.protection.outlook.com include:_spf.hubspotemail.net include:sendgrid.net -all'], ['MS=ms123'], ['docusign=abc'], ['knowbe4-site-verification=x']],
    dmarc: [['v=DMARC1; p=quarantine; rua=mailto:d@hill-it.com']],
  });
  assert.equal(e.mailHost, 'Microsoft 365');
  assert.deepEqual(e.senders, ['Microsoft 365', 'HubSpot', 'SendGrid']);
  assert.equal(e.dmarc, 'quarantine');
  assert.deepEqual(e.verifiedTools, ['Microsoft 365', 'DocuSign', 'KnowBe4 (security training)']);
  assert.equal(emailSetupFrom({}).dmarc, 'missing');
});

test('history and look-alikes', () => {
  const h = historyFrom([['timestamp'], ['20120304000000'], ['20190101000000'], ['20250101000000']], new Date('2026-09-25'));
  assert.equal(h.firstSeen, '2012-03-04');
  assert.equal(h.years, 14);
  assert.equal(h.monthsCaptured, 3);
  assert.ok(lookalikeCandidates('hill-it.com').includes('gethill-it.com'));
  assert.match(outboundSignal([{ domain: 'gethillit.com', mail: true, pointsHome: true }]).text, /someone may already cold-email for them/);
  assert.equal(outboundSignal([{ domain: 'x.com', mail: false }]), null);
  const caps = yearlyCaptures([['timestamp', 'original', 'statuscode'], ...[2012, 2013, 2015, 2016, 2018, 2019, 2021, 2023, 2025].map((y) => [`${y}0601000000`, 'http://hill-it.com/', '200'])], 5);
  assert.equal(caps.length, 5);
  assert.equal(caps[0].ts.slice(0, 4), '2012');
  assert.equal(caps[4].ts.slice(0, 4), '2025');
  assert.deepEqual(snapshotFacts('<title>Hill Computer Repair</title><h1>Home &amp; office PCs</h1>'), { title: 'Hill Computer Repair', headline: 'Home & office PCs', description: '' });
});

test('money: PPP payroll by the SBA formula, name matching, revenue ranges with their basis', async () => {
  assert.deepEqual(payrollFromPpp([{ amount: 60200, date: '2020-04-28' }, { amount: 40000, date: '2021-02-01' }]).annual, 288960);
  assert.equal(sameCompany('BURGESS COMPANY, PC', 'Burgess Company'), true);
  assert.equal(sameCompany('BURGESS FARMS LLC', 'Burgess Company'), false);
  assert.equal(sameCompany('PIVIT STRATEGY LLC', 'PivIT Strategy'), true);
  assert.equal(benchmarkFor({ niche: 'pro-services', text: 'Tax and accounting services for small businesses' }), BENCHMARKS.accounting);
  assert.equal(benchmarkFor({ niche: 'msp', text: 'Managed IT for law firms' }), BENCHMARKS.msp, '"for law firms" is the buyer, not what they sell');
  assert.equal(benchmarkFor({ text: 'staffing for warehouses' }), null);
  const r = revenueRange({ headcount: 18, headcountExact: true, payroll: { annual: 1_000_000 }, bench: BENCHMARKS.msp });
  assert.deepEqual([r[0].low, r[0].high], [2_520_000, 4_500_000]);
  assert.match(r[0].basis, /18 people × \$140,000–\$250,000 revenue per employee for IT services/);
  assert.deepEqual([r[1].low, r[1].high], [2_632_000, 3_125_000]);
  assert.equal(revenueRange({ headcount: 5, bench: null }), null);
  // USAspending answers → only this company's records, state-filtered.
  const calls = [];
  const was = io.fetchJson;
  io.fetchJson = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url.endsWith('/spending_by_category/recipient/')) return { ok: true, json: { results: [{ name: 'HILL IT LLC', amount: 250000 }] } };
    const types = JSON.parse(opts.body).filters.award_type_codes;
    if (types.includes('07')) return { ok: true, json: { results: [{ 'Recipient Name': 'HILL IT LLC', 'Loan Value': 150000, 'Subsidy Cost': 151000, 'Issued Date': '2020-04-20', 'Award ID': 'P1' }, { 'Recipient Name': 'HILLSIDE BAKERY', 'Loan Value': 9000, 'Issued Date': '2020-05-01' }] } };
    if (types.includes('A')) return { ok: true, json: { results: [{ 'Recipient Name': 'HILL IT LLC', 'Award Amount': 250000, 'Awarding Agency': 'Department of Veterans Affairs', 'Start Date': '2023-02-01', Description: 'NETWORK SUPPORT' }] } };
    return { ok: true, json: { results: [] } };
  };
  try {
    const m = await federalMoney({ names: ['Hill IT'], state: 'NC' });
    assert.equal(m.ppp.length, 1, 'the bakery is not them');
    assert.equal(m.payroll.annual, 720000);
    assert.equal(m.contracts[0].agency, 'Department of Veterans Affairs');
    assert.equal(m.federalTotal, 250000);
    assert.deepEqual(calls[0].body.filters.recipient_locations, [{ country: 'USA', state: 'NC' }]);
  } finally { io.fetchJson = was; }
});

test('names for the public record: the page\'s own spelling, trimmed to the name', async () => {
  const { brandPhrases } = await import('@/lib/systems/research');
  const { nameCandidates } = await import('@/lib/systems/bizintel');
  assert.deepEqual(brandPhrases('Accountant E-mail Burgess Company. Since 1953, Burgess Company has provided Dallas.', 'burgesscpas.com'), ['Burgess Company']);
  assert.deepEqual(nameCandidates({ domain: 'burgesscpas.com', title: '214-828-0114 – A Professional Corporation', brand: ['Burgess Company'], clientName: 'Burgesscpas' }), ['Burgess Company', 'Burgesscpas']);
  assert.deepEqual(nameCandidates({ domain: 'hill-it.com', copyright: '© 2025 Hill IT, LLC. All rights reserved.' }).slice(0, 1), ['Hill IT, LLC']);
});
