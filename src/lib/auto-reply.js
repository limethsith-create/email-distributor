/**
 * Auto-Reply Bot — Aviance MailDistro
 *
 * When a prospect replies to our cold email, send EXACTLY ONE automatic
 * reply continuing the conversation, then stop forever for that lead
 * (a human takes over). The full conversation is stored in the KV
 * 'conversations' hash so the UI can show both sides.
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getSmtpAccounts } from '@/lib/smtp-accounts';
import { proposeSlotsForLead } from '@/lib/calendar';
import { addToSuppression } from '@/lib/leads-db';

const LEADS_KEY = 'leads';
const CONVERSATIONS_KEY = 'conversations';

// Senders we never auto-reply to
const BLOCKED_SENDER_PATTERNS = ['no-reply', 'noreply', 'mailer-daemon', 'postmaster', 'donotreply'];

// Obvious auto-acknowledgement / bounce patterns in subject or preview
const AUTO_ACK_RE = /auto[- ]?reply|out of office|ticket received|autoreply|automatic reply|delivery status/i;

// Negative-sentiment detection for the polite opt-out variant
const NEGATIVE_RE = /not interested|unsubscribe|\bremove\b|\bstop\b|opt[- ]?out|take me off|do not (contact|email)|don'?t (contact|email)/i;

const BUSINESS_CONTEXT =
  "Aviance (aviance.online) sells guaranteed booked sales calls, not emails: a done-for-you cold email engine (domains, inboxes, verified prospect lists, copywriting, sending, reply handling) that books qualified discovery calls straight onto the client's calendar. Live within 3 weeks or the next month is free. No-shows are replaced free. If a month falls short of the guaranteed call count, the missing calls roll over and never expire, and only calls matching the agreed ideal customer profile count. No setup fee, month-to-month. Plans: Starter $2,497/mo for 10 guaranteed calls, Growth $3,997/mo for 20, Scale $8,497/mo for 50.";

// ---------------------------------------------------------------------------
// Rule-based fallback templates (used when Gemini is unavailable or fails)
// ---------------------------------------------------------------------------

const FALLBACK_POSITIVE = `Thanks for getting back to us — here are the exact details so you know precisely what you'd be getting.

What we do: we don't sell emails, we sell guaranteed booked sales calls — on your calendar. We build and run the entire engine (domains, inboxes, verified lists, copy, sending, reply handling); you just show up and take the calls.

The deal:
- Live within 3 weeks — or your next month is free
- Guaranteed booked calls every month, no-shows replaced free
- Fall short and the missing calls roll over — they never expire
- Only calls matching your ideal customer profile count
- No setup fee, month-to-month — Starter is $2,497/month for 10 guaranteed calls

The fastest way to see if it fits is a 15-minute call. What time works for you this week? Full breakdown at aviance.online.

— Aviance Team`;

/**
 * Positive reply that offers concrete times drawn from the calendar's open
 * slots. The slots are already HELD (status 'proposed') for this lead, so they
 * surface on the Calendar tab for the human to confirm. All times US Eastern.
 */
function buildPositiveWithSlots(slots) {
  const lines = slots.map((s) => `  • ${s.usDate}, ${s.usTime} ET`).join('\n');
  return `Thanks for getting back to us — here are the exact details so you know precisely what you'd be getting.

What we do: we don't sell emails, we sell guaranteed booked sales calls — on your calendar. We build and run the entire engine (domains, inboxes, verified lists, copy, sending, reply handling); you just show up and take the calls.

The deal:
- Live within 3 weeks — or your next month is free
- Guaranteed booked calls every month, no-shows replaced free
- Fall short and the missing calls roll over — they never expire
- No setup fee, month-to-month — Starter is $2,497/month for 10 guaranteed calls

To keep it quick, here are a few times for a 15-minute call (all US Eastern):
${lines}

Reply with whichever works and we'll lock it in and send the invite — or name a better time. Full breakdown at aviance.online.

— Aviance Team`;
}

const FALLBACK_NEGATIVE = `Thanks for letting us know — we appreciate you taking the time to reply.

We've noted your preference and you won't be contacted again. If anything changes down the road, you can always find us at aviance.online.

Wishing you and the team all the best.

— Aviance Team`;

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
    .replace(/\n?— Aviance Team\s*$/,'') // the signature is rendered as a styled block below
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      let t = escapeHtml(para);
      // Linkify bare aviance.online (not when part of www./https:// or a longer path)
      t = t.replace(
        /(^|[^/.\w])(aviance\.online)/gi,
        '$1<a href="https://www.aviance.online" style="color:#E0290F;text-decoration:underline;">aviance.online</a>'
      );
      t = t.replace(/\n/g, '<br>');
      return `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#26282B;line-height:1.65;">${t}</p>`;
    })
    .join('\n');

  // Official signature block — every reply leaves the desk looking the same.
  const signature = `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:3px solid #141414;width:100%;max-width:520px;"><tbody>
<tr><td style="padding:12px 0 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.04em;color:#141414;">AVIANCE&nbsp;<span style="color:#E0290F;">TEAM</span></td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6B7075;line-height:1.6;">Guaranteed booked sales calls — in writing<br><a href="https://www.aviance.online" style="color:#E0290F;text-decoration:none;">www.aviance.online</a></td></tr>
</tbody></table>`;

  return paragraphs + signature;
}

/**
 * Generate the reply body with Gemini; fall back to the rule-based template.
 * Negative-sentiment messages always get the polite opt-out template
 * (never a "book a call" pitch).
 */
async function generateReplyBody(reply, lead, isNegative) {
  if (isNegative) return FALLBACK_NEGATIVE;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return FALLBACK_POSITIVE;

  try {
    const company = lead.company_name || lead.company || 'their company';
    const prompt = `You are replying to a prospect who just responded to our cold email.

OUR BUSINESS: ${BUSINESS_CONTEXT}

PROSPECT COMPANY: ${company}
THEIR MESSAGE: "${(reply.preview || reply.subject || '').substring(0, 500)}"

Write the reply email body. Rules:
- Under 140 words, plain text only (no HTML, no markdown)
- Confident and direct — this is a sales reply, so sell: state clearly that we deliver guaranteed booked sales calls on their calendar, live within 3 weeks or the next month is free, with no-shows replaced free
- Include one price anchor: Starter is $2,497/month for 10 guaranteed calls
- Open by acknowledging what they said, in one sentence
- Close by proposing a quick 15-minute call and asking what time works this week
- Include the link aviance.online exactly once
- No exclamation marks, no invented facts, no personal names
- Sign off as "— Aviance Team"

Return ONLY the reply body.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) return FALLBACK_POSITIVE;
    const data = await response.json();
    const generated = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (
      generated &&
      generated.length > 30 &&
      generated.split(/\s+/).length <= 170
    ) {
      return generated;
    }
    return FALLBACK_POSITIVE;
  } catch {
    return FALLBACK_POSITIVE;
  }
}

/**
 * Read the conversation entry for a lead (or null).
 */
async function getConversation(leadEmail) {
  try {
    return (await kv.hget(CONVERSATIONS_KEY, leadEmail)) || null;
  } catch {
    return null;
  }
}

/**
 * Append messages to the lead's conversation entry.
 */
async function appendConversation(leadEmail, lead, existing, newMessages) {
  try {
    const entry = {
      email: leadEmail,
      company: lead.company_name || lead.company || '',
      messages: [...(existing?.messages || []), ...newMessages],
      status: 'awaiting_human',
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(CONVERSATIONS_KEY, { [leadEmail]: entry });
  } catch {
    // Non-fatal — conversation logging must never break the flow
  }
}

/**
 * Record just the incoming message (used on skip paths), deduped by ts.
 */
async function recordIncoming(leadEmail, lead, existing, reply) {
  const messages = existing?.messages || [];
  const alreadyRecorded = messages.some(
    (m) => m && m.dir === 'in' && m.ts === reply.date
  );
  if (alreadyRecorded) return;
  await appendConversation(leadEmail, lead, existing, [
    { dir: 'in', subject: reply.subject, text: reply.preview || '', ts: reply.date },
  ]);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Maybe send exactly one automatic reply to a matched lead reply.
 *
 * @param {object} reply - { from, subject, date, account, preview, messageId }
 * @param {object} lead - the lead record from the 'leads' KV hash
 * @returns {Promise<{sent:true,to:string}|{skipped:string}>} — never throws
 */
export async function maybeAutoReply(reply, lead) {
  try {
    if (!reply || !reply.from || !lead) return { skipped: 'missing_data' };

    const leadEmail = String(lead.email || reply.from).toLowerCase();
    const from = String(reply.from).toLowerCase();
    const haystack = `${reply.subject || ''} ${reply.preview || ''}`;

    const conversation = await getConversation(leadEmail);
    const messages = conversation?.messages || [];

    // Dedupe: checkRepliesForAccount can re-report the same reply across runs.
    // If we've already recorded this exact incoming message and already
    // auto-replied, there is nothing to do at all.
    const seenThisMessage = messages.some(
      (m) => m && m.dir === 'in' && m.ts === reply.date
    );
    if (seenThisMessage && lead.auto_replied) {
      return { skipped: 'duplicate' };
    }

    // Guard: automated/system senders — never reply, but log the message
    if (BLOCKED_SENDER_PATTERNS.some((p) => from.includes(p))) {
      await recordIncoming(leadEmail, lead, conversation, reply);
      return { skipped: 'automated_sender' };
    }

    // Guard: auto-acknowledgement / out-of-office / bounce content
    if (AUTO_ACK_RE.test(haystack)) {
      await recordIncoming(leadEmail, lead, conversation, reply);
      return { skipped: 'auto_ack' };
    }

    // Guard: we already sent our one automatic reply — human's turn now.
    // Still record the new incoming message (deduped by ts) so the UI sees it.
    if (lead.auto_replied) {
      await recordIncoming(leadEmail, lead, conversation, reply);
      return { skipped: 'already_auto_replied' };
    }

    // Find the sending account (the inbox that received the reply)
    const accounts = getSmtpAccounts();
    if (!accounts.length) {
      await recordIncoming(leadEmail, lead, conversation, reply);
      return { skipped: 'no_smtp_accounts' };
    }
    const account = accounts.find((a) => a.email === reply.account) || accounts[0];

    // Generate the reply body. For interested (non-negative) replies, offer
    // real open calendar slots and hold them for this lead; a human confirms
    // on the Calendar tab. If no slots are available, fall back to the generic
    // "what time works for you?" copy.
    const isNegative = NEGATIVE_RE.test(haystack);
    let body;
    if (isNegative) {
      // We advertise 'reply STOP' in every email - honour it. Suppression is
      // permanent and survives re-imports, so this contact can never be
      // re-added by a future scrape.
      try { await addToSuppression(leadEmail); } catch {}
      body = FALLBACK_NEGATIVE;
    } else {
      let slots = [];
      try {
        slots = await proposeSlotsForLead(leadEmail, lead.company_name || lead.company || '', 3);
      } catch { slots = []; }
      body = slots.length ? buildPositiveWithSlots(slots) : await generateReplyBody(reply, lead, false);
    }

    // Build and send the threaded reply
    const subject = /^re:/i.test(reply.subject || '')
      ? reply.subject
      : `Re: ${reply.subject || ''}`;

    const result = await sendEmail(account, {
      to: reply.from,
      subject,
      text: body,
      html: bodyToHtml(body),
      inReplyTo: reply.messageId,
      references: reply.messageId,
    });

    if (!result || !result.success) {
      // Log the incoming message anyway; leave auto_replied unset so a later
      // run can retry the send.
      await recordIncoming(leadEmail, lead, conversation, reply);
      return { skipped: `send_failed: ${result?.error || 'unknown'}` };
    }

    // Mark the lead so we never auto-reply again
    try {
      const updatedLead = {
        ...lead,
        status: 'replied',
        auto_replied: true,
        auto_replied_at: new Date().toISOString(),
        // Remember the id of the email the bot just sent, so a further reply
        // from this lead (which threads back to it) still matches as genuine.
        auto_reply_message_id: result.messageId || lead.auto_reply_message_id || null,
        updatedAt: new Date().toISOString(),
      };
      await kv.hset(LEADS_KEY, { [leadEmail]: updatedLead });
    } catch {}

    // Store both sides of the exchange in the conversation log
    const newMessages = [];
    if (!seenThisMessage) {
      newMessages.push({
        dir: 'in',
        subject: reply.subject,
        text: reply.preview || '',
        ts: reply.date,
      });
    }
    newMessages.push({
      dir: 'out',
      subject,
      text: body,
      ts: new Date().toISOString(),
    });
    await appendConversation(leadEmail, lead, conversation, newMessages);

    return { sent: true, to: reply.from };
  } catch (err) {
    return { skipped: `error: ${err?.message || 'unknown'}` };
  }
}
