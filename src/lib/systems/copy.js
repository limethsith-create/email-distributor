/**
 * Copy Engine (SPEC §7.5, Copy v2). No AI: niche templates + rule tables.
 *
 * Templates: templates/sequence/{niche}.json for `msp`, `trades` (home
 * services / trades selling to commercial customers), `agency`,
 * `pro-services` and `trial-default`. Each holds four frameworks —
 * problem-first, question-led, quick-idea and local-proof (the last only when
 * the profile has a true `proofLine`) — every one with four touches (Day 0,
 * 3, 7, 10), an A/B pair of variants that differ only in the Day 0 subject
 * and the first-line set (the opener), and a C/D backup pair (Pace Check
 * Day 7: new subject + new opener, same bodies). A subject-line bank per niche
 * (short, no first name, no spam words) is there for owner edits.
 *
 * Framework choice: profile.copyFramework when set → the Learning Library's
 * best-ranked variant for this niche → the niche's default.
 *
 * The client-level slots ({SenderName} {ClientCompany} {oneLiner} {niche}
 * {ICP} {postalAddress} {proof}) are filled at build time, so what the client
 * approves is the real text. The lead-level slots stay for the Sender:
 * {FirstName} {Company} {City} {FirstLine}.
 *
 * {FirstLine} is personalised from facts the crawler found — a strong Google
 * rating, years in business, a service they list, a named service page —
 * phrased by rule per first-line set, and falls back to the Places-type line
 * ("Saw X is one of the dental practices serving Dallas.") when no fact is
 * safe to use. {Company} is the business name cleaned of SEO tails
 * ("Smile Dental - Family & Cosmetic Dentistry" → "Smile Dental"), legal
 * suffixes and shouting.
 *
 * Stored in client:{id}:sequence as `variantA` / `variantB` JSON strings with
 * the SAME shape as templates/sequence/default.json ({name, version, footer,
 * touches:[{touch, day, thread, subject?, body}]}) plus `variantId`,
 * `firstLineSet` and `framework`.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile } from '@/lib/db/client';
import { getLeadsByStatus } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { fill, TemplateError } from '@/lib/templates/render';
import { checkEmail, ticks, capsWords } from '@/lib/systems/copycheck';
import msp from '@/lib/templates/sequence/msp.json';
import trades from '@/lib/templates/sequence/trades.json';
import agency from '@/lib/templates/sequence/agency.json';
import proServices from '@/lib/templates/sequence/pro-services.json';
import trialDefault from '@/lib/templates/sequence/trial-default.json';

export const NICHE_TEMPLATES = { msp, trades, agency, 'pro-services': proServices, 'trial-default': trialDefault };
export const FRAMEWORKS = ['problem-first', 'question-led', 'quick-idea', 'local-proof'];

export const CLIENT_SLOTS = ['SenderName', 'ClientCompany', 'oneLiner', 'niche', 'ICP', 'postalAddress', 'proof'];
export const LEAD_SLOTS = ['FirstName', 'Company', 'City', 'FirstLine'];

/** One framework of a niche file in the v1 template shape ({name, niche, version, footer, variants, touches}). */
export function frameworkTemplate(nicheTpl, framework = null, { backup = false } = {}) {
  const fwName = framework && nicheTpl.frameworks?.[framework] ? framework : nicheTpl.defaultFramework;
  const fw = nicheTpl.frameworks[fwName];
  return {
    name: `${nicheTpl.name} — ${fw.label}${backup ? ' (backup opening)' : ''}`,
    niche: nicheTpl.niche,
    version: backup ? 2 : 1,
    footer: nicheTpl.footer,
    framework: fwName,
    needs: fw.needs || [],
    variants: backup ? fw.backupVariants : fw.variants,
    touches: fw.touches,
  };
}

/** Back-compat maps: each niche's default framework (TEMPLATES) and its backup (BACKUPS). */
export const TEMPLATES = Object.fromEntries(Object.entries(NICHE_TEMPLATES).map(([k, t]) => [k, frameworkTemplate(t)]));
export const BACKUPS = Object.fromEntries(Object.entries(NICHE_TEMPLATES).map(([k, t]) => [k, frameworkTemplate(t, null, { backup: true })]));

/** The subject-line bank of a niche (for owner edits in Mission Control). */
export function subjectBank(niche) {
  return (NICHE_TEMPLATES[niche] || trialDefault).subjectBank || [];
}

// ── first-line rule table (20 type patterns + fact-based lines) ─────────────

/** Places `types` → how the first line names the prospect's kind of business. */
export const FIRST_LINE_RULES = [
  { types: ['dentist', 'dental_clinic'], label: 'dental practices' },
  { types: ['doctor', 'medical_clinic', 'health'], label: 'medical practices' },
  { types: ['lawyer', 'legal_services'], label: 'law firms' },
  { types: ['accounting', 'tax_preparation_service'], label: 'accounting firms' },
  { types: ['real_estate_agency'], label: 'real estate offices' },
  { types: ['insurance_agency'], label: 'insurance agencies' },
  { types: ['veterinary_care'], label: 'vet clinics' },
  { types: ['physiotherapist', 'chiropractor'], label: 'therapy clinics' },
  { types: ['general_contractor', 'construction_company'], label: 'contractors' },
  { types: ['roofing_contractor'], label: 'roofing teams' },
  { types: ['plumber'], label: 'plumbing companies' },
  { types: ['electrician'], label: 'electrical contractors' },
  { types: ['car_repair', 'car_dealer'], label: 'auto shops' },
  { types: ['beauty_salon', 'hair_care', 'spa'], label: 'salons and spas' },
  { types: ['gym', 'fitness_center'], label: 'fitness studios' },
  { types: ['restaurant', 'cafe', 'bakery'], label: 'restaurants' },
  { types: ['school', 'primary_school', 'secondary_school'], label: 'schools' },
  { types: ['church', 'place_of_worship'], label: 'churches' },
  { types: ['storage', 'moving_company'], label: 'storage and moving companies' },
  { types: [], label: 'local businesses' }, // fallback (the 20th pattern)
];

/** Phrasing per first-line set; {label} {Company} {City}. `noCity` when the lead has no city. */
const PHRASES = {
  A: { city: 'Saw {Company} is one of the {label} serving {City}.', noCity: 'Saw {Company} while looking at {label} in your area.' },
  B: { city: 'I was looking at {label} in {City} and {Company} came up.', noCity: 'I was looking at {label} and {Company} came up.' },
  C: { city: '{Company} stood out while I was reading up on {label} around {City}.', noCity: '{Company} stood out while I was reading up on {label}.' },
  D: { city: 'Noticed {Company} while going through {label} near {City}.', noCity: 'Noticed {Company} while going through {label} near you.' },
};

/**
 * Fact-based openers (Copy v2). Each set tries its facts in its own order —
 * A and B differ in which fact leads, so the A/B test compares openers.
 */
const FACT_ORDER = { A: ['rating', 'years', 'service'], B: ['service', 'years', 'rating'], C: ['page', 'years', 'rating'], D: ['years', 'service', 'rating'] };
const FACT_PHRASES = {
  rating: {
    A: 'Saw {Company} has a {rating}-star rating across {reviews} Google reviews.',
    B: '{reviews} Google reviews at {rating} stars is a strong record for {Company}.',
    C: 'The {rating}-star rating {Company} holds across {reviews} Google reviews caught my eye.',
    D: 'Noticed {Company} holds {rating} stars across {reviews} Google reviews.',
  },
  years: {
    A: { city: 'Saw {Company} has been serving {City} since {since}.', noCity: 'Saw {Company} has been in business since {since}.' },
    B: { city: 'Noticed {Company} has been part of {City} since {since}.', noCity: 'Noticed {Company} has been around since {since}.' },
    C: { city: '{Company} has served {City} since {since}, which caught my eye.', noCity: '{Company} has been in business since {since}, which caught my eye.' },
    D: { city: 'Noticed {Company} has been serving {City} since {since}.', noCity: 'Noticed {Company} has been in business since {since}.' },
  },
  service: {
    A: { city: 'Saw {Company} does {service} around {City}.', noCity: 'Saw {Company} does {service}.' },
    B: { city: 'I was reading about the {service} work {Company} does in {City}.', noCity: 'I was reading about the {service} work {Company} does.' },
    C: { city: 'The {service} work {Company} does around {City} caught my eye.', noCity: 'The {service} work {Company} does caught my eye.' },
    D: { city: 'Noticed {Company} offers {service} in {City}.', noCity: 'Noticed {Company} offers {service}.' },
  },
  page: {
    A: 'I was reading the {service} page on the {Company} site.', B: 'I was reading the {service} page on the {Company} site.',
    C: 'I was reading the {service} page on the {Company} site.', D: 'I was reading the {service} page on the {Company} site.',
  },
};
const GENERIC_SERVICE = /^(services?|residential|commercial|home|about|contact|repairs?|maintenance|installation|products?|solutions?|specials?|other|more|all services|what we do)$/i;
// A link label with a call to action in it is a button, not a service ("sewer repair now").
const CTA_WORDS = /\b(now|today|call|free|here|more|click|book|get|schedule|learn|view|read|contact|quote|estimate|near me|best|top|cheap|affordable|us)\b/i;

export function firstLineRule(types = []) {
  const t = new Set((Array.isArray(types) ? types : String(types).split(/[,\s]+/)).map((x) => String(x).toLowerCase()));
  return FIRST_LINE_RULES.find((r) => r.types.some((x) => t.has(x))) || FIRST_LINE_RULES[FIRST_LINE_RULES.length - 1];
}

/**
 * The business name as a person would write it: SEO tail after " - " / " | "
 * / ":" dropped, "(…)" dropped, legal suffix dropped, a bare domain turned
 * into its name, ALL-CAPS words (> 3 letters) put in Title Case, no "!".
 */
export function cleanCompany(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.split(/\s+[-–—|:]\s+|\s*\|\s*/)[0].trim();
  if (cut.length >= 3) s = cut;
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[!]+/g, '').trim();
  s = s.replace(/,?\s+(llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|co\.|ltd\.?|pllc|p\.c\.|pc|lp|llp)$/i, '').trim();
  const dom = /^([a-z0-9-]+)\.(com|net|org|co|us|io|biz)$/i.exec(s);
  if (dom) s = dom[1].replace(/-/g, ' ');
  s = s.split(' ').map((w) => (/^[A-Z][A-Z'’&-]{3,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** A fact-based opener is used only when it is short, calm and link-free. */
function safeLine(line) {
  if (!line || line.length > 140 || /[!?]/.test(line) || /https?:|www\.|\.(com|net|org)\b/i.test(line)) return false;
  if (capsWords(line).length) return false;
  return line.split(/\s+/).length <= 20;
}

function factValues(lead, now = new Date()) {
  const f = lead.facts && typeof lead.facts === 'object' ? lead.facts : {};
  const out = {};
  const rating = Number(f.rating);
  const reviews = Number(f.reviews);
  if (rating >= 4.5 && rating <= 5 && reviews >= 25 && f.ratingSource !== 'site') out.rating = { rating: String(Math.round(rating * 10) / 10), reviews: String(Math.round(reviews)) };
  const since = Number(f.since);
  if (since >= 1900 && since <= now.getUTCFullYear() - 5) out.years = { since: String(since) };
  const svc = [...(Array.isArray(f.services) ? f.services : [])].map((s) => String(s).toLowerCase().replace(/[^a-z &'-]/g, ' ').replace(/\s+/g, ' ').trim())
    .find((s) => s && s.length >= 4 && s.length <= 30 && s.split(' ').length <= 4 && !GENERIC_SERVICE.test(s) && !CTA_WORDS.test(s) && !String(lead.company || '').toLowerCase().includes(s));
  if (svc) out.service = { service: svc };
  const page = f.servicePage && String(f.servicePage.label || '').toLowerCase().replace(/[^a-z &'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (page && page.length >= 4 && page.length <= 30 && page.split(' ').length <= 4 && !GENERIC_SERVICE.test(page) && !CTA_WORDS.test(page)) out.page = { service: page };
  return out;
}

/** The personalised first line for a lead (never contains an unfilled slot). */
export function firstLineFor(lead, set = 'A', { now = new Date() } = {}) {
  const company = cleanCompany(lead.company || lead.company_name);
  if (!company) throw new TemplateError('firstLine', ['Company']);
  const city = String(lead.city || '').trim();
  const s = PHRASES[set] ? set : 'A';
  const facts = factValues(lead, now);
  for (const kind of FACT_ORDER[s]) {
    if (!facts[kind]) continue;
    const p = FACT_PHRASES[kind][s];
    const tpl = typeof p === 'string' ? p : (city ? p.city : p.noCity);
    try {
      const line = fill('firstLine', tpl, { Company: company, City: city, ...facts[kind] });
      if (safeLine(line)) return line;
    } catch { /* fall through to the next fact */ }
  }
  const rule = firstLineRule(lead.types);
  const p = PHRASES[s];
  return fill('firstLine', city ? p.city : p.noCity, { Company: company, City: city, label: rule.label });
}

const first = (...v) => v.find((x) => x !== undefined && x !== null && String(x).trim() !== '');

/** Lead-level slot values for a stored variant (what the Sender fills at send time). */
export function leadVars(lead, variant = {}) {
  const vars = {
    FirstName: first(lead.first_name, String(lead.name || '').trim().split(/[\s,]+/)[0]),
    Company: first(cleanCompany(lead.company), lead.company, lead.company_name),
    City: first(lead.city),
  };
  try { vars.FirstLine = firstLineFor(lead, variant.firstLineSet || lead.sequenceVariant || 'A'); } catch { /* left unset → TemplateError at render */ }
  return vars;
}

/** Client-level slot values from the client record + profile (missing = undefined). */
export function clientVars(client = {}, profile = {}) {
  return {
    SenderName: first(profile.senderName),
    ClientCompany: first(profile.companyName, client.name),
    oneLiner: first(profile.oneLiner, profile.sellsTo),
    niche: first(profile.defaultNiche, profile.nicheLabel, profile.industry),
    ICP: first(profile.defaultIcp, profile.icp),
    postalAddress: first(profile.postalAddress),
    proof: first(profile.proofLine, profile.proof),
  };
}

const NICHE_RULES = [
  ['msp', /\bmsps?\b|managed (it|services?)|\bit (support|services?|solutions|consult\w*)|managed service provider|cyber ?security|computer (repair|support|services)|tech support|network(ing)? (support|services)/],
  ['agency', /\b(marketing|advertising|seo|web ?design|website design|web development|digital agency|branding|social media|ppc|google ads|creative agency|video production|content marketing|lead generation|appointment setting|booked (sales )?calls|cold email)\b/],
  ['trades', /\b(plumb\w*|roof\w*|hvac|heating|air condition\w*|electric(al|ian)s?|landscap\w*|lawn|pest control|janitorial|commercial cleaning|cleaning services?|painting|painters?|flooring|concrete|paving|asphalt|fencing|pool service|garage doors?|restoration|remodel\w*|general contractor|construction|handyman|pressure washing|window cleaning|locksmith|moving|junk removal|snow removal|signage|sign company|glass|gutters?|solar install\w*)\b/],
  ['pro-services', /\b(accounting|accountants?|bookkeep\w*|cpas?|tax (prep\w*|services?|firm)|law firm|attorneys?|legal services?|insurance|financial advis\w*|wealth management|consult\w*|staffing|recruit\w*|payroll|hr services|fractional|architects?|engineering firm|business coach\w*)\b/],
];

/** Which niche template a client uses: profile.niche, else its offer (defaultNiche / sellsTo), else its industry words. */
export function nicheOf(profile = {}) {
  const explicit = String(profile.niche || '').toLowerCase();
  if (NICHE_TEMPLATES[explicit]) return explicit;
  // What they sell comes first in their sentence, who they sell to after it:
  // "Bookkeeping for contractors" is pro-services, not trades.
  const earliest = (text) => {
    let best = null;
    for (const [n, re] of NICHE_RULES) {
      const m = re.exec(text);
      if (m && (!best || m.index < best.at)) best = { n, at: m.index };
    }
    return best?.n || null;
  };
  const found = earliest(String(profile.defaultNiche || '').toLowerCase())
    || earliest(`${profile.sellsTo || ''} ${profile.oneLiner || ''}`.toLowerCase())
    || earliest(String(Array.isArray(profile.industry) ? profile.industry.join(' ') : profile.industry || '').toLowerCase());
  return found || 'trial-default';
}

/** Fill only the client-level slots; lead slots stay. Throws TemplateError listing missing client slots. */
export function fillClientSlots(name, text, cvars) {
  const missing = [];
  const out = String(text).replace(/\{([A-Za-z][A-Za-z0-9_.]*)\}/g, (whole, key) => {
    if (!CLIENT_SLOTS.includes(key)) return whole;
    const v = cvars[key];
    if (v === undefined || v === null || String(v).trim() === '') { missing.push(key); return whole; }
    return String(v).trim();
  });
  if (missing.length) throw new TemplateError(name, [...new Set(missing)]);
  return out;
}

/** One stored variant from a template + variant definition. */
export function buildVariant(template, variantDef, cvars) {
  const touches = template.touches.map((t) => {
    const subjectSrc = t.subject === '@variant' ? variantDef.subjects?.[t.touch] : t.subject;
    const out = { touch: t.touch, day: t.day, thread: t.thread, body: fillClientSlots(`${template.niche}:${t.touch}`, t.body, cvars) };
    if (subjectSrc) out.subject = fillClientSlots(`${template.niche}:${t.touch}:subject`, subjectSrc, cvars);
    return out;
  });
  return {
    name: template.name,
    niche: template.niche,
    version: template.version,
    variantId: variantDef.id,
    firstLineSet: variantDef.firstLineSet,
    framework: template.framework || null,
    footer: fillClientSlots(`${template.niche}:footer`, template.footer, cvars),
    touches,
  };
}

/** Rank variants from learning:{niche}; returns ids best-first (only those with ≥ minSends). */
export function rankLearning(learning = {}, minSends = 50) {
  return Object.entries(learning)
    .map(([id, raw]) => {
      let r = raw;
      if (typeof raw === 'string') { try { r = JSON.parse(raw); } catch { r = {}; } }
      r = r || {};
      const sends = Number(r.sends) || 0;
      return { id, sends, pos: sends ? (Number(r.positive) || 0) / sends : 0, rep: sends ? (Number(r.replies) || 0) / sends : 0 };
    })
    .filter((x) => x.sends >= minSends)
    .sort((a, b) => b.pos - a.pos || b.rep - a.rep)
    .map((x) => x.id);
}

/** Pick [A, B] variant definitions; learning winners first when they exist in the template. */
export function pickVariants(template, learning = null) {
  const defs = template.variants || [];
  if (defs.length < 2) throw new Error(`template ${template.niche} needs two variants`);
  const ranked = learning ? rankLearning(learning).filter((id) => defs.some((d) => d.id === id)) : [];
  const chosen = ranked.map((id) => defs.find((d) => d.id === id));
  for (const d of defs) if (!chosen.includes(d)) chosen.push(d);
  return chosen.slice(0, 2);
}

/**
 * The framework for a client: profile.copyFramework (owner's choice) → the
 * framework of the best-ranked Learning Library variant → the niche default.
 * A framework that needs a slot the profile lacks (local-proof → proofLine)
 * is skipped.
 */
export function chooseFramework(nicheTpl, profile = {}, learning = null, cvars = {}) {
  const usable = (fw) => nicheTpl.frameworks?.[fw] && (nicheTpl.frameworks[fw].needs || []).every((slot) => cvars[slot]);
  const asked = String(profile.copyFramework || '').toLowerCase();
  if (usable(asked)) return asked;
  if (learning) {
    for (const id of rankLearning(learning)) {
      const fw = Object.keys(nicheTpl.frameworks || {}).find((f) => (nicheTpl.frameworks[f].variants || []).some((v) => v.id === id));
      if (fw && usable(fw)) return fw;
    }
  }
  return nicheTpl.defaultFramework;
}

/**
 * The prospect's own words the Copy Checker must not judge as copy: the
 * company name (ALL-CAPS brands, long legal names in a subject), first name
 * and city.
 */
export function exemptWordsFor(lead = {}) {
  return [...new Set([cleanCompany(lead.company || lead.company_name), lead.company, lead.first_name, lead.city].map((x) => String(x || '').trim()).filter(Boolean))];
}

/** Render a stored variant fully for one lead → [{touch, subject, body, text, thread, exemptWords}]. Throws TemplateError. */
export function renderVariant(variant, lead) {
  const vars = leadVars(lead, variant);
  const exemptWords = exemptWordsFor(lead);
  return variant.touches.map((t) => {
    const name = `${variant.variantId || 'seq'}:${t.touch}`;
    const body = fill(name, t.body, vars);
    const subject = t.subject ? fill(name, t.subject, vars) : null;
    const footer = variant.footer ? fill(`${name}:footer`, variant.footer, vars) : '';
    return { touch: t.touch, thread: t.thread, subject, body, text: footer ? `${body}\n\n${footer}` : body, exemptWords };
  });
}

/** Copy Checker over a whole variant for a sample lead → [{touch, ok, failures, ticks, rendered}]. */
export function checkVariant(variant, profile, lead, { maxWords = 80, spamWords = undefined } = {}) {
  let rendered;
  try {
    rendered = renderVariant(variant, lead);
  } catch (err) {
    const f = [{ rule: 'unfilled_slot', detail: err.message }];
    return variant.touches.map((t) => ({ touch: t.touch, ok: false, failures: f, ticks: ticks({ failures: f }), rendered: null }));
  }
  return rendered.map((r) => {
    const res = checkEmail({ ...r }, profile, { maxWords, spamWords });
    // The subject of a threaded touch is "Re: …" of the first; show it for the page.
    return { touch: r.touch, ok: res.ok, failures: res.failures, ticks: ticks(res), rendered: r };
  });
}

/** A lead to render samples with: a sanity row with a name, else the first unsent lead. */
export async function sampleLead(clientId) {
  try {
    const raw = await kv.get(K.sanityRows(clientId));
    const rows = typeof raw === 'string' ? JSON.parse(raw) : raw || [];
    const good = (Array.isArray(rows) ? rows : []).find((r) => r.first_name && r.company);
    if (good) return good;
  } catch {}
  const leads = await getLeadsByStatus(clientId, 'unsent', 50);
  return leads.find((l) => l.first_name && l.company) || null;
}

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export async function getStoredSequence(clientId) {
  const raw = (await kv.hgetall(K.sequence(clientId))) || {};
  const out = { ...raw };
  for (const k of ['variantA', 'variantB']) {
    try { out[k] = raw[k] ? parseJson(raw[k]) : null; } catch { out[k] = null; }
  }
  return out;
}

/**
 * Build (or rebuild with force) the client's sequence. Never overwrites an
 * approved sequence unless `force`. Missing profile values → copy_blocked
 * alert naming them, nothing stored.
 */
export async function buildSequence(clientId, { force = false, backup = false } = {}) {
  const existing = await getStoredSequence(clientId);
  if (existing.variantA && existing.approvedAt && !force) return { ok: true, skipped: 'approved', sequence: existing };
  const [client, profile] = await Promise.all([getClient(clientId), getProfile(clientId)]);
  const niche = nicheOf(profile);
  let learning = null;
  try { learning = (await kv.hgetall(K.learning(niche))) || null; } catch {}
  const cvars = clientVars(client || {}, profile);
  const framework = chooseFramework(NICHE_TEMPLATES[niche], profile, learning, cvars);
  const template = frameworkTemplate(NICHE_TEMPLATES[niche], framework, { backup });
  const [defA, defB] = pickVariants(template, learning);
  let variantA;
  let variantB;
  try {
    variantA = buildVariant(template, defA, cvars);
    variantB = buildVariant(template, defB, cvars);
  } catch (err) {
    if (err instanceof TemplateError) {
      await alertOwner('copy_blocked', { clientId, vars: { clientId, rule: `missing ${err.missing.join(', ')}` }, body: `The copy for ${clientId} cannot be built: the profile has no ${err.missing.join(', ')}.`, did: 'Nothing was stored; fill the profile in Mission Control and the next run builds it.' });
      return { ok: false, missing: err.missing };
    }
    throw err;
  }
  const version = backup ? 2 : 1;
  const fields = {
    variantA: JSON.stringify(variantA),
    variantB: JSON.stringify(variantB),
    niche,
    framework,
    version: String(version),
    builtAt: new Date().toISOString(),
  };
  if (!backup) fields.active = existing.active && existing.approvedAt ? existing.active : 'both';
  await kv.hset(K.sequence(clientId), fields);
  await logEvent(clientId, 'copy', backup ? 'backup_built' : 'sequence_built', { niche, framework, variants: [defA.id, defB.id], learningSeeded: Boolean(learning && rankLearning(learning).length) });

  // Copy Checker on a sample lead; a failure is flagged to the owner now, not at send time.
  const lead = await sampleLead(clientId);
  if (lead) {
    const maxWords = await cfg(clientId, 'COPY.maxWords');
    const failures = [...checkVariant(variantA, profile, lead, { maxWords }), ...checkVariant(variantB, profile, lead, { maxWords })].filter((r) => !r.ok);
    if (failures.length) {
      const f = failures[0];
      await alertOwner('copy_blocked', { clientId, vars: { clientId, rule: f.failures[0].rule }, body: `Copy Checker failed on ${f.touch}: ${f.failures.map((x) => `${x.rule} (${x.detail})`).join('; ')}`, did: 'The copy is stored but will not be sent until it passes; edit it at /mc/clients/' + clientId + '/sequence.' });
    }
  }
  return { ok: true, sequence: { ...fields, variantA, variantB } };
}

/**
 * Stage C's Pace Check (Day 7) backup: the same framework the client is on,
 * with the C/D subjects and openers, client slots filled. Not stored here.
 */
export async function buildBackupVariants(clientId) {
  const [client, profile, current] = await Promise.all([getClient(clientId), getProfile(clientId), getStoredSequence(clientId)]);
  const niche = nicheOf(profile);
  const framework = current.variantA?.framework || current.framework || null;
  const template = frameworkTemplate(NICHE_TEMPLATES[niche], framework, { backup: true });
  const [a, b] = pickVariants(template, null);
  const cvars = clientVars(client || {}, profile);
  return { niche, framework: template.framework, variantA: buildVariant(template, a, cvars), variantB: buildVariant(template, b, cvars) };
}

/** Owner edit from Mission Control: validate shape, store, bump version. */
export async function saveEditedVariant(clientId, which, json) {
  if (!['A', 'B'].includes(which)) throw new Error('variant must be A or B');
  const v = typeof json === 'string' ? JSON.parse(json) : json;
  if (!v || !Array.isArray(v.touches) || !v.touches.length) throw new Error('variant needs touches[]');
  for (const t of v.touches) {
    if (!['d0', 'd3', 'd7', 'd10'].includes(t.touch) || typeof t.body !== 'string') throw new Error(`bad touch ${t.touch}`);
    if (t.thread === 'new' && typeof t.subject !== 'string') throw new Error(`touch ${t.touch} starts a thread and needs a subject`);
  }
  const unknown = JSON.stringify(v).match(/\{([A-Za-z][A-Za-z0-9_.]*)\}/g)?.map((s) => s.slice(1, -1)).filter((s) => !LEAD_SLOTS.includes(s)) || [];
  if (unknown.length) throw new Error(`unfilled slots the Sender cannot fill: ${[...new Set(unknown)].join(', ')}`);
  const cur = await getStoredSequence(clientId);
  const version = (Number(cur.version) || 1) + 1;
  await kv.hset(K.sequence(clientId), { [`variant${which}`]: JSON.stringify(v), version: String(version), editedAt: new Date().toISOString() });
  await logEvent(clientId, 'copy', 'variant_edited', { which, version });
  return { version };
}
