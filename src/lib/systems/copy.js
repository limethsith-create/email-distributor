/**
 * Copy Engine (SPEC §7.5). No AI: niche templates + a first-line rule table.
 *
 * Templates: templates/sequence/{niche}.json (`msp`, `trial-default`) with
 * `variants` (subject of Day 0 + first-line set) and four `touches`. The
 * client-level slots ({SenderName} {ClientCompany} {oneLiner} {niche} {ICP}
 * {postalAddress}) are filled at build time from the profile, so what the
 * client approves is the real text. The lead-level slots stay for the Sender:
 * {FirstName} {Company} {City} {FirstLine}.
 *
 * Stored in client:{id}:sequence as `variantA` / `variantB` JSON strings with
 * the SAME shape as templates/sequence/default.json ({name, version, footer,
 * touches:[{touch, day, thread, subject?, body}]}) plus `variantId` and
 * `firstLineSet`. `leadVars(lead, variant)` gives the Sender every lead slot,
 * including {FirstLine} from the rule table below.
 *
 * Learning Library seeding: when learning:{niche} has data, the best variant
 * by positive rate (then reply rate) becomes A and the runner-up B.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile } from '@/lib/db/client';
import { getLeadsByStatus } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { alertOwner } from '@/lib/notify';
import { fill, TemplateError } from '@/lib/templates/render';
import { checkEmail, ticks } from '@/lib/systems/copycheck';
import msp from '@/lib/templates/sequence/msp.json';
import mspBackup from '@/lib/templates/sequence/msp.backup.json';
import trialDefault from '@/lib/templates/sequence/trial-default.json';
import trialDefaultBackup from '@/lib/templates/sequence/trial-default.backup.json';

export const TEMPLATES = { msp, 'trial-default': trialDefault };
export const BACKUPS = { msp: mspBackup, 'trial-default': trialDefaultBackup };

export const CLIENT_SLOTS = ['SenderName', 'ClientCompany', 'oneLiner', 'niche', 'ICP', 'postalAddress'];
export const LEAD_SLOTS = ['FirstName', 'Company', 'City', 'FirstLine'];

// ── first-line rule table (20 patterns) ─────────────────────────────────────

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

export function firstLineRule(types = []) {
  const t = new Set((Array.isArray(types) ? types : String(types).split(/[,\s]+/)).map((x) => String(x).toLowerCase()));
  return FIRST_LINE_RULES.find((r) => r.types.some((x) => t.has(x))) || FIRST_LINE_RULES[FIRST_LINE_RULES.length - 1];
}

/** The personalised first line for a lead (never contains an unfilled slot). */
export function firstLineFor(lead, set = 'A') {
  const company = String(lead.company || lead.company_name || '').trim();
  if (!company) throw new TemplateError('firstLine', ['Company']);
  const rule = firstLineRule(lead.types);
  const p = PHRASES[set] || PHRASES.A;
  const city = String(lead.city || '').trim();
  return fill('firstLine', city ? p.city : p.noCity, { Company: company, City: city, label: rule.label });
}

const first = (...v) => v.find((x) => x !== undefined && x !== null && String(x).trim() !== '');

/** Lead-level slot values for a stored variant (what the Sender fills at send time). */
export function leadVars(lead, variant = {}) {
  const vars = {
    FirstName: first(lead.first_name, String(lead.name || '').trim().split(/[\s,]+/)[0]),
    Company: first(lead.company, lead.company_name),
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
  };
}

/** Which template a client uses. */
export function nicheOf(profile = {}) {
  const explicit = String(profile.niche || '').toLowerCase();
  if (TEMPLATES[explicit]) return explicit;
  const hay = `${profile.industry || ''} ${profile.sellsTo || ''} ${profile.defaultNiche || ''}`.toLowerCase();
  if (/\bmsps?\b|managed (it|services?)|it (support|services?)|managed service provider/.test(hay)) return 'msp';
  return 'trial-default';
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
    footer: fillClientSlots(`${template.niche}:footer`, template.footer, cvars),
    touches,
  };
}

/** Rank variants from learning:{niche}; returns ids best-first (only those with ≥ minSends). */
export function rankLearning(learning = {}, minSends = 50) {
  return Object.entries(learning)
    .map(([id, raw]) => {
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
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

/** Render a stored variant fully for one lead → [{touch, subject, body, text, thread}]. Throws TemplateError. */
export function renderVariant(variant, lead) {
  const vars = leadVars(lead, variant);
  return variant.touches.map((t) => {
    const name = `${variant.variantId || 'seq'}:${t.touch}`;
    const body = fill(name, t.body, vars);
    const subject = t.subject ? fill(name, t.subject, vars) : null;
    const footer = variant.footer ? fill(`${name}:footer`, variant.footer, vars) : '';
    return { touch: t.touch, thread: t.thread, subject, body, text: footer ? `${body}\n\n${footer}` : body };
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
  const template = backup ? BACKUPS[niche] : TEMPLATES[niche];
  let learning = null;
  try { learning = (await kv.hgetall(K.learning(niche))) || null; } catch {}
  const [defA, defB] = pickVariants(template, learning);
  const cvars = clientVars(client || {}, profile);
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
    version: String(version),
    builtAt: new Date().toISOString(),
  };
  if (!backup) fields.active = existing.active && existing.approvedAt ? existing.active : 'both';
  await kv.hset(K.sequence(clientId), fields);
  await logEvent(clientId, 'copy', backup ? 'backup_built' : 'sequence_built', { niche, variants: [defA.id, defB.id], learningSeeded: Boolean(learning && rankLearning(learning).length) });

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
 * Stage C's Pace Check (Day 7) backup: the {niche}.backup.json variants built
 * with this client's profile, same shape as variantA/B. Not stored here.
 */
export async function buildBackupVariants(clientId) {
  const [client, profile] = await Promise.all([getClient(clientId), getProfile(clientId)]);
  const niche = nicheOf(profile);
  const template = BACKUPS[niche];
  const [a, b] = pickVariants(template, null);
  const cvars = clientVars(client || {}, profile);
  return { niche, variantA: buildVariant(template, a, cvars), variantB: buildVariant(template, b, cvars) };
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
