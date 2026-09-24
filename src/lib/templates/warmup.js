/**
 * Warm-up filler text (SPEC §7.1 step 2). Not client copy and not AI: plain
 * everyday-work sentences composed from fixed parts.
 *
 *   12 topics × 10 subject forms  = 120 subject lines
 *   10 openers × 20 middles       = 200 bodies (2–6 sentences each)
 *
 * No links, no images, no numbers that look like offers. `{firstName}` is the
 * recipient's first name (or "there"), `{senderFirst}` the sender's.
 *
 * Replies (Deliverability v2): 20 first-reply lines, 16 shorter follow-ups for
 * later replies in a thread, and the original quoted underneath like a mail
 * client ("On …, Name <addr> wrote:" + "> " lines). Every mail can be rebuilt
 * from its indices (renderWarmup / renderReply), which the signed warm-up
 * marker carries (encodeWarmMeta), so the reader never downloads bodies.
 */

export const TOPICS = [
  'the quarterly plan', 'next week’s schedule', 'the team lunch', 'the supplier call',
  'the office move', 'the training session', 'the budget review', 'the client visit',
  'the project timeline', 'the new starter', 'the stock count', 'the Friday meeting',
];

const SUBJECT_FORMS = [
  (t) => `Quick note on ${t}`,
  (t) => `About ${t}`,
  (t) => `Thoughts on ${t}`,
  (t) => `${cap(t)} update`,
  (t) => `Following up on ${t}`,
  (t) => `Checking in about ${t}`,
  (t) => `A question on ${t}`,
  (t) => `Notes from ${t}`,
  (t) => `Small change to ${t}`,
  (t) => `${cap(t)} — next steps`,
];

const OPENERS = [
  'Hope your week is going well.',
  'Thanks again for the help earlier.',
  'Just catching up on a few things before the weekend.',
  'Sorry for the slow reply on this one.',
  'Good to hear from you the other day.',
  'Hope the morning has been a calm one.',
  'Picking this back up after our chat.',
  'I had a spare minute so wanted to get this out.',
  'Quick one while I remember.',
  'Hope things have settled down on your side.',
];

// Each middle is 1–4 sentences about {topic}.
const MIDDLES = [
  ['I went through {topic} and most of it looks fine to me.'],
  ['I think we can keep {topic} as it is for now.', 'If anything changes I will let you know.'],
  ['Could we move {topic} to a little later in the day?', 'Mornings are getting busy here.'],
  ['I added a couple of notes about {topic} to the shared folder.', 'Nothing urgent, just ideas.', 'Have a look when you get a chance.'],
  ['The team was happy with how {topic} went.', 'A few people asked if we can do it the same way next time.'],
  ['I am still waiting on one answer about {topic}.', 'Should have it by tomorrow.'],
  ['Can you remind me who is leading {topic}?', 'I want to make sure I send my notes to the right person.'],
  ['I spoke to Sam about {topic} this morning.', 'He agreed with most of it.', 'There is one small point we can talk about later.', 'No rush at all.'],
  ['Let us keep {topic} simple this time.'],
  ['I moved {topic} in my calendar so it does not clash.', 'Let me know if the new time works for you.'],
  ['The notes from {topic} are nearly done.', 'I will tidy them up and share them this week.'],
  ['I liked your idea about {topic}.', 'It would save us a fair bit of back and forth.'],
  ['Do you have the latest version of {topic}?', 'Mine seems to be a week old.'],
  ['We might need one more person for {topic}.', 'I can ask around if that helps.', 'Happy to sort it.'],
  ['Everything for {topic} is on track.', 'Nothing for you to do yet.'],
  ['I will be out for part of Thursday, so {topic} may need to wait until Friday.'],
  ['I printed the list for {topic} and left it on the desk.', 'Shout if anything is missing.'],
  ['Is there anything you need from me before {topic}?', 'I have some time this afternoon.'],
  ['A few small things came up around {topic}.', 'None of them are a problem.', 'I will fill you in when we next talk.'],
  ['I think {topic} went better than last time.', 'The prep really helped.', 'Thanks for pushing for it.'],
];

const CLOSERS = [
  'Speak soon,', 'Thanks,', 'Cheers,', 'Best,', 'Talk later,', 'Many thanks,', 'All the best,', 'Have a good day,',
];

export const REPLIES = [
  'Thanks, that works for me.',
  'Sounds good. Speak soon.',
  'Got it, thank you.',
  'Perfect, thanks for the update.',
  'Great, I will take a look later today.',
  'No problem at all.',
  'Thanks for letting me know.',
  'That is fine by me.',
  'Appreciate it. Talk tomorrow.',
  'Makes sense, thanks.',
  'Good to know, thank you.',
  'Thanks! I will pass it on.',
  'All good here, thanks.',
  'Noted, thank you.',
  'Lovely, thanks for sorting it.',
  'Sure, happy with that.',
  'Thanks, I will keep an eye out.',
  'Great news, thank you.',
  'Understood. Thanks for the heads up.',
  'Cheers, that helps a lot.',
];

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** All 120 subject lines, in a stable order. */
export const SUBJECTS = TOPICS.flatMap((t) => SUBJECT_FORMS.map((f) => f(t)));

/** Body template i (0..199) with `{topic}` left as a slot. */
export function bodyTemplate(i) {
  const n = ((i % 200) + 200) % 200;
  const opener = OPENERS[n % 10];
  const middle = MIDDLES[Math.floor(n / 10)];
  return [opener, ...middle].join(' ');
}

export const BODY_COUNT = 200;

/** Sentence count of a body template (2–6 by construction). */
export function sentenceCount(text) {
  return (String(text).match(/[.?!](\s|$)/g) || []).length;
}

const firstWord = (s) => String(s || '').trim().split(/[\s,.@]+/)[0] || '';

/**
 * One warm-up email from its three indices — deterministic, so the reader
 * can quote the original in a reply without downloading the message body.
 */
export function renderWarmup({ subjectIndex, bodyIndex, closerIndex }, { toName = '', fromName = '' } = {}) {
  const s = ((Number(subjectIndex) % SUBJECTS.length) + SUBJECTS.length) % SUBJECTS.length;
  const topic = TOPICS[Math.floor(s / SUBJECT_FORMS.length)];
  const firstName = cap(firstWord(toName)) || 'there';
  const senderFirst = cap(firstWord(fromName)) || '';
  const body = bodyTemplate(bodyIndex).replace(/\{topic\}/g, topic);
  const closer = CLOSERS[((Number(closerIndex) % CLOSERS.length) + CLOSERS.length) % CLOSERS.length];
  const text = `Hi ${firstName},\n\n${body}\n\n${closer}${senderFirst ? `\n${senderFirst}` : ''}`;
  return { subject: SUBJECTS[s], text, html: textToHtml(text) };
}

/**
 * Compose one warm-up email. `rng` is a () → [0,1) function (Math.random in
 * production, seeded in tests).
 * @returns {{subject, text, html, subjectIndex, bodyIndex, closerIndex}}
 */
export function composeWarmup(rng = Math.random, names = {}) {
  const subjectIndex = Math.floor(rng() * SUBJECTS.length);
  const bodyIndex = Math.floor(rng() * BODY_COUNT);
  const closerIndex = Math.floor(rng() * CLOSERS.length);
  return { ...renderWarmup({ subjectIndex, bodyIndex, closerIndex }, names), subjectIndex, bodyIndex, closerIndex };
}

// Deeper in a thread people write less: an acknowledgement or a closer.
export const FOLLOW_UPS = [
  'Great, speak then.',
  'Perfect, thank you.',
  'Brilliant, cheers.',
  'Sounds like a plan.',
  'Thanks again.',
  'Will do.',
  'All sorted then, thanks.',
  'Good stuff, talk soon.',
  'Lovely, thanks.',
  'Noted, speak later.',
  'Agreed, thanks.',
  'Cool, see you then.',
  'Thanks for confirming.',
  'Appreciate it.',
  'Fab, thanks.',
  'Right you are, thanks.',
];

/** Reply line i for a thread depth (1 = first reply, 2+ = later replies). */
export function replyLine(i, depth = 1) {
  const list = depth >= 2 ? FOLLOW_UPS : REPLIES;
  return list[((Number(i) % list.length) + list.length) % list.length];
}

/** Text of a reply from its index — the quoting side of composeReply. */
export function renderReply(lineIndex, depth = 1, { fromName = '' } = {}) {
  const senderFirst = cap(firstWord(fromName));
  return `${replyLine(lineIndex, depth)}${senderFirst ? `\n\n${senderFirst}` : ''}`;
}

/** "On Mon, Oct 5, 2026 at 11:00 AM, Ann Lee <ann@x.com> wrote:" + "> " lines. */
export function quoteBlock(text, { date = null, name = '', email = '', tz = 'America/New_York' } = {}) {
  let when = '';
  const d = date ? new Date(date) : null;
  if (d && Number.isFinite(d.getTime())) {
    const f = (o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(d);
    when = `${f({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} at ${f({ hour: 'numeric', minute: '2-digit' })}`;
  }
  const who = [name, email ? `<${email}>` : ''].filter(Boolean).join(' ') || 'you';
  const lines = String(text || '').split('\n').map((l) => (l ? `> ${l}` : '>'));
  return `${when ? `On ${when}, ` : ''}${who} wrote:\n${lines.join('\n')}`;
}

/**
 * A short in-thread reply. `depth` = its place in the thread (1 = replying to
 * the first mail); `quote` = the text being replied to (quoted under the reply
 * like a normal mail client does), with `quoteMeta` {date, name, email, tz}.
 * @returns {{text, html, lineIndex, depth}}
 */
export function composeReply(rng = Math.random, { fromName = '', depth = 1, quote = null, quoteMeta = {} } = {}) {
  const list = depth >= 2 ? FOLLOW_UPS : REPLIES;
  const lineIndex = Math.floor(rng() * list.length);
  const own = renderReply(lineIndex, depth, { fromName });
  const text = quote ? `${own}\n\n${quoteBlock(quote, quoteMeta)}` : own;
  return { text, html: textToHtml(text), lineIndex, depth };
}

/**
 * Warm-up marker metadata (inside the signed nonce): how the mail was built,
 * so a reply can quote it and the thread knows its depth.
 *   original: s{subject}b{body}c{closer}d0      reply: r{line}d{depth}
 */
export function encodeWarmMeta(m = {}) {
  if (m.lineIndex != null) return `r${m.lineIndex}d${m.depth || 1}`;
  if (m.subjectIndex != null) return `s${m.subjectIndex}b${m.bodyIndex}c${m.closerIndex ?? 0}d0`;
  return '';
}

export function decodeWarmMeta(tag) {
  const t = String(tag || '');
  let m = /^s(\d+)b(\d+)c(\d+)d(\d+)$/.exec(t);
  if (m) return { kind: 'original', subjectIndex: Number(m[1]), bodyIndex: Number(m[2]), closerIndex: Number(m[3]), depth: Number(m[4]) };
  m = /^r(\d+)d(\d+)$/.exec(t);
  if (m) return { kind: 'reply', lineIndex: Number(m[1]), depth: Number(m[2]) };
  return null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textToHtml(text) {
  return String(text).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}
