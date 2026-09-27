// Research v4 (docs/IMPROVE-PASS.md A): the news, what they write about, who
// buys from them, competitors nearby, the rules-built brief and the crawl
// speed rule. Fake KV; every network call is stubbed (io.fetchExt for pages
// and the news feed, io.fetchJson for public records, globalThis.fetch for
// Places / RDAP). No AI, no real network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { createClient } from '@/lib/db/client';
import {
  parseSitemap, pickPages, crawlConcurrency, deepFactsOf, mergeDeep, emptyDeep, customersFrom, segmentsIn, companyOf,
  wordPairs, postPairs, topPairs, postingRhythm, mainText,
} from '@/lib/systems/deepsite';
import { parseNewsRss, newsFlags, newsFlagLine, newsFor, newsUrl } from '@/lib/systems/webintel';
import { buildBrief } from '@/lib/systems/researchbrief';
import { findCompetitors, pickCompetitors, runResearch, startResearch, researchView, briefLead } from '@/lib/systems/research';
import { benchmarkFor, BENCHMARKS } from '@/lib/systems/bizintel';
import { mapBusiness } from '@/lib/ext/places';

const real = { fetchExt: io.fetchExt, fetchJson: io.fetchJson, alertOwner: io.alertOwner, fetch: globalThis.fetch };
let alerts;
beforeEach(() => {
  __reset();
  alerts = [];
  delete process.env.PLACES_API_KEY;
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
});
afterEach(() => {
  io.fetchExt = real.fetchExt;
  io.fetchJson = real.fetchJson;
  io.alertOwner = real.alertOwner;
  globalThis.fetch = real.fetch;
  delete process.env.PLACES_API_KEY;
});

const NOW = new Date('2026-09-27T12:00:00Z');
const noWords = (s) => assert.doesNotMatch(s, /undefined|null|NaN|\[object/, s);

// ── A.1 news ─────────────────────────────────────────────────────────────────

const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>"Acme IT" Charlotte - Google News</title>
<item><title>Acme IT named to Inc. 5000 list &amp;amp; wins award - Charlotte Business Journal</title><link>https://news.google.com/rss/articles/a1</link><pubDate>Wed, 12 Aug 2026 07:00:00 GMT</pubDate><source url="https://www.bizjournals.com">Charlotte Business Journal</source></item>
<item><title><![CDATA[Dental group sues Acme IT after a ransomware outage &#39;cost weeks&#39; - WSOC-TV]]></title><link>https://news.google.com/rss/articles/b2</link><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate><source url="https://www.wsoctv.com">WSOC-TV</source></item>
<item><title>Charlotte IT firms &quot;busier than ever&quot; - QCity</title><link>javascript:alert(1)</link><pubDate>not a date</pubDate><source url="https://q.example">QCity</source></item>
<item><title></title><link>https://news.google.com/rss/articles/empty</link></item>
<item><title>Acme IT acquires Piedmont Tech</title><link>https://news.google.com/rss/articles/c3</link><pubDate>Fri, 03 Jul 2026 09:00:00 GMT</pubDate></item>
<item><title>Acme IT opens its Raleigh office</title><link>https://news.google.com/rss/articles/d4</link><pubDate>Mon, 15 Jun 2026 09:00:00 GMT</pubDate></item>
<item><title>Acme IT raises $2M seed round</title><link>https://news.google.com/rss/articles/e5</link><pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate></item>
<item><title>Acme IT lays off 12 staff</title><link>https://news.google.com/rss/articles/f6</link><pubDate>Mon, 04 May 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;

test('news RSS: entities (also double-escaped) and CDATA decoded, " - Source" off, newest first, at most 5; bad items and bad feeds', () => {
  const items = parseNewsRss(FEED);
  assert.equal(items.length, 5, 'the last five by date (the empty title is skipped)');
  assert.deepEqual(items[0], { title: "Dental group sues Acme IT after a ransomware outage 'cost weeks'", source: 'WSOC-TV', date: '2026-09-01', link: 'https://news.google.com/rss/articles/b2' });
  assert.equal(items[1].title, 'Acme IT named to Inc. 5000 list & wins award', '&amp;amp; → &');
  assert.equal(items[1].source, 'Charlotte Business Journal');
  assert.deepEqual(items.map((i) => i.date), ['2026-09-01', '2026-08-12', '2026-07-03', '2026-06-15', '2026-06-01']);
  const all = parseNewsRss(FEED, { max: 20 });
  const q = all.find((i) => i.source === 'QCity');
  assert.deepEqual([q.title, q.date, q.link], ['Charlotte IT firms "busier than ever"', null, null], 'an undated story sorts last; a javascript: link is dropped');
  // Bad feeds: an HTML error page or nothing is not a feed (null); a feed without stories is [].
  assert.equal(parseNewsRss('<html><body><h1>429 Too Many Requests</h1></body></html>'), null);
  assert.equal(parseNewsRss(''), null);
  assert.equal(parseNewsRss(undefined), null);
  assert.deepEqual(parseNewsRss('<rss><channel><title>nothing</title></channel></rss>'), []);
  assert.deepEqual(parseNewsRss('<rss><channel><item><title>cut off mid-item'), [], 'an unclosed item is ignored');
  assert.equal(newsUrl('Acme IT', 'Charlotte, NC'), 'https://news.google.com/rss/search?q=%22Acme+IT%22+Charlotte&hl=en-US&gl=US&ceid=US:en');
});

test('news flags: rules on the headline only; layoffs and lawsuit warn, the rest is context', () => {
  const f = newsFlags(parseNewsRss(FEED, { max: 20 }));
  assert.deepEqual(f.map((x) => [x.kind, x.level]), [['lawsuit', 'warn'], ['award', 'info'], ['acquisition', 'info'], ['new office', 'info'], ['funding', 'info'], ['layoffs', 'warn']]);
  assert.deepEqual(newsFlags([{ title: 'Five tips to spot a phishing email' }]), []);
  const line = newsFlagLine({ query: 'Acme IT', flags: f });
  assert.equal(line.level, 'warn');
  assert.match(line.text, /^In the news for “Acme IT”: lawsuit — “Dental group sues Acme IT/);
  assert.equal(newsFlagLine({ query: 'Acme IT', flags: [f[1]] }).level, 'info');
  assert.equal(newsFlagLine({ query: 'Acme IT', flags: [] }), null);
  assert.equal(newsFlagLine(null), null);
});

test('news request: one keyless call through io.fetchExt; a bad answer is an error, never a throw', async () => {
  const calls = [];
  io.fetchExt = async (url, opts) => { calls.push({ url, opts }); return new Response(FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } }); };
  const n = await newsFor({ name: 'Acme IT', city: 'Charlotte, NC' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'news.google.com');
  assert.equal(calls[0].opts.retry, false, 'no retry: a shared, rate-limited service');
  assert.equal(calls[0].opts.service, 'news');
  assert.equal(n.items.length, 5);
  assert.equal(n.flags[0].kind, 'lawsuit');
  assert.equal(n.error, null);
  io.fetchExt = async () => new Response('slow down', { status: 429 });
  assert.deepEqual(await newsFor({ name: 'Acme IT' }), { query: 'Acme IT', url: newsUrl('Acme IT'), items: [], flags: [], error: 'HTTP 429' });
  io.fetchExt = async () => new Response('<html>consent page</html>', { status: 200 });
  assert.equal((await newsFor({ name: 'Acme IT' })).error, 'not a news feed');
  io.fetchExt = async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); };
  assert.equal((await newsFor({ name: 'Acme IT' })).error, 'timed out');
  assert.equal(await newsFor({ name: '' }), null);
});

// ── A.2 what they talk about ─────────────────────────────────────────────────

test('topics: two-word phrases, stop words out, never across a stop word or a sentence; acronyms kept', () => {
  const p = wordPairs('Why Microsoft 365 is not a backup. Retention is not recovery. Managed IT for law firms; managed IT for CPA firms. In 2026 the IT team said it is fine.');
  assert.deepEqual(Object.fromEntries([...p].map(([k, v]) => [k, v.n])), { 'microsoft 365': 1, 'managed it': 2, 'law firms': 1, 'cpa firms': 1, 'it team': 1 });
  assert.equal(p.get('managed it').text, 'managed IT');
  assert.ok(!p.has('backup retention') && !p.has('backup recovery'), 'no pair across a sentence or a stop word');
  // A post's words only: the menu and the footer are not what the post talks about.
  const html = '<html><body><nav>Case studies Case studies</nav><main><article><h1>Microsoft 365 backup basics</h1><p>Microsoft 365 backup is not retention.</p></article></main><footer>Case studies</footer></body></html>';
  assert.doesNotMatch(mainText(html), /Case studies/);
  assert.deepEqual(postPairs(html, { h1: 'Microsoft 365 backup basics' }).map(([k, n]) => [k, n]), [['365 backup', 2], ['microsoft 365', 2], ['backup basics', 1]]);
});

test('topics: the most frequent pairs over the posts, own name out, seen at least twice, tails of a phrase dropped, at most 8', () => {
  let acc = emptyDeep();
  const post = (slug, date, body) => `<html><head><title>${slug}</title></head><body><main><article><h1>${slug}</h1><time datetime="${date}">${date}</time><p>${body}</p></article></main></body></html>`;
  const posts = [
    ['/blog/a', '2026-09-15', 'Acme IT helps law firms. Microsoft 365 backup keeps law firms safe. Phishing emails pretend to be banks.'],
    ['/blog/b', '2026-09-01', 'Microsoft 365 backup again. Phishing emails pretend to be clients. Law firms need this.'],
    ['/blog/c', '2026-08-20', 'Acme IT said so. Ransomware recovery plans. Ransomware recovery drills.'],
  ];
  for (const [page, date, body] of posts) acc = mergeDeep(acc, deepFactsOf(post(page.slice(6), date, body), { url: `https://acme-it.com${page}` }));
  assert.equal(acc.posts.length, 3);
  const top = topPairs(acc.pairs, { exclude: ['acme'], label: 'acme-it' });
  const texts = top.map((t) => t.text);
  assert.deepEqual(texts.slice(0, 3), ['law firms', 'microsoft 365', 'phishing emails'], 'most posts first, then most often');
  assert.ok(texts.includes('ransomware recovery'), 'twice in one post is enough');
  assert.ok(!texts.some((t) => /acme/.test(t)), 'their own name is not a topic');
  assert.ok(!texts.includes('365 backup') && !texts.includes('emails pretend'), 'the tail of "microsoft 365 backup" / "phishing emails pretend" is dropped');
  assert.ok(!texts.includes('recovery plans'), 'seen once: not a topic');
  assert.equal(top.find((t) => t.text === 'law firms').posts, 2);
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`topic${i} word`, [3, 1, `topic${i} word`]]));
  assert.equal(topPairs(many).length, 8);
});

test('posting rhythm: "about 2 posts a month, last one 12 days ago"; "at least" when the site lists more; old blogs said plainly', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const monthly = Array.from({ length: 24 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 15) - i * 15.2 * 86400e3).toISOString().slice(0, 10) }));
  const r = postingRhythm(monthly, { now });
  assert.equal(r.text, 'about 2 posts a month, last one 12 days ago');
  assert.equal(r.last, '2026-09-15');
  assert.equal(r.atLeast, false);
  assert.match(postingRhythm(monthly, { now, known: 80 }).text, /^at least 2 posts a month/);
  assert.equal(postingRhythm([{ date: '2026-03-01' }, { date: '2025-12-01' }, { date: '2025-06-01' }], { now }).text, 'about 2 posts a year, last one 7 months ago');
  assert.equal(postingRhythm([{ date: '2023-05-01' }], { now }).text, 'no posts in the last year, last one 3 years ago');
  assert.equal(postingRhythm([{ date: null }, {}], { now }), null, 'no date, no rhythm (never guessed)');
  assert.equal(postingRhythm([{ date: '2026-09-27' }], { now }).text, 'about 1 post a month, last one today');
});

// ── A.3 who buys from them ───────────────────────────────────────────────────

const SITE = 'https://www.acme-it.com';
const shell = (body) => `<html><head><title>Acme IT</title></head><body><nav><a href="/industries/dental-practices">Dental practices</a> <a href="/industries/dental-practices">Dental practices</a></nav><main>${body}</main><footer>Serving dental practices everywhere</footer></body></html>`;

test('customers: segments counted over pages, testimonials, case studies and client names; up to 8 examples; one plain line', () => {
  const pages = {
    '/': shell('<h1>IT for law firms and CPA firms</h1><section class="client-logos"><img alt="Hollis &amp; Grant Law logo"><img alt="Carolina Tax Partners"><img alt="Microsoft Partner"></section><blockquote>They moved our whole office over one weekend and nobody lost a file. — Renee Hollis, Hollis &amp; Grant Law</blockquote>'),
    '/about': shell('<p>We serve law firms and accounting firms across the Carolinas.</p>'),
    '/industries/law-firms': shell('<h1>IT for attorneys</h1><p>Clio and NetDocuments support.</p>'),
    '/case-studies/cpa-recovery': '<html><head><title>Case study: a CPA firm back online in 6 hours</title></head><body><main><h1>Carolina Tax Partners recovered in six hours</h1></main></body></html>',
    '/testimonials': shell('<blockquote>Best IT partner our dental office has had in twenty years of practice. — Dr. Amy Cole, Cole Family Dental</blockquote>'),
  };
  let acc = emptyDeep();
  for (const [path, html] of Object.entries(pages)) acc = mergeDeep(acc, deepFactsOf(html, { url: `${SITE}${path}` }));
  const c = customersFrom(acc);
  // law firms: 3 pages (/, /about, the law-firms industry page) + the testimonial's company + a client's name = 5.
  assert.deepEqual(c.segments.map((s) => [s.name, s.count]), [['law firms', 5], ['accounting firms', 4], ['dental practices', 2]]);
  assert.deepEqual(c.segments[0].pages, ['/', '/about', '/industries/law-firms']);
  assert.deepEqual(c.examples, [
    { name: 'Hollis & Grant Law', page: '/', how: 'client list' },
    { name: 'Carolina Tax Partners', page: '/', how: 'client list' },
    { name: 'Cole Family Dental', page: '/testimonials', how: 'testimonial' },
  ], 'the Microsoft badge is a partner, not a client; a client named twice is one example');
  assert.equal(c.line, 'They mostly serve law firms and accounting firms; named clients include Hollis & Grant Law, Carolina Tax Partners and Cole Family Dental.');
  // The menu and the footer never count ("Dental practices" there on every page).
  assert.deepEqual(segmentsIn(mainText(shell('<p>Nothing about customers.</p>'))), []);
  assert.equal(companyOf('Renee Hollis, Hollis & Grant Law'), 'Hollis & Grant Law');
  assert.equal(companyOf('Renee Hollis, Owner'), null);
  assert.equal(companyOf('Renee Hollis'), null);
  // One mention: "they mention serving", not "mostly". Nothing found: no line (never made up).
  const one = customersFrom(mergeDeep(emptyDeep(), deepFactsOf(shell('<p>Our newest clients are veterinary clinics.</p>'), { url: `${SITE}/about` })));
  assert.equal(one.line, 'They mention serving veterinary practices.');
  assert.deepEqual(customersFrom(emptyDeep()), { segments: [], examples: [], line: null });
  const eight = customersFrom({ clients: Array.from({ length: 12 }, (_, i) => ({ name: `Client ${i}`, page: '/' })) });
  assert.equal(eight.examples.length, 8);
  assert.equal(eight.line, 'Named clients include Client 0, Client 1 and Client 2.');
});

// ── A.4 competitors nearby ───────────────────────────────────────────────────

const place = (name, web, cid, rating = 4.5, reviews = 40) => ({ displayName: { text: name }, formattedAddress: `${cid} Tryon St, Charlotte, NC 28202, USA`, primaryTypeDisplayName: { text: 'Computer support and services' }, rating, userRatingCount: reviews, googleMapsUri: `https://maps.google.com/?cid=${cid}`, websiteUri: web });
const SELF = { name: 'Acme IT', address: '100 Main St, Charlotte, NC 28202, USA', category: 'Computer support and services', rating: 4.8, reviews: 61, mapsUrl: 'https://maps.google.com/?cid=1' };
const RIVALS = [
  place('Queen City Tech', 'https://qctech.com/', 11, 4.9, 212), place('Acme IT Solutions', null, 1), place('Totally Other', 'https://www.acme-it.com/', 12),
  place('Carolina Networks', null, 13), place('Piedmont IT', 'https://piedmontit.com/', 14), place('Queen City Tech', 'https://qctech.com/', 11),
  place('Uptown Help', null, 15), place('Crown Cyber', null, 16), place('Southend Tech', null, 17),
];

test('competitors: only with the Places key and a Google category; never the applicant; 5 at most; counted as Enterprise calls', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), body: JSON.parse(init.body || '{}'), mask: init.headers?.['X-Goog-FieldMask'] }); return new Response(JSON.stringify({ places: RIVALS }), { status: 200 }); };
  // No key: nothing is asked, nothing is shown.
  assert.deepEqual(await findCompetitors({ business: SELF, city: 'Charlotte, NC', mainDomain: 'acme-it.com', name: 'Acme IT' }), { competitors: null, skipped: 'no_key' });
  assert.equal(calls.length, 0);
  process.env.PLACES_API_KEY = 'k';
  // No matched Google listing (so no category of theirs): nothing is guessed.
  assert.deepEqual(await findCompetitors({ business: null, city: 'Charlotte, NC', mainDomain: 'acme-it.com', name: 'Acme IT' }), { competitors: null, skipped: 'no_category' });
  assert.equal(calls.length, 0);
  const r = await findCompetitors({ business: SELF, city: 'Charlotte, NC', mainDomain: 'acme-it.com', name: 'Acme IT' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.textQuery, 'Computer support and services in Charlotte, NC');
  assert.match(calls[0].mask, /places\.rating/);
  assert.equal(r.competitors.query, 'Computer support and services in Charlotte, NC');
  assert.deepEqual(r.competitors.items.map((c) => c.name), ['Queen City Tech', 'Carolina Networks', 'Piedmont IT', 'Uptown Help', 'Crown Cyber']);
  assert.deepEqual(Object.keys(r.competitors.items[0]), ['name', 'rating', 'reviews', 'website', 'mapsUrl', 'address']);
  assert.deepEqual([r.competitors.items[0].rating, r.competitors.items[0].reviews], [4.9, 212]);
  const usage = await kv.hgetall(`usage:places:${new Date().toISOString().slice(0, 7)}`);
  assert.equal(Number(usage.enterprise), 1);
  assert.deepEqual(pickCompetitors(RIVALS.map(mapBusiness), { mainDomain: 'acme-it.com', name: 'Acme IT', self: SELF, max: 2 }).map((c) => c.name), ['Queen City Tech', 'Carolina Networks']);
  globalThis.fetch = async () => new Response('{"error":{"message":"quota"}}', { status: 429 });
  assert.match((await findCompetitors({ business: SELF, city: 'Charlotte, NC', mainDomain: 'acme-it.com', name: 'Acme IT' })).skipped, /^failed: places 429/);
});

// ── A.5 the brief ────────────────────────────────────────────────────────────

const FULL = () => ({
  name: 'Acme IT',
  origin: SITE,
  website: { url: `${SITE}/`, title: 'Acme IT', description: 'Managed IT for law firms.', services: ['Managed IT services', 'Cybersecurity', 'Cloud backup'], yearsHint: 'Founded in 2012', pagesRead: 8 },
  src: { services: '/services', years: '/about', team: '/about' },
  teamText: 'Website says a team of 16',
  application: { web_sellsTo: 'Managed IT for law firms' },
  customers: 'law firms',
  business: SELF, businessMatched: true,
  signals: {},
  registeredAt: '2011-03-01T00:00:00Z',
  deep: {
    pagesRead: 22, people: [{ name: 'Jane Hill', title: 'CEO', page: '/team' }],
    testimonials: [{ quote: 'Great.', by: 'Ann, Smith Law', page: '/' }], caseStudies: [{ title: 'Smith Law moves', page: '/case-studies/smith' }], clients: [{ name: 'Smith Law', page: '/' }],
    credentials: [{ name: 'SOC 2', quote: '…', page: '/about' }], addresses: ['100 Main St, Charlotte, NC 28202', '9 Oak Ave, Raleigh, NC 27601'], prices: [], tech: [],
    offers: { ctas: ['Book a free network assessment'], promos: [{ offer: 'free network assessment', page: '/' }, { offer: 'No long-term contracts', page: '/pricing' }], magnets: [{ title: 'Download the IT buyer guide', page: '/' }], plans: [{ name: 'Essentials', price: '$99 per user / month', page: '/pricing' }] },
    history: { firstSeen: '2013-02-15' }, company: { founded: '2012', employees: null }, orgPage: '/',
    money: { federal: { ppp: [{ amount: 118400, date: '2020-04-28' }], contracts: [] }, sec: null, revenue: [{ low: 2240000, high: 4000000, basis: '16 people × $140,000–$250,000 revenue per employee for IT services / MSPs (Census SUSB 2022 NAICS 541512/541513)', floor: false }] },
    blog: { recent: [{ page: '/blog/a' }, { page: '/blog/b' }] },
    topics: { pairs: [{ text: 'microsoft 365', count: 4, posts: 3 }, { text: 'law firms', count: 3, posts: 2 }], rhythm: { text: 'about 2 posts a month, last one 12 days ago' } },
    customers: { segments: [{ name: 'law firms', count: 6, pages: ['/industries/law-firms'] }], examples: [{ name: 'Smith Law', page: '/' }], line: 'They mostly serve law firms; named clients include Smith Law.' },
    news: { query: 'Acme IT', url: newsUrl('Acme IT'), items: [{ title: 'Acme IT opens its Raleigh office', source: 'CBJ', date: '2026-06-15', link: 'https://news.google.com/rss/articles/d4' }], flags: [{ kind: 'new office', level: 'info', title: 'Acme IT opens its Raleigh office', source: 'CBJ', date: '2026-06-15', link: 'https://news.google.com/rss/articles/d4' }] },
    competitors: { query: 'Computer support and services in Charlotte, NC', items: [{ name: 'Queen City Tech', rating: 4.9, reviews: 212, mapsUrl: 'https://maps.google.com/?cid=11' }] },
  },
  score: {
    parts: [
      { key: 'proof', pct: 100, items: [{ text: 'They already sell to strangers (“yes”)', status: 'good', points: 7, known: true, evidence: null }] },
      { key: 'b2b', pct: 90, items: [{ text: 'Website talks to businesses (9 mentions)', status: 'good', points: 12, known: true, evidence: { quote: '…', page: '/services' } }] },
      { key: 'ready', pct: 40, items: [{ text: 'Website has a phone number, no booking link', status: 'ok', points: 2, known: true }, { text: 'Can take only 2 calls a week — under 5', status: 'bad', points: 0.8, known: true }] },
    ],
    dealbreakers: [], warnings: [], questions: ['How many people work at the company?'],
  },
});

test('brief: 8–12 plain sentences from the facts, each with its sources; order and content by rule', () => {
  const b = buildBrief(FULL());
  assert.ok(b.sentences.length >= 8 && b.sentences.length <= 12, `${b.sentences.length} sentences`);
  for (const s of b.sentences) {
    assert.ok(s.sources.length >= 1, `no source: ${s.text}`);
    for (const src of s.sources) assert.ok(b.sources.includes(src));
    assert.match(s.text, /^[A-Z“].*[.?”]$/, s.text);
    noWords(s.text);
  }
  assert.equal(b.text, b.sentences.map((s) => s.text).join(' '));
  const t = b.sentences.map((s) => s.text);
  assert.equal(t[0], 'Acme IT sells Managed IT services, Cybersecurity, and Cloud backup.');
  assert.deepEqual(b.sentences[0].sources, [`${SITE}/services`]);
  assert.equal(t[1], 'They mostly serve law firms; named clients include Smith Law.');
  assert.equal(t[2], 'Acme IT has been in business since 2012, and their website has been online since 2013.');
  assert.deepEqual(b.sentences[2].sources, [`${SITE}/about`, 'https://web.archive.org/web/*/www.acme-it.com']);
  assert.equal(t[3], 'About 16 people work there (website says a team of 16), with offices in Charlotte, NC and Raleigh, NC.');
  assert.ok(t.includes('Their website shows 1 testimonial, 1 case study, and 1 named client; they name SOC 2; Google rates them 4.8★ from 61 reviews.'));
  assert.ok(t.includes('Offers they run: their main call to action is “Book a free network assessment”; they promise no long-term contracts; published plans: Essentials ($99 per user / month); a free download (“Download the IT buyer guide”).'), 'the free assessment the button already says is not repeated');
  assert.ok(t.includes('On the 22 pages read, their website has no booking link.'), 'only what is missing: they have case studies, pricing and a testimonial');
  assert.ok(t.includes('In the news: “Acme IT opens its Raleigh office” (CBJ, 15 Jun 2026) — it mentions a new office.'));
  const moneyLine = b.sentences.find((s) => s.text.startsWith('Revenue is likely'));
  assert.deepEqual(moneyLine.sources, ['https://www.census.gov/programs-surveys/susb.html', 'USAspending.gov'], 'the Census survey page, not its table codes');
  assert.ok(t.includes('Two angles for the call: they already sell to strangers (“yes”); and website talks to businesses (9 mentions).'));
  const angles = b.sentences.find((s) => s.text.startsWith('Two angles'));
  assert.deepEqual(angles.sources, ['fit score', `${SITE}/services`]);
  assert.equal(t[t.length - 1], 'The risk to raise: can take only 2 calls a week — under 5.');
  // 13 facts → 12 sentences: the competitors go first (they are on the call card anyway).
  assert.equal(b.sentences.length, 12);
  assert.ok(!t.some((s) => s.startsWith('Nearby on Google')));
  assert.ok(buildBrief({ ...FULL(), max: 13 }).sentences.some((s) => s.text.startsWith('Nearby on Google for “Computer support and services in Charlotte, NC”: Queen City Tech (4.9★, 212 reviews).')));
  assert.equal(buildBrief({ ...FULL(), max: 10 }).sentences.length, 10);
  assert.ok(!buildBrief({ ...FULL(), max: 10 }).sentences.some((s) => /^Revenue|^Their blog|^Nearby/.test(s.text)), 'then money, then topics');
});

test('brief: a sentence only when its fact exists — never made up', () => {
  const f = FULL();
  f.website = { url: `${SITE}/`, pagesRead: 0 };
  f.deep = null;
  f.teamText = null;
  f.business = null;
  f.registeredAt = null;
  f.score = { parts: [], dealbreakers: [{ text: 'Sells to consumers (“homeowners”)', evidence: null }], warnings: [], questions: [] };
  const b = buildBrief(f);
  assert.deepEqual(b.sentences.map((s) => s.text), [
    'On their application they say they sell to law firms.',
    'The risk to raise: sells to consumers (“homeowners”) — a dealbreaker.',
  ]);
  assert.deepEqual(b.sentences[0].sources, ['their application']);
  for (const s of b.sentences) noWords(s.text);
  assert.equal(buildBrief({ name: 'Nobody Co' }), null, 'no facts at all: no brief');
  // A site that was read but shows nothing: the missing sentence names every gap, and nothing else is claimed.
  const bare = buildBrief({ name: 'Bare Co', origin: SITE, website: { url: `${SITE}/`, pagesRead: 3 }, deep: { pagesRead: 3, offers: {}, tech: [] } });
  assert.deepEqual(bare.sentences.map((s) => s.text), ['On the 3 pages read, their website has no booking link, case studies, pricing or testimonials.']);
  // A news warning is the risk when the fit score has none; a news story that does not name them is not "their" news.
  const nf = FULL();
  nf.score.parts = [];
  nf.deep.news = { query: 'Acme IT', url: 'u', items: [{ title: 'Charlotte IT is busy', source: 'X', date: '2026-09-01', link: 'https://n/1' }, { title: 'Acme IT hires', source: 'Y', date: '2026-08-01', link: 'https://n/2' }], flags: [] };
  const nb = buildBrief(nf);
  assert.ok(nb.sentences.some((s) => s.text === 'Latest news found for “Acme IT”: “Acme IT hires” (Y, 1 Aug 2026).'));
  nf.deep.news.flags = [{ kind: 'lawsuit', level: 'warn', title: 'Dental group sues Acme IT', link: 'https://n/3' }];
  assert.equal(buildBrief(nf).sentences.at(-1).text, 'The risk to raise: a news story mentions a lawsuit (“Dental group sues Acme IT”).');
});

test('revenue benchmark: what they sell, not who buys it', () => {
  assert.equal(benchmarkFor({ niche: 'msp', text: 'Managed IT and cybersecurity for law firms and accounting firms. Ridgeline IT | Managed IT for Law & Accounting Firms' }), BENCHMARKS.msp);
  assert.equal(benchmarkFor({ niche: 'pro-services', text: 'Tax and accounting services for small businesses' }), BENCHMARKS.accounting);
});

// ── A.6 speed ────────────────────────────────────────────────────────────────

test('speed: 5 pages at a time, 8 when the site answers fast (median < 800 ms over 3+ pages)', () => {
  const R = { deepConcurrency: 5, deepConcurrencyFast: 8, deepFastMs: 800 };
  assert.equal(crawlConcurrency([], R), 5);
  assert.equal(crawlConcurrency([100, 120], R), 5, 'two pages are not enough to judge');
  assert.equal(crawlConcurrency([300, 500, 2500], R), 8, 'the median, not the average');
  assert.equal(crawlConcurrency([900, 700, 1200, 400], R), 5, 'median 800 is not under 800');
  assert.equal(crawlConcurrency([100, 100, 100], { deepConcurrency: 5 }), 8, 'defaults');
});

test('speed: sitemap lastmod read per page; stale pages skipped only when the budget is short — posts first, core pages never', () => {
  const sm = parseSitemap(`<urlset><url><loc>${SITE}/about</loc><lastmod>2019-01-01</lastmod></url><url>\n<loc>${SITE}/blog/x</loc>\n<changefreq>monthly</changefreq>\n<lastmod>2026-05-01T10:00:00+00:00</lastmod></url><url><loc>${SITE}/team</loc></url><url><loc>${SITE}/bad</loc><lastmod>soon</lastmod></url></urlset>`);
  assert.deepEqual(sm.lastmods, [{ url: `${SITE}/about`, lastmod: '2019-01-01' }, { url: `${SITE}/blog/x`, lastmod: '2026-05-01T10:00:00+00:00' }, { url: `${SITE}/team`, lastmod: null }, { url: `${SITE}/bad`, lastmod: null }]);
  const now = Date.parse('2026-09-27');
  const urls = ['/about', '/services/cloud', '/case-studies/old', '/case-studies/new', ...Array.from({ length: 9 }, (_, i) => `/blog/post-${i}`)].map((p) => `${SITE}${p}`);
  const lastmod = { 'acme-it.com/about': '2015-01-01', 'acme-it.com/case-studies/old': '2020-01-01', 'acme-it.com/case-studies/new': '2026-01-01' };
  for (let i = 0; i < 9; i++) lastmod[`acme-it.com/blog/post-${i}`] = i < 5 ? '2021-06-01' : '2026-06-01';
  // Room for everything: nothing is skipped.
  assert.equal(pickPages(urls, { origin: SITE, max: 60, lastmod, staleYears: 3, now }).length, 13);
  // Budget short (max 6: 4 company pages + 2 posts): the old posts go first, so the 2 posts read are recent ones.
  const short = pickPages(urls, { origin: SITE, max: 6, lastmod, staleYears: 3, now });
  assert.deepEqual(short.filter((u) => u.includes('/blog/')).map((u) => u.split('/').pop()), ['post-5', 'post-6']);
  assert.ok(short.includes(`${SITE}/case-studies/old`), 'posts went first and made enough room');
  // Still short after the posts: stale company pages go too — the about page never.
  const tighter = pickPages(urls, { origin: SITE, max: 3, lastmod, staleYears: 3, now });
  assert.ok(tighter.includes(`${SITE}/about`), 'a core page stays however old');
  assert.ok(!tighter.includes(`${SITE}/case-studies/old`));
  // Without the rule (staleYears 0) the old order stands.
  assert.deepEqual(pickPages(urls, { origin: SITE, max: 6 }).filter((u) => u.includes('/blog/')).length, 2);
});

// ── the whole run ────────────────────────────────────────────────────────────

const post = (title, date, text) => `<html><head><title>${title} | Acme IT</title></head><body><nav><a href="/">Home</a></nav><main><article><h1>${title}</h1><time datetime="${date}">${date}</time><p>${text}</p></article></main><footer>© 2026 Acme IT</footer></body></html>`;
const PAGES = {
  '/': shell('<script type="application/ld+json">{"@type":"Organization","name":"Acme IT","foundingDate":"2012"}</script><h1>Managed IT for law firms and CPA firms</h1><p>Managed IT, cybersecurity and cloud backup for law firms in Charlotte.</p><section class="client-logos"><img alt="Hollis &amp; Grant Law"><img alt="Carolina Tax Partners"></section><blockquote>They moved our whole office over one weekend and nobody lost a file. — Renee Hollis, Hollis &amp; Grant Law</blockquote><a href="/contact" class="btn">Book a free network assessment</a><address>100 Main St, Charlotte, NC 28202</address>'),
  '/about': shell('<p>Founded in 2012, Acme IT is a team of 14 people. We serve law firms and accounting firms. SOC 2 aligned.</p>'),
  '/services': shell('<ul><li><a href="/services/managed-it">Managed IT</a></li><li><a href="/services/cybersecurity">Cybersecurity</a></li></ul>'),
  '/services/managed-it': shell('<h1>Managed IT</h1><p>Unlimited help desk. No long-term contracts.</p>'),
  '/services/cybersecurity': shell('<h1>Cybersecurity</h1><p>Phishing training for law firms.</p>'),
  '/contact': shell('<p>100 Main St, Charlotte, NC 28202 · (704) 555-0100</p>'),
  '/industries/law-firms': shell('<h1>IT for law firms</h1>'),
  '/case-studies/move': '<html><head><title>Case study: a law firm moves offices</title></head><body><main><h1>Hollis &amp; Grant Law moves offices</h1></main></body></html>',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`/blog/post-${i}`, post(`Microsoft 365 tip ${i}`, `2026-0${9 - Math.floor(i / 2)}-0${1 + (i % 2)}`, 'Microsoft 365 backup matters. Phishing emails target law firms.')])),
};

function serve({ news = FEED } = {}) {
  const log = { pages: [], inFlight: 0, maxInFlight: 0 };
  io.fetchExt = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'news.google.com') { log.news = (log.news || 0) + 1; return new Response(news, { status: 200, headers: { 'content-type': 'application/rss+xml' } }); }
    if (u.hostname !== 'www.acme-it.com') throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${u.hostname}`), { code: 'ENOTFOUND' });
    log.pages.push(u.pathname);
    log.inFlight += 1;
    log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    log.inFlight -= 1;
    if (u.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (u.pathname === '/sitemap.xml') return new Response(`<urlset>${Object.keys(PAGES).map((p) => `<url><loc>${SITE}${p}</loc><lastmod>2026-09-01</lastmod></url>`).join('')}</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
    const html = PAGES[u.pathname.replace(/\/+$/, '') || '/'];
    return html ? new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  };
  io.fetchJson = async () => ({ ok: false, status: 503, json: null, text: '' });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('places.googleapis.com')) {
      const q = JSON.parse(init.body || '{}').textQuery || '';
      if (q.startsWith('Computer support')) return new Response(JSON.stringify({ places: RIVALS }), { status: 200 });
      if ((init.headers?.['X-Goog-FieldMask'] || '').includes('formattedAddress')) return new Response(JSON.stringify({ places: [{ ...place('Acme IT', 'https://www.acme-it.com/', 1, 4.8, 61), formattedAddress: '100 Main St, Charlotte, NC 28202, USA' }] }), { status: 200 });
      return new Response(JSON.stringify({ places: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}` })) }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return log;
}

async function applicant(id = 'acme-it') {
  await createClient(id, { name: 'Acme IT', contactName: 'Ann Lee', contactEmail: 'ann@acme-it.com', website: 'https://acme-it.com', mainDomain: 'acme-it.com', state: 'applied' });
  await kv.hset(`client:${id}:application`, { mainDomain: 'acme-it.com', web_city: 'Charlotte, NC', web_sellsTo: 'Managed IT for law firms in the Carolinas', review: 'pending', alertedAt: NOW.toISOString(), soldToStrangers: 'yes', dealValue: '8000' });
  return id;
}

test('the whole run: news, topics, customers, competitors and the brief in research; 8 pages at a time on a fast site; the score alert ends with the brief', async () => {
  process.env.PLACES_API_KEY = 'k';
  const log = serve();
  const id = await applicant();
  await startResearch(id, { now: NOW });
  const r = await runResearch(id, { now: NOW, deadline: Date.now() + 60000 });
  assert.equal(r.status, 'done');
  const v = await researchView(id);
  // The news: one request, the stories, a flags line (a lawsuit headline warns).
  assert.equal(log.news, 1);
  assert.equal(v.deep.news.items.length, 5);
  assert.ok(v.flags.some((f) => f.level === 'warn' && /^In the news for “Acme IT”: lawsuit/.test(f.text)), JSON.stringify(v.flags));
  // What they write about: from the posts only.
  assert.equal(v.deep.topics.pairs[0].text, 'microsoft 365');
  assert.ok(v.deep.topics.pairs.some((p) => p.text === 'phishing emails'));
  assert.match(v.deep.topics.rhythm.text, /posts? a (month|year), last one \d+ days ago$/);
  // Who buys from them.
  assert.equal(v.deep.customers.segments[0].name, 'law firms');
  assert.match(v.deep.customers.line, /^They mostly serve law firms/);
  assert.deepEqual(v.deep.customers.examples.map((e) => e.name), ['Hollis & Grant Law', 'Carolina Tax Partners']);
  // Competitors: their Google category in their city, never themselves.
  assert.equal(v.deep.competitors.query, 'Computer support and services in Charlotte, NC');
  assert.equal(v.deep.competitors.items.length, 5);
  assert.ok(!v.deep.competitors.items.some((c) => /acme/i.test(c.name)));
  // The brief.
  assert.ok(v.brief.sentences.length >= 8 && v.brief.sentences.length <= 12, v.brief.text);
  assert.ok(v.brief.sentences.every((s) => s.sources.length && s.sources.every((x) => v.brief.sources.includes(x))));
  noWords(v.brief.text);
  assert.match(v.brief.sentences[0].text, /^Acme IT sells /);
  // Speed: the site answered fast, so the deep crawl read 8 pages at a time (never more).
  assert.equal(log.maxInFlight, 8);
  assert.equal(new Set(log.pages).size, log.pages.length, 'no page fetched twice');
  // The owner's score alert ends with the brief's first two sentences.
  const scored = alerts.filter((a) => a.key === 'application_scored');
  assert.equal(scored.length, 1);
  assert.ok(scored[0].body.endsWith(`\n\n${briefLead(v.brief)}`), scored[0].body);
  assert.equal(briefLead(v.brief), `${v.brief.sentences[0].text} ${v.brief.sentences[1].text}`);
});

test('the whole run without the Places key: no competitors, no Places call; a broken news feed is only an error', async () => {
  const log = serve({ news: '<html>blocked</html>' });
  const id = await applicant('acme-nokey');
  await startResearch(id, { now: NOW });
  // Without the key the quick market count falls back to OpenStreetMap, which is retried once on the next run.
  let status = 'pending';
  for (let i = 0; i < 3 && status === 'pending'; i++) status = (await runResearch(id, { now: NOW, deadline: Date.now() + 60000 })).status;
  assert.equal(status, 'done');
  const v = await researchView(id);
  assert.equal(v.deep.competitors, null);
  assert.deepEqual([v.deep.news.items, v.deep.news.error], [[], 'not a news feed']);
  assert.ok(!v.flags.some((f) => /In the news/.test(f.text)));
  assert.ok(v.brief.sentences.length >= 6, v.brief.text);
  assert.ok(!v.brief.sentences.some((s) => /Nearby on Google|In the news|Latest news/.test(s.text)));
  assert.equal(log.news, 1);
});
