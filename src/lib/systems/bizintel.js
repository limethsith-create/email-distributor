/**
 * Money and history of an applicant (Research v3): what public records say,
 * free and without keys. Private small companies do not publish revenue, so
 * everything here is either a public record or a range computed from one,
 * with the formula and the source shown — never a guessed number.
 *
 *  money    USAspending.gov (federal spending, public domain): Paycheck
 *           Protection Program loans — the SBA formula (loan = 2.5 × average
 *           monthly payroll) gives the payroll behind it — plus federal
 *           contracts and grants they won. SEC EDGAR full-text search: Form D
 *           (private fundraising) and other filings in their name.
 *           A revenue RANGE: headcount × the industry's revenue per employee,
 *           and payroll ÷ the industry's payroll share (Census SUSB), each
 *           shown with its basis.
 *  history  the Wayback Machine: the home page once a year since it first
 *           appeared — title, headline and description — so a rebrand or a
 *           change of offer shows up.
 */

import { io } from '@/lib/systems/intake-io';

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = squash(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const STOP = new Set(['inc', 'llc', 'pc', 'pllc', 'pa', 'co', 'corp', 'corporation', 'company', 'ltd', 'group', 'the', 'and', 'of', 'services', 'solutions', 'lp', 'llp']);
export const nameTokens = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));

/**
 * Is a public record in this company's name? The telling words must be the
 * same words ("BURGESS COMPANY, PC" = "Burgess Company"; "BURGESS FARMS" is
 * someone else), or the same letters run together ("PIVITSTRATEGY").
 * A miss is better than someone else's money in the report.
 */
export function sameCompany(recordName, searchName) {
  const want = nameTokens(searchName);
  const have = nameTokens(recordName);
  if (!want.length || !have.length) return false;
  const a = [...new Set(want)].sort().join(' ');
  const b = [...new Set(have)].sort().join(' ');
  return a === b || (want.join('').length >= 6 && want.join('') === have.join(''));
}

/**
 * Names a company goes by on the public record, best first: its site's own
 * spelling, schema.org, the part of the title that shares a word with the
 * domain ("Burgess Company" for burgesscpas.com), the copyright line
 * ("© 2024 Burgess Company, PC"), the Google listing, the application.
 */
export function nameCandidates({ domain = '', siteName = null, orgName = null, title = '', copyright = '', brand = [], business = null, clientName = '' } = {}) {
  const label = String(domain).split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const pieces = String(title || '').split(/\s+[|–—:-]\s+|\s*[|:]\s*/).map(squash).filter((p) => p && p.length <= 60 && p.split(' ').length <= 6);
  const fromTitle = pieces.filter((p) => nameTokens(p).some((t) => t.length >= 4 && label.includes(t)));
  const copy = (String(copyright || '').match(/(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(?:\d{4})?\s*,?\s*([A-Z][A-Za-z0-9&.,' -]{2,60}?)(?:\.|,?\s+all rights|\s*\||\s*$)/i) || [])[1];
  const list = [siteName, orgName, ...fromTitle, copy, ...(brand || []).slice(0, 2), business?.name, clientName].map((n) => squash(String(n || '').replace(/,?\s*all rights reserved.*$/i, ''))).filter((n) => n && nameTokens(n).length);
  const seen = new Set();
  return list.filter((n) => { const k = nameTokens(n).join(' '); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
}

// ── USAspending.gov ─────────────────────────────────────────────────────────

const USA = 'https://api.usaspending.gov/api/v2';
const CONTRACTS = ['A', 'B', 'C', 'D'];
const GRANTS = ['02', '03', '04', '05'];
const LOANS = ['07', '08'];

async function usaPost(path, body, timeoutMs) {
  // USAspending is slow at times (503s, 10 s answers): one retry.
  const res = await io.fetchJson(`${USA}${path}`, { service: 'usaspending', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs, retry: true });
  if (!res.ok || !res.json) throw new Error(`usaspending ${res.status}`);
  return res.json;
}

/** SBA rule for first-draw PPP loans: 2.5 × average monthly payroll (2019). → yearly payroll. */
export function payrollFromPpp(loans = []) {
  const first = loans.filter((l) => l.amount > 0).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  if (!first) return null;
  return { annual: Math.round((first.amount / 2.5) * 12), fromLoan: first.amount, loanDate: first.date, basis: 'PPP loan ÷ 2.5 × 12 (SBA formula: a first-draw loan was 2.5 months of 2019 payroll; pay above $100k a person was capped, so this is a floor)' };
}

/**
 * Federal money in their name (and state): PPP loans, contracts, grants.
 * Every record is matched by name words and state; unmatched look-alikes are dropped.
 */
export async function federalMoney({ names = [], state = null, states = null, timeoutMs = 9000 } = {}) {
  const search = [...new Set(names.map(squash).filter((n) => nameTokens(n).length))].slice(0, 3);
  if (!search.length) return null;
  const where = (states || (state ? [state] : [])).length ? { recipient_locations: (states || [state]).map((st) => ({ country: 'USA', state: st })) } : {};
  const window = [{ start_date: '2007-10-01', end_date: new Date().toISOString().slice(0, 10) }];
  const base = { recipient_search_text: search, time_period: window, ...where };
  const [ppp, contracts, grants, totals] = await Promise.allSettled([
    usaPost('/search/spending_by_award/', { filters: { ...base, award_type_codes: LOANS, program_numbers: ['59.073'] }, fields: ['Award ID', 'Recipient Name', 'Loan Value', 'Subsidy Cost', 'Issued Date'], limit: 10, page: 1 }, timeoutMs),
    usaPost('/search/spending_by_award/', { filters: { ...base, award_type_codes: CONTRACTS }, fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'], limit: 5, page: 1, sort: 'Award Amount', order: 'desc' }, timeoutMs),
    usaPost('/search/spending_by_award/', { filters: { ...base, award_type_codes: GRANTS }, fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'], limit: 5, page: 1, sort: 'Award Amount', order: 'desc' }, timeoutMs),
    usaPost('/search/spending_by_category/recipient/', { filters: { ...base, award_type_codes: [...CONTRACTS, ...GRANTS] }, limit: 5, page: 1 }, timeoutMs),
  ]);
  const mine = (r) => search.some((n) => sameCompany(r['Recipient Name'] || r.name, n));
  const rows = (p) => (p.status === 'fulfilled' ? (p.value.results || []).filter(mine) : null);
  const loanRows = rows(ppp);
  const loans = (loanRows || []).map((r) => ({ amount: Number(r['Loan Value']) || 0, forgiven: Number(r['Subsidy Cost']) > 0, date: r['Issued Date'] || null, recipient: r['Recipient Name'], id: r['Award ID'] }));
  const award = (r) => ({ amount: Number(r['Award Amount']) || 0, agency: r['Awarding Agency'] || null, date: r['Start Date'] || null, what: clip(r.Description, 120) || null, recipient: r['Recipient Name'], id: r['Award ID'] });
  const c = rows(contracts);
  const g = rows(grants);
  const t = totals.status === 'fulfilled' ? (totals.value.results || []).filter(mine) : null;
  const errors = [ppp, contracts, grants, totals].filter((p) => p.status === 'rejected').map((p) => String(p.reason?.message || p.reason).slice(0, 80));
  return {
    searched: search, state: (states || [state]).filter(Boolean).join(', ') || null,
    ppp: loanRows ? loans : null,
    payroll: loanRows ? payrollFromPpp(loans) : null,
    contracts: c ? c.map(award) : null,
    grants: g ? g.map(award) : null,
    federalTotal: t ? t.reduce((s, r) => s + (Number(r.amount) || 0), 0) : null,
    recipients: [...new Set([...(loanRows || []), ...(c || []), ...(g || [])].map((r) => r['Recipient Name']))].slice(0, 5),
    errors,
    source: 'USAspending.gov',
  };
}

// ── SEC EDGAR full-text search ──────────────────────────────────────────────

/** Filings in their exact name (Form D = they raised money privately). */
export async function secFilings(name, { userAgent, timeoutMs = 8000 } = {}) {
  if (!nameTokens(name).length) return null;
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${squash(name)}"`)}&dateRange=all`;
  const res = await io.fetchJson(url, { service: 'sec', timeoutMs, retry: false, headers: { 'user-agent': userAgent, accept: 'application/json' } });
  if (!res.ok || !res.json) throw new Error(`sec ${res.status}`);
  const hits = res.json.hits?.hits || [];
  const out = [];
  for (const h of hits) {
    const src = h._source || {};
    const entity = (src.display_names || [])[0] || '';
    if (!sameCompany(entity.replace(/\s*\(CIK[^)]*\)\s*$/i, ''), name)) continue;
    const cik = (entity.match(/CIK\s*0*(\d+)/i) || [])[1] || (src.ciks || [])[0] || null;
    out.push({ form: src.form || src.root_forms?.[0] || null, date: src.file_date || null, entity: clip(entity, 100), url: cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}` : null });
    if (out.length >= 8) break;
  }
  return { total: out.length, filings: out, raisedMoney: out.some((f) => /^D(\/A)?$/.test(String(f.form))), source: 'SEC EDGAR' };
}

// ── revenue range ──────────────────────────────────────────────────────────

/**
 * Revenue per employee and payroll share of revenue for small US firms
 * (5–99 staff). Census SUSB 2022 (receipts, payroll, employment by NAICS and
 * firm size) plus the trade surveys where public; the ranges sit below the
 * Census averages (averages run high, Census leaves owners out). Sources and
 * the judgement behind each range: docs/assumptions/research-v3.md.
 */
const CENSUS = 'Census SUSB 2022';
export const BENCHMARKS = {
  msp: { label: 'IT services / MSPs', perEmployee: [140_000, 250_000], payrollShare: [0.32, 0.38], perEmployeeSource: `${CENSUS} NAICS 541512/541513, Service Leadership`, payrollSource: `${CENSUS} NAICS 541512/541513` },
  accounting: { label: 'accounting / CPA firms', perEmployee: [120_000, 210_000], payrollShare: [0.43, 0.49], perEmployeeSource: `${CENSUS} NAICS 541211, Rosenberg survey`, payrollSource: `${CENSUS} NAICS 541211` },
  law: { label: 'law firms', perEmployee: [150_000, 260_000], payrollShare: [0.37, 0.43], perEmployeeSource: `${CENSUS} NAICS 541110`, payrollSource: `${CENSUS} NAICS 541110` },
  engineering: { label: 'engineering / architecture firms', perEmployee: [150_000, 250_000], payrollShare: [0.36, 0.40], perEmployeeSource: `${CENSUS} NAICS 541310/541330, Zweig 2025`, payrollSource: `${CENSUS} NAICS 541310/541330` },
  agency: { label: 'marketing / advertising agencies', perEmployee: [120_000, 220_000], payrollShare: [0.26, 0.31], perEmployeeSource: `${CENSUS} NAICS 541810/541613, Promethean Research`, payrollSource: `${CENSUS} NAICS 541810/541613` },
  trades: { label: 'specialty trades (plumbing, HVAC, electrical …)', perEmployee: [180_000, 270_000], payrollShare: [0.24, 0.28], perEmployeeSource: `${CENSUS} NAICS 238`, payrollSource: `${CENSUS} NAICS 238220/238210` },
  roofing: { label: 'roofing contractors', perEmployee: [250_000, 330_000], payrollShare: [0.17, 0.21], perEmployeeSource: `${CENSUS} NAICS 238160`, payrollSource: `${CENSUS} NAICS 238160` },
  cleaning: { label: 'commercial cleaning', perEmployee: [55_000, 80_000], payrollShare: [0.34, 0.43], perEmployeeSource: `${CENSUS} NAICS 561720`, payrollSource: `${CENSUS} NAICS 561720` },
  staffing: null, // Census counts placed temps as employees: no fair per-office-employee figure
  'pro-services': { label: 'professional services', perEmployee: [150_000, 250_000], payrollShare: [0.35, 0.39], perEmployeeSource: `${CENSUS} NAICS 54`, payrollSource: `${CENSUS} NAICS 54` },
  'trial-default': { label: 'B2B services (general)', perEmployee: [150_000, 250_000], payrollShare: [0.35, 0.39], perEmployeeSource: `${CENSUS} NAICS 54`, payrollSource: `${CENSUS} NAICS 54` },
};

/** The benchmark for what they sell: the copy niche, refined by their own words. */
export function benchmarkFor({ niche = 'trial-default', text = '' } = {}) {
  const t = String(text || '').toLowerCase();
  if (/\b(staffing|recruit\w*|temp agency)\b/.test(t)) return null;
  if (/\b(accounting|accountants?|cpas?|bookkeep\w*|tax (?:prep\w*|services?))\b/.test(t)) return BENCHMARKS.accounting;
  if (/\b(law firm|attorneys?|legal services?|lawyers?)\b/.test(t) && !/\bfor (?:law|legal)\b/.test(t)) return BENCHMARKS.law;
  if (/\b(engineering firm|architects?|architecture)\b/.test(t)) return BENCHMARKS.engineering;
  if (/\broof\w*/.test(t)) return BENCHMARKS.roofing;
  if (/\b(janitorial|commercial cleaning|cleaning services?)\b/.test(t)) return BENCHMARKS.cleaning;
  return BENCHMARKS[niche] || BENCHMARKS['trial-default'];
}

/**
 * A revenue RANGE from what is known, each with its basis (headcount ×
 * revenue per employee; PPP payroll ÷ payroll share). null when nothing
 * supports one. Always labelled an estimate by the caller.
 */
export function revenueRange({ headcount = null, headcountExact = false, payroll = null, bench = null } = {}) {
  const b = bench;
  if (!b) return null;
  const k = (n) => Math.round(n / 1000) * 1000;
  const out = [];
  if (headcount && b.perEmployee) {
    out.push({
      low: k(headcount * b.perEmployee[0]),
      high: k(headcount * b.perEmployee[1]),
      basis: `${headcount}${headcountExact ? '' : '+'} people × $${b.perEmployee[0].toLocaleString('en-US')}–$${b.perEmployee[1].toLocaleString('en-US')} revenue per employee for ${b.label} (${b.perEmployeeSource})`,
      floor: !headcountExact,
    });
  }
  if (payroll?.annual && b.payrollShare) {
    out.push({
      low: k(payroll.annual / b.payrollShare[1]),
      high: k(payroll.annual / b.payrollShare[0]),
      basis: `2019 payroll about $${payroll.annual.toLocaleString('en-US')} (their PPP loan) ÷ payroll being ${Math.round(b.payrollShare[0] * 100)}–${Math.round(b.payrollShare[1] * 100)}% of revenue for ${b.label} (${b.payrollSource})`,
      floor: true,
      year: 2019,
    });
  }
  return out.length ? out : null;
}

// ── history (Wayback Machine) ──────────────────────────────────────────────

/** One capture per year (the earliest of each year), newest last, at most `max` (always the first and the latest). */
export function yearlyCaptures(rows = [], max = 6) {
  const list = rows.slice(rows[0]?.[0] === 'timestamp' ? 1 : 0).filter((r) => Array.isArray(r) && /^\d{14}$/.test(r[0]) && (!r[2] || String(r[2]) === '200'));
  const byYear = new Map();
  for (const r of list.sort((a, b) => a[0].localeCompare(b[0]))) if (!byYear.has(r[0].slice(0, 4))) byYear.set(r[0].slice(0, 4), { ts: r[0], url: r[1] });
  const years = [...byYear.values()];
  if (years.length <= max) return years;
  const pick = new Set([0, years.length - 1]);
  for (let i = 1; pick.size < max; i++) pick.add(Math.round((i * (years.length - 1)) / (max - 1)));
  return [...pick].sort((a, b) => a - b).map((i) => years[i]);
}

/** Title / headline / description of an archived home page. */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™' };
const decodeHtml = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32)).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);

export function snapshotFacts(html) {
  const h = String(html || '');
  const text = (s) => clip(decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ')), 160);
  return {
    title: text((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]),
    headline: text((h.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]),
    description: text((h.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i) || h.match(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i) || [])[1]),
  };
}

/** The captures list for the timeline (CDX: timestamp, original, statuscode). */
export async function captureList(domain, { timeoutMs = 8000 } = {}) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&collapse=timestamp:4&limit=60`;
  const res = await io.fetchJson(url, { service: 'wayback', timeoutMs, retry: false });
  if (!res.ok || !Array.isArray(res.json)) throw new Error(`wayback ${res.status}`);
  return res.json;
}

/** Read the chosen yearly captures (original HTML via the id_ form). */
export async function timeline(captures, { timeoutMs = 8000, concurrency = 3 } = {}) {
  const out = [];
  for (let i = 0; i < captures.length; i += concurrency) {
    const batch = captures.slice(i, i + concurrency);
    const got = await Promise.all(batch.map(async (c) => {
      try {
        const res = await io.fetchExt(`https://web.archive.org/web/${c.ts}id_/${c.url}`, { service: 'wayback', timeoutMs, retry: false, headers: { 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' } });
        if (res.status !== 200) return null;
        const html = String(await res.text()).slice(0, 400_000);
        return { year: Number(c.ts.slice(0, 4)), date: `${c.ts.slice(0, 4)}-${c.ts.slice(4, 6)}-${c.ts.slice(6, 8)}`, ...snapshotFacts(html), url: `https://web.archive.org/web/${c.ts}/${c.url}` };
      } catch { return null; }
    }));
    out.push(...got.filter(Boolean));
  }
  // Mark what changed from the year before (a new name or a new offer).
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    b.changed = [a.title !== b.title && b.title ? 'title' : null, a.headline !== b.headline && b.headline ? 'headline' : null].filter(Boolean);
  }
  return out;
}
