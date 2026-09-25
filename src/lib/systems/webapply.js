/**
 * Trial applications from the public website (aviance.online/trial.html).
 *
 * The site's form asks its own nine questions (value band, calls a week,
 * sold to strangers, meet within five days, "what then", …), not the
 * Gatekeeper's (headcount, three dream customers, US-based, nobody else
 * emailing). Deciding on the site's answers alone would decline nearly every
 * applicant for "no headcount", so a website application is saved and held
 * for the owner (the site promises "a person reads this"): the hub shows the
 * answers and a fit verdict — each rule pass / fail / unknown, never guessed —
 * and the owner presses Approve (onboarding link or queue) or Decline (the
 * reason goes to the applicant). See docs/HUB-API.md "application".
 */

import { cfg } from '@/lib/config';
import { applyForTrial, normaliseDomain, findRepeat, fetchSiteText, detectAgency, normaliseApplication, FIT_RULES } from '@/lib/systems/gatekeeper';

const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

/** "Charlotte, NC" / "Austin, Texas" / "NYC, New York" → 'NC' | 'TX' | 'NY', else null. */
export function usStateOf(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) if (new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(lower)) return code;
  const m = s.match(/(?:^|[\s,])([A-Za-z]{2})\.?\s*(?:\d{5})?\s*$/);
  if (m && US_STATES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  return null;
}

/** 'acme-plumbing.com' → 'Acme Plumbing' (the onboarding page collects the real name). */
export function companyFromDomain(domain) {
  const label = String(domain || '').split('.')[0] || '';
  return label.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const pick = (v) => String(v ?? '').trim();
const lc = (v) => pick(v).toLowerCase();

/** Value band → the lowest amount it guarantees (never a midpoint). */
function valueFloor(band) {
  const b = lc(band);
  if (!b) return null;
  if (b.startsWith('under')) return 0;
  const m = b.replace(/,/g, '').match(/\$?\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Calls-a-week band → the lowest number it guarantees. */
function capacityFloor(band) {
  const b = lc(band);
  if (!b) return null;
  if (b.startsWith('more than')) { const m = b.match(/(\d+)/); return m ? Number(m[1]) + 1 : null; }
  const m = b.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The site's raw body → answers list, Gatekeeper fields, and the extras worth keeping. */
export function mapWebsiteForm(raw = {}) {
  const website = pick(raw.website).slice(0, 300);
  const mainDomain = normaliseDomain(website);
  const city = pick(raw.city).slice(0, 120);
  const state = usStateOf(city);
  const proof = (Array.isArray(raw.proof) ? raw.proof : pick(raw.proof) ? String(raw.proof).split(/\s*,\s*/) : []).map(pick).filter(Boolean).slice(0, 8);
  const answers = [
    ['Name', raw.name], ['Work email', raw.email], ['Company website', website], ['City / state', city],
    ['What do you sell, and who to?', raw.sell], ['What is a new customer worth in the first year?', raw.value],
    ['How many sales calls a week could you actually take?', raw.capacity], ['Has anyone outside your network ever bought from you?', raw.strangers],
    ['Could you take a booked meeting within five business days?', raw.calendar], ['If the trial books you a call, what then?', raw.then],
    ['Anything we should know?', raw.notes], ['Agreed to the quote + honest review', raw.agree ? 'Yes' : 'No'],
    ['Open to (optional)', proof.join(', ')],
  ].map(([q, a]) => ({ q, a: pick(a).slice(0, 600) })).filter((x) => x.a);

  const calendar = lc(raw.calendar);
  const strangers = lc(raw.strangers);
  const fields = {
    // The site never asks for a company name; an unreadable website is reported once, as the website.
    companyName: companyFromDomain(mainDomain) || pick(raw.company).slice(0, 120) || website || pick(raw.name).slice(0, 120),
    contactName: pick(raw.name).slice(0, 120),
    contactEmail: lc(raw.email).slice(0, 200),
    website,
    ...(state ? { usBased: 'yes' } : {}),
    ...(valueFloor(raw.value) !== null ? { dealValue: String(valueFloor(raw.value)) } : {}),
    ...(strangers ? { soldToStrangers: strangers.startsWith('yes') ? 'yes' : 'no' } : {}),
    ...(calendar === 'yes' ? { meetWithin5Days: 'yes' } : calendar.startsWith('no') ? { meetWithin5Days: 'no' } : {}),
    ...(capacityFloor(raw.capacity) !== null ? { slotsPerWeek: String(capacityFloor(raw.capacity)) } : {}),
    reviewAgreed: raw.agree === true || lc(raw.agree) === 'true' || lc(raw.agree) === 'yes' || lc(raw.agree) === 'on' ? 'yes' : 'no',
    notes: [raw.sell && `Sells: ${pick(raw.sell)}`, raw.then && `If it works: ${pick(raw.then)}`, raw.notes && `Notes: ${pick(raw.notes)}`, proof.length && `Open to: ${proof.join(', ')}`].filter(Boolean).join('\n').slice(0, 2000),
  };
  const extras = { sellsTo: pick(raw.sell).slice(0, 400), city, state: state || '', valueBand: pick(raw.value), capacityBand: pick(raw.capacity), ifItWorks: pick(raw.then), calendarAnswer: pick(raw.calendar), strangersAnswer: pick(raw.strangers), companyNameFromDomain: 'yes' };
  return { fields, extras, answers, mainDomain };
}

/**
 * The owner's fit verdict: every Gatekeeper rule as pass / fail / unknown
 * from what the site actually asked. Unknown is never turned into a guess.
 */
export async function fitLines(raw, { mainDomain, fetchText = fetchSiteText } = {}) {
  const fit = await cfg(null, 'FIT');
  const keywords = await cfg(null, 'INTAKE.agencyKeywords');
  const value = valueFloor(raw.value);
  const cap = capacityFloor(raw.capacity);
  const city = pick(raw.city);
  const state = usStateOf(city);
  const calendar = lc(raw.calendar);
  const strangers = lc(raw.strangers);
  const lines = [];
  const line = (rule, label, status, note) => lines.push({ rule, label, status, note });

  const repeat = mainDomain ? await findRepeat(mainDomain).catch(() => null) : null;
  line('one_trial_ever', 'First trial for this company', repeat ? 'fail' : 'pass', repeat ? `${mainDomain} already had a trial (${repeat.id}, ${repeat.state})` : `${mainDomain || 'no domain'} has not had one`);
  line('us_based', 'US-based', state ? 'pass' : 'unknown', state ? `They sell from ${city}` : city ? `Could not read a US state from "${city}"` : 'City / state left blank');
  line('employees', `${fit.employeesMin}–${fit.employeesMax} people`, 'unknown', 'The website form does not ask for headcount');
  line('deal_value', `Customer worth ≥ $${fit.dealValueMin.toLocaleString('en-US')} in year one`, value === null ? 'unknown' : value >= fit.dealValueMin ? 'pass' : 'fail', raw.value ? `They said ${pick(raw.value)}` : 'Not answered');
  line('sold_to_strangers', 'Has sold to strangers before', !strangers ? 'unknown' : strangers.startsWith('yes') ? 'pass' : 'fail', raw.strangers ? `They said "${pick(raw.strangers)}"` : 'Not answered');
  line('dream_customers', 'Three dream customers', 'unknown', 'Collected on the onboarding page');
  line('meet_within_5_days', 'Can meet within five business days', calendar === 'yes' ? 'pass' : calendar.startsWith('no') ? 'fail' : 'unknown', raw.calendar ? `They said "${pick(raw.calendar)}"` : 'Not answered');
  line('slots_per_week', `At least ${fit.slotsPerWeekMin} open slots a week`, cap === null ? 'unknown' : cap >= fit.slotsPerWeekMin ? 'pass' : /\d+\D+(\d+)/.test(lc(raw.capacity)) && Number(lc(raw.capacity).match(/\d+\D+(\d+)/)[1]) >= fit.slotsPerWeekMin ? 'unknown' : 'fail', raw.capacity ? `They said ${pick(raw.capacity)}` : 'Not answered');
  line('nobody_else_emailing', 'Nobody else cold-emailing for them', 'unknown', 'The website form does not ask');
  line('review_agreed', 'Agreed to the quote + honest review', raw.agree ? 'pass' : 'fail', raw.agree ? 'Ticked the box' : 'Did not tick the box');
  let siteText = '';
  try { siteText = mainDomain ? await fetchText(mainDomain) : ''; } catch { siteText = ''; }
  const agency = detectAgency(`${siteText} ${pick(raw.sell)} ${pick(raw.notes)}`, keywords);
  line('not_agency', 'Not a lead-gen / outbound agency', agency ? 'fail' : 'pass', agency ? `Found "${agency}"` : siteText ? 'Website title and their answers checked' : 'Their answers checked (website did not load)');

  const fails = lines.filter((l) => l.status === 'fail');
  const unknown = lines.filter((l) => l.status === 'unknown').length;
  const verdict = fails.length ? 'fails' : 'fit';
  const summary = fails.length
    ? `Fails ${fails.length} check${fails.length === 1 ? '' : 's'}: ${fails.map((f) => f.label).join(', ')}`
    : `Looks like a fit${unknown ? ` — ${unknown} check${unknown === 1 ? '' : 's'} unknown` : ''}`;
  return { verdict, summary, lines };
}

/** POST /api/apply from the website: save, work out the verdict, hold for the owner. */
export async function submitWebsiteApplication(raw, { now = new Date(), fetchText } = {}) {
  const { fields, extras, answers, mainDomain } = mapWebsiteForm(raw);
  const fit = await fitLines(raw, { mainDomain, fetchText });
  return applyForTrial({ ...fields }, {
    source: 'website',
    now,
    review: { answers, fit, extras },
  });
}

/**
 * POST /api/apply in the Gatekeeper's own shape (the machine's /apply page, or
 * anyone posting JSON). Public input never decides by itself: it is held for
 * the owner exactly like a website application, with the Gatekeeper's rules
 * as the fit verdict (a missing answer is "unknown", never a pass).
 */
export async function submitFormApplication(raw, { now = new Date(), fetchText = fetchSiteText } = {}) {
  const app = normaliseApplication(raw);
  const fit = await cfg(null, 'FIT');
  const keywords = await cfg(null, 'INTAKE.agencyKeywords');
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');
  const answers = [
    ['Company', app.companyName], ['Name', app.contactName], ['Email', app.contactEmail], ['Website', app.website],
    ['US-based', yn(app.usBased)], ['People', app.employees ?? ''], ['A new customer is worth (year one)', app.dealValue != null ? `$${app.dealValue}` : ''],
    ['Has sold to strangers', yn(app.soldToStrangers)], ['Three dream customers', app.dreamCustomers.join(' · ')],
    ['Can meet within five business days', yn(app.meetWithin5Days)], ['Open slots a week', app.slotsPerWeek ?? ''],
    ['Nobody else cold-emailing for them', yn(app.nobodyElseEmailing)], ['Agreed to the honest review', yn(app.reviewAgreed)], ['Notes', app.notes],
  ].map(([q, a]) => ({ q, a: String(a ?? '').slice(0, 600) })).filter((x) => x.a);

  const repeat = app.mainDomain ? await findRepeat(app.mainDomain).catch(() => null) : null;
  let siteText = '';
  try { siteText = app.mainDomain ? await fetchText(app.mainDomain) : ''; } catch { siteText = ''; }
  const agencyHit = detectAgency(`${siteText} ${app.companyName} ${app.notes}`, keywords);
  const missing = { us_based: app.usBased === null, employees: app.employees === null, deal_value: app.dealValue === null, sold_to_strangers: app.soldToStrangers === null, meet_within_5_days: app.meetWithin5Days === null, slots_per_week: app.slotsPerWeek === null, nobody_else_emailing: app.nobodyElseEmailing === null, review_agreed: app.reviewAgreed === null };
  const lines = [{ rule: 'one_trial_ever', label: 'First trial for this company', status: repeat ? 'fail' : 'pass', note: repeat ? `${app.mainDomain} already had a trial (${repeat.id}, ${repeat.state})` : `${app.mainDomain || 'no domain'} has not had one` }];
  for (const r of FIT_RULES) {
    const status = missing[r.id] ? 'unknown' : r.test(app, fit, { agencyHit }) ? 'pass' : 'fail';
    lines.push({ rule: r.id, label: r.id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), status, note: status === 'fail' ? r.reason(app, fit, { agencyHit }) : status === 'unknown' ? 'Not answered' : 'OK' });
  }
  const fails = lines.filter((l) => l.status === 'fail');
  const unknown = lines.filter((l) => l.status === 'unknown').length;
  const verdict = { verdict: fails.length ? 'fails' : 'fit', summary: fails.length ? `Fails ${fails.length} check${fails.length === 1 ? '' : 's'}: ${fails.map((f) => f.label).join(', ')}` : `Looks like a fit${unknown ? ` — ${unknown} check${unknown === 1 ? '' : 's'} unknown` : ''}`, lines };
  return applyForTrial(raw, { source: 'form', now, review: { answers, fit: verdict, extras: {} } });
}
