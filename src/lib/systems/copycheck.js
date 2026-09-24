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
 */

import { spamWords } from '@/lib/systems/listfiles';

export const RULES = {
  word_count: 'Body is within the word limit',
  no_urls: 'No links in the first email',
  cta_question: 'One clear question at the end',
  unfilled_slot: 'Every blank is filled',
  placeholder: 'No placeholder text',
  spam_word: 'No spam-trigger words',
  all_caps: 'No shouting (ALL-CAPS words)',
  postal_address: 'Your postal address is in the footer',
  stop_line: 'The "reply STOP" opt-out line is present',
  sender_name: 'Signed with your sender name',
};

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

export function checkEmail(rendered = {}, profile = {}, opts = {}) {
  const maxWords = Number(opts.maxWords) || 80;
  const words = opts.spamWords || spamWords();
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

  if (SLOT_RE.test(all)) fail('unfilled_slot', `unfilled ${SLOT_RE.exec(all)[0]}`);
  if (/\[placeholder/i.test(all)) fail('placeholder', 'contains [PLACEHOLDER');

  const lower = ` ${norm(`${subject} ${body}`)} `;
  const hits = words.filter((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`).test(lower));
  if (hits.length) fail('spam_word', hits.slice(0, 5).join(', '));

  const caps = capsWords(`${subject}\n${body}`);
  if (caps.length) fail('all_caps', caps.slice(0, 5).join(', '));

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
