/**
 * Replies cleanup - permanently purge junk (bounce / DSN / raw-MIME) entries
 * from KV so they never come back.
 *
 *   GET /api/replies/cleanup?token=CRON_SECRET            -> dry run (lists what WOULD be removed)
 *   GET /api/replies/cleanup?token=CRON_SECRET&confirm=1  -> actually deletes them
 *
 * Uses the same predicates the Replies tab uses to hide junk, so what a dry
 * run lists is exactly what gets deleted — with two safety rails on top:
 *
 *   1. A reply the scanner classified as 'human' is never deleted.
 *   2. A record that belongs to a lead we actually emailed (`sent_at`) is only
 *      deleted when its subject / sender matches the deterministic DSN / OOO /
 *      auto-ack / receipt patterns (or the scanner tagged it non-human at
 *      ingest). The letter-ratio "looks like noise" heuristic alone can hide a
 *      record from the tab, but it can never delete one.
 */

import { kv } from '@vercel/kv';
import { isJunkReply, isJunkConversation } from '@/lib/junk-filter';
import { getLeadsByEmail } from '@/lib/leads-db';
import {
  DSN_SUBJECT_RE, OOO_SUBJECT_RE, AUTO_ACK_SUBJECT_RE, MDN_SUBJECT_RE, DSN_SENDER_RE,
} from '@/lib/mail-utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const REPLIES_KEY = 'replies_v3';
const CONVERSATIONS_KEY = 'conversations';

const NON_HUMAN_KINDS = new Set(['dsn', 'ooo', 'auto_ack', 'mdn', 'bulk']);

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Subject / sender match one of the deterministic non-reply patterns. */
function deterministicJunkText(subject, from) {
  const s = String(subject || '');
  const f = String(from || '');
  return DSN_SENDER_RE.test(f)
    || DSN_SUBJECT_RE.test(s)
    || OOO_SUBJECT_RE.test(s)
    || AUTO_ACK_SUBJECT_RE.test(s)
    || MDN_SUBJECT_RE.test(s);
}

/** Deterministic junk for a reply record: scanner kind, or subject / sender pattern. */
function deterministicJunkReply(r) {
  const kind = String((r && r.kind) || '').toLowerCase();
  if (NON_HUMAN_KINDS.has(kind)) return true;
  return deterministicJunkText(r && r.subject, r && (r.from || r.leadEmail));
}

/** Deterministic junk for a conversation: every inbound message matches a pattern. */
function deterministicJunkConversation(c) {
  if (!c || !Array.isArray(c.messages)) return false;
  if (DSN_SENDER_RE.test(String(c.email || ''))) return true;
  const inbound = c.messages.filter(function (m) { return m && m.dir === 'in'; });
  if (!inbound.length) return true; // nothing a person wrote: an empty shell
  return inbound.every(function (m) { return deterministicJunkText(m.subject, m.from); });
}

function wasSent(lead) {
  return Boolean(lead && lead.sent_at);
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  const { searchParams } = new URL(request.url);
  if (cronSecret) {
    const token = searchParams.get('token');
    const authHeader = request.headers.get('authorization');
    if (authHeader !== 'Bearer ' + cronSecret && token !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const confirm = searchParams.get('confirm') === '1';

  try {
    const [repliesRaw, conversationsRaw] = await Promise.all([
      kv.hgetall(REPLIES_KEY).catch(function () { return {}; }),
      kv.hgetall(CONVERSATIONS_KEY).catch(function () { return {}; }),
    ]);
    const replies = repliesRaw && typeof repliesRaw === 'object' ? repliesRaw : {};
    const conversations = conversationsRaw && typeof conversationsRaw === 'object' ? conversationsRaw : {};

    // Candidates by the display predicates (what the tab hides today).
    const replyCandidates = Object.keys(replies).filter(function (k) { return isJunkReply(replies[k]); });
    const convCandidates = Object.keys(conversations).filter(function (k) { return isJunkConversation(conversations[k]); });

    // One batched lead lookup for every candidate's lead.
    const leadEmails = new Set();
    for (const k of replyCandidates) {
      const r = replies[k] || {};
      const e = normEmail(r.leadEmail || (String(k).includes(':') ? String(k).split(':')[0] : ''));
      if (e) leadEmails.add(e);
    }
    for (const k of convCandidates) {
      const c = conversations[k] || {};
      const e = normEmail(c.email || k);
      if (e) leadEmails.add(e);
    }
    let leads = {};
    try { leads = await getLeadsByEmail([...leadEmails]); } catch { leads = {}; }

    const junkReplyKeys = [];
    const protectedReplyKeys = [];
    for (const k of replyCandidates) {
      const r = replies[k] || {};
      const kind = String(r.kind || '').toLowerCase();
      if (kind === 'human') { protectedReplyKeys.push(k); continue; }
      const leadEmail = normEmail(r.leadEmail || (String(k).includes(':') ? String(k).split(':')[0] : ''));
      const lead = leadEmail ? leads[leadEmail] : null;
      if (wasSent(lead) && !deterministicJunkReply(r)) { protectedReplyKeys.push(k); continue; }
      junkReplyKeys.push(k);
    }

    const junkConvKeys = [];
    const protectedConvKeys = [];
    for (const k of convCandidates) {
      const c = conversations[k] || {};
      const leadEmail = normEmail(c.email || k);
      const lead = leadEmail ? leads[leadEmail] : null;
      if (wasSent(lead) && !deterministicJunkConversation(c)) { protectedConvKeys.push(k); continue; }
      junkConvKeys.push(k);
    }

    if (confirm) {
      if (junkReplyKeys.length) {
        try { await kv.hdel(REPLIES_KEY, ...junkReplyKeys); } catch (err) { throw new Error('replies hdel failed: ' + (err.message || err)); }
      }
      if (junkConvKeys.length) {
        try { await kv.hdel(CONVERSATIONS_KEY, ...junkConvKeys); } catch (err) { throw new Error('conversations hdel failed: ' + (err.message || err)); }
      }
    }

    const protectedCount = protectedReplyKeys.length + protectedConvKeys.length;
    return Response.json({
      success: true,
      mode: confirm ? 'deleted' : 'dry_run',
      removed: {
        replies: junkReplyKeys.length,
        conversations: junkConvKeys.length,
      },
      keys: { replies: junkReplyKeys, conversations: junkConvKeys },
      protected: protectedCount,
      protectedKeys: { replies: protectedReplyKeys, conversations: protectedConvKeys },
      note: confirm ? 'Junk entries permanently removed.' : 'Dry run - add &confirm=1 to delete.',
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
