/**
 * Fit Score: how well an applicant fits the trial, 0–100, with a grade and a
 * plain reason for every point. The yardstick is the owner's own fit gate
 * ("The 30-Day Trial" §2, docs/SPEC.md): a US B2B company already selling to
 * strangers, 5–50 people, a customer worth ≥ $2,000 in year one, ≥ 1,000
 * reachable companies, can meet within five business days, not an agency.
 *
 * Six parts (points are FITSCORE.weights, default 20/20/15/15/15/15):
 *   Sells to businesses · Deal size · Size and age · Already wins strangers
 *   · Market · Ready for calls
 * Inputs are only what was found: their answers, their website's words
 * (systems/fitsignals.js), domain age, Google rating, the market count. No AI.
 *
 * Unknown is never guessed and never punished: the score is the points
 * earned out of the points that could be checked, `confidence` is how many
 * of the 100 points could be checked, and every unknown becomes a question
 * for the call. Below FITSCORE.minConfidence the label is "Needs a look"
 * rather than a grade the facts cannot carry (lead-scoring practice:
 * Selworthy, SalesforceBen, DigitalApplied — docs/assumptions/fit-score.md).
 *
 * Dealbreakers (the owner's "every one has to be true" and "say no when")
 * cap the grade at D whatever the points: an agency, a banned industry, not
 * US-based, sells to consumers only, a customer worth under $2,000, never
 * sold to strangers, cannot meet within five days, a market under 500, a
 * market everyone already emails, a repeat trial.
 */

const clip = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const low = (s) => String(s || '').toLowerCase();
const numOr = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const parseJson = (v, fb) => { if (v == null || v === '') return fb; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fb; } };

export const DEFAULT_WEIGHTS = { b2b: 20, deal: 20, size: 15, proof: 15, market: 15, ready: 15 };
export const PARTS = [
  ['b2b', 'Sells to businesses'],
  ['deal', 'Deal size'],
  ['size', 'Size and age'],
  ['proof', 'Already wins strangers'],
  ['market', 'Market'],
  ['ready', 'Ready for calls'],
];

const B2B_BUYERS = /\b(firms?|practices|offices|compan(?:y|ies)|businesses|owners|managers|contractors|manufacturers|distributors|clinics|agencies|brands|retailers|dealers|developers|builders|schools|districts|municipalit\w*|hospitals|providers|operators|restaurants|hotels|shops|stores|b2b|msps?|cpas?|attorneys|lawyers|dentists|architects|engineers|landlords|investors|nonprofits|organizations|enterprises|startups|plants|warehouses|fleets)\b/;
const B2C_BUYERS = /\b(homeowners?|families|individuals|consumers|people|parents|seniors|patients|students|couples|kids|women|men|athletes|pet owners|renters|home ?buyers)\b/;
const GENERIC_BUYERS = /^(?:(?:small |local |all |any )?(?:businesses|companies|clients|customers|organizations|b2b companies)|anyone|everyone|people)$/;
/** They sell cold outreach themselves (Aviance's own service): "not a competitor" in the fit gate. */
const COMPETITOR = /\b(cold (?:email|outreach|calling)|outbound (?:sales|agency|prospecting)|lead gen\w*|appointment setting|sdrs?(?: as a service)?|email (?:outreach|deliverability|warm-?up)|sales engagement)\b/;
const HAMMERED = /\b(saas (?:founders|companies|startups)|vc-backed|venture-backed|startups?|startup founders|marketing agencies|digital agencies|agency owners|lead gen\w*|coaches|course creators)\b/;

/** "Founded in 2009" | "Since 2009" | "25+ years in business" → years, else null. */
export function yearsFrom(hint, now = new Date()) {
  const t = String(hint || '');
  const y = t.match(/\b((?:18|19|20)\d{2})\b/);
  if (y) return Math.max(0, now.getUTCFullYear() - Number(y[1]));
  const n = t.match(/\b(\d{1,3})\+?\s+years?/i);
  return n ? Number(n[1]) : null;
}

/** People count from the application, the "team of 25" text, or the team page (a lower bound). */
export function teamFrom({ employees, teamText, teamCount }) {
  const e = numOr(employees);
  if (e !== null && e > 0) return { n: e, source: 'their answer', exact: true };
  const m = String(teamText || '').match(/(\d{1,5})/);
  if (m) return { n: Number(m[1]), source: clip(teamText, 60), exact: true };
  const c = numOr(teamCount);
  if (c !== null && c > 0) return { n: c, source: `${c} people on their team page`, exact: false };
  return null;
}

const ev = (sig) => (sig?.ev || [])[0] || null;

/**
 * Score one applicant. Everything optional; missing = unknown.
 * @param {object} x
 *   application  the stored application hash (web_* answers, dealValue, …)
 *   customers    their customers from "what you sell and to whom" (or null)
 *   website      research website object (teamHint, yearsHint, locations, phones, …)
 *   signals      merged fitsignals; teamCount / teamText from the crawl
 *   business     Google listing { rating, reviews, address } or null
 *   market       { estimate } or null
 *   registeredAt RDAP registration date of their domain
 *   agencyHit    the agency keyword found, or null
 *   homeError    why the website could not be read, or null
 *   fit          FIT config { employeesMin, employeesMax, dealValueMin, slotsPerWeekMin }
 *   opts         FITSCORE config { weights, grades, minConfidence, marketMin, marketGood }
 */
export function scoreFit(x = {}, opts = {}) {
  const now = x.now || new Date();
  const a = x.application || {};
  const sig = x.signals || {};
  const web = x.website || {};
  const fitRules = { employeesMin: 5, employeesMax: 50, dealValueMin: 2000, slotsPerWeekMin: 5, ...(x.fit || {}) };
  const W = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const G = { A: 80, B: 65, C: 50, ...(opts.grades || {}) };
  const minConfidence = Number.isFinite(Number(opts.minConfidence)) ? Number(opts.minConfidence) : 50;
  const marketMin = Number(opts.marketMin) || 500;
  const marketGood = Number(opts.marketGood) || 1000;
  const siteRead = !x.homeError && (Number(web.pagesRead) || 0) > 0;

  const parts = Object.fromEntries(PARTS.map(([k, label]) => [k, { key: k, label, items: [] }]));
  const dealbreakers = [];
  const questions = [];
  const breaker = (text, evidence = null) => { if (!dealbreakers.some((d) => d.text === text)) dealbreakers.push({ text, evidence }); };
  /** One scored line. status: good | ok | bad | unknown. `share` 0–1 of `max`. */
  const item = (part, { max, share = null, text, status, evidence = null, ask = null }) => {
    const known = share !== null && status !== 'unknown';
    parts[part].items.push({ text, status: known ? status : 'unknown', max, share: known ? share : null, evidence, known });
    if (!known && ask) questions.push(ask);
  };

  const sells = a.web_sellsTo || a.sellsTo || '';
  // A competitor is the first thing the owner needs to know.
  const competitorAnswer = COMPETITOR.exec(low(sells));
  if (x.agencyHit) breaker(`Looks like a lead-gen or outbound agency (“${x.agencyHit}”)`);
  else if (competitorAnswer) breaker(`Sells cold outreach themselves (“${competitorAnswer[0]}”) — a competitor`);
  else if ((sig.outbound?.n || 0) >= 5) breaker(`Website is about cold outreach (${sig.outbound.n} mentions) — a competitor`, ev(sig.outbound));

  // ── 1. Sells to businesses ────────────────────────────────────────────────
  const buyers = low(x.customers || '');
  // The whole "… for / to …" part of their answer (the short phrase can drop the noun: "law and accounting [firms]").
  const buyerText = low((String(sells).match(/\b(?:for|to)\s+(.+)$/i) || [])[1] || buyers).replace(/\s*\(.*$/, '').replace(/[.;].*$/, '').trim();
  const buyerShow = clip(buyerText || x.customers, 60);
  const hammeredAnswer = HAMMERED.exec(low(`${sells} ${buyers}`)) || (/^(?:\w+ )?agencies\b/.test(buyerText) && !/\b(insurance|staffing|travel|real estate|government|state|federal)\b/.test(buyerText) ? ['agencies'] : null);
  if (buyerText) {
    const b2b = B2B_BUYERS.test(buyerText.replace(/\b(pet|home ?)owners\b|\bhome ?buyers\b/g, ' '));
    const b2c = B2C_BUYERS.test(buyerText) && !b2b;
    if (b2c) { item('b2b', { max: 8, share: 0, status: 'bad', text: `They sell to “${buyerShow}” — consumers, not businesses` }); breaker(`Sells to consumers (“${buyerShow}”)`); }
    else if (b2b) item('b2b', { max: 8, share: 1, status: 'good', text: `They sell to “${buyerShow}” — businesses` });
    else item('b2b', { max: 8, share: 0.5, status: 'ok', text: `They sell to “${buyerShow}” — not clear it is businesses`, ask: 'Who exactly buys from you — businesses or people at home?' });
  } else item('b2b', { max: 8, text: 'Who they sell to: not stated in a way we can read', status: 'unknown', ask: 'Who exactly buys from you — businesses or people at home?' });

  const nB2b = sig.b2b?.n || 0;
  const nB2c = sig.b2c?.n || 0;
  if (!siteRead) item('b2b', { max: 12, status: 'unknown', text: 'Website words: the site could not be read' });
  else if (nB2b === 0 && nB2c === 0 && !sig.industriesPage) item('b2b', { max: 12, status: 'unknown', text: 'Website does not say who it serves' });
  else if (nB2c >= 3 && nB2b === 0) { item('b2b', { max: 12, share: 0, status: 'bad', text: `Website talks to consumers (${nB2c} mentions, none of businesses)`, evidence: ev(sig.b2c) }); if (!buyers || !B2B_BUYERS.test(buyers)) breaker('Website talks only to consumers', ev(sig.b2c)); }
  else if (nB2b >= 3 && nB2c * 2 <= nB2b) item('b2b', { max: 12, share: 1, status: 'good', text: `Website talks to businesses (${nB2b} mentions${nB2c ? `, ${nB2c} of consumers` : ''})`, evidence: ev(sig.b2b) });
  else if (nB2b > nB2c || (sig.industriesPage && nB2c === 0)) item('b2b', { max: 12, share: 0.67, status: 'ok', text: `Website leans to businesses (${nB2b} vs ${nB2c} consumer mentions)`, evidence: ev(sig.b2b) || ev(sig.industriesPage) });
  else item('b2b', { max: 12, share: 0.33, status: 'bad', text: `Website serves both homes and businesses (${nB2c} consumer vs ${nB2b} business mentions)`, evidence: ev(sig.b2c) });

  // ── 2. Deal size ─────────────────────────────────────────────────────────
  const value = numOr(a.dealValue);
  const band = a.web_valueBand || (value !== null ? `$${value.toLocaleString('en-US')}` : '');
  if (value === null) item('deal', { max: 12, status: 'unknown', text: 'What a new customer is worth: not answered', ask: 'What is a new customer worth to you in the first year?' });
  else if (value < fitRules.dealValueMin) { item('deal', { max: 12, share: 0, status: 'bad', text: `A new customer is worth ${band} — under $${fitRules.dealValueMin.toLocaleString('en-US')}` }); breaker(`A new customer is worth under $${fitRules.dealValueMin.toLocaleString('en-US')}`); }
  else if (value >= 5000) item('deal', { max: 12, share: 1, status: 'good', text: `A new customer is worth ${band} in year one` });
  else item('deal', { max: 12, share: 0.6, status: 'ok', text: `A new customer is worth ${band} — enough, not much room` });

  const hi = sig.highTicket;
  const lo = (sig.lowTicket?.n || 0) + (sig.shopPage ? 1 : 0);
  if (!siteRead) item('deal', { max: 8, status: 'unknown', text: 'Website pricing signs: the site could not be read' });
  else if (hi && hi.n >= 2) item('deal', { max: 8, share: 1, status: 'good', text: 'Website sells ongoing or quoted work (plans, contracts, consultations)', evidence: ev(hi) });
  else if (hi) item('deal', { max: 8, share: 0.6, status: 'ok', text: 'Website shows some signs of bigger deals', evidence: ev(hi) });
  else if (lo) item('deal', { max: 8, share: 0, status: 'bad', text: 'Website sells small items online (cart, checkout)', evidence: ev(sig.lowTicket) || ev(sig.shopPage) });
  else item('deal', { max: 8, status: 'unknown', text: 'Website shows no pricing signs either way' });

  // ── 3. Size and age ──────────────────────────────────────────────────────
  const team = teamFrom({ employees: a.employees, teamText: x.teamText, teamCount: x.teamCount });
  const { employeesMin: eMin, employeesMax: eMax } = fitRules;
  if (!team) item('size', { max: 7, status: 'unknown', text: 'How many people work there: not found', ask: 'How many people work at the company?' });
  else if (team.n >= eMin && team.n <= eMax) item('size', { max: 7, share: 1, status: 'good', text: `About ${team.n} people (${team.source}) — inside ${eMin}–${eMax}` });
  else if (team.n > eMax) item('size', { max: 7, share: team.n <= eMax * 2 ? 0.4 : 0.15, status: 'bad', text: `About ${team.n} people (${team.source}) — bigger than ${eMax}; a committee may decide`, ask: 'Can the person on the call approve $2,497 a month alone?' });
  else if (!team.exact) item('size', { max: 7, status: 'unknown', text: `${team.source} — the page may not list everyone`, ask: 'How many people work at the company?' });
  else item('size', { max: 7, share: team.n >= 3 ? 0.4 : 0, status: 'bad', text: `About ${team.n} people (${team.source}) — smaller than ${eMin}` });

  const years = yearsFrom(web.yearsHint, now);
  const domainYears = x.registeredAt && Number.isFinite(Date.parse(x.registeredAt)) ? (now.getTime() - Date.parse(x.registeredAt)) / (365.25 * 86400e3) : null;
  const age = years ?? (domainYears !== null ? Math.floor(domainYears) : null);
  const ageSrc = years !== null ? `website: ${clip(web.yearsHint, 40)}` : domainYears !== null ? `domain registered ${String(x.registeredAt).slice(0, 10)}` : '';
  if (age === null) item('size', { max: 5, status: 'unknown', text: 'How long in business: not found', ask: 'How long has the company been selling?' });
  else if (age >= 3) item('size', { max: 5, share: 1, status: 'good', text: `In business about ${age} year${age === 1 ? '' : 's'} (${ageSrc})` });
  else if (age >= 1) item('size', { max: 5, share: 0.6, status: 'ok', text: `In business about ${age} year${age === 1 ? '' : 's'} (${ageSrc})` });
  else item('size', { max: 5, share: 0, status: 'bad', text: `Very new — under a year (${ageSrc})` });

  const locs = (web.locations || []).length;
  const growth = sig.hiring || sig.careersPage;
  if (growth || locs >= 2) item('size', { max: 3, share: 1, status: 'good', text: [growth ? 'Hiring' : null, locs >= 2 ? `${locs} locations` : null].filter(Boolean).join(' · '), evidence: ev(sig.hiring) || ev(sig.careersPage) });
  else item('size', { max: 3, status: 'unknown', text: 'No sign of hiring or more than one location' });

  // ── 4. Already wins strangers ────────────────────────────────────────────
  const strangers = low(a.soldToStrangers);
  const said = a.web_strangersAnswer || '';
  if (strangers === 'yes') item('proof', { max: 7, share: 1, status: 'good', text: `They already sell to strangers${said ? ` (“${clip(said, 40)}”)` : ''}` });
  else if (strangers === 'no') { item('proof', { max: 7, share: 0, status: 'bad', text: `Only referrals and their network so far${said ? ` (“${clip(said, 40)}”)` : ''}` }); breaker('Has never sold to strangers — only referrals and network'); }
  else item('proof', { max: 7, status: 'unknown', text: 'Selling to strangers: not answered', ask: 'Has anyone outside your network ever bought from you?' });

  const proofSig = sig.proof || sig.proofPage;
  if (!siteRead) item('proof', { max: 4, status: 'unknown', text: 'Testimonials and case studies: the site could not be read' });
  else if (proofSig) item('proof', { max: 4, share: 1, status: 'good', text: 'Website shows testimonials, case studies or clients', evidence: ev(sig.proof) || ev(sig.proofPage) });
  else item('proof', { max: 4, share: 0.25, status: 'bad', text: 'No testimonials, case studies or client names on the website' });

  const words = Number(sig.words) || 0;
  if (!siteRead) item('proof', { max: 3, status: 'unknown', text: 'Website content: the site could not be read' });
  else if (words >= 600) item('proof', { max: 3, share: 1, status: 'good', text: `A real website (${words.toLocaleString('en-US')} words across ${web.pagesRead} page${web.pagesRead === 1 ? '' : 's'})` });
  else if (words >= 200) item('proof', { max: 3, share: 0.6, status: 'ok', text: `A small website (${words} words)` });
  else item('proof', { max: 3, share: 0, status: 'bad', text: `Website is nearly empty (${words} words)` });

  const b = x.business || null;
  const rating = numOr(b?.rating);
  const reviews = numOr(b?.reviews) || 0;
  if (!b || rating === null) item('proof', { max: 4, status: 'unknown', text: x.placesNote === 'no_key' ? 'Google reviews: not checked (no Google Places key)' : 'Google reviews: no listing found' });
  else if (rating >= 4 && reviews >= 10) item('proof', { max: 4, share: 1, status: 'good', text: `Google: ${rating}★ from ${reviews} reviews` });
  else if (rating >= 4) item('proof', { max: 4, share: 0.5, status: 'ok', text: `Google: ${rating}★ from only ${reviews} review${reviews === 1 ? '' : 's'}` });
  else item('proof', { max: 4, share: rating >= 3.5 ? 0.4 : 0, status: 'bad', text: `Google: ${rating}★ from ${reviews} reviews — low` });

  // ── 5. Market ────────────────────────────────────────────────────────────
  const est = numOr(x.market?.estimate);
  if (est === null) item('market', { max: 8, status: 'unknown', text: 'Market size: not counted yet', ask: 'Roughly how many companies could buy from you in your area?' });
  else if (est >= marketGood) item('market', { max: 8, share: 1, status: 'good', text: `About ${est.toLocaleString('en-US')} companies to reach (${clip(x.market.query, 50)})` });
  else if (est >= marketMin) item('market', { max: 8, share: 0.5, status: 'ok', text: `About ${est.toLocaleString('en-US')} companies to reach — under ${marketGood.toLocaleString('en-US')}` });
  // OpenStreetMap only counts businesses whose NAME has the words: too rough to turn anyone down on.
  else if (x.market?.source === 'overpass') item('market', { max: 8, status: 'unknown', text: `OpenStreetMap found ${est.toLocaleString('en-US')} by name — too rough to judge`, ask: 'Roughly how many companies could buy from you in your area?' });
  else { item('market', { max: 8, share: 0, status: 'bad', text: `Only about ${est.toLocaleString('en-US')} companies to reach` }); breaker(`Market too small — about ${est.toLocaleString('en-US')} companies`); }

  if (!buyerText) item('market', { max: 4, status: 'unknown', text: 'Their buyer: not described', ask: 'Describe your perfect customer in one sentence.' });
  else if (GENERIC_BUYERS.test((buyers || buyerText).trim())) item('market', { max: 4, share: 0.25, status: 'bad', text: `Buyer is vague (“${buyerShow}”)`, ask: 'Which kind of business buys from you most?' });
  else if (hammeredAnswer) item('market', { max: 4, share: 0, status: 'bad', text: `Buyer is a list many already email (“${buyerShow}”)` });
  else item('market', { max: 4, share: 1, status: 'good', text: `Clear buyer: “${buyerShow}”` });

  const dreams = parseJson(a.dreamCustomers, []);
  if (Array.isArray(dreams) && dreams.filter(Boolean).length >= 3) item('market', { max: 3, share: 1, status: 'good', text: 'Named three dream customers' });
  else if (Array.isArray(dreams) && dreams.filter(Boolean).length) item('market', { max: 3, share: 0.34, status: 'bad', text: `Named only ${dreams.filter(Boolean).length} dream customer${dreams.filter(Boolean).length === 1 ? '' : 's'}`, ask: 'Name three companies that would be perfect customers.' });
  else item('market', { max: 3, status: 'unknown', text: 'Three dream customers: not asked yet', ask: 'Name three companies that would be perfect customers.' });

  if (hammeredAnswer) breaker(`Their buyers are a list everyone already emails (“${hammeredAnswer[0]}”)`);

  // ── 6. Ready for calls ───────────────────────────────────────────────────
  const cal = low(a.web_calendarAnswer || '');
  const meet = low(a.meetWithin5Days);
  if (meet === 'yes') item('ready', { max: 4, share: 1, status: 'good', text: 'Can take a meeting within five business days' });
  else if (cal.startsWith('usually')) item('ready', { max: 4, share: 0.5, status: 'ok', text: 'Can “usually” meet within five business days', ask: 'If a call is booked for next Tuesday, can you take it?' });
  else if (meet === 'no') { item('ready', { max: 4, share: 0, status: 'bad', text: 'Cannot meet within five business days' }); breaker('Cannot take a meeting within five business days'); }
  else item('ready', { max: 4, status: 'unknown', text: 'Meeting within five days: not answered', ask: 'Can you take a booked meeting within five business days?' });

  const slots = numOr(a.slotsPerWeek);
  const capBand = String(a.web_capacityBand || '').replace(/\s*a week$/i, '');
  const capTop = Number((capBand.match(/\d+\D+(\d+)/) || [])[1]) || null;
  if (slots === null) item('ready', { max: 4, status: 'unknown', text: 'Open call slots a week: not answered', ask: 'How many sales calls a week could you actually take?' });
  else if (slots >= fitRules.slotsPerWeekMin) item('ready', { max: 4, share: 1, status: 'good', text: `Can take ${capBand || slots} calls a week` });
  else if (capTop && capTop >= fitRules.slotsPerWeekMin) item('ready', { max: 4, share: 0.6, status: 'ok', text: `Can take ${capBand} calls a week — may be under ${fitRules.slotsPerWeekMin}`, ask: `Can you keep ${fitRules.slotsPerWeekMin} slots a week open for these calls?` });
  else item('ready', { max: 4, share: 0.2, status: 'bad', text: `Can take only ${capBand || slots} calls a week — under ${fitRules.slotsPerWeekMin}` });

  const then = low(a.web_ifItWorks || '');
  if (!then) item('ready', { max: 3, status: 'unknown', text: 'What happens if it works: not answered', ask: 'If the trial books you good calls, what happens on day 31?' });
  else if (/growth|starter/.test(then)) item('ready', { max: 3, share: 1, status: 'good', text: `If it works: “${clip(a.web_ifItWorks, 50)}”` });
  else if (/day[- ]?30|decide/.test(then)) item('ready', { max: 3, share: 0.6, status: 'ok', text: 'If it works: decide on the day-30 call' });
  else if (/just testing|see what happens/.test(then)) item('ready', { max: 3, share: 0, status: 'bad', text: 'If it works: “just testing” — no plan to buy', ask: 'What would these 30 days need to show for you to start on day 31?' });
  else item('ready', { max: 3, share: 0.5, status: 'ok', text: `If it works: “${clip(a.web_ifItWorks, 50)}”` });

  const bookingSig = sig.booking;
  const phones = (web.phones || []).length;
  if (!siteRead) item('ready', { max: 4, status: 'unknown', text: 'How buyers reach them: the site could not be read' });
  else if (bookingSig) item('ready', { max: 4, share: 1, status: 'good', text: 'Website lets buyers book a call', evidence: ev(bookingSig) });
  else if (phones) item('ready', { max: 4, share: 0.5, status: 'ok', text: 'Website has a phone number, no booking link' });
  else item('ready', { max: 4, share: 0, status: 'bad', text: 'Website has no phone number or booking link' });

  // ── dealbreakers from outside the six parts ──────────────────────────────
  if (sig.prohibited && sig.prohibited.n >= 2) breaker('Industry cold email is not allowed for (gambling, cannabis, payday loans, …)', ev(sig.prohibited));
  const usState = a.web_state || null;
  const usLoc = locs > 0 || (b?.address && /\b[A-Z]{2}\s+\d{5}\b/.test(b.address));
  if (low(a.usBased) === 'no') breaker('Not US-based (their answer)');
  else if (!usState && !usLoc && a.web_city) breaker(`Could not place “${clip(a.web_city, 40)}” in the US`);
  const repeat = (parseJson(a.fit, {})?.lines || []).find((l) => l.rule === 'one_trial_ever' && l.status === 'fail');
  if (repeat) breaker('Already had a trial', repeat.note ? { quote: repeat.note, page: null } : null);
  if (sig.franchise) questions.push('Is this location independently owned — can you sign on your own?');
  if (low(a.nobodyElseEmailing) !== 'yes') questions.push('Is anyone else cold-emailing this same list for you right now?');

  // ── totals: points earned out of the points that could be checked ────────
  let earned = 0;
  let checkable = 0;
  const out = PARTS.map(([k]) => {
    const p = parts[k];
    const rawMax = p.items.reduce((s, i) => s + i.max, 0) || 1;
    const scale = W[k] / rawMax;
    let pts = 0;
    let known = 0;
    for (const i of p.items) {
      i.max = Math.round(i.max * scale * 10) / 10;
      i.points = i.known ? Math.round(i.max * i.share * 10) / 10 : null;
      if (i.known) { pts += i.points; known += i.max; }
      delete i.share;
    }
    earned += pts;
    checkable += known;
    return { key: k, label: p.label, points: Math.round(pts * 10) / 10, checked: Math.round(known * 10) / 10, max: W[k], pct: known ? Math.round((pts / known) * 100) : null, items: p.items };
  });
  const weightSum = Object.values(W).reduce((s, v) => s + v, 0) || 100;
  const score = checkable ? Math.max(0, Math.min(100, Math.round((earned / checkable) * 100))) : null;
  const confidence = Math.round((checkable / weightSum) * 100);
  let grade = score === null ? null : score >= G.A ? 'A' : score >= G.B ? 'B' : score >= G.C ? 'C' : 'D';
  if (dealbreakers.length) grade = 'D';
  // A company we cannot see (no website, or one that says almost nothing) is not graded on its answers alone.
  const blankSite = !siteRead || words < 100;
  const thin = !dealbreakers.length && (score === null || confidence < minConfidence || blankSite);
  const label = dealbreakers.length ? 'Not a fit' : thin ? 'Needs a look' : { A: 'Strong fit', B: 'Good fit', C: 'Borderline', D: 'Poor fit' }[grade];
  const ranked = out.filter((p) => p.pct !== null).sort((p, q) => q.pct - p.pct);
  const scoreText = score === null ? 'no score' : `${score}/100`;
  let summary;
  if (dealbreakers.length) summary = `${scoreText} — not a fit: ${dealbreakers[0].text}${dealbreakers.length > 1 ? ` (+${dealbreakers.length - 1} more)` : ''}.`;
  else if (thin && blankSite) summary = `${scoreText} — needs a look: ${siteRead ? `their website says almost nothing (${words} words)` : 'their website could not be read'}, so the score rests on their answers. Check them before approving.`;
  else if (thin) summary = `${scoreText} — needs a look: only ${confidence} of 100 points could be checked. Ask the questions below.`;
  else summary = `${scoreText} — ${label.toLowerCase()} (${confidence} of 100 points checked).${ranked.length > 1 ? ` Strongest: ${ranked[0].label.toLowerCase()}; weakest: ${ranked[ranked.length - 1].label.toLowerCase()}.` : ''}`;
  return { score, grade, label, confidence, summary, parts: out, dealbreakers, questions: [...new Set(questions)].slice(0, 8) };
}

/** One line for the owner's alert. */
export function fitScoreLine(f) {
  if (!f || !f.label) return '';
  const head = typeof f.score === 'number' ? `${f.score}/100${f.grade ? ` (${f.grade})` : ''}` : 'no score';
  return `Fit score: ${head} — ${f.label}, ${f.confidence} of 100 points checked.${f.dealbreakers?.length ? ` Dealbreaker: ${f.dealbreakers[0].text}.` : ''}`;
}
