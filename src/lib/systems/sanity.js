/**
 * List Sanity Check (SPEC §7.4). On each Lead Finder batch: sample
 * LIST.sanitySample random rows and check
 *   title   ∈ approved titles (only when the row has a title; excluded titles fail)
 *   size    plausible: employee hint within the size band (×0.5 … ×2), and
 *           Places types are not an obviously large organisation
 *   state   a US state is present
 *   chain   the website host is not a known chain/franchise (config/chains.txt)
 * More than LIST.maxFail failing rows → the batch is rejected and the Lead
 * Finder is re-dispatched with the failing pattern excluded (leadfinder.js).
 * The sampled rows are what the approval page shows ("20 companies we found").
 *
 * Leads v2: with a grade context (`ctx`, systems/grader.js) every sampled row
 * is also graded, and the grader's pattern rejects count as failures — role
 * address, no named person, chain / franchise, outside the area, too big or
 * too small, excluded title — each under its grader reason. Verification
 * results never fail a row (a batch arrives unverified by design).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { hostOf } from '@/lib/db/leads';
import { chainHosts } from '@/lib/systems/listfiles';
import { gradeLead } from '@/lib/systems/grader';
import { titleFits } from '@/lib/leadquality/rules.mjs';

/** Grader reject reasons that say the batch's search pattern is wrong → sanity failure name. */
const GRADER_FAILS = { role: 'role', no_name: 'no_name', chain: 'chain', out_of_area: 'state', size: 'size', excluded_title: 'title' };

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const STATE_NAMES = new Set(['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia']);
/** Places types that are never a 5–50 person private business. */
export const BIG_TYPES = new Set(['hospital', 'university', 'airport', 'shopping_mall', 'department_store', 'supermarket', 'city_hall', 'local_government_office', 'embassy', 'stadium', 'courthouse', 'police', 'fire_station', 'post_office', 'amusement_park', 'casino']);

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n;]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);

export function validState(s) {
  const v = String(s || '').trim();
  return US_STATES.has(v.toUpperCase()) || STATE_NAMES.has(v.toLowerCase());
}

function titleMatches(title, approved) {
  const t = String(title || '').toLowerCase();
  return approved.some((a) => t.includes(a) || a.includes(t));
}

/** Checks for one row → array of failure reasons (+ the grader's pattern rejects when `ctx` is given). */
export function checkRow(lead, profile = {}, { chains = new Set(), ctx = null } = {}) {
  const fails = baseChecks(lead, profile, { chains });
  if (ctx) {
    const g = gradeLead({ ...lead, verifyStatus: 'pending' }, ctx);
    const f = g.rejectReason && GRADER_FAILS[g.rejectReason];
    if (f && !fails.includes(f)) fails.push(f);
  }
  return fails;
}

function baseChecks(lead, profile = {}, { chains = new Set() } = {}) {
  const fails = [];
  const approved = list(profile.titles);
  const excluded = list(profile.excludedTitles);
  if (lead.title) {
    if (excluded.length && titleMatches(lead.title, excluded)) fails.push('title');
    else if (approved.length && !titleFits(lead.title, approved)) fails.push('title');
  }
  const types = list(lead.types);
  const emp = Number(lead.employees);
  const min = Number(profile.sizeMin);
  const max = Number(profile.sizeMax);
  if (types.some((t) => BIG_TYPES.has(t))) fails.push('size');
  else if (Number.isFinite(emp) && emp > 0 && ((min && emp < min * 0.5) || (max && emp > max * 2))) fails.push('size');
  if (!validState(lead.state)) fails.push('state');
  const host = hostOf(lead.website || lead.host || lead.email || '');
  if (host && chains.has(host)) fails.push('chain');
  return fails;
}

function sampleOf(rows, n, rng) {
  const a = rows.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/**
 * Pure check of one batch.
 * @returns {{sample, failures: [{row, reasons}], failCount, reject, exclude}}
 */
export function sanityCheck(leads, profile = {}, { sampleSize = 20, maxFail = 2, rng = Math.random, chains = null, ctx = null } = {}) {
  let chainSet = chains;
  if (!chainSet) { try { chainSet = chainHosts(); } catch { chainSet = new Set(); } }
  const sample = sampleOf(leads, sampleSize, rng);
  const failures = [];
  for (const row of sample) {
    const reasons = checkRow(row, profile, { chains: chainSet, ctx });
    if (reasons.length) failures.push({ row, reasons });
  }
  const reject = failures.length > maxFail;
  // The pattern to exclude on re-dispatch: every value that failed, by reason.
  const exclude = { titles: [], types: [], hosts: [], requireState: false };
  for (const f of failures) {
    if (f.reasons.includes('title') && f.row.title) exclude.titles.push(String(f.row.title).toLowerCase());
    if (f.reasons.includes('size')) exclude.types.push(...list(f.row.types).filter((t) => BIG_TYPES.has(t)));
    if (f.reasons.includes('chain')) exclude.hosts.push(hostOf(f.row.website || f.row.email));
    if (f.reasons.includes('state')) exclude.requireState = true;
  }
  for (const k of ['titles', 'types', 'hosts']) exclude[k] = [...new Set(exclude[k])];
  return { sample, failures, failCount: failures.length, reject, exclude };
}

/** What the approval page shows per row (no more than it needs). */
export function displayRow(l) {
  return {
    company: l.company || '', first_name: l.first_name || '', name: l.name || '', title: l.title || '',
    city: l.city || '', state: l.state || '', website: l.website || '', email: l.email || '',
    riskLevel: l.riskLevel || '', score: l.score ?? null, types: list(l.types).slice(0, 3),
    grade: l.grade || null, reasons: Array.isArray(l.reasons) ? l.reasons.slice(0, 4) : [], verifyStatus: l.verifyStatus || null,
  };
}

export async function storeSanityRows(clientId, rows) {
  await kv.set(K.sanityRows(clientId), JSON.stringify(rows.map(displayRow)));
}

export async function getSanityRows(clientId) {
  const raw = await kv.get(K.sanityRows(clientId));
  if (!raw) return [];
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
}
