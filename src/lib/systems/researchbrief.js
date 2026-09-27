/**
 * The research brief (Research v4): 8–12 plain sentences the owner reads
 * before the launch call — what they sell, to whom, since when, how big,
 * money on the record, proof, the offers they run, what their website is
 * missing, what they write about, the news, who is nearby, two angles for
 * the call and the risk to raise.
 *
 * Built by rules from the research facts only (no AI): a sentence is written
 * only when its fact exists, and every sentence carries its sources — a page
 * of their site (full URL), a public record's link, or a plain label
 * ("their application", "fit score") when the fact has no page.
 * Pure: research.js `finish` calls it and stores `research.brief`.
 */

import { teamFrom } from '@/lib/systems/fitscore';

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const v = squash(s); return v.length > n ? `${v.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : v; };
const listText = (arr) => (arr.length <= 1 ? arr.join('') : arr.length === 2 ? `${arr[0]} and ${arr[1]}` : `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KEEP_CASE = /^(Google|Microsoft|LinkedIn|OpenStreetMap|PPP|SEC|IT)\b/;
/** "Website talks to …" → "website talks to …" (acronyms and names kept). */
const lowerFirst = (s) => { const t = squash(s); return !t || KEEP_CASE.test(t) || /^[A-Z]{2}/.test(t) ? t : `${t[0].toLowerCase()}${t.slice(1)}`; };
const upperFirst = (s) => { const t = squash(s); return t ? `${t[0].toUpperCase()}${t.slice(1)}` : t; };
const stop = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const money = (n) => (n >= 1e6 ? `$${(Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '')}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthYear = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})/); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null; };
const dayText = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1].slice(0, 3)} ${m[1]}` : null; };

/** Drop-order when there are more than `max` sentences (the least needed on the call first). */
const DROP = ['competitors', 'money', 'topics', 'news'];

/** A news flag's kind (webintel NEWS_RULES) as the thing a story mentions. */
const MENTIONS = { layoffs: 'layoffs', lawsuit: 'a lawsuit', acquisition: 'an acquisition', funding: 'funding', 'new office': 'a new office', award: 'an award' };
const mentions = (kind) => MENTIONS[kind] || String(kind || '');

/** The public source behind a revenue range's basis: the Census survey's page, plus any named industry benchmark. */
const CENSUS_URL = 'https://www.census.gov/programs-surveys/susb.html';
function basisSources(basis) {
  const inner = String(basis || '').match(/\(([^)]*)\)\s*$/)?.[1] || '';
  const out = /census/i.test(inner) ? [CENSUS_URL] : [];
  for (const part of inner.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/census|NAICS|SUSB|:/i.test(part) || part.length > 40) continue;
    out.push(`${part} (industry benchmark)`);
  }
  return out.length ? out : [CENSUS_URL];
}

/**
 * @param {object} x
 *   name, origin         the company's name; their site's origin ("https://www.x.com")
 *   website, deep        research.website and research.deep (deepOut)
 *   business             the matched Google listing or null
 *   score                the Fit Score (fitscore.js) or null
 *   application          the stored application hash (for their own answers)
 *   customers            their customers from "what you sell and to whom" (or null)
 *   registeredAt         RDAP registration date of their domain
 *   src                  the page each website fact came from ({ services, years, team, locations })
 *   signals              merged fit signals (booking link, proof page …)
 *   teamText, teamCount  from the crawl
 *   max                  sentences at most (RESEARCH.briefMax, 12)
 * @returns {{ text: string, sentences: {text: string, sources: string[]}[], sources: string[] } | null}
 */
export function buildBrief(x = {}) {
  const name = squash(x.name) || 'They';
  const origin = String(x.origin || '').replace(/\/+$/, '');
  const web = x.website || {};
  const d = x.deep || null;
  const a = x.application || {};
  const sig = x.signals || {};
  const src = x.src || {};
  const max = Number(x.max) > 0 ? Number(x.max) : 12;
  const at = (p) => (!p ? null : /^https?:\/\//i.test(p) ? p : origin ? `${origin}${p.startsWith('/') ? p : `/${p}`}` : p);
  const home = at('/') || web.url || null;
  const out = [];
  const say = (key, text, sources) => {
    const s = [...new Set((sources || []).map((v) => (v && /^\//.test(v) ? at(v) : v)).filter(Boolean))];
    if (text && s.length) out.push({ key, text: stop(squash(text)), sources: s });
  };

  // 1. What they sell.
  const services = (web.services || []).filter(Boolean).slice(0, 4);
  if (services.length) say('sells', `${name} sells ${listText(services)}`, [src.services || '/']);
  else if (web.description || web.headline) say('sells', `${name} describes itself as “${clip(web.description || web.headline, 150)}”`, ['/']);

  // 2. To whom: the site's own customers first, else their answer on the form.
  const cu = d?.customers;
  if (cu?.line) say('whom', cu.line, [...(cu.segments || []).slice(0, 2).flatMap((s) => (s.pages || []).slice(0, 1)), ...(cu.examples || []).slice(0, 2).map((e) => e.page)]);
  else if (x.customers) say('whom', `On their application they say they sell to ${x.customers}`, ['their application']);

  // 3. Since when.
  const yearOf = (v) => (String(v || '').match(/\b(18|19|20)\d{2}\b/) || [])[0] || null;
  const since = [];
  const sinceSrc = [];
  const hintYear = yearOf(web.yearsHint);
  if (hintYear) { since.push(`${name} has been in business since ${hintYear}`); sinceSrc.push(src.years || '/'); }
  else if (yearOf(d?.company?.founded)) { since.push(`${name} was founded in ${yearOf(d.company.founded)}`); sinceSrc.push(d.orgPage || '/'); }
  else if (web.yearsHint) { since.push(`Their website says “${clip(web.yearsHint, 60)}”`); sinceSrc.push(src.years || '/'); }
  const seen = d?.history?.firstSeen ? String(d.history.firstSeen).slice(0, 4) : null;
  if (seen) { since.push(`${since.length ? 'their' : 'Their'} website has been online since ${seen}`); sinceSrc.push(`https://web.archive.org/web/*/${String(web.url || origin).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`); }
  if (!since.length && x.registeredAt && Number.isFinite(Date.parse(x.registeredAt))) { since.push(`Their domain was registered in ${String(x.registeredAt).slice(0, 4)}`); sinceSrc.push('domain registration (RDAP)'); }
  if (since.length) say('since', since.join(', and '), sinceSrc);

  // 4. Size: people and offices.
  const team = teamFrom({ employees: a.employees, teamText: x.teamText, teamCount: x.teamCount, people: d?.people?.length || 0, schemaEmployees: d?.company?.employees });
  const cities = [...new Set((d?.addresses || []).map((ad) => (String(ad).match(/,\s*([A-Z][A-Za-z .'-]+),?\s+([A-Z]{2})\.?\s+\d{5}/) || []).slice(1, 3).join(', ')).filter(Boolean))];
  const size = [];
  const sizeSrc = [];
  if (team) {
    size.push(`${team.exact ? 'About' : 'At least'} ${team.n} ${team.n === 1 ? 'person works' : 'people work'} there (${lowerFirst(team.source).replace(/\s*\(([^()]*)\)$/, ', $1')})`);
    sizeSrc.push(team.source === 'their answer' ? 'their application' : team.source === 'their website’s company data' ? (d?.orgPage || '/') : (src.team || '/'));
  }
  if (cities.length >= 2) { size.push(`${size.length ? 'with offices' : 'They have offices'} in ${listText(cities.slice(0, 3))}`); sizeSrc.push(home); }
  else if ((d?.addresses || []).length === 1) { size.push(`${size.length ? 'from an office at' : 'Their office is at'} ${d.addresses[0]}`); sizeSrc.push(home); }
  if (size.length) say('size', size.join(', '), sizeSrc);

  // 5. Money on the public record (a range with its basis — never one guessed number).
  const m = d?.money || null;
  const mon = [];
  const monSrc = [];
  const rev = (m?.revenue || [])[0];
  if (rev && rev.low && rev.high) { mon.push(`Revenue is likely ${rev.floor ? 'at least ' : ''}${money(rev.low)}–${money(rev.high)} a year (${clip(String(rev.basis || '').replace(/\s*\([^)]*\)\s*$/, ''), 110)})`); monSrc.push(...basisSources(rev.basis)); }
  const ppp = (m?.federal?.ppp || []).filter((l) => l.amount > 0).sort((p, q) => String(p.date).localeCompare(String(q.date)))[0];
  if (ppp) { mon.push(`${mon.length ? 'the' : 'The'} public record shows a $${Math.round(ppp.amount).toLocaleString('en-US')} PPP loan${monthYear(ppp.date) ? ` from ${monthYear(ppp.date)}` : ''}`); monSrc.push('USAspending.gov'); }
  const contracts = (m?.federal?.contracts || []).filter((c) => c.amount > 0);
  if (contracts.length) { mon.push(`${mon.length ? 'they' : 'They'} won ${plural(contracts.length, 'federal contract')} worth ${money(contracts.reduce((s, c) => s + c.amount, 0))}`); monSrc.push('USAspending.gov'); }
  const formD = (m?.sec?.filings || []).find((f) => /^D(\/A)?$/.test(String(f.form)));
  if (formD) { mon.push(`${mon.length ? 'they' : 'They'} filed a Form D with the SEC (private fundraising)${formD.date ? ` in ${String(formD.date).slice(0, 4)}` : ''}`); monSrc.push(formD.url || 'SEC EDGAR'); }
  if (mon.length) say('money', mon.join('; '), monSrc);

  // 6. Proof: testimonials, case studies, named clients, badges, Google.
  const proof = [];
  const proofSrc = [];
  const nT = d?.testimonials?.length || 0;
  const nC = d?.caseStudies?.length || 0;
  const nK = d?.clients?.length || 0;
  const counted = [nT ? plural(nT, 'testimonial') : null, nC ? plural(nC, 'case study', 'case studies') : null, nK ? plural(nK, 'named client') : null].filter(Boolean);
  if (counted.length) { proof.push(`Their website shows ${listText(counted)}`); proofSrc.push(d.testimonials?.[0]?.page, d.caseStudies?.[0]?.page, d.clients?.[0]?.page); }
  const creds = (d?.credentials || []).slice(0, 3);
  if (creds.length) { proof.push(`${proof.length ? 'they' : 'They'} name ${listText(creds.map((c) => c.name))}`); proofSrc.push(creds[0].page); }
  const b = x.businessMatched ? x.business : null;
  if (b && b.rating != null && b.reviews != null) { proof.push(`${proof.length ? 'Google' : 'On Google they'} ${proof.length ? 'rates them' : 'have'} ${b.rating}★ from ${plural(Number(b.reviews), 'review')}`); proofSrc.push(b.mapsUrl || 'Google Maps'); }
  if (proof.length) say('proof', proof.join('; '), proofSrc);

  // 7. The offers they run.
  const o = d?.offers || {};
  const off = [];
  const offSrc = [];
  const freeCta = (o.ctas || []).find((c) => /\bfree\b/i.test(c));
  if (freeCta) { off.push(`their main call to action is “${clip(freeCta, 60)}”`); offSrc.push(home); }
  // Free offers ("free network assessment") are offers; the rest ("no long-term contracts") are promises. One the call to action already says is not repeated.
  const promos = (o.promos || []).filter((p) => !(freeCta && freeCta.toLowerCase().includes(String(p.offer).toLowerCase())));
  const freebies = promos.filter((p) => /^free\b/i.test(p.offer)).slice(0, 2);
  const promises = promos.filter((p) => !/^free\b/i.test(p.offer)).slice(0, 3);
  if (freebies.length) { off.push(`they offer ${listText(freebies.map((p) => `a ${lowerFirst(p.offer)}`))}`); offSrc.push(freebies[0].page); }
  if (promises.length) { off.push(`they promise ${listText(promises.map((p) => lowerFirst(p.offer)))}`); offSrc.push(promises[0].page); }
  const plans = (o.plans || []).filter((p) => p.price).slice(0, 3);
  if (plans.length) { off.push(`published plans: ${plans.map((p) => `${p.name} (${p.price})`).join(', ')}`); offSrc.push(plans[0].page); }
  else if ((d?.prices || []).length) { off.push(`a published price: “${d.prices[0].text}”`); offSrc.push(d.prices[0].page); }
  const magnet = (o.magnets || [])[0];
  if (magnet) { off.push(`a free download (“${clip(magnet.title, 60)}”)`); offSrc.push(magnet.page); }
  if (off.length) say('offers', `Offers they run: ${off.join('; ')}`, offSrc);

  // 8. What their website is missing (only claimed for a site that was read).
  if (d && (Number(web.pagesRead) || 0) > 0) {
    const hasBooking = Boolean(sig.booking) || (d.tech || []).some((t) => t.kind === 'booking');
    const missing = [
      hasBooking ? null : 'booking link',
      nC ? null : 'case studies',
      (d.prices || []).length || (o.plans || []).length ? null : 'pricing',
      nT || sig.proof || sig.proofPage ? null : 'testimonials',
    ].filter(Boolean);
    const orList = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} or ${missing[missing.length - 1]}`;
    if (missing.length) say('missing', `On the ${plural(Number(d.pagesRead) || Number(web.pagesRead) || 0, 'page')} read, their website has no ${orList}`, [home]);
  }

  // 9. What they write about.
  const t = d?.topics || null;
  const pairs = (t?.pairs || []).slice(0, 3).map((p) => p.text);
  const recent = (d?.blog?.recent || []).slice(0, 2).map((p) => p.page);
  if (t?.rhythm?.text && pairs.length) say('topics', `Their blog: ${t.rhythm.text}; the posts mostly talk about ${listText(pairs)}`, recent.length ? recent : [home]);
  else if (t?.rhythm?.text) say('topics', `Their blog: ${t.rhythm.text}`, recent.length ? recent : [home]);
  else if (pairs.length) say('topics', `Their blog posts mostly talk about ${listText(pairs)}`, recent.length ? recent : [home]);

  // 10. The news.
  const news = d?.news || null;
  // A flagged headline first, else the newest story that names them, else the newest story.
  const flag = (news?.flags || [])[0];
  const named = (news?.items || []).find((i) => news.query && String(i.title).toLowerCase().includes(String(news.query).toLowerCase()));
  const story = flag || named || (news?.items || [])[0];
  if (story?.title) {
    const when = [story.source, dayText(story.date)].filter(Boolean).join(', ');
    say('news', flag ? `In the news: “${clip(story.title, 120)}”${when ? ` (${when})` : ''} — it mentions ${mentions(flag.kind)}` : `Latest news found for “${news.query}”: “${clip(story.title, 120)}”${when ? ` (${when})` : ''}`, [story.link || news.url]);
  }

  // 11. Who is nearby (never contacted — only shown on the call).
  const comp = d?.competitors?.items || [];
  if (comp.length) {
    const who = comp.slice(0, 3).map((c) => `${c.name}${c.rating != null ? ` (${c.rating}★${c.reviews != null ? `, ${plural(Number(c.reviews), 'review')}` : ''})` : ''}`);
    say('competitors', `Nearby on Google for “${d.competitors.query}”: ${listText(who)}`, comp.slice(0, 3).map((c) => c.mapsUrl || c.website).filter(Boolean).length ? comp.slice(0, 3).map((c) => c.mapsUrl || c.website).filter(Boolean) : ['Google Maps']);
  }

  // 12. Two angles for the call: the strongest facts of the Fit Score.
  const sc = x.score || null;
  const ranked = (sc?.parts || []).filter((p) => p.pct !== null && p.pct !== undefined).sort((p, q) => q.pct - p.pct);
  const angles = [];
  for (const p of ranked) {
    const best = (p.items || []).filter((i) => i.status === 'good' && i.known !== false).sort((i, j) => (j.points ?? j.max ?? 0) - (i.points ?? i.max ?? 0))[0];
    if (best) angles.push(best);
    if (angles.length === 2) break;
  }
  if (angles.length) {
    const text = angles.map((i) => lowerFirst(i.text));
    say('angles', angles.length === 2 ? `Two angles for the call: ${text[0]}; and ${text[1]}` : `An angle for the call: ${text[0]}`, angles.map((i) => (i.evidence?.page ? i.evidence.page : 'fit score')));
  }

  // 13. The risk to raise: a dealbreaker, else a warning, else a news warning, else the weakest fact.
  const newsWarn = (news?.flags || []).find((f) => f.level === 'warn');
  const weakest = [...ranked].reverse().flatMap((p) => (p.items || []).filter((i) => i.status === 'bad'))[0];
  if (sc?.dealbreakers?.length) say('risk', `The risk to raise: ${lowerFirst(sc.dealbreakers[0].text)} — a dealbreaker`, [sc.dealbreakers[0].evidence?.page || 'fit score']);
  else if (sc?.warnings?.length) say('risk', `The risk to raise: ${lowerFirst(sc.warnings[0].text)}`, [sc.warnings[0].evidence?.page || 'fit score']);
  else if (newsWarn) say('risk', `The risk to raise: a news story mentions ${mentions(newsWarn.kind)} (“${clip(newsWarn.title, 100)}”)`, [newsWarn.link || news.url]);
  else if (weakest) say('risk', `The risk to raise: ${lowerFirst(weakest.text)}`, [weakest.evidence?.page || 'fit score']);
  else if (sc?.questions?.length) say('risk', `Still open — ask them: ${sc.questions[0]}`, ['fit score']);

  if (!out.length) return null;
  const keep = [...out];
  for (const key of DROP) { if (keep.length <= max) break; const i = keep.findIndex((s) => s.key === key); if (i >= 0) keep.splice(i, 1); }
  const sentences = keep.slice(0, max).map((s) => ({ text: upperFirst(s.text), sources: s.sources }));
  return { text: sentences.map((s) => s.text).join(' '), sentences, sources: [...new Set(sentences.flatMap((s) => s.sources))] };
}
