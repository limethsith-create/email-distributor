/**
 * Ava's question planner (docs/HUB-API.md "Ava (AI helper)") — a cheap local
 * look at the question, no AI call, so the first word comes sooner:
 *
 *   mode 'direct' — greetings, general knowledge, how-tos, "what does X
 *                   mean", writing: ONE streamed call with the guide chunks,
 *                   no tools (a smaller prompt, no tool round).
 *   mode 'tools'  — live data (clients, numbers, calls, money, the team,
 *                   "what needs me", current events with a search key):
 *                   the obvious look-ups are run BEFORE the first call, side
 *                   by side (`prefetch`), and their results go in with it; the
 *                   model can still call more tools.
 *
 * Navigation ("open Lakeview's money", "take me to the keys", "show the
 * warm-up settings") is resolved here too (`nav`): the hub gets the navigate
 * action without waiting for a tool round. "…and read it" / "what's on this
 * tab" adds `read` (the hub reads its own screen out loud).
 *
 * `quick` — a short or spoken question the small fast model can answer.
 */

import { scoreClients } from '@/lib/ava/tools';

const HIDDEN = new Set(['aviance', '_test']);

export const GENERAL_RE = /^(?:hi|hello|hey|hiya|yo|thanks|thank you|cheers|good (?:morning|afternoon|evening|night)|ok(?:ay)?|cool|great|nice)\b|\bhow (?:do|does|can|should|to|would|could|is it done)\b|\bwhat (?:is|are|does|do)\b(?! (?:on|in) (?:my|the|this) (?:calendar|tab|page|screen))|\bwhat does .{1,60} mean\b|\bmeaning of\b|\bexplain\b|\bdefine\b|\bdefinition\b|\bwhy (?:do|does|is|are|would|should)\b|\bwrite\b|\bdraft\b|\brewrite\b|\bimprove\b|\btranslate\b|\bsummari[sz]e\b|\bideas?\b|\btips?\b/i;
export const LIVE_RE = /\bhow many\b|\bhow much\b|\bwho(?:'s| is| are)? (?:online|in the hub|working|looks? after|on)\b|\bwhich (?:clients?|trials?|ones?)\b|\bstatus\b|\bnumbers\b|\bstats\b|\btoday\b|\btonight\b|\btomorrow\b|\byesterday\b|\bthis (?:week|month)\b|\bnext week\b|\blast week\b|\bright now\b|\bat the moment\b|\bneeds? (?:me|my|you|attention)\b|\bto-?dos?\b|\bwaiting\b|\boverdue\b|\bstuck\b|\bhow (?:is|are|'s) .{1,40} (?:doing|going)\b|\bhow are (?:the |my )?(?:trials|clients)\b|\bany (?:new|replies|calls|applications|inquiries)\b|\bwhat'?s (?:new|up|on)\b|\bso far\b|\blatest\b/i;
const TOPIC_RE = /\b(?:clients?|trials?|paying|calendar|calls?|meetings?|team|replies|bounces?|bounced|invoices?|revenue|earned|made|paid|unpaid|outreach|inquir(?:y|ies)|applications?|booked)\b/i;
const CURRENT_RE = /\b(?:latest|news|current(?:ly)?|recent(?:ly)?|this year|weather|price of|stock|exchange rate|who won|20[2-3]\d)\b/i;
export const READ_RE = /\bread (?:it|this|that|them|me|out|aloud|back|the (?:page|screen|tab)|what'?s)\b|\bread\b.{0,50}\b(?:out|aloud|to me)\b|\band read\b|\bwhat'?s (?:on|in) (?:this|the|my) (?:tab|page|screen)\b|\bwhat (?:does|is) (?:this|the) (?:tab|page|screen) (?:say|show)/i;
export const NAV_RE = /\b(?:open|show(?! me how)(?: me)?|take me|go to|goto|bring up|pull up|jump to|switch to|navigate|head to)\b|\bwhere (?:is|are|do i find|can i find|'s)\b/i;

const MONEY_RE = /\b(?:money|revenue|income|earn(?:ed|ings)?|made this|we made|did we make|invoices?|unpaid|owed?|paid)\b/i;
const CAL_RE = /\b(?:calendar|calls?|meetings?|schedule|appointments?)\b/i;
const NEEDS_RE = /\bneeds? (?:me|my|you|attention)\b|\bto-?dos?\b|\bwhat should i do\b|\banything (?:urgent|new)\b|\bwhat'?s (?:new|up)\b|\bwaiting (?:on|for) me\b|\bwhat needs\b/i;
const MYSTATS_RE = /\bmy stats\b|\bmy (?:own )?outreach\b|\bour (?:own )?(?:outreach|cold emails)\b/i;
const TEAM_RE = /\bteam\b|\bwho(?:'s| is) (?:online|in the hub|working)\b|\bwho looks after\b/i;
const TOTALS_RE = /\b(?:replies|sent|bounces?|interested|booked)\b/i;
const PRONOUN_RE = /\b(?:this client|this one|they|them|their|theirs|it|here)\b/i;

/** Tab words → the client tab (the first that matches wins). */
const TAB_WORDS = [
  ['money', /\b(?:money|invoices?|plan|paid|payments?|price)\b/i],
  ['health', /\b(?:health|deliverability|warm-?up|inboxes|bounces?|spam|growth|auto-?buy)\b/i],
  ['leads', /\b(?:leads?|copy|sequence|coming up)\b/i],
  ['setup', /\b(?:setup|set up|access|application|history|timeline|disputes?|parts)\b/i],
  ['conversations', /\b(?:conversations?|replies|threads?|convos?)\b/i],
  ['sent', /\b(?:emails? sent|sent emails?|sent)\b/i],
  ['calls', /\bcalls?\b|\bmeetings?\b/i],
  ['messages', /\b(?:messages?|chat)\b/i],
  ['overview', /\b(?:overview|numbers|stats)\b/i],
];
/** Settings words → the section (checked before the views; "settings" alone opens Settings). */
const SECTION_WORDS = [
  ['keys', /\bkeys?\b/i],
  ['warmup', /\bwarm-?up (?:settings|helpers?)\b|\bhelpers?\b/i],
  ['phone', /\bphone alerts?\b|\bnotifications?\b/i],
  ['alerts', /\balerts?\b/i],
  ['ava', /\bava(?:'s)? (?:settings|brains?|voice|requests?)\b|\bbusiness facts\b|\bchange requests?\b/i],
  ['details', /\b(?:your|my) details\b/i],
  ['google', /\bgoogle meet\b|\bgoogle settings\b|\bmeet settings\b|\bconnect google\b/i],
  ['inboxes', /\binboxes (?:and|&) domains\b|\bcheapinboxes\b|\bauto-?buy settings\b/i],
  ['replybot', /\breply ?bot\b|\bauto-?reply\b/i],
  ['demo', /\btest run\b|\bdemo\b/i],
  ['status', /\beverything running\b|\bhealth check\b|\bsystem status\b/i],
  ['advanced', /\badvanced\b|\bmission control\b|\bconfig\b/i],
  ['look', /\btheme\b|\bdark mode\b|\blight mode\b|\blight or dark\b/i],
  ['account', /\bmy account\b|\byour account\b|\blog ?out\b|\bsign ?out\b/i],
];
const VIEW_WORDS = [
  ['mystats', /\bmy stats\b|\bmy outreach\b/i],
  ['behind', /\bbehind the scenes\b|\bthe board\b/i],
  ['inquiries', /\binquir(?:y|ies)\b|\bplan call requests?\b/i],
  ['activity', /\bactivity\b|\bwho signed in\b/i],
  ['calendar', /\bcalendar\b/i],
  ['team', /\bteam\b/i],
  ['paying', /\bpaying\b|\bpaid clients\b/i],
  ['trials', /\btrials?\b(?! run)/i],
  ['settings', /\bsettings\b/i],
];

/** A client named in the question (fuzzy) → { id, name } | null. */
export function mentionedClient(text, clients = []) {
  const list = clients.filter((c) => c && c.id && !HIDDEN.has(c.id));
  if (!list.length) return null;
  const best = scoreClients(text, list)[0];
  return best && best.s >= 28 ? best.c : null;
}

/** Where the question asks to go → { view, id?, tab?, section? } | null. */
export function guessNav(text, { client = null, page = {} } = {}) {
  const t = String(text || '');
  const onClient = page?.view === 'client' && page.clientId;
  const target = client || (onClient && PRONOUN_RE.test(t) ? { id: page.clientId } : null);
  if (target) {
    const tab = TAB_WORDS.find(([, re]) => re.test(t))?.[0];
    return { view: 'client', id: target.id, ...(tab ? { tab } : {}) };
  }
  const sec = SECTION_WORDS.find(([, re]) => re.test(t))?.[0];
  if (sec) return { view: 'settings', section: sec };
  const view = VIEW_WORDS.find(([, re]) => re.test(t))?.[0];
  if (view) return { view };
  if (onClient) {
    const tab = TAB_WORDS.find(([, re]) => re.test(t))?.[0];
    if (tab && /\b(?:tab|their|this)\b/i.test(t)) return { view: 'client', id: page.clientId, tab };
  }
  return null;
}

/**
 * The plan for one question.
 * → { mode: 'direct'|'tools', prefetch: [{ name, args }], nav: {…}|null, read, quick, client, why }
 */
export function planQuestion(text, { page = {}, role = 'employee', voice = false, smart = false, search = false, clients = [] } = {}) {
  const t = String(text || '').trim();
  const owner = role === 'admin';
  const words = t.split(/\s+/).filter(Boolean).length;
  const client = mentionedClient(t, clients);
  const onClient = page?.view === 'client' && page?.clientId;
  const aboutThisClient = !client && onClient && PRONOUN_RE.test(t);
  const read = READ_RE.test(t);
  const navAsked = NAV_RE.test(t);
  const nav = navAsked ? guessNav(t, { client, page }) : null;
  const general = GENERAL_RE.test(t);
  // The words that only name the place to open ("my stats", "the calendar") do not make it a live question.
  let rest = t;
  if (nav) for (const [, re] of [...VIEW_WORDS, ...SECTION_WORDS, ...TAB_WORDS]) rest = rest.replace(new RegExp(re.source, 'gi'), ' ');
  const live = LIVE_RE.test(rest) || (TOPIC_RE.test(rest) && !general);
  const current = search && CURRENT_RE.test(t) && !client;

  const prefetch = [];
  const add = (name, args = {}) => { if (prefetch.length < 3 && !prefetch.some((p) => p.name === name && JSON.stringify(p.args) === JSON.stringify(args))) prefetch.push({ name, args }); };
  if (client) add('get_client', { id: client.id });
  else if (aboutThisClient && (live || read || !general)) add('get_client', { id: page.clientId });
  if (!client && !aboutThisClient) {
    if (owner && MONEY_RE.test(t) && (live || /\bhow much\b|\bmoney\b|\brevenue\b|\bunpaid\b/i.test(t))) add('get_numbers', { scope: 'money' });
    if (NEEDS_RE.test(t)) add('list_clients', { filter: 'needs_you' });
    if (CAL_RE.test(t) && (live || /\bcalendar\b/i.test(t)) && !general) add('get_calendar', {});
    if (MYSTATS_RE.test(t) && (live || read || !general)) add('get_numbers', { scope: 'my_outreach' });
    if (TEAM_RE.test(t) && (live || !general)) add('search_hub', { query: 'team' });
    if (live && /\b(?:trials?|clients?|paying)\b/i.test(t) && !prefetch.some((p) => p.name === 'list_clients')) add('list_clients', { filter: /\bpaying\b/i.test(t) ? 'paying' : /\btrials?\b/i.test(t) ? 'trials' : 'all' });
    if (live && TOTALS_RE.test(t) && !prefetch.length) add('get_numbers', { scope: 'all_clients' });
    if (live && !prefetch.length && !current) add('list_clients', { filter: 'all' });
  }

  // A navigation it could not place, a live question or a current one → tools; a plain "open X (and read it)" → direct.
  const pureNav = Boolean(nav) && !live && !client;
  let mode = 'direct';
  let why = general ? 'general' : 'plain';
  if (navAsked && !nav) { mode = 'tools'; why = 'navigate'; }
  else if (client || aboutThisClient && !general) { mode = 'tools'; why = 'client'; }
  else if (live && !pureNav) { mode = 'tools'; why = 'live'; }
  else if (current) { mode = 'tools'; why = 'current'; }
  else if (nav) why = 'navigate';
  if (mode === 'direct' && !(client || aboutThisClient)) prefetch.length = 0;
  // Data the answer needs for "open my stats and read it" (the numbers, PII-free) still come along.
  if (mode === 'direct' && read && nav?.view === 'mystats') prefetch.push({ name: 'get_numbers', args: { scope: 'my_outreach' } });

  const short = words <= 12;
  const quick = !smart && (voice || short) && (mode === 'direct' || prefetch.length > 0) && !(navAsked && !nav);
  return { mode, prefetch, nav, read, quick, client, why };
}
