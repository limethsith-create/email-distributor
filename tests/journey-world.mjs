// The outside world for tests/journey.test.mjs — ONE applicant from the
// website form to Day 30, through the real route handlers.
//
// Built on tests/sim-world.mjs (SMTP stub, warm-up + trial IMAP boxes, Stage C
// scans, dkimvalidator, Porkbun/RDAP/GitHub) and adds what the newer steps
// talk to: a simulated clock (the global Date, so routes that read the wall
// clock see the journey's time), the applicant's own website (home, sitemap,
// ~20 pages, a PDF), their DNS, the Wayback Machine, USAspending (a PPP
// loan), SEC EDGAR, Google Places, Google OAuth + Calendar (Meet links), and
// a CheapInboxes account the OWNER buys in. Every fake answers with a small
// simulated latency that moves the clock, so time-boxed work (research in the
// request, the 20 s agreement request) behaves as it would on a real network.
//
// Nothing leaves the machine: global fetch, io.fetchExt / io.fetchJson,
// io.dns and every socket are fakes; an address the world does not know is
// refused and recorded in `world.unknown` (the test asserts it stays empty).
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import zlib from 'node:zlib';
import dns from 'node:dns';
import nodemailer from 'nodemailer';
import { sim, installWorld, deliver } from './sim-world.mjs';
import { io } from '@/lib/systems/intake-io';
import { net as warmNet } from '@/lib/systems/warmup';
import { TOKEN_URL, REVOKE_URL, EVENTS_URL, USERINFO_URL } from '@/lib/ext/google';

export { sim, deliver };

// ── the clock ────────────────────────────────────────────────────────────────

const RealDate = globalThis.Date;
let nowMs = RealDate.parse('2026-10-01T19:40:00Z');
class SimDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
  static now() { return nowMs; }
}
export const clock = {
  set(d) { nowMs = d instanceof RealDate ? d.getTime() : typeof d === 'number' ? d : RealDate.parse(d); },
  advance(ms) { nowMs += ms; },
  get now() { return new RealDate(nowMs); },
  iso() { return new RealDate(nowMs).toISOString(); },
};
/** US Eastern wall clock → Date (EDT until 1 Nov 2026, EST after). */
export const et = (day, hhmm) => new RealDate(`${day}T${hhmm}:00${day >= '2026-11-01' ? '-05:00' : '-04:00'}`);
/** Sri Lanka wall clock → Date (UTC+5:30, no daylight saving). */
export const colombo = (day, hhmm) => new RealDate(`${day}T${hhmm}:00+05:30`);
const latency = (ms) => { nowMs += ms; };

// ── the people and places ────────────────────────────────────────────────────

export const APPLICANT = { name: 'Dana Whitfield', email: 'dana@ridgelineit.com', company: 'Ridgeline IT', domain: 'ridgelineit.com', city: 'Charlotte, NC' };
export const OWNER = { email: 'owner@aviance.test', inbox: 'hello@aviance.test', name: 'Limeth Sith' };
export const MACHINE = 'https://machine.test';
const SITE = 'https://www.ridgelineit.com';

export const world = {
  unknown: [],        // addresses nobody in the world answers
  calls: [],          // every outside call { at, kind, method, url }
  google: null,       // the owner's Google account (OAuth + Calendar)
  ci: null,           // the owner's CheapInboxes account
  dnsLive: new Set(), // trial domains whose DNS CheapInboxes has set
  spamShare: 0.02,    // warm-up mail that lands in spam
};

// ── the applicant's website ──────────────────────────────────────────────────

const NAV = '<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/services">Services</a> <a href="/team">Team</a> <a href="/industries/law-firms">Law firms</a> <a href="/case-studies">Case studies</a> <a href="/pricing">Pricing</a> <a href="/careers">Careers</a> <a href="/blog">Blog</a> <a href="/contact">Contact</a></nav>';
const FOOT = '<footer><address>2100 South Blvd, Suite 300, Charlotte, NC 28203</address><p>Call (704) 555-0142 · <a href="mailto:info@ridgelineit.com">info@ridgelineit.com</a></p><p><a href="https://www.linkedin.com/company/ridgeline-it">LinkedIn</a> <a href="https://www.facebook.com/ridgelineit">Facebook</a></p><p>© 2026 Ridgeline IT, LLC. All rights reserved.</p></footer>';
const page = (title, body, desc = '') => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${desc}">
<script src="https://js.hs-scripts.com/4412.js"></script><script async src="https://www.googletagmanager.com/gtag/js?id=G-RIDGE1"></script><script>gtag('config','G-RIDGE1')</script>
</head><body>${NAV}<main>${body}</main>${FOOT}</body></html>`;
const post = (title, date, text) => page(`${title} | Ridgeline IT Blog`, `<article><h1>${title}</h1><time datetime="${date}">${date}</time><p>${text}</p></article>`);

const PAGES = {
  '/': page('Ridgeline IT | Managed IT for Law & Accounting Firms in Charlotte',
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Ridgeline IT","url":"https://www.ridgelineit.com","foundingDate":"2012","numberOfEmployees":{"@type":"QuantitativeValue","value":16},"address":{"@type":"PostalAddress","streetAddress":"2100 South Blvd, Suite 300","addressLocality":"Charlotte","addressRegion":"NC","postalCode":"28203"}}</script>
<h1>Managed IT that law firms and accounting firms trust</h1>
<p>We run IT support, cybersecurity and cloud for 10–75 person law firms and CPA firms across the Carolinas.</p>
<section class="client-logos"><img alt="Hollis &amp; Grant Law logo"><img alt="Carolina Tax Partners"><img alt="Queen City Family Law"></section>
<blockquote>They moved our whole office over a weekend and nobody lost a file. — Renee Hollis, Hollis &amp; Grant Law</blockquote>
<a href="/contact" class="btn">Book a free network assessment</a> <a href="/downloads/ridgeline-capabilities.pdf">Download our capabilities statement</a>`,
    'Managed IT, cybersecurity and cloud for law firms and accounting firms in Charlotte and Raleigh.'),
  '/about': page('About Ridgeline IT', '<h1>About us</h1><p>Founded in 2012 in Charlotte, Ridgeline IT is a team of 16 people. We are a Microsoft Solutions Partner for Modern Work, SOC 2 aligned and veteran-owned. We serve law firms and accounting firms in North Carolina and South Carolina.</p><p>Offices in Charlotte, NC and Raleigh, NC.</p>'),
  '/services': page('Services | Ridgeline IT', '<h1>Services</h1><ul><li><a href="/services/managed-it">Managed IT services</a></li><li><a href="/services/cybersecurity">Cybersecurity</a></li><li><a href="/services/cloud-backup">Cloud backup and recovery</a></li><li><a href="/services/compliance">Compliance for law and CPA firms</a></li></ul>'),
  '/services/managed-it': page('Managed IT Services | Ridgeline IT', '<h1>Managed IT services</h1><p>Unlimited help desk, 15-minute response time guaranteed, patching and monitoring for every device.</p>'),
  '/services/cybersecurity': page('Cybersecurity | Ridgeline IT', '<h1>Cybersecurity</h1><p>Endpoint protection, phishing training with KnowBe4, and 24/7 monitoring. HIPAA and FINRA ready.</p>'),
  '/services/cloud-backup': page('Cloud Backup | Ridgeline IT', '<h1>Cloud backup and recovery</h1><p>Microsoft 365 backup and disaster recovery for law firms. Restores in under an hour.</p>'),
  '/services/compliance': page('Compliance | Ridgeline IT', '<h1>Compliance for law and CPA firms</h1><p>ABA and IRS Publication 4557 checklists, written information security plans.</p>'),
  '/team': page('Our Team | Ridgeline IT', '<h1>Our team</h1><div class="team"><h3>Marcus Hale</h3><p>Founder &amp; CEO</p><h3>Dana Whitfield</h3><p>Director of Client Success</p><h3>Priya Raman</h3><p>Service Desk Lead</p><h3>Tom Becker</h3><p>Network Engineer</p></div>'),
  '/contact': page('Contact | Ridgeline IT', '<h1>Contact us</h1><p>2100 South Blvd, Suite 300, Charlotte, NC 28203</p><p>(704) 555-0142</p><form action="/contact" method="post"><input name="email"><button>Send</button></form>'),
  '/pricing': page('Pricing | Ridgeline IT', '<h1>Pricing</h1><h3>Essentials</h3><p>$99 per user / month</p><h3>Complete</h3><p>$149 per user / month</p><p>No long-term contracts. Onboarding included.</p>'),
  '/careers': page('Careers | Ridgeline IT', '<h1>Careers</h1><h3>Account Executive (B2B sales)</h3><p>Sell managed IT to law firms in Charlotte.</p><h3>Help Desk Technician</h3><p>Tier 1 support.</p>'),
  '/industries/law-firms': page('IT for Law Firms | Ridgeline IT', '<h1>IT for law firms</h1><p>Clio, NetDocuments and iManage support for 10–75 attorney firms.</p>'),
  '/industries/accounting-firms': page('IT for Accounting Firms | Ridgeline IT', '<h1>IT for accounting firms</h1><p>CCH, UltraTax and Drake support; tax-season uptime guaranteed.</p>'),
  '/case-studies': page('Case Studies | Ridgeline IT', '<h1>Case studies</h1><a href="/case-studies/law-firm-office-move">Law firm office move</a> <a href="/case-studies/cpa-ransomware-recovery">CPA firm ransomware recovery</a>'),
  '/case-studies/law-firm-office-move': page('Case Study: A 40-person law firm moves offices | Ridgeline IT', '<h1>How Hollis &amp; Grant Law moved 40 people over one weekend</h1><p>Zero downtime on Monday morning.</p>'),
  '/case-studies/cpa-ransomware-recovery': page('Case Study: CPA firm back online in 6 hours | Ridgeline IT', '<h1>Carolina Tax Partners recovered from ransomware in six hours</h1><p>Backups restored, no ransom paid.</p>'),
  '/blog': page('Blog | Ridgeline IT', '<h1>Blog</h1><a href="/blog/phishing-season">Phishing season</a> <a href="/blog/m365-backup">Microsoft 365 backup</a>'),
  '/blog/phishing-season': post('Tax season is phishing season', '2026-02-10', 'Five scams CPA firms saw this year.'),
  '/blog/m365-backup': post('Why Microsoft 365 is not a backup', '2026-04-22', 'Retention is not recovery.'),
  '/blog/clio-security': post('Locking down Clio for small firms', '2026-06-03', 'MFA, conditional access and more.'),
  '/blog/office-move-checklist': post('The office move checklist', '2025-11-18', 'Twelve weeks out, start here.'),
  '/blog/wisp-template': post('A WISP your CPA firm can use', '2026-08-04', 'IRS 4557 made practical.'),
};
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(PAGES).map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`;
const PDF = (() => {
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (Ridgeline IT Capability Statement) Tj T* [(Microsoft Solutions Partner ) (SOC 2 aligned, HIPAA and CMMC Level 1 ready)] TJ T* (Serving law firms and accounting firms since 2012) Tj ET'));
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Title (Ridgeline IT Capabilities) >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Length 160 /Filter /FlateDecode >> stream\n'), content, Buffer.from('\nendstream endobj\n%%EOF')]);
})();
const WAYBACK_HOMES = {
  2013: '<title>Ridgeline Computer Services — Charlotte PC repair</title><h1>PC and network repair for small offices</h1>',
  2016: '<title>Ridgeline Computer Services</title><h1>Computer support for Charlotte businesses</h1>',
  2019: '<title>Ridgeline IT | Managed IT Services</title><h1>Managed IT for professional firms</h1>',
  2022: '<title>Ridgeline IT | Managed IT for Law Firms</h1><h1>IT that law firms trust</h1>',
  2025: '<title>Ridgeline IT | Managed IT for Law &amp; Accounting Firms in Charlotte</title><h1>Managed IT that law firms and accounting firms trust</h1>',
};

// ── Response-shaped answers ──────────────────────────────────────────────────

function answer(status, body, { url = '', type = 'text/html; charset=utf-8', location = null } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? null));
  const headers = new Headers({ 'content-type': type, 'content-length': String(buf.length), ...(location ? { location } : {}) });
  return {
    ok: status >= 200 && status < 300, status, url, headers, body: null,
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}
const jsonAnswer = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json ?? null) });
const dnsMissing = (name) => Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });

// ── io.fetchExt: web pages ───────────────────────────────────────────────────

async function fetchExt(url, opts = {}) {
  const u = new URL(String(url));
  const method = String(opts.method || 'GET').toUpperCase();
  world.calls.push({ at: clock.iso(), kind: 'web', method, url: u.href });
  const follow = opts.redirect !== 'manual';
  // The applicant's site: the bare domain redirects to www.
  if (u.hostname === APPLICANT.domain) {
    latency(120);
    const to = `${SITE}${u.pathname}${u.search}`;
    return follow ? fetchExt(to, opts) : answer(301, '', { url: u.href, location: to });
  }
  if (u.origin === SITE) {
    latency(350);
    if (u.pathname === '/robots.txt') return answer(200, `User-agent: *\nAllow: /\nDisallow: /wp-admin/\nSitemap: ${SITE}/sitemap.xml\n`, { url: u.href, type: 'text/plain' });
    if (u.pathname === '/sitemap.xml') return answer(200, SITEMAP, { url: u.href, type: 'application/xml' });
    if (u.pathname === '/downloads/ridgeline-capabilities.pdf') return answer(200, PDF, { url: u.href, type: 'application/pdf' });
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return PAGES[path] ? answer(200, PAGES[path], { url: u.href }) : answer(404, '<h1>Not found</h1>', { url: u.href });
  }
  // The Wayback Machine's copy of their home page, one a year.
  const wb = /^\/web\/(\d{14})id_\//.exec(u.pathname);
  if (u.hostname === 'web.archive.org' && wb) {
    latency(900);
    const year = Number(wb[1].slice(0, 4));
    return answer(200, WAYBACK_HOMES[year] || WAYBACK_HOMES[2025], { url: u.href });
  }
  // The client's own booking link (Cal.com) — the onboarding page and the booking test open it.
  if (u.hostname === 'cal.com') {
    latency(400);
    return answer(200, '<html><head><title>Book a call with Dana Whitfield | Cal.com</title></head><body>cal.com booking page · 30 min</body></html>', { url: u.href });
  }
  // The new sending domain forwards to their website once CheapInboxes has set it.
  const ciDomain = world.ci && [...world.ci.domains.values()].find((d) => d.domain === u.hostname || `www.${d.domain}` === u.hostname);
  if (ciDomain) {
    latency(300);
    if (ciDomain.forwarding_url && follow) return fetchExt(ciDomain.forwarding_url, opts);
    return answer(200, '<html><title>Parked</title></html>', { url: u.href });
  }
  // Cloudflare's .com price (the monthly promo check).
  if (u.hostname === 'tld-list.com') { latency(500); return answer(200, '<table><tr><td>.com</td><td>$10.44</td></tr></table>', { url: u.href }); }
  // Look-alike domains (get…, try…): nobody registered them.
  world.unknown.push({ at: clock.iso(), kind: 'web', url: u.href });
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${u.hostname}`), { code: 'ENOTFOUND' });
}

// ── io.fetchJson: APIs ───────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const u = new URL(String(url));
  const method = String(opts.method || 'GET').toUpperCase();
  world.calls.push({ at: clock.iso(), kind: 'api', method, url: u.origin + u.pathname });
  if (u.hostname === 'api.cheapinboxes.com') { latency(300); return fakeCheapInboxes(u, method, opts); }
  if (u.href.startsWith(TOKEN_URL) || u.href.startsWith(REVOKE_URL) || u.href.startsWith(EVENTS_URL) || u.href.startsWith(USERINFO_URL)) { latency(400); return fakeGoogle(u, method, opts); }
  if (u.hostname === 'api.usaspending.gov') {
    latency(1400);
    const body = JSON.parse(opts.body || '{}');
    if (u.pathname.endsWith('/spending_by_category/recipient/')) return jsonAnswer(200, { results: [] });
    const types = body.filters?.award_type_codes || [];
    if (types.includes('07')) return jsonAnswer(200, { results: [{ 'Award ID': 'PPP-7721', 'Recipient Name': 'RIDGELINE IT LLC', 'Loan Value': 118400, 'Subsidy Cost': 119650, 'Issued Date': '2020-04-28' }, { 'Award ID': 'PPP-9', 'Recipient Name': 'RIDGELINE ROOFING INC', 'Loan Value': 51000, 'Issued Date': '2020-05-02' }] });
    return jsonAnswer(200, { results: [] });
  }
  if (u.hostname === 'efts.sec.gov') { latency(700); return jsonAnswer(200, { hits: { total: { value: 0 }, hits: [] } }); }
  if (u.hostname === 'web.archive.org' && u.pathname === '/cdx/search/cdx') {
    latency(1200);
    const fl = u.searchParams.get('fl') || '';
    if (fl === 'timestamp') {
      const rows = [['timestamp']];
      for (let y = 2013; y <= 2026; y++) for (const m of ['02', '06', '10']) if (`${y}${m}` <= '202609') rows.push([`${y}${m}15000000`]);
      return jsonAnswer(200, rows);
    }
    return jsonAnswer(200, [['timestamp', 'original', 'statuscode'], ...[2013, 2014, 2016, 2018, 2019, 2021, 2022, 2024, 2025].map((y) => [`${y}0615000000`, 'http://ridgelineit.com/', '200'])]);
  }
  world.unknown.push({ at: clock.iso(), kind: 'api', url: u.href });
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${u.hostname}`), { code: 'ENOTFOUND' });
}

// ── DNS ──────────────────────────────────────────────────────────────────────

const OWN_DNS = {
  txt: { 'ridgelineit.com': [['v=spf1 include:spf.protection.outlook.com include:_spf.hubspotemail.net -all'], ['MS=ms48213377'], ['docusign=9c1f2a'], ['knowbe4-site-verification=77ab']], '_dmarc.ridgelineit.com': [['v=DMARC1; p=quarantine; rua=mailto:dmarc@ridgelineit.com']] },
  mx: { 'ridgelineit.com': [{ exchange: 'ridgelineit-com.mail.protection.outlook.com', priority: 0 }] },
};
function trialDnsFor(name) {
  const base = name.replace(/^(google\._domainkey|_dmarc)\./, '');
  return world.dnsLive.has(base) ? base : null;
}
const fakeDns = {
  resolveTxt: async (name) => {
    latency(40);
    if (OWN_DNS.txt[name]) return OWN_DNS.txt[name];
    const d = trialDnsFor(name);
    if (d) {
      if (name.startsWith('google._domainkey.')) return [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq']];
      // CheapInboxes sets DMARC itself, with its own report address.
      if (name.startsWith('_dmarc.')) return [['v=DMARC1; p=none; rua=mailto:dmarc-reports@cheapinboxes.com']];
      return [['v=spf1 include:_spf.google.com ~all']];
    }
    throw dnsMissing(name);
  },
  resolveMx: async (name) => {
    latency(40);
    if (OWN_DNS.mx[name]) return OWN_DNS.mx[name];
    if (trialDnsFor(name) === name) return [{ exchange: 'smtp.google.com', priority: 1 }];
    throw dnsMissing(name);
  },
  resolve4: async (name) => {
    latency(30);
    if (name === APPLICANT.domain || name === `www.${APPLICANT.domain}`) return ['34.117.59.81'];
    if (trialDnsFor(name) === name) return ['216.239.32.21'];
    if (/^(smtp|aspmx\.l)\.google\.com$/.test(name)) return ['142.250.4.27'];
    // Every blacklist answers its documented test entry as listed (the checker asks each run) …
    if (/^2\.0\.0\.127\./.test(name) || /^test\.(uribl\.com\.multi\.uribl\.com|surbl\.org\.multi\.surbl\.org)$/.test(name) || name === 'test.dbl.nordspam.com') {
      return [name.includes('uribl') ? '127.0.0.2' : name.includes('surbl') ? '127.0.0.8' : '127.0.0.2'];
    }
    throw dnsMissing(name); // … and our domain, IPs and the controls as not listed
  },
};

// ── Google (the owner's account): OAuth + Calendar with Meet ─────────────────

export const GOOGLE = { clientId: '123456789012-ridgeline0test.apps.googleusercontent.com', clientSecret: 'GOCSPX-journey-secret-value', refresh: 'rt-journey-1', account: 'limethsith@gmail.com' };
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
function fakeGoogle(u, method, opts) {
  const g = world.google;
  g.calls.push({ method, url: u.origin + u.pathname });
  const idToken = ['x', Buffer.from(JSON.stringify({ email: GOOGLE.account, email_verified: true })).toString('base64url'), 'sig'].join('.');
  if (u.href.startsWith(TOKEN_URL)) {
    const f = new URLSearchParams(opts.body);
    if (f.get('client_id') !== GOOGLE.clientId || f.get('client_secret') !== GOOGLE.clientSecret) return jsonAnswer(401, { error: 'invalid_client' });
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== 'owner-said-allow') return jsonAnswer(400, { error: 'invalid_grant' });
      g.valid.add('at-0');
      return jsonAnswer(200, { access_token: 'at-0', expires_in: 3599, refresh_token: GOOGLE.refresh, scope: `${CAL_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`, token_type: 'Bearer', id_token: idToken });
    }
    if (f.get('grant_type') === 'refresh_token') {
      if (f.get('refresh_token') !== GOOGLE.refresh) return jsonAnswer(400, { error: 'invalid_grant' });
      const t = `at-${++g.refreshes}`;
      g.valid.add(t);
      return jsonAnswer(200, { access_token: t, expires_in: 3599, scope: CAL_SCOPE, token_type: 'Bearer' });
    }
    return jsonAnswer(400, { error: 'unsupported_grant_type' });
  }
  if (u.href.startsWith(REVOKE_URL)) return jsonAnswer(200, {});
  if (u.href.startsWith(USERINFO_URL)) return jsonAnswer(200, { email: GOOGLE.account });
  const token = String(opts.headers?.authorization || '').replace(/^Bearer /, '');
  if (!g.valid.has(token)) return jsonAnswer(401, { error: { code: 401, message: 'Invalid Credentials' } });
  const id = decodeURIComponent(u.pathname.split('/events/')[1] || '');
  if (method === 'POST' && !id) {
    const body = JSON.parse(opts.body);
    const n = ++g.n;
    const link = `https://meet.google.com/rdg-${String(n).padStart(3, '0')}-avc`;
    const ev = { id: `gev${n}`, status: 'confirmed', ...body, hangoutLink: link, conferenceData: { createRequest: { ...body.conferenceData.createRequest, status: { statusCode: 'success' } }, entryPoints: [{ entryPointType: 'video', uri: link }] } };
    g.events.set(ev.id, ev);
    return jsonAnswer(200, ev);
  }
  const ev = g.events.get(id);
  if (!ev) return jsonAnswer(404, { error: { code: 404, message: 'Not Found' } });
  if (method === 'GET') return jsonAnswer(200, ev);
  if (method === 'PATCH') { Object.assign(ev, JSON.parse(opts.body)); return jsonAnswer(200, ev); }
  if (method === 'DELETE') { g.events.delete(id); return jsonAnswer(204, null); }
  throw new Error(`fake Google does not know ${method} ${u.href}`);
}

// ── CheapInboxes (the owner's account; only HE buys — the fake's own state) ──

export const CI_KEY = 'ci_live_JourneyKey_0123456789abcdef';
const ciPage = (all, q) => { const limit = Number(q.limit) || 25; const offset = Number(q.offset) || 0; return { rows: all.slice(offset, offset + limit), pagination: { total: all.length, limit, offset } }; };
const ciNotFound = (what) => jsonAnswer(404, { error: { code: 'NOT_FOUND', message: `${what} not found` } });
const ORDERING = /\/(orders|billing\/(?!payment-methods$)|checkout|cancel)/;
function fakeCheapInboxes(u, method, opts) {
  const api = world.ci;
  const p = u.pathname;
  const call = { at: clock.iso(), method, path: p, query: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null };
  api.calls.push(call);
  if (ORDERING.test(p) || method === 'DELETE' && !/^\/v1\/webhooks\//.test(p)) api.forbidden.push(call);
  if (opts.headers?.authorization !== `Bearer ${CI_KEY}`) return jsonAnswer(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
  let m;
  if (method === 'GET' && p === '/v1/org') return jsonAnswer(200, { organization: { id: 'org_aviance', name: 'Aviance Outreach' }, role: 'owner' });
  if (method === 'GET' && p === '/v1/billing/payment-methods') return jsonAnswer(200, { payment_methods: [{ id: 'pm_1', type: 'card', is_default: true, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } }] });
  if (method === 'GET' && p === '/v1/webhooks') return jsonAnswer(200, [...api.hooks.values()].map(({ secret, ...h }) => h));
  if (method === 'POST' && p === '/v1/webhooks') {
    const h = { id: `wh_${++api.hookN}`, url: call.body.url, events: call.body.events, secret: `whsec_${crypto.randomBytes(18).toString('base64')}`, created_at: clock.iso() };
    api.hooks.set(h.id, h);
    return jsonAnswer(201, h);
  }
  if (method === 'DELETE' && (m = p.match(/^\/v1\/webhooks\/([^/]+)$/))) return api.hooks.delete(m[1]) ? jsonAnswer(200, { success: true }) : ciNotFound('Webhook');
  if (method === 'POST' && p === '/v1/discovery/domains/search') {
    const kw = call.body.keyword;
    const exact = (call.body.tlds || ['com']).map((t) => { const d = `${kw}.${t}`; const free = !api.taken.has(d); return { domain: d, available: free, status: free ? 'available' : 'registered', price: { com: 11.25, net: 13.5, co: 26 }[t] ?? 11.25, currency: 'USD' }; });
    return jsonAnswer(200, { exact, suggestions: [] });
  }
  if (method === 'GET' && p === '/v1/domains') { const r = ciPage([...api.domains.values()], call.query); return jsonAnswer(200, { domains: r.rows, pagination: r.pagination }); }
  if (method === 'GET' && (m = p.match(/^\/v1\/domains\/([^/]+)$/))) { const d = api.domains.get(m[1]); return d ? jsonAnswer(200, { domain: d }) : ciNotFound('Domain'); }
  if (method === 'PATCH' && (m = p.match(/^\/v1\/domains\/([^/]+)\/forwarding$/))) {
    const d = api.domains.get(m[1]);
    if (!d) return ciNotFound('Domain');
    Object.assign(d, { forwarding_url: call.body.forwarding_url, forwarding_permanent: call.body.permanent, forwarding_status: 'active' });
    return jsonAnswer(200, { domain: { id: d.id, forwarding_url: d.forwarding_url, forwarding_status: 'active' } });
  }
  if (method === 'GET' && p === '/v1/mailboxes') {
    let all = [...api.mailboxes.values()];
    if (call.query.domain_id) all = all.filter((x) => x.domain_id === call.query.domain_id);
    const r = ciPage(all, call.query);
    return jsonAnswer(200, { mailboxes: r.rows, pagination: r.pagination });
  }
  if (method === 'GET' && (m = p.match(/^\/v1\/mailboxes\/([^/]+)\/credentials$/))) { const c = api.creds.get(m[1]); return c ? jsonAnswer(200, { credentials: c }) : jsonAnswer(404, { error: { code: 'NOT_FOUND', message: 'Credentials are not available yet' } }); }
  if (method === 'GET' && (m = p.match(/^\/v1\/mailboxes\/([^/]+)$/))) { const x = api.mailboxes.get(m[1]); return x ? jsonAnswer(200, { mailbox: x }) : ciNotFound('Mailbox'); }
  throw new Error(`fake CheapInboxes does not know ${method} ${p}`);
}

/** The owner presses Buy in his CheapInboxes account: the domain + mailboxes appear, provisioning. */
export function ownerBuysInCheapInboxes(domain, mailboxes) {
  const api = world.ci;
  const id = `dom_${domain.replace(/\W/g, '')}`;
  api.domains.set(id, { id, domain, status: 'provisioning', setup_state: 'registering', provisioning_error: null, source_provider: 'cheapinboxes', dns_mode: 'nameservers', infra_provider: 'google', auto_renew: true, forwarding_url: null, created_at: clock.iso() });
  for (const mb of mailboxes) {
    const mid = `mb_${mb.email.replace(/\W/g, '')}`;
    api.mailboxes.set(mid, { id: mid, domain_id: id, full_email: mb.email, first_name: mb.firstName, last_name: mb.lastName, status: 'provisioning', source_provider: 'google', daily_limit: 50, created_at: clock.iso() });
  }
  return id;
}
/** CheapInboxes finishes the domain (DNS, DKIM, DMARC set by them). */
export function cheapInboxesDomainReady(domainId) {
  const d = world.ci.domains.get(domainId);
  Object.assign(d, { status: 'active', setup_state: 'dns_configured' });
  world.dnsLive.add(d.domain);
}
/** CheapInboxes finishes the mailboxes and their logins. */
export function cheapInboxesMailboxesReady(domainId) {
  for (const [id, x] of world.ci.mailboxes) {
    if (x.domain_id !== domainId) continue;
    x.status = 'active';
    world.ci.creds.set(id, { email: x.full_email, password: `Login-${x.full_email.split('@')[0]}#9`, app_password: 'wxyz abcd efgh ijkl', imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587 });
  }
}
/** A signed CheapInboxes webhook delivery (their HMAC over the raw body). */
export function cheapInboxesWebhook(event) {
  const hook = [...world.ci.hooks.values()][0];
  const raw = JSON.stringify({ id: `evt_${crypto.randomBytes(6).toString('hex')}`, type: event, created_at: clock.iso() });
  const sig = hook ? crypto.createHmac('sha256', hook.secret).update(raw).digest('hex') : 'none';
  return { raw, headers: { 'x-cheapinboxes-signature': `sha256=${sig}` } };
}

// ── the rest of the internet (global fetch) ──────────────────────────────────

function installFetch() {
  const simFetch = globalThis.fetch; // sim-world's: Porkbun, RDAP, GitHub, dkimvalidator
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    world.calls.push({ at: clock.iso(), kind: 'fetch', method: init.method || 'GET', url: u.split('?')[0] });
    if (u.includes('places.googleapis.com')) {
      latency(300);
      const mask = String(init.headers?.['X-Goog-FieldMask'] || '');
      const body = JSON.parse(init.body || '{}');
      if (mask.includes('formattedAddress')) {
        // The research's one business lookup.
        return new Response(JSON.stringify({ places: [{ id: 'ChIJridgeline', displayName: { text: 'Ridgeline IT' }, formattedAddress: '2100 South Blvd Suite 300, Charlotte, NC 28203, USA', primaryTypeDisplayName: { text: 'Computer support and services' }, rating: 4.8, userRatingCount: 61, googleMapsUri: 'https://maps.google.com/?cid=4411', nationalPhoneNumber: '(704) 555-0142', websiteUri: 'https://www.ridgelineit.com/' }] }), { status: 200 });
      }
      // IDs only (market counts): three pages of 20 per query.
      const n = body.pageToken ? Number(String(body.pageToken).split(':')[1]) : 0;
      const ids = Array.from({ length: 20 }, (_, i) => `pl-${crypto.createHash('md5').update(body.textQuery || '').digest('hex').slice(0, 8)}-${n}-${i}`);
      return new Response(JSON.stringify({ places: ids.map((id) => ({ id })), nextPageToken: n < 2 ? `tok:${n + 1}` : undefined }), { status: 200 });
    }
    // RDAP: their own domain is 14 years old; the rest are free.
    if (/rdap\.(verisign\.com|org)/.test(u)) {
      latency(150);
      if (u.endsWith(`/${APPLICANT.domain}`)) return new Response(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2012-03-19T15:02:11Z' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    }
    if (u.startsWith('https://emailverifier.reoon.com/')) return new Response(JSON.stringify({ status: 'safe', is_safe_to_send: true }), { status: 200 });
    if (u.startsWith('https://api.github.com/')) { world.calls.push({ at: clock.iso(), kind: 'dispatch', method: 'POST', url: u, body: init.body || null }); return new Response(null, { status: 204 }); }
    return simFetch(url, init);
  };
}

// ── mail ─────────────────────────────────────────────────────────────────────

function addressOf(v) {
  if (!v) return '';
  if (typeof v === 'string') { const m = /<([^>]+)>/.exec(v); return (m ? m[1] : v).trim().toLowerCase(); }
  return String(v.address || '').toLowerCase();
}
function installSmtp() {
  nodemailer.createTransport = (opts = {}) => ({
    async sendMail(m) {
      latency(250);
      const messageId = m.messageId || `<${crypto.randomUUID()}@sim>`;
      sim.sent.push({
        from: addressOf(m.from) || String(opts.auth?.user || ''), fromHeader: typeof m.from === 'string' ? m.from : '', user: opts.auth?.user || null,
        to: addressOf(m.to), subject: m.subject, text: m.text || '', html: m.html || '', messageId, at: clock.iso(),
        headers: m.headers || {}, inReplyTo: m.inReplyTo || null, references: m.references || null,
        icalEvent: m.icalEvent ? { method: m.icalEvent.method || null, content: String(m.icalEvent.content || '') } : null,
        attachments: (m.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType || null })),
      });
      return { messageId, response: '250 OK' };
    },
    async verify() { latency(200); return true; },
    close() {},
  });
}

/** Warm-up mail: most lands in the INBOX, a few in Spam (the read job rescues them). */
function installWarmupDelivery(seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let uid = 500000;
  warmNet.send = async (account, mail) => {
    const b = (sim.warmBoxes[mail.to] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    const id = `<${crypto.randomUUID()}@warm>`;
    const folder = rnd() < world.spamShare ? '[Gmail]/Spam' : 'INBOX';
    b[folder].push({ uid: ++uid, envelope: { messageId: id, from: [{ address: account.email }], subject: mail.subject }, headers: `X-Aviance-Warm: ${mail.headers['X-Aviance-Warm']}\r\nMessage-ID: ${id}\r\n` });
    return { success: true, messageId: id };
  };
}

// ── install ──────────────────────────────────────────────────────────────────

export function installJourney({ seed = 20261001, start = '2026-10-01T19:40:00Z' } = {}) {
  installWorld({ seed });
  // Ids, tokens and Message-IDs come from crypto.randomUUID / randomBytes: a seeded stream instead, so the
  // saved hub answers are the same on every run (tests only — the keys and tokens still work as keys and tokens).
  let uuidN = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
  let x = (seed ^ 0x9e3779b9) >>> 0;
  const byte = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 0xff; };
  crypto.randomBytes = (n, cb) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = byte(); if (cb) { process.nextTick(cb, null, b); return undefined; } return b; };
  syncBuiltinESMExports();
  clock.set(start);
  globalThis.Date = SimDate;
  Object.defineProperty(sim, 'now', { configurable: true, get: () => new RealDate(nowMs), set: (d) => { nowMs = d.getTime(); } });
  // Belt and braces: the callback DNS API too (safefetch resolves through it).
  dns.lookup = (host, o, cb) => { const done = typeof o === 'function' ? o : cb; process.nextTick(() => done(Object.assign(new Error(`real DNS blocked in the journey: ${host}`), { code: 'EBLOCKED' }))); };

  process.env.CRON_SECRET = 'journey-cron';
  process.env.OWNER_INBOX = `${OWNER.inbox}:app-pw-owner:${OWNER.name}`;
  process.env.OWNER_EMAIL = OWNER.email;
  process.env.PUBLIC_BASE_URL = MACHINE;
  process.env.LEADFINDER_TOKEN = 'journey-leadfinder';
  process.env.REOON_API_KEY = 'journey-reoon';
  delete process.env.OPEN_TRACKING;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.CHEAPINBOXES_API_KEY;
  delete process.env.HUB_URL;

  world.unknown = [];
  world.calls = [];
  world.dnsLive = new Set();
  world.google = { calls: [], events: new Map(), valid: new Set(), n: 0, refreshes: 0 };
  world.ci = { calls: [], forbidden: [], hooks: new Map(), hookN: 0, taken: new Set([`${APPLICANT.domain.split('.')[0]}.net`]), domains: new Map(), mailboxes: new Map(), creds: new Map() };

  installSmtp();
  installWarmupDelivery(seed + 7);
  installFetch();
  io.now = () => new RealDate(nowMs);
  io.fetchExt = fetchExt;
  io.fetchJson = fetchJson;
  io.dns = fakeDns;
  // Setup-check loopback: sent through the SMTP stub above; IMAP finds it with passing auth headers.
  io.imapFindMessage = async (acct, token) => { latency(800); return { found: true, folder: 'INBOX', headers: `Subject: Setup check ${token}\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=${acct.email.split('@')[1]}; spf=pass smtp.mailfrom=${acct.email}` }; };
  io.smtpVerify = async () => { latency(600); return { success: true }; };
  io.imapLogin = async () => { latency(700); return { ok: true, spamFolderExists: true }; };
}

// ── calling the machine like the website / hub / applicant would ─────────────

/** Run the after() callbacks a route left (Vercel runs them after the answer), including ones they add. */
export async function drainAfter() {
  let n = 0;
  while ((globalThis.__after || []).length) {
    const fns = globalThis.__after.splice(0);
    for (const fn of fns) { n++; await fn(); }
  }
  return n;
}

/**
 * Call a route handler: `route` is the module under src/app (e.g.
 * 'api/mc/hub/[id]/route'), `params` its dynamic segments (passed as Next 15
 * does: a promise that also carries the values). → { status, json|text, headers, after }.
 */
export async function call(route, method, { path = '/', body, headers = {}, params = null, form = null } = {}) {
  const mod = await import(`@/app/${route}`);
  const init = { method, headers: { ...headers } };
  if (form) { init.body = new URLSearchParams(form).toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  else if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); if (typeof body !== 'string') init.headers['content-type'] ||= 'application/json'; }
  const req = new Request(`${MACHINE}${path}`, init);
  const ctx = { params: Object.assign(Promise.resolve(params || {}), params || {}) };
  globalThis.__after = [];
  const res = await mod[method](req, ctx);
  const type = res.headers.get('content-type') || '';
  const out = { status: res.status, headers: res.headers };
  if (type.includes('json')) out.json = await res.json(); else out.text = await res.text();
  out.after = await drainAfter();
  return out;
}

/** The mail sent since `mark` (an index into sim.sent). */
export const sentSince = (mark) => sim.sent.slice(mark);
export const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find((l) => l && !/^hi\b/i.test(l)) || '';
export const linkIn = (text, pagePath) => { const m = new RegExp(`${MACHINE.replace(/[.]/g, '\\.')}/c/([A-Za-z0-9_-]{20,})/${pagePath}`).exec(String(text || '')); return m ? m[1] : null; };
