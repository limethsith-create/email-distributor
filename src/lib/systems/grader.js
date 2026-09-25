/**
 * Lead Grader (Leads v2). Scores every lead 0–100 with plain-language
 * reasons and a grade A / B / C / rejected. No AI: every point comes from a
 * fact the Lead Finder recorded or a check the verifier made.
 *
 *   ICP match          ≤ 30  industry words, city / state, size band, dream customers
 *   decision-maker     ≤ 20  owner-level title → office manager; the client's own titles
 *   named person       ≤ 10  full name, or a first name only
 *   verified email     ≤ 20  valid 20 · catch-all 4 · risky / unknown 2 · pending 0
 *   website quality    ≤ 10  https, updated this year, street address, phone, mobile layout
 *   Google reputation  ≤  6  rating and review count (Places)
 *   intent / problem   ≤  8  hiring, a new location, and what the client's niche fixes
 *                            (free-mail business address, no https, an old site …)
 *
 * Rejected (never sent), with the reason: role address, invalid email, no
 * mail server, throwaway domain, chain / franchise, outside the area, too big
 * or too small, excluded title, no name, duplicate company, catch-all while
 * risky sends are not allowed (never in week one).
 *
 * Only grades in GRADE.sendable (A, B) are sendable, and only once the
 * address is verified `valid` (SEND.allowRiskyAfterDay may let risky /
 * catch-all through after week one; default never).
 *
 * The rollup client:{id}:leadquality is what the hub shows (HUB-API "Lead
 * quality"); `leadQualityView(clientId)` returns it.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getProfile, getTrial } from '@/lib/db/client';
import { getLeads } from '@/lib/db/leads';
import { chainHosts } from '@/lib/systems/listfiles';
import { sendingDayNumber } from '@/lib/systems/ramp';
import { nicheOf } from '@/lib/systems/copy';
import { dayKeyIn, ET } from '@/lib/time';
import {
  titleTier, isRoleAddress, isFreemail, isDisposable, franchiseBrand, normState, keywords, stem,
} from '@/lib/leadquality/rules.mjs';

const list = (v) => {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  if (s.startsWith('[')) { try { return list(JSON.parse(s)); } catch { /* plain text */ } }
  return s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
};
const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const lower = (s) => String(s || '').trim().toLowerCase();

/** Plain-language labels for every reject reason (finder-side and grader-side). */
export const REJECT_LABELS = {
  role: 'Role address (info@, sales@ …)',
  invalid_email: 'Email address does not exist',
  no_mx: 'Domain cannot receive email',
  disposable: 'Throwaway email domain',
  chain: 'Chain or franchise location',
  out_of_area: 'Outside the target area',
  size: 'Too large or too small for the size band',
  excluded_title: 'Job title on the exclude list',
  no_name: 'No named person found',
  duplicate_company: 'Company already on the list',
  duplicate_person: 'Same person found twice',
  blocklist: "On the client's do-not-contact list",
  suppressed: 'Opted out (STOP) before',
  other_client: 'Another client in this niche has it (90 days)',
  catchall: 'Catch-all domain (cannot be verified — not sent in week one)',
  closed: 'Business marked closed',
  excluded_pattern: 'Excluded after a rejected batch',
  site_unreachable: 'Website did not load',
  crawl_error: 'Website could not be read',
};
/** Finder drops that are search artefacts, not companies we judged (not counted as graded). */
const NOT_GRADED = new Set(['no_website', 'duplicate_host', 'no_state']);

const BIG_TYPES = new Set(['hospital', 'university', 'airport', 'shopping_mall', 'department_store', 'supermarket', 'city_hall', 'local_government_office', 'embassy', 'stadium', 'courthouse', 'police', 'fire_station', 'post_office', 'amusement_park', 'casino']);
const REGULATED_TYPES = /dentist|dental|doctor|medical|clinic|physiotherap|chiropract|health|lawyer|legal|attorney|accounting|accountant|cpa|insurance|financial|bank|veterinar/;

// ── what the client's niche fixes: prospect problems we can see for free ─────

/**
 * Per client niche (copy.nicheOf): signals that say the prospect has the
 * problem the client solves. Each is a fact from the crawl, never a guess.
 */
const PROBLEM_RULES = {
  msp: [
    { id: 'freemail', pts: 4, test: (l) => l.signals?.freemailContact || isFreemail(l.email), text: () => 'Uses a free Gmail/Yahoo-type address for business email' },
    { id: 'nohttps', pts: 3, test: (l) => l.signals?.https === false, text: () => 'Website has no HTTPS' },
    { id: 'regulated', pts: 3, test: (l) => REGULATED_TYPES.test(`${list(l.types).join(' ')} ${l.facts?.primaryType || ''} ${lower(l.company)}`), text: () => 'Handles regulated client data (health, legal or financial records)' },
    { id: 'hiring', pts: 2, test: (l) => l.signals?.hiring, text: () => 'Growing: hiring now (more people, more IT)' },
    { id: 'expansion', pts: 2, test: (l) => l.signals?.expansion, text: () => 'Opening a new location' },
  ],
  agency: [
    { id: 'nohttps', pts: 3, test: (l) => l.signals?.https === false, text: () => 'Website has no HTTPS' },
    { id: 'oldsite', pts: 3, test: (l, now) => Number(l.signals?.copyrightYear) > 0 && Number(l.signals.copyrightYear) <= now.getUTCFullYear() - 2, text: (l) => `Website not updated since ${l.signals.copyrightYear}` },
    { id: 'nomobile', pts: 3, test: (l) => l.signals && l.signals.viewport === false && Number(l.signals.pagesRead) > 0, text: () => 'Website is not mobile-friendly' },
    { id: 'fewreviews', pts: 2, test: (l) => Number.isFinite(Number(l.facts?.reviews)) && l.facts.reviews !== null && Number(l.facts.reviews) < 20, text: (l) => `Only ${l.facts.reviews} Google reviews` },
    { id: 'lowrating', pts: 2, test: (l) => Number(l.facts?.rating) > 0 && Number(l.facts.rating) < 4, text: (l) => `Google rating ${l.facts.rating}★` },
    { id: 'nodesc', pts: 1, test: (l) => l.signals && l.signals.metaDescription === false && Number(l.signals.pagesRead) > 0, text: () => 'Home page has no search description' },
  ],
  trades: [
    { id: 'expansion', pts: 3, test: (l) => l.signals?.expansion, text: () => 'Opening a new location (more space to look after)' },
    { id: 'hiring', pts: 2, test: (l) => l.signals?.hiring, text: () => 'Growing: hiring now' },
    { id: 'established', pts: 1, test: (l) => Number(l.facts?.years) >= 15, text: (l) => `${l.facts.years} years in business (older premises)` },
  ],
  'pro-services': [
    { id: 'hiring', pts: 3, test: (l) => l.signals?.hiring, text: () => 'Growing: hiring now' },
    { id: 'newbiz', pts: 3, test: (l, now) => Number(l.facts?.since) >= now.getUTCFullYear() - 3, text: (l) => `New business (since ${l.facts.since})` },
    { id: 'expansion', pts: 2, test: (l) => l.signals?.expansion, text: () => 'Opening a new location' },
  ],
  'trial-default': [
    { id: 'hiring', pts: 3, test: (l) => l.signals?.hiring, text: () => 'Growing: hiring now' },
    { id: 'expansion', pts: 3, test: (l) => l.signals?.expansion, text: () => 'Opening a new location' },
  ],
};

// ── context ──────────────────────────────────────────────────────────────────

/** Everything gradeLead needs about the client, loaded once per batch / run. */
export async function gradeContext(clientId, { now = new Date(), profile = null, trial = null } = {}) {
  const [p, t] = await Promise.all([profile ? Promise.resolve(profile) : getProfile(clientId), trial ? Promise.resolve(trial) : getTrial(clientId)]);
  const pr = p || {};
  const sendingDay = t?.day1Date ? sendingDayNumber(t.day1Date, dayKeyIn(ET, now)) : 0;
  const [A, B, sendable, allowRiskyAfterDay] = await Promise.all([
    cfg(clientId, 'GRADE.A'), cfg(clientId, 'GRADE.B'), cfg(clientId, 'GRADE.sendable'), cfg(clientId, 'SEND.allowRiskyAfterDay'),
  ]);
  let chains = new Set();
  try { chains = chainHosts(); } catch { /* list file not in the bundle: brand names still apply */ }
  return buildContext(pr, { now, sendingDay, A, B, sendable, allowRiskyAfterDay, chains, niche: nicheOf(pr), contactsPerCompany: Number(pr.contactsPerCompany) || 1 });
}

/** Pure part of the context (tests build it directly). */
export function buildContext(profile = {}, { now = new Date(), sendingDay = 0, A = 70, B = 50, sendable = ['A', 'B'], allowRiskyAfterDay = null, chains = new Set(), niche = 'trial-default', contactsPerCompany = 1 } = {}) {
  const cities = list(profile.cities).map((c) => {
    const [city, st] = c.includes('|') ? c.split('|') : [c.replace(/,\s*[A-Za-z]{2}\s*$/, ''), (/,\s*([A-Za-z]{2})\s*$/.exec(c) || [])[1] || ''];
    return { city: lower(city), state: normState(st) };
  });
  const states = new Set(list(profile.states).map(normState).filter(Boolean));
  for (const c of cities) if (c.state) states.add(c.state);
  const industryWords = new Set([...keywords(list(profile.industry).join(' ')), ...keywords(profile.defaultIcp || profile.icp || '')].map(stem));
  const dreams = parse(profile.dreamCustomers, []);
  return {
    profile, now, sendingDay, allowRiskyAfterDay, chains, niche,
    thresholds: { A: Number(A) || 70, B: Number(B) || 50 },
    sendable: Array.isArray(sendable) ? sendable : ['A', 'B'],
    cities, states, industryWords,
    industryLabel: list(profile.industry)[0] || '',
    titles: list(profile.titles).map(lower),
    excludedTitles: list(profile.excludedTitles).map(lower),
    sizeMin: Number(profile.sizeMin) || null,
    sizeMax: Number(profile.sizeMax) || null,
    dreams: Array.isArray(dreams) ? dreams : [],
    contactsPerCompany: Math.max(1, Math.min(3, contactsPerCompany)),
  };
}

/** May risky / catch-all addresses be sent on this sending day? Never in week one. */
export function riskyAllowed(ctx) {
  const n = ctx.allowRiskyAfterDay;
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return false;
  return Number(ctx.sendingDay) >= Math.max(8, Number(n));
}

/** The verification state of a lead (v2 field, else mapped from the v1 riskLevel). */
export function verifyStateOf(lead) {
  if (lead.verifyStatus) return lead.verifyStatus;
  const r = lower(lead.riskLevel);
  if (r === 'safe') return 'valid'; // v1 / referral / test-mode record: an address a person gave us or a mailbox we own
  if (r === 'catchall') return 'catchall';
  return 'risky';
}

// ── grading ──────────────────────────────────────────────────────────────────

/**
 * Grade one lead. Pure. ctx from buildContext/gradeContext plus optional
 * `duplicateCompany` (another lead at this host already fills the quota).
 * → { grade, score, reasons[], rejectReason, problems[], sendable }
 */
export function gradeLead(lead = {}, ctx = buildContext({}), { duplicateCompany = false } = {}) {
  const reasons = [];
  const problems = [];
  const email = lower(lead.email);
  const host = lower(lead.host || String(lead.website || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').split(/[/?#:]/)[0] || email.split('@')[1]);
  const vstate = verifyStateOf(lead);
  const reject = (key, extra) => ({ grade: 'rejected', score: 0, reasons: [REJECT_LABELS[key] + (extra ? ` (${extra})` : ''), ...reasons], rejectReason: key, problems, sendable: false });

  // Hard rejects first (cheapest to explain).
  if (!email.includes('@')) return reject('invalid_email');
  if (isRoleAddress(email)) return reject('role', email.split('@')[0] + '@');
  if (isDisposable(email)) return reject('disposable');
  if (vstate === 'invalid') return reject(lead.verifyDetail === 'no_mx' ? 'no_mx' : 'invalid_email', lead.verifiedBy || '');
  const brand = franchiseBrand(lead.company);
  if (brand || lead.signals?.franchise || (host && ctx.chains?.has?.(host))) return reject('chain', brand || (lead.signals?.franchise ? 'franchise notice on the site' : host));
  const st = normState(lead.state);
  if (!st) return reject('out_of_area', 'no US state');
  if (ctx.states.size && !ctx.states.has(st)) return reject('out_of_area', st);
  if (list(lead.types).some((t) => BIG_TYPES.has(lower(t)))) return reject('size', 'large organisation');
  const emp = Number(lead.employees);
  if (Number.isFinite(emp) && emp > 0 && ((ctx.sizeMin && emp < ctx.sizeMin * 0.5) || (ctx.sizeMax && emp > ctx.sizeMax * 2))) return reject('size', `${emp} staff`);
  const title = lower(lead.title);
  if (title && ctx.excludedTitles.some((x) => x && (title.includes(x) || x.includes(title)))) return reject('excluded_title', lead.title);
  const fullName = String(lead.name || '').trim();
  const firstName = String(lead.first_name || '').trim() || fullName.split(/\s+/)[0] || '';
  if (!firstName) return reject('no_name');
  if (duplicateCompany) return reject('duplicate_company', host);
  if (vstate === 'catchall' && !riskyAllowed(ctx)) return reject('catchall');

  let score = 0;
  // ICP match (≤ 30)
  let icp = 0;
  const leadText = `${lower(lead.company)} ${list(lead.types).join(' ').replace(/_/g, ' ')} ${String(lead.facts?.primaryType || '').replace(/_/g, ' ')} ${list(lead.facts?.services).join(' ')} ${lower(lead.query)}`;
  const leadWords = new Set(leadText.split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem));
  const hit = [...ctx.industryWords].find((w) => leadWords.has(w));
  if (hit) { icp += 15; reasons.push(`Matches your industry (${hit})`); } else if (ctx.industryWords.size) reasons.push('Industry not confirmed from their name or site');
  const city = lower(lead.city);
  if (city && ctx.cities.some((c) => c.city === city)) { icp += 8; reasons.push(`In ${lead.city}, ${st} (your city)`); } else if (ctx.states.has(st)) { icp += 5; reasons.push(`In ${st} (your state)`); } else { icp += 5; reasons.push(`In ${st}`); }
  if (Number.isFinite(emp) && emp > 0 && ctx.sizeMin && ctx.sizeMax) {
    if (emp >= ctx.sizeMin && emp <= ctx.sizeMax) { icp += 5; reasons.push(`Size fits (${emp} staff)`); } else reasons.push(`Size outside your band (${emp} staff)`);
  }
  const dm = Math.max(0, Math.min(3, Number(lead.dreamMatch) || 0));
  if (dm) { icp += 3 * dm; reasons.push(`Like ${dm} of your dream customers`); }
  score += Math.min(30, icp);

  // Decision-maker title (≤ 20)
  const tier = titleTier(lead.title);
  let tpts = tier >= 100 ? 20 : tier >= 85 ? 16 : tier >= 70 ? 12 : tier >= 55 ? 9 : tier > 0 ? 5 : 4;
  if (tier >= 100) reasons.push(`Owner-level title (${title})`);
  else if (tier >= 55) reasons.push(`Decision-maker title (${title})`);
  else if (tier > 0) reasons.push(`Title: ${title}`);
  else reasons.push('No title found');
  if (title && ctx.titles.some((x) => x && (title.includes(x) || x.includes(title)))) { tpts += 4; reasons.push('Title is on your list'); }
  score += Math.min(20, tpts);

  // Named person (≤ 10)
  if (fullName.split(/\s+/).length >= 2) { score += 10; reasons.push(`Named person (${fullName})`); } else { score += 6; reasons.push(`First name only (${firstName})`); }
  if (lead.linkedinHint) reasons.push('Name matches a LinkedIn link on their site');

  // Verified email (≤ 20)
  const by = lead.verifiedBy ? ` by ${lead.verifiedBy}` : '';
  if (vstate === 'valid') { score += 20; reasons.push(lead.emailGuessed ? `Email pattern confirmed${by}` : `Verified email${by}`); }
  else if (vstate === 'catchall') { score += 4; reasons.push('Catch-all domain (accepts every address)'); }
  else if (vstate === 'pending') reasons.push('Email not verified yet');
  else { score += 2; reasons.push(vstate === 'unknown' ? `Verifier could not tell${by}` : `Email unconfirmed${by}`); }

  // Website quality (≤ 10)
  const s = lead.signals || {};
  let web = 0;
  if (s.https === true) { web += 3; reasons.push('Website uses HTTPS'); }
  const cy = Number(s.copyrightYear);
  if (cy && cy >= ctx.now.getUTCFullYear() - 1) { web += 3; reasons.push(`Website updated ${cy}`); }
  if (s.hasAddress || lead.address) { web += 2; if (s.hasAddress) reasons.push('Street address on their site'); }
  if (s.hasPhone || lead.phone) web += 1;
  if (s.viewport) web += 1;
  score += Math.min(10, web);

  // Google reputation (≤ 6)
  const rating = Number(lead.facts?.rating);
  const reviews = Number(lead.facts?.reviews);
  if (rating > 0 && Number.isFinite(reviews)) {
    if (rating >= 4.5 && reviews >= 25) { score += 6; reasons.push(`${rating}★ from ${reviews} Google reviews`); }
    else if (rating >= 4 && reviews >= 5) { score += 3; reasons.push(`${rating}★ from ${reviews} Google reviews`); }
    else reasons.push(`${rating}★ from ${reviews} Google reviews`);
  }

  // Intent / the problem the client fixes (≤ 8)
  let intent = 0;
  for (const r of PROBLEM_RULES[ctx.niche] || PROBLEM_RULES['trial-default']) {
    let ok = false;
    try { ok = Boolean(r.test(lead, ctx.now)); } catch { ok = false; }
    if (ok) { intent += r.pts; const t = r.text(lead); problems.push(t); reasons.push(t); }
  }
  score += Math.min(8, intent);

  // A person a prospect pointed us to (Wrong-Person Follower) is a warm lead.
  if (lead.source === 'referral') { score += 15; reasons.push(`Referred by ${lead.referrerName || 'a colleague'}`); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= ctx.thresholds.A ? 'A' : score >= ctx.thresholds.B ? 'B' : 'C';
  const out = { grade, score, reasons, rejectReason: null, problems };
  out.sendable = isSendable({ ...lead, grade }, ctx);
  return out;
}

/**
 * The sender's gate (Leads v2): the grade is sendable AND the address is
 * verified `valid`. risky / catch-all only after week one, and only when
 * SEND.allowRiskyAfterDay allows it; `pending` never. A lead with no grade
 * (v1 record, referral, Test Mode) is judged on its riskLevel alone.
 */
export function isSendable(lead, ctx) {
  const v = verifyStateOf(lead);
  if (lead.grade !== undefined && lead.grade !== null && lead.grade !== '') {
    if (!(ctx.sendable || ['A', 'B']).includes(lead.grade)) return false;
  }
  if (v === 'valid') return true;
  if (v === 'risky' || v === 'catchall') return riskyAllowed(ctx);
  return false;
}

/** Store the grade on a lead object (returns the patch). */
export function gradePatch(lead, ctx, opts) {
  const g = gradeLead(lead, ctx, opts);
  return { grade: g.grade, score: g.score, reasons: g.reasons.slice(0, 12), rejectReason: g.rejectReason, problems: g.problems, gradedAt: ctx.now.toISOString() };
}

/** Points a lead would gain from a `valid` verification: is it worth a verifier credit? */
export function worthVerifying(lead, ctx) {
  const g = gradeLead({ ...lead, verifyStatus: 'valid' }, ctx);
  return g.grade !== 'rejected' && ctx.sendable.includes(g.grade);
}

// ── rollup + hub view ────────────────────────────────────────────────────────

const SOURCE_LABELS = { 'leadfinder:places': 'google-places', 'leadfinder:osm': 'openstreetmap', referral: 'referral', test: 'test-mode' };
const sourceLabel = (s) => SOURCE_LABELS[s] || String(s || 'other').replace(/^leadfinder:/, '');

/**
 * Build the leadQuality rollup (HUB-API "Lead quality") from the client's
 * leads + the finder's reject counts, and store it in client:{id}:leadquality.
 */
export async function rollupLeadQuality(clientId, { now = new Date(), ctx = null } = {}) {
  const c = ctx || await gradeContext(clientId, { now });
  const [leads, lf] = await Promise.all([getLeads(clientId), kv.hgetall(K.leadfinder(clientId)).then((h) => h || {})]);
  const grades = { A: 0, B: 0, C: 0, rejected: 0 };
  const verification = { valid: 0, risky: 0, catchall: 0, invalid: 0, unknown: 0, pending: 0 };
  const rejects = {};
  const sources = {};
  let sendable = 0;
  let sendableUnsent = 0;
  const rows = [];
  for (const l of leads) {
    const g = l.grade ? { grade: l.grade, score: Number(l.score) || 0, reasons: Array.isArray(l.reasons) ? l.reasons : [], rejectReason: l.rejectReason || null } : gradeLead(l, c);
    grades[g.grade] = (grades[g.grade] || 0) + 1;
    const v = verifyStateOf(l);
    verification[v] = (verification[v] || 0) + 1;
    if (g.grade === 'rejected' && g.rejectReason) rejects[g.rejectReason] = (rejects[g.rejectReason] || 0) + 1;
    const src = sourceLabel(l.source);
    sources[src] = (sources[src] || 0) + 1;
    // Judged exactly as the Sender judges it (a record with no stored grade goes by its riskLevel).
    if (g.grade !== 'rejected' && isSendable(l, c)) { sendable++; if (l.status === 'unsent') sendableUnsent++; }
    if (g.grade !== 'rejected') rows.push({ l, g });
  }
  const finder = parse(lf.rejects, {}) || {};
  let finderGraded = 0;
  for (const [k, n] of Object.entries(finder)) {
    if (NOT_GRADED.has(k) || !(Number(n) > 0)) continue;
    rejects[k] = (rejects[k] || 0) + Number(n);
    finderGraded += Number(n);
  }
  grades.rejected += finderGraded;
  const size = await cfg(clientId, 'GRADE.sampleSize');
  rows.sort((a, b) => b.g.score - a.g.score || String(a.l.company).localeCompare(String(b.l.company)));
  const data = {
    graded: leads.length + finderGraded,
    grades,
    sendable,
    sendableUnsent,
    verification,
    rejectReasons: Object.entries(rejects).map(([k, n]) => ({ reason: REJECT_LABELS[k] || k, key: k, count: n })).sort((a, b) => b.count - a.count),
    sources: Object.entries(sources).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    sample: rows.slice(0, Number(size) || 25).map(({ l, g }) => ({
      email: l.email, name: l.name || l.first_name || '', title: l.title || '', company: l.company || '', city: l.city || '',
      grade: g.grade, score: g.score, reasons: g.reasons.slice(0, 6), verify: verifyStateOf(l),
    })),
    builtAt: now.toISOString(),
  };
  await kv.hset(K.leadQuality(clientId), { data: JSON.stringify(data), builtAt: data.builtAt });
  return data;
}

/** Rebuild the rollup when it is older than GRADE.rollupEveryMin (or forced). */
export async function maybeRollup(clientId, { now = new Date(), force = false, ctx = null } = {}) {
  if (!force) {
    const at = await kv.hget(K.leadQuality(clientId), 'builtAt');
    const every = await cfg(clientId, 'GRADE.rollupEveryMin');
    if (at && now.getTime() - Date.parse(at) < Number(every) * 60_000) return null;
  }
  return rollupLeadQuality(clientId, { now, ctx });
}

/**
 * The hub's `leadQuality` block for GET /api/mc/hub/{id} (HUB-API v2 "Lead
 * quality"). null when the client has no leads yet. `budgetLeftToday` is live.
 */
export async function leadQualityView(clientId, { now = new Date() } = {}) {
  let raw = await kv.hget(K.leadQuality(clientId), 'data');
  let data = parse(raw, null);
  if (!data) {
    const n = await kv.hlen(K.leads(clientId)).catch(() => 0);
    if (!n) return null;
    data = await rollupLeadQuality(clientId, { now });
  }
  let budgetLeftToday = null;
  try { budgetLeftToday = (await (await import('@/lib/systems/verify')).budgetLeftToday({ now })).total; } catch { budgetLeftToday = null; }
  return {
    graded: data.graded,
    grades: data.grades,
    sendable: data.sendable,
    verification: { ...data.verification, budgetLeftToday },
    rejectReasons: data.rejectReasons.map(({ reason, count }) => ({ reason, count })),
    sources: data.sources,
    sample: data.sample.map(({ email, name, title, company, city, grade, score, reasons }) => ({ email, name, title, company, city, grade, score, reasons })),
    sendableUnsent: data.sendableUnsent,
    builtAt: data.builtAt,
  };
}
