/**
 * Compliance Guard (SPEC §8.2, §14.7) — runs on every outbound email to a
 * prospect (cold touches and replies; warm-up excluded). It blocks unless:
 *
 *   1. recipient not in suppression:global            (lead-specific)
 *   2. recipient email / domain not in the blocklist  (lead-specific)
 *   3. From name = profile.senderName
 *   4. From address is one of this client's trial inboxes
 *   5. body contains profile.postalAddress
 *   6. body contains the opt-out line ("reply STOP")
 *   7. first touch: subject has no RE:/FW:
 *   8. no misleading claim from config/claims.txt
 *   9. List-Unsubscribe (→ /api/unsubscribe) + List-Unsubscribe-Post one-click headers
 *
 * A block logs `compliance_block` with the rule; three blocks in one ET day
 * on one client raise the owner alert (once a day).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { isBlocked } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { unsubscribeUrl } from '@/lib/tokens';
import { dayKeyIn, ET } from '@/lib/time';
import { configList, alert, lower, ccfg } from '@/lib/systems/stagec-common';

const norm = (s) => String(s || '').replace(/[\s,]+/g, ' ').trim().toLowerCase();

export const OPTOUT_RE = /reply\s+["“']?stop\b/i;
export const LEAD_SPECIFIC_RULES = new Set(['suppressed', 'blocklist']);

/** The two headers every prospect email carries (the mailer sets the same values). */
export function unsubscribeHeaders(to, fromAddress) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(to)}>, <mailto:${fromAddress}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Pure rule check. `msg` = { to, fromName, fromAddress, subject, text,
 * headers }, `ctx` = { profile, inboxEmails, firstTouch, blockedReason }.
 * Returns { ok, rule, detail }.
 */
export function checkRules(msg, { profile = {}, inboxEmails = [], firstTouch = false, blockedReason = null, claims = configList('claims') } = {}) {
  const fail = (rule, detail) => ({ ok: false, rule, detail });
  if (blockedReason === 'suppressed') return fail('suppressed', 'recipient is on suppression:global');
  if (blockedReason) return fail('blocklist', blockedReason);
  if (!profile.senderName || String(msg.fromName || '').trim() !== String(profile.senderName).trim()) {
    return fail('from_name', `From name "${msg.fromName || ''}" is not the approved sender name`);
  }
  if (!inboxEmails.map(lower).includes(lower(msg.fromAddress))) return fail('from_address', `${msg.fromAddress} is not a trial inbox`);
  const body = String(msg.text || '');
  if (!profile.postalAddress || !norm(body).includes(norm(profile.postalAddress))) return fail('postal_address', 'postal address missing from the body');
  if (!OPTOUT_RE.test(body)) return fail('optout_line', 'opt-out line missing from the body');
  if (firstTouch && /^\s*(re|fw|fwd)\s*:/i.test(String(msg.subject || ''))) return fail('first_touch_re', 'first touch subject starts with RE:/FW:');
  const hay = `${msg.subject || ''}\n${body}`.toLowerCase();
  const claim = claims.find((c) => c && hay.includes(c));
  if (claim) return fail('misleading_claim', `contains "${claim}"`);
  const h = Object.fromEntries(Object.entries(msg.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!h['list-unsubscribe'] || !h['list-unsubscribe'].includes('/api/unsubscribe')) return fail('list_unsubscribe', 'List-Unsubscribe header missing');
  if (h['list-unsubscribe-post'] !== 'List-Unsubscribe=One-Click') return fail('list_unsubscribe_post', 'one-click header missing');
  return { ok: true, rule: null, detail: null };
}

/** Log a block and alert on the third one of the day. */
export async function recordBlock(clientId, rule, detail, { to = null, now = new Date() } = {}) {
  await logEvent(clientId, 'compliance', 'compliance_block', { rule, detail, to });
  let n = 0;
  try {
    const key = K.complianceDay(clientId, dayKeyIn(ET, now));
    n = Number(await kv.incr(key)) || 0;
    await kv.expire(key, 3 * 86400);
  } catch {}
  const limit = await ccfg(clientId, 'COMPLIANCE.alertBlocksPerDay');
  if (n >= limit) {
    await alert('compliance_block', {
      clientId,
      vars: { clientId },
      body: `${n} outbound emails were blocked by the Compliance Guard today for ${clientId}.\nLatest rule: ${rule} — ${detail}`,
      did: 'Each blocked email was not sent. Lead-specific blocks (suppressed / blocklist) closed that lead; copy or header blocks held the send.',
    });
  }
  return n;
}

/**
 * Full guard: looks up suppression + blocklist, runs the rules, records a
 * block. Returns { ok, rule, detail, leadSpecific }.
 */
export async function guardOutbound(clientId, msg, { profile, inboxEmails, firstTouch = false, now = new Date() } = {}) {
  const blockedReason = await isBlocked(clientId, msg.to);
  const res = checkRules(msg, { profile, inboxEmails, firstTouch, blockedReason });
  if (!res.ok) {
    await recordBlock(clientId, res.rule, res.detail, { to: msg.to, now });
    return { ...res, leadSpecific: LEAD_SPECIFIC_RULES.has(res.rule) };
  }
  return res;
}
