/**
 * Onboarding page logic (SPEC §6.2) — used by /api/c/onboard.
 *
 * Collects Form A plus the targeting profile into client:{id}:profile
 * (arrays stored as JSON), with save-and-resume: every save keeps the valid
 * fields and returns per-field errors for the rest. Validation: calendar URL
 * must answer 200 (checked server-side), postal address must hold a US state
 * and ZIP, sender prefix must match [a-z.]{2,20}. Customers/competitors to
 * suppress go to the client blocklist (domains/emails; bare names are kept for
 * Stage B's Blocklist Keeper to resolve).
 *
 * The agreement is the last step. It is rendered from templates/agreement.js
 * and refused (config_missing alert) while OWNER.signerName is not set.
 * Acceptance stores agreementAcceptedAt/Name/Ip, emails both sides a copy and
 * starts the Market Counter; only a passing count moves the client to
 * awaiting_purchase.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, getTrial, updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { addToBlocklist } from '@/lib/db/leads';
import { dayKeyIn, ET } from '@/lib/time';
import { renderAgreement, agreementHash, AGREEMENT_VERSION } from '@/lib/templates/agreement';
import { runMarketCount } from '@/lib/systems/market';
import { addBlocklistInput } from '@/lib/systems/blocklist';
import { io, asArray, firstNameOf, ownerName, sendClient, formatDay, isPublicUrl } from '@/lib/systems/intake-io';
import { stateCode, isUsPostalAddress } from '@/lib/systems/usgeo';

const SYSTEM = 'onboarding';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:[/?#].*)?$/i;

/**
 * Every field on the page. type: text | long | list (array, one per line or
 * comma) | url | email | int | dream (3 × {name, website}) | dates.
 */
export const FIELDS = [
  { key: 'companyName', label: 'Company name', type: 'text', required: true },
  { key: 'senderName', label: 'Who we send as — full name', type: 'text', required: true },
  { key: 'senderTitle', label: 'Their title', type: 'text', required: true },
  { key: 'senderPrefix', label: 'Email prefix for the sending address (e.g. john or john.smith)', type: 'text', required: true },
  { key: 'calendarUrl', label: 'Calendar link for booked meetings', type: 'url', required: true },
  { key: 'postalAddress', label: 'Postal address for the email footer (US)', type: 'long', required: true },
  { key: 'hotLeadEmail', label: 'Where hot-lead alerts go (email)', type: 'email', required: true },
  { key: 'suppressCustomers', label: 'Existing customers to suppress (names, websites or emails — one per line, or paste a CSV)', type: 'list', required: false },
  { key: 'competitors', label: 'Competitors to exclude (names or websites)', type: 'list', required: false },
  { key: 'sellsTo', label: 'One sentence: what you sell and to whom, in your words (it goes into your emails as written)', type: 'long', required: true },
  { key: 'defaultNiche', label: 'What you offer, in 2–4 words (used in the emails, e.g. "managed IT")', type: 'text', required: true },
  { key: 'defaultIcp', label: 'Your ideal customers in a few words, plural (used in the emails, e.g. "dental practices")', type: 'text', required: true },
  { key: 'industry', label: 'Industry keywords of your customers (comma-separated, e.g. managed IT services, IT support)', type: 'text', required: true },
  { key: 'cities', label: 'Cities to target (one per line, "Dallas, TX")', type: 'list', required: false },
  { key: 'states', label: 'States to target (e.g. TX, OK)', type: 'list', required: false },
  { key: 'sizeMin', label: 'Customer size — fewest employees', type: 'int', required: true },
  { key: 'sizeMax', label: 'Customer size — most employees', type: 'int', required: true },
  { key: 'titles', label: 'Target job titles (one per line)', type: 'list', required: true },
  { key: 'excludedTitles', label: 'Titles never to email (optional)', type: 'list', required: false },
  { key: 'dreamCustomers', label: 'Three dream customers (name + website)', type: 'dream', required: true },
  { key: 'capacityPerWeek', label: 'How many sales calls a week can you actually handle?', type: 'int', required: true },
  { key: 'winCondition', label: 'What would these 30 days need to show for you to start on day 31?', type: 'long', required: true },
  { key: 'awayDates', label: "Weeks you can't take calls (optional, one date range per line)", type: 'list', required: false },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/**
 * Split pasted text / CSV into items (lines, commas, semicolons, tabs; CSV
 * quotes stripped). Cities keep their commas ("Dallas, TX") and split on
 * lines and semicolons only.
 */
export function splitList(v, { keepCommas = false } = {}) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  const re = keepCommas ? /\r?\n|;/ : /\r?\n|[,;\t]/;
  return String(v || '').split(re).map((s) => s.trim().replace(/^"|"$/g, '').trim()).filter(Boolean).slice(0, 2000);
}

/** One blocklist item → 'domain.com' | 'bob@x.com' | null (a bare name). */
export function blockItem(s) {
  const v = String(s || '').trim().toLowerCase();
  if (EMAIL_RE.test(v)) return v;
  const m = v.match(DOMAIN_RE);
  return m ? m[1].toLowerCase() : null;
}

/** Does the URL answer 200 (after redirects)? Never throws. */
export async function urlResponds(url) {
  if (!isPublicUrl(url)) return { ok: false, status: null, error: 'not a public web address' };
  try {
    const res = await io.fetchExt(url, { timeoutMs: 8000, retry: false, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; AvianceBot/1.0; +aviance.online/bot)' } });
    return { ok: res.status === 200, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message || err).slice(0, 120) };
  }
}

/**
 * Validate and normalise submitted fields. Only keys present in `input` are
 * looked at (partial save). Returns { values, errors, blocklist }.
 */
export async function validateFields(input, current = {}) {
  const values = {};
  const errors = {};
  const blocklist = [];
  for (const [key, raw] of Object.entries(input || {})) {
    const f = BY_KEY[key];
    if (!f) continue;
    if (f.type === 'dream') {
      const rows = (Array.isArray(raw) ? raw : []).slice(0, 3).map((r) => ({ name: String(r?.name || '').trim().slice(0, 120), website: String(r?.website || '').trim().slice(0, 200) }));
      values[key] = JSON.stringify(rows);
      if (rows.some((r) => r.website && !blockItem(r.website))) errors[key] = 'Each website should look like example.com.';
      continue;
    }
    if (f.type === 'list') {
      const items = splitList(raw, { keepCommas: key === 'cities' });
      if (key === 'states') {
        const codes = items.map(stateCode);
        const bad = items.filter((_, i) => !codes[i]);
        if (bad.length) { errors[key] = `Not a US state: ${bad.slice(0, 3).join(', ')}`; continue; }
        values[key] = JSON.stringify([...new Set(codes)]);
        continue;
      }
      values[key] = JSON.stringify(items);
      if (key === 'suppressCustomers' || key === 'competitors') {
        for (const it of items) { const b = blockItem(it); if (b) blocklist.push(b); }
      }
      continue;
    }
    const v = String(raw ?? '').trim();
    if (!v) { values[key] = ''; continue; }
    if (f.type === 'int') {
      const n = Number(v.replace(/[,\s]/g, ''));
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) { errors[key] = 'Enter a whole number.'; continue; }
      values[key] = String(n);
      continue;
    }
    if (f.type === 'email' && !EMAIL_RE.test(v)) { errors[key] = 'Enter a valid email address.'; continue; }
    if (key === 'senderPrefix' && !/^[a-z.]{2,20}$/.test(v)) { errors[key] = 'Use 2–20 lowercase letters or dots, e.g. john or john.smith.'; continue; }
    if (key === 'postalAddress' && !isUsPostalAddress(v)) { errors[key] = 'The address needs a US state and a ZIP code.'; continue; }
    if (f.type === 'url') {
      if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(v)) { errors[key] = 'Enter the full link, starting with https://'; continue; }
      if (v !== current[key] || !current.calendarUrlCheckedAt) {
        const r = await urlResponds(v);
        if (!r.ok) { errors[key] = `That link did not open (${r.status ? `status ${r.status}` : r.error || 'no answer'}). Check it opens in a private browser window.`; continue; }
        values.calendarUrlCheckedAt = new Date().toISOString();
      }
    }
    values[key] = v.slice(0, f.type === 'long' ? 1000 : 300);
  }
  if (values.sizeMin && values.sizeMax && Number(values.sizeMin) > Number(values.sizeMax)) errors.sizeMax = 'The most must be at least the fewest.';
  return { values, errors, blocklist };
}

/** Parsed profile for the page (arrays as arrays). */
export function parseProfile(p = {}) {
  const out = {};
  for (const f of FIELDS) {
    const v = p[f.key];
    if (f.type === 'list') out[f.key] = asArray(v);
    else if (f.type === 'dream') out[f.key] = asArray(v).map((r) => (typeof r === 'object' ? r : { name: String(r), website: '' }));
    else out[f.key] = v == null ? '' : String(v);
  }
  return out;
}

/** Required fields still missing (for the agreement step). */
export function missingRequired(profile) {
  const p = parseProfile(profile);
  const missing = FIELDS.filter((f) => f.required).filter((f) => {
    const v = p[f.key];
    if (f.type === 'dream') return v.filter((r) => r.name).length < 3;
    if (f.type === 'list') return !v.length;
    return !v;
  }).map((f) => f.key);
  if (!p.cities.length && !p.states.length) missing.push('cities');
  return missing;
}

/** Agreement text for this client, or { blocked } when the signer is not set. */
export async function agreementFor(clientId, { now = io.now(), clientSignature } = {}) {
  const client = await getClient(clientId);
  const profile = await getProfile(clientId);
  const signerName = await cfg(clientId, 'OWNER.signerName');
  const usHours = await cfg(clientId, 'OWNER.usHours');
  if (!signerName) {
    await io.alertOwner('config_missing', { clientId, scope: 'OWNER.signerName', vars: { key: 'OWNER.signerName' }, body: `${client?.name || clientId} reached the agreement step, but OWNER.signerName is not set, so the agreement cannot be shown.`, did: 'The onboarding page shows "agreement not ready yet"; the client can still fill in everything else.' });
    return { blocked: 'The agreement is being prepared — fill in everything else and come back to this step shortly.' };
  }
  const company = profile.companyName || client?.name;
  const text = renderAgreement({ company, date: formatDay(dayKeyIn(ET, now), { date: true }), usHours, signerName, ...(clientSignature ? { clientSignature } : {}) });
  return { text };
}

/** Everything the page needs. */
export async function loadOnboarding(clientId) {
  const client = await getClient(clientId);
  const profile = await getProfile(clientId);
  const trial = await getTrial(clientId);
  const market = (await kv.hgetall(K.market(clientId)).catch(() => null)) || {};
  const agreement = trial.agreementAcceptedAt ? { text: trial.agreementText || null, accepted: true } : await agreementFor(clientId);
  return {
    company: { name: profile.companyName || client.name, mainDomain: client.mainDomain, contactName: client.contactName },
    state: client.state,
    fields: FIELDS,
    profile: parseProfile(profile),
    missing: missingRequired(profile),
    agreement,
    accepted: trial.agreementAcceptedAt ? { at: trial.agreementAcceptedAt, name: trial.agreementName } : null,
    market: { status: market.status || null },
  };
}

/** Partial save. Returns { saved: [keys], errors }. */
export async function saveOnboarding(clientId, input) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'onboarding') return { saved: [], errors: { _form: 'This page is closed.' } };
  const trial = await getTrial(clientId);
  if (trial.agreementAcceptedAt) return { saved: [], errors: { _form: 'The agreement is already signed; email us to change anything.' } };
  const current = await getProfile(clientId);
  const { values, errors, blocklist } = await validateFields(input, current);
  if (values.industry !== undefined) values.industryKeywords = JSON.stringify(values.industry.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
  if (values.suppressCustomers !== undefined || values.competitors !== undefined) {
    const names = [...splitList(asArray(values.suppressCustomers ?? current.suppressCustomers)), ...splitList(asArray(values.competitors ?? current.competitors))].filter((s) => !blockItem(s));
    values.suppressNames = JSON.stringify([...new Set(names)]);
  }
  if (Object.keys(values).length) {
    await kv.hset(K.profile(clientId), { ...values, onboardingSavedAt: new Date().toISOString() });
    if (values.companyName) await updateClient(clientId, { name: values.companyName });
  }
  if (blocklist.length) await addToBlocklist(clientId, blocklist);
  await logEvent(clientId, SYSTEM, 'saved', { fields: Object.keys(values), errors: Object.keys(errors), blocklistAdded: blocklist.length });
  return { saved: Object.keys(values).filter((k) => BY_KEY[k]), errors };
}

/**
 * Click-to-accept. Requires every required field, the typed full name and
 * the tick. Then: store the legal record, email both sides, start the Market
 * Counter (bounded by `deadline`; the `market` job continues it).
 */
export async function acceptAgreement(clientId, { name, title, agree, ip, now = io.now(), deadline = Date.now() + 12000 }) {
  const client = await getClient(clientId);
  if (!client || client.state !== 'onboarding') return { ok: false, error: 'This page is closed.' };
  const trial = await getTrial(clientId);
  if (trial.agreementAcceptedAt) return { ok: true, already: true };
  const profile = await getProfile(clientId);
  const missing = missingRequired(profile);
  if (missing.length) return { ok: false, error: 'Please complete every required field first.', missing };
  const fullName = String(name || '').trim();
  if (!agree || fullName.split(/\s+/).length < 2) return { ok: false, error: 'Type your full name and tick "I agree".' };
  const signerTitle = String(title || '').trim().slice(0, 120);
  if (!signerTitle) return { ok: false, error: 'Please add your title.' };

  const acceptedDay = formatDay(dayKeyIn(ET, now), { date: true });
  const ag = await agreementFor(clientId, { now, clientSignature: `${fullName}, ${signerTitle}, ${acceptedDay}` });
  if (ag.blocked) return { ok: false, error: ag.blocked };

  const claimed = await kv.set(K.onceClaim('agreement', clientId, 'accepted'), now.toISOString(), { nx: true, ex: 400 * 86400 });
  if (claimed !== 'OK') return { ok: true, already: true };

  const record = {
    agreementAcceptedAt: now.toISOString(),
    agreementName: fullName.slice(0, 120),
    agreementTitle: signerTitle,
    agreementIp: String(ip || 'unknown').slice(0, 64),
    agreementVersion: AGREEMENT_VERSION,
    agreementHash: agreementHash(ag.text),
    agreementText: ag.text,
  };
  await kv.hset(K.trial(clientId), record);
  await updateClient(clientId, { intakeStep: 'market' });
  await logEvent(clientId, SYSTEM, 'agreement_accepted', { name: record.agreementName, title: signerTitle, ip: record.agreementIp, hash: record.agreementHash, version: AGREEMENT_VERSION });

  const vars = {
    firstName: firstNameOf(client.contactName), companyName: profile.companyName || client.name,
    agreementText: ag.text, agreementName: record.agreementName, agreementTitle: signerTitle,
    acceptedAt: now.toISOString().replace('T', ' ').slice(0, 16), agreementIp: record.agreementIp,
  };
  try {
    await sendClient(clientId, 'agreement_copy', { ...vars, ownerName: await ownerName(clientId) }, { dedupe: 'agreement_copy' });
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'agreement_copy_failed', { error: String(err.message).slice(0, 200) });
    await io.alertOwner('report_blocked', { clientId, scope: `${clientId}:agreement_copy`, vars: { report: 'agreement_copy', clientId }, body: `The signed agreement copy could not be emailed to ${client.contactEmail}: ${String(err.message).slice(0, 200)}`, did: 'The acceptance is stored (client:{id}:trial) and the market count continues. Send the copy by hand.' });
  }
  const own = await io.sendOwnerEmail(`[Aviance] Agreement signed: ${vars.companyName}`, `${vars.companyName} accepted the trial agreement.\n\nAccepted by: ${vars.agreementName}, ${signerTitle}\nAt: ${record.agreementAcceptedAt} from IP ${record.agreementIp}\nText fingerprint: ${record.agreementHash}\n\n${ag.text}`).catch((e) => ({ ok: false, error: e.message }));
  if (!own?.ok) await logEvent(clientId, SYSTEM, 'owner_copy_failed', { error: own?.error || 'unknown' });

  // Blocklist Keeper (SPEC §7.3) on onboarding submit: every pasted customer /
  // competitor, including bare company names (resolved with a Places IDs-only lookup).
  try {
    const pasted = [...splitList(asArray(profile.suppressCustomers)), ...splitList(asArray(profile.competitors)), ...asArray(profile.suppressNames)];
    if (pasted.length) await addBlocklistInput(clientId, [...new Set(pasted)].join('\n'), { source: 'onboarding' });
  } catch (err) {
    await logEvent(clientId, SYSTEM, 'blocklist_failed', { error: String(err.message).slice(0, 200) });
    await io.alertOwner('config_missing', { clientId, scope: `${clientId}:blocklist`, vars: { key: 'client blocklist' }, body: `The pasted customer / competitor list for ${clientId} could not be added to the blocklist: ${String(err.message).slice(0, 200)}`, did: 'Domains and emails were added when the form was saved; bare company names were not. Paste them again in Mission Control.' });
  }

  const market = await runMarketCount(clientId, { deadline, now }).catch(async (err) => {
    await logEvent(clientId, SYSTEM, 'market_start_failed', { error: String(err.message).slice(0, 200) });
    return { status: 'running' };
  });
  return { ok: true, market };
}
