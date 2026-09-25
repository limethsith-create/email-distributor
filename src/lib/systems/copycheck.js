/**
 * Copy Checker (SPEC §7.5). Runs before the client sees the copy (approval
 * page ticks) and before every send (Stage C calls `checkEmail`).
 *
 * `checkEmail(rendered, profile, opts)` → { ok, failures: [{rule, detail}] }
 *   rendered = { touch, subject, body, text, fromName? }
 *     body = the email body without the footer (the word limit applies here)
 *     text = the full text that will be sent (body + footer)
 *
 * Rules (all must pass):
 *   word_count      body ≤ COPY.maxWords words
 *   no_urls         email 1 (touch d0) has no URL or bare domain
 *   cta_question    the CTA sentence (the body's last paragraph) has exactly one "?"
 *   unfilled_slot   no {Slot} left anywhere
 *   placeholder     no "[PLACEHOLDER" anywhere
 *   spam_word       no word/phrase from config/spamwords.txt
 *   all_caps        no ALL-CAPS word longer than 2 letters (acronym allow-list aside)
 *   postal_address  profile.postalAddress appears in the text
 *   stop_line       the opt-out line ("reply STOP") appears in the text
 *   sender_name     profile.senderName appears, and the From name (if given) matches it
 *
 * Copy v2 rules (docs/research/v2-leads-copy.md):
 *   one_question    no question mark outside the CTA paragraph (one ask per email)
 *   no_exclamation  no "!" anywhere
 *   stale_phrase    no "just following up", "circling back", "quick question" …
 *   readability     average sentence ≤ 16 words, none over 28 (a body already
 *                   over the word limit is reported once, as word_count)
 *   you_focus       "I/we" words ≤ 3, or no more of them than "you/your" words
 *   subject_length  subject (without "Re:") ≤ 6 words and ≤ 60 characters
 * and the spam-word list grows with EXTRA_SPAM_WORDS (built in, merged with
 * config/spamwords.txt).
 */

import { spamWords } from '@/lib/systems/listfiles';

export const RULES = {
  word_count: 'Body is within the word limit',
  no_urls: 'No links in the first email',
  cta_question: 'One clear question at the end',
  one_question: 'Only one question in the email',
  unfilled_slot: 'Every blank is filled',
  placeholder: 'No placeholder text',
  spam_word: 'No spam-trigger words',
  stale_phrase: 'No stale phrases ("just following up" …)',
  all_caps: 'No shouting (ALL-CAPS words)',
  no_exclamation: 'No exclamation marks',
  readability: 'Short, easy sentences',
  you_focus: 'About them more than about us ("you" vs "I/we")',
  subject_length: 'Short subject line',
  postal_address: 'Your postal address is in the footer',
  stop_line: 'The "reply STOP" opt-out line is present',
  sender_name: 'Signed with your sender name',
};

/** Thresholds of the v2 rules (constants so the approval page and the send gate always agree). */
export const LIMITS = { maxAvgSentenceWords: 16, maxSentenceWords: 28, maxSelfWords: 3, subjectMaxWords: 6, subjectMaxChars: 60 };

/** Spam triggers added in v2 (HubSpot list, the owner's banned "AI words"); merged with config/spamwords.txt. */
export const EXTRA_SPAM_WORDS = [
  'free', 'special offer', 'limited offer', 'offer expires', 'expires today', 'last chance', 'final notice', 'no fees', 'no hidden fees',
  'save now', 'save up to', 'lowest rate', 'dear sir', 'dear madam', 'to whom it may concern', 'while supplies last', '100%',
  'guaranteed results', 'get paid', 'fast cash', 'best deal', 'hot deal', 'deal ends', 'exclusive offer', 'order today',
  'what are you waiting for', 'you won', 'claim your', 'pre-approved', 'amazing', 'revolutionary', 'game changer', 'game-changer',
  'cutting-edge', 'state-of-the-art', 'synergy', 'leverage', 'utilize', 'robust', 'seamless', 'seamlessly', 'streamline', 'elevate',
  'unlock', 'unleash', 'harness', 'empower', 'supercharge', 'turbocharge', 'revolutionize', 'transformative', 'best-in-class',
  'world-class', 'skyrocket', '10x',
];

/** Phrases that read as mass mail or nagging (Gong, Berman, the owner's voice rules). */
export const STALE_PHRASES = [
  'just following up', 'just checking in', 'following up on my', 'circling back', 'touching base', 'touch base', 'bumping this',
  'bump this', 'never heard back', "haven't heard back", 'have not heard back', 'sorry to bother', 'hope this email finds you',
  'hope this finds you', 'i wanted to reach out', 'i am reaching out', "i'm reaching out", 'thoughts?', 'quick question', 'feel free to',
  'let me know if you have any questions', 'per my last email', 'as per my last', 'i hope you are well', "i hope you're well",
];

const SELF_WORDS = new Set(['i', "i'm", 'im', "i've", "i'll", "i'd", 'me', 'my', 'mine', 'we', "we're", "we've", "we'll", "we'd", 'our', 'ours']);
const YOU_WORDS = new Set(['you', 'your', 'yours', 'yourself', "you're", "you've", "you'll", "you'd"]);

/** {self, you} word counts ("us" counts only in lower case; "US" is the country). */
export function selfYouCounts(text) {
  let self = 0;
  let you = 0;
  for (const raw of String(text || '').replace(/[’]/g, "'").match(/[A-Za-z']+/g) || []) {
    const w = raw.toLowerCase();
    if (SELF_WORDS.has(w) || (raw === 'us')) self++;
    else if (YOU_WORDS.has(w)) you++;
  }
  return { self, you };
}

/** Sentences of a body (split at . ! ? and line breaks) → word counts. */
export function sentenceLengths(body) {
  return String(body || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z0-9]/.test(s) && !/^(hi|hello|hey)\b[^.!?]*,$/i.test(s))
    .map((s) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length);
}

// Short all-caps words that are normal business acronyms, not shouting.
const CAPS_OK = new Set(['MSP', 'MSPS', 'CEO', 'CFO', 'COO', 'CTO', 'CIO', 'HVAC', 'CPA', 'CPAS', 'LLC', 'USA', 'SEO', 'HIPAA', 'PPC', 'CRM', 'ERP', 'VOIP', 'SAAS', 'B2B', 'STOP', 'FAQ', 'PDF', 'VPN', 'LLP', 'INC', 'DBA']);

const URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|co|us|biz|info|online|app|ai|site|xyz|me|ly)\b/i;
const SLOT_RE = /\{[A-Za-z][A-Za-z0-9_.]{0,40}\}/;

export function wordCount(text) {
  return String(text || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/**
 * The CTA sentence: the body's last paragraph (the templates keep the ask on
 * its own line). Two questions there = two asks; none = no ask.
 */
export function ctaSentence(body) {
  const paras = String(body || '').trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (paras[paras.length - 1] || '').replace(/\s+/g, ' ');
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function capsWords(text) {
  return (String(text || '').match(/\b[A-Z][A-Z0-9'’-]*[A-Z0-9]\b/g) || [])
    .filter((w) => w.replace(/[^A-Z]/g, '').length > 2 && !CAPS_OK.has(w.replace(/[’']S$/, '')));
}

let fileWords = null;
function spamList() {
  if (!fileWords) { try { fileWords = spamWords(); } catch { fileWords = []; } }
  return [...new Set([...fileWords, ...EXTRA_SPAM_WORDS])];
}

export function checkEmail(rendered = {}, profile = {}, opts = {}) {
  const maxWords = Number(opts.maxWords) || 80;
  const words = opts.spamWords ? [...new Set([...opts.spamWords, ...EXTRA_SPAM_WORDS])] : spamList();
  const L = { ...LIMITS, ...(opts.limits || {}) };
  const subject = String(rendered.subject || '');
  const body = String(rendered.body || '');
  const text = String(rendered.text || body);
  const all = `${subject}\n${text}`;
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });

  const n = wordCount(body);
  if (n > maxWords) fail('word_count', `${n} words (limit ${maxWords})`);

  if ((rendered.touch === 'd0' || rendered.isFirst) && URL_RE.test(all)) fail('no_urls', `link found: ${URL_RE.exec(all)[0]}`);

  const cta = ctaSentence(body);
  const q = (cta.match(/\?/g) || []).length;
  if (q !== 1) fail('cta_question', `${q} question marks in "${cta.slice(0, 80)}"`);
  const paras = body.trim().split(/\n\s*\n/);
  const earlierQ = paras.slice(0, -1).join('\n').match(/\?/g) || [];
  if (earlierQ.length) fail('one_question', `${earlierQ.length} question mark(s) before the closing question`);

  if (SLOT_RE.test(all)) fail('unfilled_slot', `unfilled ${SLOT_RE.exec(all)[0]}`);
  if (/\[placeholder/i.test(all)) fail('placeholder', 'contains [PLACEHOLDER');

  const lower = ` ${norm(`${subject} ${body}`)} `;
  const hits = words.filter((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`).test(lower));
  if (hits.length) fail('spam_word', hits.slice(0, 5).join(', '));
  const stale = STALE_PHRASES.filter((p) => lower.replace(/[’]/g, "'").includes(p));
  if (stale.length) fail('stale_phrase', stale.slice(0, 3).join(', '));

  // The prospect's own name, company and city may be written in capitals ("ABC Plumbing"): not shouting.
  const exempt = new Set((rendered.exemptWords || []).flatMap((w) => String(w || '').split(/\s+/)).filter(Boolean));
  const caps = capsWords(`${subject}\n${body}`).filter((w) => !exempt.has(w));
  if (caps.length) fail('all_caps', caps.slice(0, 5).join(', '));
  if (/!/.test(`${subject}\n${body}`)) fail('no_exclamation', 'contains "!"');

  if (n <= maxWords) {
    // A long business name reads as one word ("Greater Metro Property Group" is a name, not a long sentence).
    let plain = body;
    for (const name of rendered.exemptWords || []) if (name && String(name).includes(' ')) plain = plain.split(String(name)).join('Company');
    const lens = sentenceLengths(plain);
    const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
    const longest = lens.length ? Math.max(...lens) : 0;
    if (avg > L.maxAvgSentenceWords || longest > L.maxSentenceWords) fail('readability', `average ${avg.toFixed(1)} words per sentence (limit ${L.maxAvgSentenceWords}), longest ${longest} (limit ${L.maxSentenceWords})`);
  }
  const sy = selfYouCounts(body);
  if (sy.self > L.maxSelfWords && sy.self > sy.you) fail('you_focus', `${sy.self} I/we words vs ${sy.you} you/your`);

  if (subject) {
    // The company's name counts as one word (a long legal name is not a long subject).
    let s = subject.replace(/^\s*re:\s*/i, '').trim();
    for (const name of rendered.exemptWords || []) if (name && String(name).includes(' ')) s = s.split(String(name)).join('Company');
    const sw = s.split(/\s+/).filter(Boolean).length;
    if (sw > L.subjectMaxWords || s.length > L.subjectMaxChars) fail('subject_length', `${sw} words, ${s.length} characters`);
  }

  const addr = norm(profile.postalAddress);
  if (!addr) fail('postal_address', 'no postal address in the profile');
  else if (!norm(text).includes(addr)) fail('postal_address', 'postal address missing from the email');

  if (!/reply\s+stop\b/i.test(text)) fail('stop_line', 'no "reply STOP" line');

  const sender = norm(profile.senderName);
  if (!sender) fail('sender_name', 'no sender name in the profile');
  else if (!norm(text).includes(sender)) fail('sender_name', 'sender name missing from the email');
  else if (rendered.fromName && norm(rendered.fromName) !== sender) fail('sender_name', `From name "${rendered.fromName}" does not match "${profile.senderName}"`);

  return { ok: failures.length === 0, failures };
}

/** Ticks for the approval page: every rule with pass/fail. */
export function ticks(result) {
  const failed = new Map(result.failures.map((f) => [f.rule, f.detail]));
  return Object.entries(RULES).map(([rule, label]) => ({ rule, label, ok: !failed.has(rule), detail: failed.get(rule) || null }));
}
