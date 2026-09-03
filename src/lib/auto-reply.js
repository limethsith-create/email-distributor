/**
 * Auto-Reply Bot — Aviance MailDistro (v2)
 *
 * When a prospect replies to our cold email, send EXACTLY ONE automatic
 * reply continuing the conversation, then stop forever for that lead
 * (a human takes over). The full conversation is stored in the KV
 * 'conversations' hash so the UI can show both sides.
 *
 * v2:
 *  - Campaign-aware. A "SEND IT" on the free-leads campaign gets the list
 *    promise it was made ("pulling the five together now"), never the
 *    $2,497 pitch; the offer campaign gets the terms + held call slots.
 *  - Intent classification (Gemini JSON with a rules fallback) on the
 *    quote-stripped text only: interested / send_it / question / meeting /
 *    referral / wrong_person / not_now / not_interested / unsubscribe.
 *    Explicit opt-outs are honoured with suppression; "not interested" is
 *    suppressed too but stays a reply (it counts in reply rate, not in
 *    positive reply rate). Nothing else can ever suppress a lead.
 *  - Exactly-once: the bot claims the lead atomically (HSETNX) BEFORE
 *    sending, so two overlapping scans can never both reply.
 *  - Thread-correct: In-Reply-To + the full References chain, sent from the
 *    inbox that received the reply (never a different inbox), to the
 *    address they asked us to use (Reply-To), with no tracking pixel and no
 *    List-Unsubscribe headers (it's a 1:1 reply, not bulk mail).
 *  - Calendar holds are atomic, spread across days, expire after 72h, and
 *    are released if the send fails.
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { findSmtpAccount } from '@/lib/smtp-accounts';
import { proposeSlotsForLead, releaseProposals } from '@/lib/calendar';
import { addToSuppression, patchLead, indexMessageIds } from '@/lib/leads-db';
import { geminiGenerateJson, geminiGenerate } from '@/lib/gemini';
import { normId } from '@/lib/mail-utils';
import { campaignOf, getTodayKey } from '@/lib/metrics';

const CONVERSATIONS_KEY = 'conversations';
const CLAIMS_KEY = 'auto_reply_claims';   // Hash: leadEmail -> ISO timestamp (atomic once-only guard)
const DAILY_SEND_KEY = 'daily_sends';

// Senders we never auto-reply to
const BLOCKED_SENDER_RE = /no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?@|alerts?@|bounce/i;

export const INTENTS = ['send_it', 'interested', 'question', 'meeting', 'referral', 'wrong_person', 'not_now', 'not_interested', 'unsubscribe', 'ooo', 'other'];

const BUSINESS_CONTEXT =
  "Aviance (aviance.online) sells guaranteed booked sales calls, not emails: a done-for-you cold email engine (domains, inboxes, verified prospect lists, copywriting, sending, reply handling) that books qualified discovery calls straight onto the client's calendar. Live within 3 weeks or the next month is free. No-shows are replaced free. If a month falls short of the guaranteed call count, the missing calls roll over and never expire, and only calls matching the agreed ideal customer profile count. No setup fee, month-to-month. Plans: Starter $2,497/mo for 10 guaranteed calls, Growth $3,997/mo for 20, Scale $8,497/mo for 50.";

const FREE_LEADS_CONTEXT =
  'The "free leads" campaign offered the prospect five researched leads for their business at no cost (company, why the timing is right, the decision-maker, direct contact), delivered the same day they reply "SEND IT". It is a goodwill gift; there is no pitch until they ask.';

// ---------------------------------------------------------------------------
// Copy blocks
// ---------------------------------------------------------------------------

const OFFER_TERMS = `What we do: we don't sell emails, we sell guaranteed booked sales calls — on your calendar. We build and run the entire engine (domains, inboxes, verified lists, copy, sending, reply handling); you just show up and take the calls.

The deal:
- Live within 3 weeks — or your next month is free
- Guaranteed booked calls every month, no-shows replaced free
- Fall short and the missing calls roll over — they never expire
- Only calls matching your ideal customer profile count
- No setup fee, month-to-month — Starter is $2,497/month for 10 guaranteed calls`;

const SIGN_OFF = '— Aviance Team';

function slotLines(slots) {
  return slots.map((s) => `  • ${s.usDate}, ${s.usTime} ET`).join('\n');
}

function offerPositive({ ack, slots }) {
  const opener = ack || 'Thanks for getting back to us — here are the exact details so you know precisely what you would be getting.';
  const close = slots.length
    ? `To keep it quick, here are a few times for a 15-minute call (all US Eastern):\n${slotLines(slots)}\n\nReply with whichever works and we will lock it in and send the invite — or name a better time. Full breakdown at aviance.online.`
    : 'The fastest way to see if it fits is a 15-minute call. What time works for you this week? Full breakdown at aviance.online.';
  return `${opener}\n\n${OFFER_TERMS}\n\n${close}\n\n${SIGN_OFF}`;
}

function freeLeadsPositive({ ack, company }) {
  const opener = ack || 'Great — thanks for the quick reply.';
  return `${opener}

I am pulling the five together for ${company} now: each one with the reason the timing is right, the decision-maker to ask for, and their direct contact. They will be in your inbox today.

One quick thing so the list is spot on: who is your ideal customer — role and type of company? If the five I picked already fit, no reply needed.

${SIGN_OFF}`;
}

const NEGATIVE_BODY = `Thanks for letting us know — we appreciate you taking the time to reply.

We've noted your preference and you won't be contacted again. If anything changes down the road, you can always find us at aviance.online.

Wishing you and the team all the best.

${SIGN_OFF}`;

function notNowBody(company) {
  return `Understood — thanks for letting me know.

I will make a note and check back in a couple of months rather than chase in the meantime. If timing changes sooner for ${company}, a one-line reply is all it takes.

${SIGN_OFF}`;
}

function wrongPersonBody({ company, campaign, referralName }) {
  const who = referralName ? `${referralName}` : 'the right person';
  const what = campaign === 'free-leads' ? 'send the five researched leads to them instead' : 'send the details to them instead';
  return `Thanks for pointing me in the right direction.

Could you share ${referralName ? `${who}'s` : 'their'} email (or forward this along)? Happy to ${what} so it lands with whoever owns new business at ${company}.

${SIGN_OFF}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert the plain-text body into simple, inline-styled HTML paragraphs.
 * - double newlines → separate <p> blocks
 * - single newlines → <br>
 * - bare "aviance.online" mentions → linked
 */
export function bodyToHtml(body) {
  const paragraphs = String(body)
    .replace(/\n?— Aviance Team\s*$/, '') // the signature is rendered as a styled block below
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      let t = escapeHtml(para);
      t = t.replace(
        /(^|[^/.\w])(aviance\.online)/gi,
        '$1<a href="https://www.aviance.online" style="color:#E0290F;text-decoration:underline;">aviance.online</a>'
      );
      t = t.replace(/\n/g, '<br>');
      return `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#26282B;line-height:1.65;">${t}</p>`;
    })
    .join('\n');

  const signature = `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:3px solid #141414;width:100%;max-width:520px;"><tbody>
<tr><td style="padding:12px 0 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.04em;color:#141414;">AVIANCE&nbsp;<span style="color:#E0290F;">TEAM</span></td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6B7075;line-height:1.6;">Guaranteed booked sales calls — in writing<br><a href="https://www.aviance.online" style="color:#E0290F;text-decoration:none;">www.aviance.online</a></td></tr>
</tbody></table>`;

  return paragraphs + signature;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

const POSITIVE_RE = /\b(send it|send them|send me|send the|send over|yes please|yes,? please|please send|go ahead|sure|sounds good|(?<!\bnot\s)(?<!\bnot\s\w+\s)(?<!\bun)interested|details|tell me more|more info|pricing|how much|what does it cost|learn more|let'?s (talk|chat|do it)|book|schedule|call me|happy to|would love|keen|curious)\b/i;
const UNSUB_RE = /\b(unsubscribe|opt[- ]?out|take (me|us) off|remove (me|us)( from)?|do not (contact|email|message)|don'?t (contact|email|message)|stop (emailing|contacting|sending|messaging)|no more emails|cease|spam)\b|^\s*stop\W*$/i;
const NOT_INTERESTED_RE = /\b(not interested|no thanks|no thank you|not (a|the right) fit|we'?re (good|all set|fine|set)|not (looking|in the market)|already (have|use|work(ing)? with)|not (for|something) (us|we)|pass on this|no need|we don'?t need|not relevant)\b/i;
const NOT_NOW_RE = /\b(not (right )?now|not at (this|the) (time|moment)|maybe (later|next|in)|circle back|check back|reach (back )?out (in|next|later)|later (this|next) (year|quarter|month)|revisit|in (a few|\d+) (weeks|months)|next (quarter|year)|busy (right now|at the moment))\b/i;
const SEND_IT_RE = /\b(send it|send them|send the list|send me the (list|leads|five|5)|please send|yes,? send|go ahead and send|i'?ll take (it|them)|let'?s see (it|them)|would love (it|them|to see))\b/i;
const MEETING_RE = /\b(call|meeting|chat|talk|zoom|teams|calendar|schedule|book|slot|time works|works for me|available|free (on|at|this|next))\b/i;
const WRONG_PERSON_RE = /\b(wrong person|not the (right|best) person|not (my|in my) (area|department|role)|i'?m not (the|in charge|responsible)|no longer (work|with|at)|left the company|has left|please (contact|reach out to|speak with)|you (should|can) (contact|reach|speak)|forward(ed|ing)? (this|it|your)|better (person|contact)|handles? (that|this|our)|in charge of)\b/i;
const EMAIL_IN_TEXT_RE = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i;

/** Deterministic classifier on the quote-stripped text. */
export function ruleClassify(text, subject, campaign) {
  // The body is what they typed; the subject only speaks when the body is empty
  // (a bare "unsubscribe" subject) or carries an explicit opt-out word.
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  const subj = String(subject || '').replace(/^\s*(re|fwd?|aw|sv)\s*:\s*/i, '').trim();
  const t = body || subj;
  const words = t.split(' ').filter(Boolean).length;
  const positive = POSITIVE_RE.test(t);
  const out = (intent, confidence, sentiment) => ({ intent, confidence, sentiment, classifier: 'rules' });

  if (/\b(unsubscribe|opt[- ]?out|remove me)\b/i.test(subj) && !positive) return out('unsubscribe', 0.9, 'negative');
  if (UNSUB_RE.test(t) && !(positive && !/^\s*stop\W*$/i.test(t) && words > 8 && !/unsubscribe|opt[- ]?out|remove me/i.test(t))) {
    return out('unsubscribe', 0.9, 'negative');
  }
  if (NOT_INTERESTED_RE.test(t) && !SEND_IT_RE.test(t)) {
    // "No thanks" next to "call me" / "send details" is contradictory — let the AI decide.
    if (positive || /\b(but|however|although)\b/i.test(t)) return out('other', 0.4, 'neutral');
    return out('not_interested', 0.8, 'negative');
  }
  if (NOT_NOW_RE.test(t) && !SEND_IT_RE.test(t)) return out('not_now', 0.7, 'neutral');
  if (WRONG_PERSON_RE.test(t) && !SEND_IT_RE.test(t)) {
    return EMAIL_IN_TEXT_RE.test(text || '') ? out('referral', 0.75, 'neutral') : out('wrong_person', 0.7, 'neutral');
  }
  if (SEND_IT_RE.test(t)) return out('send_it', 0.85, 'positive');
  if (MEETING_RE.test(t) && positive) return out('meeting', 0.7, 'positive');
  if (/\b(details|more info|tell me more|interested|pricing|how much|cost|price|learn more|numbers|terms)\b/i.test(t)) return out('interested', 0.75, 'positive');
  if (/\?/.test(t)) return out('question', 0.6, 'neutral');
  if (positive) return out(campaign === 'free-leads' ? 'send_it' : 'interested', 0.6, 'positive');
  if (words <= 3 && /\b(yes|ok|okay|sure|yep|yeah|please)\b/i.test(t)) return out(campaign === 'free-leads' ? 'send_it' : 'interested', 0.65, 'positive');
  return out('other', 0.3, 'neutral');
}

/** Gemini JSON classification; null when unavailable. */
async function aiClassify(reply, lead, campaign) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const text = String(reply.text || reply.preview || '').slice(0, 1500);
  if (!text.trim()) return null;
  const company = lead.company_name || lead.company || 'their company';
  const prompt = `You classify a reply to a B2B cold email.

OUR CAMPAIGN: ${campaign === 'free-leads' ? FREE_LEADS_CONTEXT : BUSINESS_CONTEXT}
OUR ORIGINAL SUBJECT: "${lead.original_subject || ''}"
PROSPECT COMPANY: ${company}
PROSPECT'S REPLY (quoted history already removed):
"""
${text}
"""

Return ONLY a JSON object:
{
  "intent": one of ${JSON.stringify(INTENTS)},
  "sentiment": "positive" | "neutral" | "negative",
  "confidence": number 0-1,
  "question": the prospect's actual question in one sentence, or null,
  "ooo_until": ISO date (YYYY-MM-DD) if they say when they are back, else null,
  "referral_name": name of another person they point us to, or null,
  "referral_email": that person's email if given, or null,
  "phone": a phone number they gave, or null,
  "preferred_time": any time/day they proposed for a call, or null
}
Rules: "send_it" = they want the free leads / list sent. "interested" = wants details, pricing, terms. "meeting" = proposes or asks for a call. "question" = asks something that needs an answer first. "referral" = points to someone else WITH contact details; "wrong_person" = not the right person, no details. "not_now" = interested later. "not_interested" = a polite no. "unsubscribe" = asks to stop emails / remove / opt out. "ooo" = out-of-office auto-responder. Use "other" only when nothing fits.`;

  const data = await geminiGenerateJson(apiKey, prompt, { temperature: 0.1, maxOutputTokens: 300, timeoutMs: 12000 });
  if (!data || typeof data !== 'object') return null;
  const intent = INTENTS.includes(String(data.intent)) ? String(data.intent) : null;
  if (!intent) return null;
  const sentiment = ['positive', 'neutral', 'negative'].includes(data.sentiment) ? data.sentiment : 'neutral';
  const confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0.5));
  return {
    intent, sentiment, confidence, classifier: 'gemini',
    question: data.question ? String(data.question).slice(0, 300) : null,
    oooUntil: data.ooo_until && /^\d{4}-\d{2}-\d{2}/.test(String(data.ooo_until)) ? String(data.ooo_until).slice(0, 10) : null,
    referralName: data.referral_name ? String(data.referral_name).slice(0, 80) : null,
    referralEmail: data.referral_email && EMAIL_IN_TEXT_RE.test(String(data.referral_email)) ? String(data.referral_email).toLowerCase() : null,
    phone: data.phone ? String(data.phone).slice(0, 40) : null,
    preferredTime: data.preferred_time ? String(data.preferred_time).slice(0, 120) : null,
  };
}

/** Final decision: rules guard the irreversible cases, Gemini refines the rest. */
export async function classifyReply(reply, lead) {
  const campaign = campaignOf(lead);
  const rules = ruleClassify(reply.text || reply.preview || '', reply.subject, campaign);
  let ai = null;
  try { ai = await aiClassify(reply, lead, campaign); } catch { ai = null; }

  let final = rules;
  if (ai) {
    if (rules.intent === 'unsubscribe' && rules.confidence >= 0.9) final = { ...ai, intent: 'unsubscribe', sentiment: 'negative', classifier: 'rules+gemini' };
    else if (ai.intent === 'unsubscribe' && ai.confidence < 0.75 && rules.intent !== 'unsubscribe') final = { ...ai, intent: rules.intent === 'other' ? 'not_interested' : rules.intent, classifier: 'gemini(guarded)' };
    else if (ai.confidence >= 0.55 || rules.intent === 'other') final = ai;
    else final = { ...ai, intent: rules.intent, sentiment: rules.sentiment, classifier: 'rules>gemini' };
  }
  if (final.intent === 'other') {
    final = { ...final, intent: campaign === 'free-leads' ? 'send_it' : 'interested', confidence: Math.min(final.confidence, 0.5), sentiment: final.sentiment === 'negative' ? 'neutral' : final.sentiment };
  }
  return { ...final, campaign, rulesIntent: rules.intent, referralEmail: final.referralEmail || (EMAIL_IN_TEXT_RE.exec(reply.text || '') || [])[1] || null };
}

/** One or two sentences that answer their question / acknowledge their reply. */
async function generateAck(reply, lead, cls) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const text = String(reply.text || reply.preview || '').slice(0, 1200);
  if (!text.trim()) return null;
  const company = lead.company_name || lead.company || 'their company';
  const prompt = `You are replying to a prospect who just responded to our cold email.

OUR BUSINESS: ${cls.campaign === 'free-leads' ? FREE_LEADS_CONTEXT + ' Also: ' + BUSINESS_CONTEXT : BUSINESS_CONTEXT}
PROSPECT COMPANY: ${company}
THEIR REPLY: """${text}"""
${cls.question ? `THEIR QUESTION: ${cls.question}` : ''}

Write ONLY the opening of our reply: one or two plain-text sentences (max 45 words) that acknowledge what they said and, if they asked something, answer it accurately from the facts above. Warm, direct, no exclamation marks, no invented facts, no personal names, no greeting line, no sign-off, no links.`;
  const out = await geminiGenerate(apiKey, prompt, { temperature: 0.5, maxOutputTokens: 160, timeoutMs: 12000 });
  if (!out) return null;
  const clean = out.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
  if (clean.length < 15 || clean.split(' ').length > 60 || /[<>{}]/.test(clean)) return null;
  return clean;
}

// ---------------------------------------------------------------------------
// Conversation log
// ---------------------------------------------------------------------------

async function getConversation(leadEmail) {
  try {
    return (await kv.hget(CONVERSATIONS_KEY, leadEmail)) || null;
  } catch {
    return null;
  }
}

async function saveConversation(leadEmail, lead, existing, newMessages, status, extra = {}) {
  try {
    const messages = [...(existing?.messages || [])];
    for (const m of newMessages) {
      if (m.dir === 'in' && m.id && messages.some((x) => x && x.dir === 'in' && x.id === m.id)) continue;
      messages.push(m);
    }
    const entry = {
      ...(existing || {}),
      email: leadEmail,
      company: lead.company_name || lead.company || existing?.company || '',
      campaign: campaignOf(lead),
      messages,
      status: status || existing?.status || 'awaiting_human',
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    await kv.hset(CONVERSATIONS_KEY, { [leadEmail]: entry });
  } catch {
    // Non-fatal — conversation logging must never break the flow
  }
}

function inboundMessage(reply) {
  return {
    dir: 'in',
    id: normId(reply.messageId) || (reply.uid ? `uid${reply.uid}` : null),
    subject: reply.subject,
    text: reply.text || reply.preview || '',
    ts: reply.date,
    touch: reply.touch || null,
    from: reply.from,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Maybe send exactly one automatic reply to a matched lead reply.
 *
 * @param {object} reply - { from, fromName, replyTo, subject, date, account, folder,
 *   preview, text, messageId, inReplyTo, references[], threadIds[], kind, touch }
 * @param {object} lead - the lead record from the 'leads' KV hash
 * @returns {Promise<object>} { sent:true, intent, ... } | { skipped, retry? } — never throws
 */
export async function maybeAutoReply(reply, lead) {
  try {
    if (!reply || !reply.from || !lead) return { skipped: 'missing_data' };

    const leadEmail = String(lead.email || reply.leadEmail || reply.from).toLowerCase();
    const from = String(reply.from).toLowerCase();
    const campaign = campaignOf(lead);
    const company = lead.company_name || lead.company || 'your company';
    const conversation = await getConversation(leadEmail);

    // Never answer automated senders or anything the scanner classified as non-human.
    if (BLOCKED_SENDER_RE.test(from)) {
      await saveConversation(leadEmail, lead, conversation, [inboundMessage(reply)], null);
      return { skipped: 'automated_sender' };
    }
    if (reply.kind && reply.kind !== 'human') {
      return { skipped: `non_human:${reply.kind}` };
    }

    // Exactly-once guard: claim the lead atomically before doing anything else.
    if (lead.auto_replied) {
      await saveConversation(leadEmail, lead, conversation, [inboundMessage(reply)], null);
      return { skipped: 'already_auto_replied' };
    }
    let claimed;
    try { claimed = await kv.hsetnx(CLAIMS_KEY, leadEmail, new Date().toISOString()); } catch { claimed = null; }
    if (claimed === null) return { skipped: 'claim_failed', retry: true };
    if (!(claimed === 1 || claimed === true)) {
      await saveConversation(leadEmail, lead, conversation, [inboundMessage(reply)], null);
      return { skipped: 'already_claimed' };
    }
    const releaseClaim = async () => { try { await kv.hdel(CLAIMS_KEY, leadEmail); } catch {} };

    // The inbox that received the reply answers it; never a different one.
    const account = findSmtpAccount(reply.account) || findSmtpAccount(lead.account_used) || findSmtpAccount(lead.reply_account);
    if (!account) {
      await releaseClaim();
      await saveConversation(leadEmail, lead, conversation, [inboundMessage(reply)], null);
      return { skipped: 'no_matching_inbox' };
    }

    // Understand the reply.
    const cls = await classifyReply(reply, lead);
    const intent = cls.intent;
    let status = 'awaiting_human';
    let body;
    let slots = [];
    let suppression = null;

    if (intent === 'unsubscribe') {
      suppression = { reason: 'unsubscribe_reply', status: true };
      body = NEGATIVE_BODY;
      status = 'opted_out';
    } else if (intent === 'not_interested') {
      suppression = { reason: 'not_interested_reply', status: false };
      body = NEGATIVE_BODY;
      status = 'closed_not_interested';
    } else if (intent === 'not_now') {
      body = notNowBody(company);
      status = 'revisit_later';
    } else if (intent === 'wrong_person' || intent === 'referral') {
      body = wrongPersonBody({ company, campaign, referralName: cls.referralName });
      status = 'needs_right_person';
    } else if (intent === 'ooo') {
      await releaseClaim();
      await saveConversation(leadEmail, lead, conversation, [inboundMessage(reply)], null);
      return { skipped: 'ooo' };
    } else {
      // interested / send_it / question / meeting
      const ack = await generateAck(reply, lead, cls).catch(() => null);
      if (campaign === 'free-leads') {
        body = freeLeadsPositive({ ack, company });
        status = 'needs_list';
      } else {
        try { slots = await proposeSlotsForLead(leadEmail, company, 3); } catch { slots = []; }
        body = offerPositive({ ack, slots });
        status = 'awaiting_human';
      }
    }

    // Build and send the threaded reply (from the receiving inbox, to the
    // address they asked us to use, with the full References chain).
    const subject = /^\s*re\s*:/i.test(reply.subject || '') ? reply.subject : `Re: ${reply.subject || lead.original_subject || ''}`.trim();
    const references = [
      lead.original_message_id, lead.d3_message_id, lead.d7_message_id,
      ...(reply.references || []).map((r) => `<${normId(r)}>`),
      reply.messageId,
    ].filter(Boolean);

    const replyTo = reply.replyTo && !BLOCKED_SENDER_RE.test(reply.replyTo) ? reply.replyTo : null;
    const result = await sendEmail(account, {
      to: replyTo || reply.from,
      subject,
      text: body,
      html: bodyToHtml(body),
      inReplyTo: reply.messageId,
      references,
      transactional: true,
      noTrack: true,
    });

    if (!result || !result.success) {
      await releaseClaim();
      if (slots.length) { try { await releaseProposals(leadEmail); } catch {} }
      await saveConversation(leadEmail, lead, conversation, [inboundMessage(reply)], null);
      return { skipped: `send_failed: ${result?.error || 'unknown'}`, retry: result?.kind === 'transient', intent };
    }

    // Suppression AFTER the courtesy note went out, so the note itself is never blocked.
    if (suppression) {
      try { await addToSuppression(leadEmail, suppression.reason, { status: suppression.status }); } catch {}
    }

    // Mark the lead so we never auto-reply again, and record what we learned.
    const now = new Date().toISOString();
    await patchLead(leadEmail, (existing) => ({
      auto_replied: true,
      auto_replied_at: now,
      auto_reply_intent: intent,
      auto_reply_message_id: result.messageId || existing.auto_reply_message_id || null,
      auto_reply_account: account.email,
      reply_intent: intent,
      reply_sentiment: cls.sentiment,
      reply_confidence: cls.confidence,
      reply_classifier: cls.classifier,
      ...(cls.question ? { reply_question: cls.question } : {}),
      ...(cls.referralEmail ? { referral_email: cls.referralEmail } : {}),
      ...(cls.referralName ? { referral_name: cls.referralName } : {}),
      ...(cls.phone ? { reply_phone: cls.phone } : {}),
      ...(cls.preferredTime ? { reply_preferred_time: cls.preferredTime } : {}),
      ...(slots.length ? { proposed_slots: slots.map((s) => s.iso), proposed_slots_at: now } : {}),
      ...(intent === 'not_now' ? { revisit_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString() } : {}),
      ...(intent === 'unsubscribe' ? { status: 'unsubscribed' } : {}),
    }));
    try { await indexMessageIds(leadEmail, result.messageId); } catch {}

    // Both sides of the exchange in the conversation log.
    await saveConversation(leadEmail, lead, conversation, [
      inboundMessage(reply),
      { dir: 'out', id: normId(result.messageId), subject, text: body, ts: now, bot: true, intent, account: account.email, slots: slots.map((s) => s.iso) },
    ], status, { intent, sentiment: cls.sentiment, lastOutboundAt: now });

    // Counters (auto-replies never count toward an inbox's outreach cap).
    try {
      const p = kv.pipeline();
      p.hincrby(DAILY_SEND_KEY, `${account.email}:${getTodayKey()}:autoreply`, 1);
      p.hincrby('stats', 'totalAutoReplies', 1);
      await p.exec();
    } catch {}

    return { sent: true, to: replyTo || reply.from, intent, sentiment: cls.sentiment, classifier: cls.classifier, slots: slots.length, messageId: result.messageId, ms: result.ms };
  } catch (err) {
    return { skipped: `error: ${err?.message || 'unknown'}` };
  }
}
