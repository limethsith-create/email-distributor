/**
 * Fit signals: what an applicant's own website says about how well they fit
 * the trial (docs/SPEC.md fit gate, "The 30-Day Trial" §2). Plain word rules
 * on the page text and links — no AI. Every hit keeps a short quote and the
 * page it came from, so the owner can check it in one click.
 *
 * One page → { key: { n, ev: [{ quote, page }] } }; mergeSignals() adds pages
 * together. systems/fitscore.js turns the merged signals into the score.
 */

const MAX_QUOTES = 2;

/** Each signal: a word rule on the lower-cased page text (global regex). */
export const SIGNAL_RULES = {
  // Sells to businesses: named business buyers, not the word "companies" on its own.
  b2b: /\b(b2b|for (?:small |mid-?sized? |growing |local )?businesses|business owners|businesses like yours|small and (?:medium|mid)[- ]sized businesses|smbs?|commercial (?:clients?|customers?|propert(?:y|ies)|buildings?|facilities|spaces?|projects?)|our clients include|industries we serve|who we serve|(?:law|accounting|cpa|dental|medical|engineering|architecture|insurance) (?:firms?|practices|offices)|property managers?|facility managers?|general contractors?|manufacturers|distributors|professional services firms|nonprofits?|enterprises|request a demo|book a demo|rfps?)\b/g,
  // Sells to people at home.
  b2c: /\b(homeowners?|residential(?! and commercial)|for your home|your family|families|patients|shop now|add to cart|free shipping|consumers|personal injury|weddings?|pet owners|students)\b/g,
  // Bigger, ongoing deals.
  highTicket: /\b(managed (?:it|services?)|monthly (?:plans?|retainers?|fee|subscription)|retainers?|service (?:agreements?|contracts?|level agreements?)|annual contracts?|per (?:user|seat|device|endpoint)|custom (?:quotes?|proposals?|pricing|solutions?)|request an? (?:quote|proposal|estimate|bid)|get an? (?:quote|proposal|estimate)|free (?:consultation|assessment|audit|estimate|quote)|schedule an? (?:consultation|assessment)|long-term partners?)\b/g,
  // Small one-off online sales.
  lowTicket: /\b(add to cart|buy now|checkout|coupons?|promo codes?|free shipping|shop now)\b/g,
  // Proof they already win customers who did not know them.
  proof: /\b(testimonials?|what (?:our )?(?:clients|customers) (?:say|are saying)|case stud(?:y|ies)|success stor(?:y|ies)|trusted by|clients include|client stories|our (?:recent )?work|portfolio|google reviews|5[- ]star reviews?)\b/g,
  // A way to book a sales call.
  booking: /(calendly\.com|cal\.com\/|meetings\.hubspot\.com|hubspot\.com\/meetings|acuityscheduling\.com|savvycal\.com|tidycal\.com|youcanbook\.me|oncehub\.com|zcal\.co|\bbook (?:a|your) (?:call|meeting|consultation|demo|strategy call|discovery call)\b|\bschedule (?:a|your) (?:call|meeting|demo|consultation)\b)/g,
  // Growing.
  hiring: /\b(we(?:'re| are) hiring|join (?:our|the) team|open positions|job openings|now hiring)\b/g,
  nationwide: /\b(nationwide|across the (?:us|u\.s\.|united states|country)|all 50 states|coast to coast)\b/g,
  // Industries cold email must not be used for (sender policies of every inbox provider).
  // Instantly / lemlist sending policies and Mailchimp's acceptable use (docs/assumptions/fit-score.md).
  prohibited: /\b(casinos?|gambling|sportsbooks?|sports betting|cbd|thc|cannabis|marijuana|dispensar(?:y|ies)|kratom|vape shops?|adult (?:entertainment|content)|escort services?|payday loans?|cash advances?|credit repair|debt relief|cryptocurrenc(?:y|ies)|crypto trading|bitcoin|web3|nfts?|forex trading|penny stocks?|network marketing|multi-level marketing|mlm|financial freedom|firearms)\b/g,
  // A list everyone already emails (the owner's "say no when").
  hammered: /\b(saas (?:founders|companies|startups)|vc-backed|venture-backed|startup founders|marketing agencies|digital agencies|agency owners|coaches and consultants)\b/g,
  // Sells what Aviance sells (cold outreach): a competitor.
  outbound: /\b(cold (?:email|outreach|calling)|outbound (?:sales|campaigns?|prospecting)|lead generation|appointment setting|sdrs?|email (?:outreach|deliverability|warm-?up)|sales engagement)\b/g,
  franchise: /\b(?:each (?:location|office|franchise|studio|store) is |(?:is |are )?)independently owned and operated\b|\bfranchise (?:location|owner|opportunit\w*)|\bindependent(?:ly owned)? franchisee\b/g,
};

/**
 * Link paths that are signals on their own. Kept apart from the word counts
 * (a menu link repeats on every page and would swamp them): presence only.
 */
const PATH_SIGNALS = [
  [/^\/(careers?|jobs|join-us|join-our-team|work-with-us)\/?$/i, 'careersPage'],
  [/^\/(testimonials?|reviews|case-studies|case-study|success-stories|clients|our-clients|portfolio|our-work)\/?$/i, 'proofPage'],
  [/^\/(industries|industries-we-serve|who-we-serve|sectors|markets)\/?$/i, 'industriesPage'],
  [/^\/(shop|store|cart|checkout|products?)\/?$/i, 'shopPage'],
];

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** The sentence around a match, at most 140 characters. */
export function quoteAround(text, index, length) {
  const t = String(text || '');
  let a = Math.max(0, t.lastIndexOf('.', index) + 1, t.lastIndexOf('\n', index) + 1);
  let b = t.length;
  for (const stop of ['.', '\n', '!', '?']) { const i = t.indexOf(stop, index + length); if (i >= 0 && i < b) b = i + 1; }
  if (index - a > 80) a = index - 60;
  if (b - (index + length) > 80) b = index + length + 60;
  const q = squash(t.slice(a, b));
  return q.length > 140 ? `${q.slice(0, 137)}…` : q;
}

/**
 * Signals on one page. `text` = visible text, `hrefs` = link targets on the
 * page, `page` = its path (shown next to each quote).
 */
export function pageSignals(text, { hrefs = [], page = '/' } = {}) {
  const out = {};
  const low = String(text || '').toLowerCase();
  const add = (key, quote) => {
    const s = out[key] || (out[key] = { n: 0, ev: [] });
    s.n += 1;
    if (quote && s.ev.length < MAX_QUOTES && !s.ev.some((e) => e.quote === quote)) s.ev.push({ quote, page });
  };
  for (const [key, re] of Object.entries(SIGNAL_RULES)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(low))) add(key, quoteAround(text, m.index, m[0].length));
  }
  const linkText = hrefs.map((h) => String(h).toLowerCase()).join('\n');
  SIGNAL_RULES.booking.lastIndex = 0;
  let b;
  while ((b = SIGNAL_RULES.booking.exec(linkText))) add('booking', `Booking link: ${b[0]}`);
  for (const h of hrefs) {
    let path = '';
    try { path = new URL(h, 'https://x.invalid').pathname; } catch { continue; }
    for (const [re, key] of PATH_SIGNALS) if (re.test(path)) add(key, `Has a ${path} page`);
  }
  const year = copyrightYear(text);
  if (year) out.copyrightYear = year;
  out.words = (low.match(/[a-z]{2,}/g) || []).length;
  return out;
}

/** "© 2019–2026 Acme" → 2026 (the latest year in a copyright line), else null. */
export function copyrightYear(text) {
  let best = null;
  const re = /(?:©|&copy;|\(c\)|copyright)\s*(?:(\d{4})\s*[-–—]\s*)?(\d{4})/gi;
  let m;
  while ((m = re.exec(String(text || '')))) { const y = Number(m[2]); if (y >= 1995 && y <= 2100 && (!best || y > best)) best = y; }
  return best;
}

/** Add one page's signals into the running total. */
export function mergeSignals(acc = {}, page = {}) {
  const out = { ...acc };
  for (const [key, v] of Object.entries(page)) {
    if (key === 'copyrightYear') { if (!out.copyrightYear || v > out.copyrightYear) out.copyrightYear = v; continue; }
    if (key === 'words') { out.words = (out.words || 0) + (Number(v) || 0); continue; }
    const cur = out[key] || { n: 0, ev: [] };
    const ev = [...cur.ev];
    for (const e of v.ev || []) if (ev.length < MAX_QUOTES && !ev.some((x) => x.quote === e.quote)) ev.push(e);
    out[key] = { n: cur.n + (v.n || 0), ev };
  }
  return out;
}
