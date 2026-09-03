/**
 * Mail parsing helpers shared by the reply scanner and the bounce scanner.
 *
 * Pure functions only (no KV, no network) — everything here is unit-testable
 * with plain node. IMAP-specific bits (imapflow bodyStructure / download) are
 * kept to the two small functions at the bottom.
 */

// ─── Message-ID helpers ───────────────────────────────────────────────────────

/** Normalize a Message-ID for comparison: strip < >, whitespace, lowercase. */
export function normId(x) {
  return String(x || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/** Every Message-ID inside an In-Reply-To / References value (may hold several). */
export function splitIds(value) {
  const src = Array.isArray(value) ? value.join(' ') : String(value || '');
  const out = [];
  const seen = new Set();
  const re = /<([^<>\s]+)>/g;
  let m;
  while ((m = re.exec(src))) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  if (!out.length) {
    for (const tok of src.split(/[\s,]+/)) {
      const id = normId(tok);
      if (id && id.includes('@') && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

// ─── Header parsing ───────────────────────────────────────────────────────────

/** Parse raw RFC822 header lines (Buffer|string) into a lowercase-key map. */
export function parseHeaders(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const map = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let key = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && key) {
      map[key] += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) { key = null; continue; }
    key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    map[key] = map[key] ? `${map[key]}, ${value}` : value;
  }
  return map;
}

// ─── Classification ───────────────────────────────────────────────────────────

export const DSN_SUBJECT_RE = /delivery status|undeliverable|mail delivery|returned mail|failure notice|delivery has failed|message not delivered|could not be delivered|delivery incomplete|delivery failure|undelivered mail|non[- ]?deliver|nondeliverable|recipient address rejected|message blocked/i;
export const DSN_SENDER_RE = /mailer-daemon|postmaster|mail delivery (subsystem|system)|maildelivery|bounce/i;
export const OOO_SUBJECT_RE = /out of (the )?office|automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|away from (my|the) (desk|office)|on (annual |parental |maternity |sick )?leave|on vacation|on holiday|abwesenheit|automatische antwort|r[ée]ponse automatique|respuesta autom[áa]tica|^auto:|^automatic:/i;
export const AUTO_ACK_SUBJECT_RE = /ticket received|ticket #|case #|we('ve| have) received your (message|email|request)|thank you for (contacting|your (email|message|enquiry|inquiry))|request received|confirmation of receipt|your request has been received|support request/i;
export const MDN_SUBJECT_RE = /^(read|not read|accepted|declined|tentative|opened):/i;
export const NO_REPLY_SENDER_RE = /^(no-?reply|do-?not-?reply|donotreply|noreply)[@.-]|[.-]no-?reply@|notifications?@|alerts?@|bounces?@|mailer@|daemon@/i;

/**
 * Classify an incoming message from its headers and structure BEFORE reading
 * the body. Returns one of:
 *   'dsn'      delivery status notification (bounce / delay)
 *   'mdn'      read receipt / calendar response
 *   'bulk'     mailing-list / marketing traffic (List-Id / List-Unsubscribe)
 *   'ooo'      out-of-office / vacation auto-responder
 *   'auto_ack' ticket-system / auto-acknowledgement
 *   'human'    everything else
 */
export function classifyKind({ headers = {}, subject = '', from = '', contentType = '' } = {}) {
  const h = (k) => String(headers[k] || '').toLowerCase();
  const subj = String(subject || '');
  const sender = String(from || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();

  const reportType = /report-type\s*=\s*"?([a-z-]+)/i.exec(h('content-type') || ct);
  if (ct.includes('multipart/report') || h('content-type').includes('multipart/report')) {
    const rt = reportType ? reportType[1].toLowerCase() : '';
    if (rt.includes('disposition')) return 'mdn';
    return 'dsn';
  }
  if (DSN_SENDER_RE.test(sender)) return 'dsn';
  if (h('return-path') === '<>' && DSN_SUBJECT_RE.test(subj)) return 'dsn';
  if (MDN_SUBJECT_RE.test(subj)) return 'mdn';
  // Mailing-list / marketing traffic from a lead's domain is never a reply.
  if (headers['list-id'] || (headers['list-unsubscribe'] && !headers['in-reply-to'])) return 'bulk';

  const autoSubmitted = h('auto-submitted');
  const precedence = h('precedence');
  const suppress = h('x-auto-response-suppress');
  const autoHeader = Boolean(headers['x-autoreply'] || headers['x-autorespond'] || headers['x-auto-reply'] || headers['x-autoresponder']);
  const isAuto = (autoSubmitted && autoSubmitted !== 'no') || /auto_reply|auto-reply|bulk|junk|list/.test(precedence) || autoHeader || /oof|autoreply|all/.test(suppress);

  if (OOO_SUBJECT_RE.test(subj)) return 'ooo';
  if (AUTO_ACK_SUBJECT_RE.test(subj)) return 'auto_ack';
  if (isAuto) {
    if (/away|leave|vacation|holiday|out of|return/i.test(subj)) return 'ooo';
    return autoSubmitted === 'auto-replied' ? 'ooo' : 'auto_ack';
  }
  if (NO_REPLY_SENDER_RE.test(sender)) return 'auto_ack';
  return 'human';
}

/** Best-effort "back on <date>" parser for out-of-office bodies. */
export function parseOooUntil(text, now = new Date()) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const months = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const lead = /(?:return(?:ing)?|back|until|through|thru|till|out of (?:the )?office (?:until|through|till)|away (?:until|through|till)|on)\s+(?:on\s+|the\s+|in the office on\s+)?/i.source;
  const patterns = [
    new RegExp(`${lead}((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?(${months})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'),
    new RegExp(`${lead}((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${months})\\.?(?:,?\\s+(\\d{4}))?`, 'i'),
    new RegExp(`${lead}(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?`, 'i'),
  ];
  const monthIndex = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase());
  let y = now.getUTCFullYear();
  let result = null;
  let m;
  if ((m = patterns[0].exec(t))) {
    const mo = monthIndex(m[2]); const d = parseInt(m[3], 10); if (m[4]) y = parseInt(m[4], 10);
    result = new Date(Date.UTC(y, mo, d, 12));
  } else if ((m = patterns[1].exec(t))) {
    const d = parseInt(m[2], 10); const mo = monthIndex(m[3]); if (m[4]) y = parseInt(m[4], 10);
    result = new Date(Date.UTC(y, mo, d, 12));
  } else if ((m = patterns[2].exec(t))) {
    const a = parseInt(m[1], 10); const b = parseInt(m[2], 10);
    if (m[3]) { y = parseInt(m[3], 10); if (y < 100) y += 2000; }
    // US style month/day first; fall back to day/month when impossible.
    const mo = a <= 12 ? a - 1 : b - 1; const d = a <= 12 ? b : a;
    result = new Date(Date.UTC(y, mo, d, 12));
  }
  if (!result || isNaN(result.getTime())) return null;
  // A date already in the past (no year given) most likely means next year.
  if (result.getTime() < now.getTime() - 24 * 3600 * 1000 && !/\d{4}/.test(m[0])) {
    result = new Date(Date.UTC(y + 1, result.getUTCMonth(), result.getUTCDate(), 12));
  }
  // Ignore absurd values (> 1 year out).
  if (result.getTime() - now.getTime() > 370 * 24 * 3600 * 1000) return null;
  return result.toISOString();
}

// ─── Bounce (DSN) parsing ─────────────────────────────────────────────────────

/** 'hard' (5.x.x / failed), 'delay' (4.x.x / delayed) or 'unknown'. */
export function dsnSeverity(text, subject = '') {
  const t = String(text || '');
  const s = String(subject || '');
  if (/\(delay\)|delayed|delivery incomplete|has been delayed|will keep trying|not yet been delivered|temporary (failure|problem)/i.test(s + ' ' + t.slice(0, 1500))) {
    if (!/action:\s*failed|status:\s*5\.\d/i.test(t)) return 'delay';
  }
  if (/action:\s*failed|status:\s*5\.\d\.\d|\b5\.[0-9]\.[0-9]\b|permanent(ly)? (failure|error|rejected)|user unknown|does not exist|no such user|mailbox unavailable|address rejected|recipient rejected|unrouteable|unknown user|invalid recipient|mailbox not found|account (has been )?(disabled|deactivated)|domain (not found|does not exist)|550[- ]/i.test(t)) return 'hard';
  if (/action:\s*delayed|status:\s*4\.\d|\b4\.[0-9]\.[0-9]\b/i.test(t)) return 'delay';
  return 'unknown';
}

/** Extract the failed recipient from a DSN body; never returns one of `own`. */
export function extractBouncedAddress(text, own = new Set()) {
  const t = String(text || '');
  const ownLower = new Set([...own].map((x) => String(x).toLowerCase()));
  const candidates = [];
  const push = (v) => {
    const e = String(v || '').replace(/^<|>$/g, '').trim().toLowerCase();
    if (e && e.includes('@') && !ownLower.has(e) && !/mailer-daemon|postmaster|noreply|no-reply/.test(e)) candidates.push(e);
  };
  let m;
  const re1 = /(?:final-recipient|original-recipient)\s*:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi;
  while ((m = re1.exec(t))) push(m[1]);
  if (candidates.length) return candidates[0];
  const re2 = /x-failed-recipients\s*:\s*([^\s\r\n]+)/i.exec(t);
  if (re2) push(re2[1]);
  if (candidates.length) return candidates[0];
  const re3 = /(?:your message (?:to|wasn'?t delivered to)|couldn'?t be delivered to|was not delivered to|delivery to the following recipients? failed[^\n]*\n\s*|recipient:|to:)\s*<?([^\s<>"]+@[^\s<>"]+)>?/gi;
  while ((m = re3.exec(t))) push(m[1]);
  if (candidates.length) return candidates[0];
  const re4 = /<([^\s<>]+@[^\s<>]+)>/g;
  while ((m = re4.exec(t))) push(m[1]);
  if (candidates.length) return candidates[0];
  const re5 = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi;
  while ((m = re5.exec(t))) push(m[1]);
  return candidates[0] || null;
}

/** Short human-readable reason from a DSN body. */
export function bounceReason(text) {
  const t = String(text || '');
  const diag = /diagnostic-code\s*:\s*(?:smtp;)?\s*([^\r\n]+)/i.exec(t);
  if (diag) return diag[1].trim().slice(0, 200);
  const status = /status\s*:\s*(\d\.\d\.\d)/i.exec(t);
  const line = /(5\d\d[- ][^\r\n]{5,160})/.exec(t);
  if (line) return line[1].trim().slice(0, 200);
  if (status) return `status ${status[1]}`;
  return 'undeliverable';
}

// ─── Body text ────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<div class="gmail_quote[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => {
      if (ENTITIES[e] !== undefined) return ENTITIES[e];
      if (/^#\d+$/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
      if (/^#x[0-9a-f]+$/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      return m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Remove quoted history, signatures and mobile boilerplate so only the words
 * the person actually typed remain. Every outreach email ends with
 * "reply STOP" — without this, the quoted text would classify every reply as
 * an unsubscribe.
 */
export function stripQuotedReply(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').replace(/ /g, ' ');
  const cutters = [
    /^\s*on .{0,200}?wrote:\s*$/im,
    /^\s*on .{0,200}?wrote:/im,
    /^\s*-{2,}\s*original message\s*-{2,}/im,
    /^\s*-{2,}\s*forwarded message\s*-{2,}/im,
    /^\s*_{5,}\s*$/m,
    /^\s*from:\s.+\n\s*(sent|date):\s.+/im,
    /^\s*le .{0,120}? a écrit\s*:/im,
    /^\s*am .{0,120}? schrieb .{0,80}:/im,
    /^\s*el .{0,120}? escribió:/im,
    /^\s*sent from my (iphone|ipad|galaxy|android|samsung|mobile|blackberry)/im,
    /^\s*get outlook for (ios|android)/im,
    /^\s*>/m,
  ];
  let cut = t.length;
  for (const re of cutters) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  // Drop quoted lines that survived (">" prefixed) and trailing signature blocks.
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const sig = /^\s*(--\s*$|—\s*$|best( regards)?,?\s*$|regards,?\s*$|kind regards,?\s*$|thanks,?\s*$|thank you,?\s*$|cheers,?\s*$|sincerely,?\s*$)/im.exec(t);
  if (sig && sig.index > 0) t = t.slice(0, sig.index);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

export function snippet(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ─── imapflow helpers ─────────────────────────────────────────────────────────

/**
 * Find the best text part in an imapflow bodyStructure: the first text/plain
 * leaf, else the first text/html leaf. Returns { part, type } or null.
 * Attachments (Content-Disposition: attachment) are skipped.
 */
export function findTextPart(node) {
  if (!node) return null;
  const walk = (n, want) => {
    if (!n) return null;
    if (n.childNodes && n.childNodes.length) {
      for (const c of n.childNodes) {
        const r = walk(c, want);
        if (r) return r;
      }
      return null;
    }
    const type = String(n.type || '').toLowerCase();
    if (type === want && String(n.disposition || '').toLowerCase() !== 'attachment') {
      return { part: n.part || (want === 'text/plain' || want === 'text/html' ? 'TEXT' : null), type, charset: (n.parameters && n.parameters.charset) || null };
    }
    return null;
  };
  return walk(node, 'text/plain') || walk(node, 'text/html');
}

/** Read an imapflow download stream into a string (bounded by maxBytes). */
export async function readStream(stream, maxBytes = 65536) {
  if (!stream) return '';
  let out = '';
  for await (const chunk of stream) {
    out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (out.length >= maxBytes) break;
  }
  return out;
}
