/**
 * IMAP Reply Checker — Aviance MailDistro (v3)
 *
 * Connects to every sending inbox via IMAP, finds replies to our outreach,
 * classifies them, updates the lead + Replies tab, and hands genuine human
 * replies to the auto-reply bot.
 *
 * v3 — exact, fast, and nothing falls through the cracks:
 *  1. UID watermark per inbox+folder (`reply_uid_state`). Every run asks the
 *     server only for messages newer than the last UID it processed, and
 *     skips the folder entirely when UIDNEXT hasn't moved — zero downloads on
 *     a quiet inbox. No 48h re-scan, no double processing, and a folder that
 *     fails keeps its watermark so nothing is ever lost.
 *  2. Inboxes are scanned in parallel, each under its own deadline, so one
 *     slow or dead inbox can never starve the others or time the run out.
 *  3. Only the decoded text part of a candidate message is downloaded
 *     (quoted-printable / base64 / charset handled by the server side), and
 *     quoted history is stripped before anything reads it. Every outreach
 *     email ends with "reply STOP" — reading the quote would have classified
 *     every reply as an unsubscribe.
 *  4. Header-based classification BEFORE a reply counts: out-of-office,
 *     auto-acknowledgements, read receipts and bounces never flip a lead to
 *     'replied', never inflate the reply rate, and never stop the sequence.
 *     Hard bounces are handled here within minutes instead of by the daily
 *     bounce sweep.
 *  5. Matching: any message from a lead we emailed, or that threads back
 *     (In-Reply-To OR References) to any Message-ID we ever generated — so
 *     replies from colleagues/aliases and replies without "Re:" all count.
 *  6. Every inbound message is recorded in the conversation (keyed by
 *     Message-ID), `replied_at` is the FIRST human reply and never moves,
 *     and each reply record carries campaign, inbox, touch, latency, intent.
 *  7. A run lock (SET NX) stops the standalone route and the heartbeat
 *     piggyback from scanning at the same time; the bot claims each lead
 *     atomically before sending, so "exactly one auto-reply" is guaranteed.
 */

import { ImapFlow } from 'imapflow';
import { kv } from '@vercel/kv';
import { getSmtpAccounts, getOwnAddresses } from '@/lib/smtp-accounts';
import { maybeAutoReply } from '@/lib/auto-reply';
import { getLeadsByEmail, getLeadsMap, patchLead, markLeadBounced, getAllReplies as getAllRepliesFromDb } from '@/lib/leads-db';
import { recordImapResult } from '@/lib/inbox-health';
import {
  normId, splitIds, parseHeaders, classifyKind, parseOooUntil, dsnSeverity,
  extractBouncedAddress, bounceReason, htmlToText, stripQuotedReply, snippet,
  findTextPart, readStream,
} from '@/lib/mail-utils';
import { campaignOf } from '@/lib/metrics';

const LEADS_KEY = 'leads';
const REPLIES_KEY = 'replies_v3';          // Hash: leadEmail:messageId -> reply record
const UID_STATE_KEY = 'reply_uid_state';   // Hash: account|folder -> { uidValidity, lastUid, updatedAt }
const MSGID_INDEX_KEY = 'msgid_index';     // Hash: normalized Message-ID -> lead email
const LOCK_KEY = 'reply_check_lock';
const LAST_RUN_KEY = 'reply_check_last_run';
const EVENTS_KEY = 'reply_events';         // List: non-human inbound (ooo / bounce / auto-ack) for diagnostics
const PENDING_BOT_KEY = 'pending_auto_replies'; // Hash: leadEmail -> reply waiting for the bot
const CONVERSATIONS_KEY = 'conversations';

const FIRST_SCAN_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_DEADLINE_MS = 35 * 1000;
const LOCK_TTL_SECONDS = 110;
const MAX_BODY_BYTES = 24 * 1024;
const MAX_CANDIDATES_PER_FOLDER = 300;

const FETCH_HEADERS = [
  'auto-submitted', 'precedence', 'x-auto-response-suppress', 'x-autoreply', 'x-autorespond',
  'return-path', 'reply-to', 'references', 'in-reply-to', 'list-id', 'list-unsubscribe',
  'x-failed-recipients', 'content-type',
];

// ─── Small helpers ────────────────────────────────────────────────────────────

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stateKey(account, folder) {
  return `${account.email}|${folder}`;
}

function safeIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Which of our touches does this message thread back to? */
function touchFor(lead, ids) {
  const map = {
    [normId(lead.original_message_id)]: 'd0',
    [normId(lead.d3_message_id)]: 'd3',
    [normId(lead.d7_message_id)]: 'd7',
    [normId(lead.auto_reply_message_id)]: 'bot',
  };
  // A reply to the day-3 touch also references day 0 — credit the LATEST touch.
  const rank = { d0: 0, d3: 1, d7: 2, bot: 3 };
  let best = null;
  for (const id of ids) {
    const t = id && map[id];
    if (t && (best === null || rank[t] > rank[best])) best = t;
  }
  return best;
}

/** Latest touch that went out before `at` (fallback when no thread header). */
function touchByTime(lead, at) {
  const t = new Date(at).getTime();
  const touches = [
    ['bot', lead.auto_replied_at], ['d7', lead.d7_sent_at], ['d3', lead.d3_sent_at], ['d0', lead.sent_at],
  ];
  for (const [touch, ts] of touches) {
    if (ts && new Date(ts).getTime() <= t) return touch;
  }
  return lead.sent_at ? 'd0' : null;
}

function touchSentAt(lead, touch) {
  return { d0: lead.sent_at, d3: lead.d3_sent_at, d7: lead.d7_sent_at, bot: lead.auto_replied_at }[touch] || lead.sent_at || null;
}

function wasEmailed(lead) {
  const st = String(lead?.status || '');
  return Boolean(lead && (lead.account_used || lead.sent_at || st.startsWith('sent') || st === 'replied' || st === 'sequence_complete'));
}

// ─── IMAP scanning ────────────────────────────────────────────────────────────

/** Resolve INBOX + the spam folder for this server (special-use aware). */
async function resolveFolders(client, account) {
  const folders = ['INBOX'];
  let spam = null;
  try {
    const list = await client.list();
    const junk = list.find((f) => f.specialUse === '\\Junk');
    if (junk) spam = junk.path;
    else if (list.find((f) => f.path === account.spamFolder)) spam = account.spamFolder;
    else {
      const guess = list.find((f) => /^(\[gmail\]\/)?(spam|junk( e-?mail)?)$/i.test(f.path));
      if (guess) spam = guess.path;
    }
  } catch {
    spam = account.spamFolder || null;
  }
  if (spam && spam !== 'INBOX') folders.push(spam);
  return folders;
}

/** Turn one fetched message into our metadata object (no body yet). */
function describeMessage(msg, folder, account) {
  const env = msg.envelope || {};
  const headers = parseHeaders(msg.headers);
  const fromEmail = String(env.from?.[0]?.address || '').toLowerCase();
  const fromName = String(env.from?.[0]?.name || '').trim();
  const subject = String(env.subject || '');
  const inReplyToIds = splitIds([env.inReplyTo, headers['in-reply-to']]);
  const referenceIds = splitIds(headers['references']);
  const threadIds = [...new Set([...inReplyToIds, ...referenceIds])];
  const receivedAt = safeIso(msg.internalDate) || safeIso(env.date) || new Date().toISOString();
  const kind = classifyKind({
    headers,
    subject,
    from: fromEmail,
    contentType: String(msg.bodyStructure?.type || ''),
  });
  return {
    uid: msg.uid,
    emailId: msg.emailId || null,
    threadId: msg.threadId || null,
    seen: Boolean(msg.flags && msg.flags.has && msg.flags.has('\\Seen')),
    size: msg.size || null,
    from: fromEmail,
    fromName,
    replyTo: String(env.replyTo?.[0]?.address || '').toLowerCase() || null,
    to: (env.to || []).map((a) => String(a.address || '').toLowerCase()).filter(Boolean),
    cc: (env.cc || []).map((a) => String(a.address || '').toLowerCase()).filter(Boolean),
    subject,
    date: receivedAt,
    headerDate: safeIso(env.date),
    messageId: env.messageId || null,
    inReplyTo: inReplyToIds[0] ? `<${inReplyToIds[0]}>` : null,
    references: referenceIds,
    threadIds,
    kind,
    account: account.email,
    folder,
    bodyStructure: msg.bodyStructure || null,
    headers,
  };
}

/** Download + clean the text body of one message (already-selected mailbox). */
async function fetchBodyText(client, meta) {
  try {
    const part = findTextPart(meta.bodyStructure) || { part: 'TEXT', type: 'text/plain' };
    const { content } = await client.download(meta.uid, part.part, { uid: true, maxBytes: MAX_BODY_BYTES });
    let text = await readStream(content, MAX_BODY_BYTES);
    if (part.type === 'text/html') text = htmlToText(text);
    return text;
  } catch (err) {
    return '';
  }
}

/**
 * Scan one account: every folder, only UIDs newer than the watermark, then
 * look the senders / thread ids up in KV and download bodies for matches.
 */
async function scanAccount(account, ctx) {
  const started = Date.now();
  const result = {
    account: account.email,
    ok: false,
    folders: [],
    newMessages: 0,
    candidates: 0,
    matched: [],
    events: [],
    stateUpdates: {},
    error: null,
    ms: 0,
  };

  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: true,
    auth: { user: account.email, pass: account.appPassword },
    logger: false,
    disableAutoIdle: true,
    // Bound every phase: a hung IMAP socket otherwise stalls the whole
    // serverless invocation and kills the send heartbeat with it.
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 25000,
  });

  try {
    await client.connect();
    const folders = await resolveFolders(client, account);

    for (const folder of folders) {
      const folderResult = { folder, scanned: 0, skipped: false, error: null };
      result.folders.push(folderResult);
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch (err) {
        folderResult.error = err.mailboxMissing ? 'missing' : (err.message || String(err));
        continue;
      }
      try {
        const mb = client.mailbox || {};
        const key = stateKey(account, folder);
        const saved = ctx.uidState[key] || null;
        const uidValidity = mb.uidValidity !== undefined ? String(mb.uidValidity) : null;
        const fresh = !saved || !uidValidity || saved.uidValidity !== uidValidity;
        const lastUid = fresh ? 0 : Number(saved.lastUid) || 0;
        const uidNext = Number(mb.uidNext) || 0;

        if (!fresh && uidNext && uidNext - 1 <= lastUid) {
          folderResult.skipped = true;
          folderResult.lastUid = lastUid;
          continue; // nothing new in this folder — zero fetches
        }

        const range = fresh ? { since: new Date(Date.now() - FIRST_SCAN_MS) } : `${lastUid + 1}:*`;
        let maxUid = lastUid;
        const pending = [];
        for await (const msg of client.fetch(range, {
          uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true,
          size: true, threadId: true, headers: FETCH_HEADERS,
        }, { uid: true })) {
          // "N:*" with N above the highest UID still returns the last message.
          if (!fresh && msg.uid <= lastUid) continue;
          if (msg.uid > maxUid) maxUid = msg.uid;
          folderResult.scanned++;
          result.newMessages++;
          const meta = describeMessage(msg, folder, account);
          if (!meta.from || ctx.own.has(meta.from)) continue;  // our own sent copies
          if (meta.kind === 'bulk') continue;                     // newsletters / lists
          if (pending.length >= MAX_CANDIDATES_PER_FOLDER) continue;
          pending.push(meta);
        }

        // Match + download while THIS folder is still selected (a download
        // after switching folders would read the wrong mailbox).
        await matchPending(client, pending, ctx, account, result);

        folderResult.lastUid = maxUid;
        result.stateUpdates[key] = { uidValidity, lastUid: maxUid, updatedAt: new Date().toISOString(), folder };
      } catch (err) {
        folderResult.error = err.message || String(err);
      } finally {
        try { lock.release(); } catch {}
      }
    }

    result.ok = true;
  } catch (err) {
    result.error = `${err.code ? err.code + ': ' : ''}${err.message || String(err)}`;
  } finally {
    result.ms = Date.now() - started;
    try { await withDeadline(client.logout(), 2000, 'logout'); } catch { try { client.close(); } catch {} }
  }
  return result;
}

/** Match a folder's candidate messages against leads (batched KV) and read their bodies. */
async function matchPending(client, pending, ctx, account, result) {
  if (!pending.length) return;
  const own = ctx.own;
  const senders = [...new Set(pending.map((m) => m.from))];
  const ids = [...new Set(pending.flatMap((m) => m.threadIds))];
  const [leadsBySender, idOwners] = await Promise.all([
    getLeadsByEmail(senders),
    lookupMessageIds(ids, ctx),
  ]);
  const needLeads = new Set();
  for (const meta of pending) {
    const viaThread = meta.threadIds.map((id) => idOwners[id]).find(Boolean) || null;
    if (viaThread) needLeads.add(viaThread);
  }
  const threadLeads = needLeads.size ? await getLeadsByEmail([...needLeads]) : {};

  for (const meta of pending) {
    const viaThread = meta.threadIds.map((id) => idOwners[id]).find(Boolean) || null;
    let lead = viaThread ? threadLeads[viaThread] : null;
    let leadEmail = lead ? viaThread : null;
    let matchedBy = lead ? 'thread' : null;
    if (!lead) {
      const senderLead = leadsBySender[meta.from];
      if (senderLead && wasEmailed(senderLead)) {
        lead = senderLead; leadEmail = meta.from; matchedBy = 'sender';
      }
    }

    // Bounces: the DSN comes from mailer-daemon, so match on the failed address.
    if (meta.kind === 'dsn') {
      const text = await fetchBodyText(client, meta);
      const failed = extractBouncedAddress(text, own);
      const severity = dsnSeverity(text, meta.subject);
      result.events.push({ kind: 'dsn', severity, failed, subject: meta.subject, date: meta.date, account: account.email, folder: meta.folder, reason: bounceReason(text) });
      if (failed && severity === 'hard') {
        result.matched.push({ type: 'bounce', email: failed, reason: bounceReason(text), meta: { ...meta, bodyStructure: undefined, headers: undefined } });
      }
      continue;
    }

    if (!lead) continue;
    result.candidates++;

    const text = await fetchBodyText(client, meta);
    const clean = stripQuotedReply(text) || snippet(text, 600);
    const touch = touchFor(lead, meta.threadIds) || touchByTime(lead, meta.date);
    const reply = {
      ...meta,
      bodyStructure: undefined,
      headers: undefined,
      leadEmail,
      matchedBy,
      text: clean.slice(0, 2000),
      preview: snippet(clean || meta.subject, 200),
      rawPreview: snippet(text, 300),
      touch,
      campaign: campaignOf(lead),
      oooUntil: meta.kind === 'ooo' ? parseOooUntil(text, new Date(meta.date)) : null,
    };
    result.matched.push({ type: reply.kind === 'human' ? 'reply' : 'event', reply, lead });
  }
}

/** Resolve Message-IDs to lead emails through the persisted index. */
async function lookupMessageIds(ids, ctx) {
  const out = {};
  if (!ids.length) return out;
  const wanted = ids.filter((id) => !ctx.idIndex || !(id in ctx.idIndex));
  if (ctx.idIndex) for (const id of ids) if (ctx.idIndex[id]) out[id] = ctx.idIndex[id];
  if (!wanted.length) return out;
  try {
    for (let i = 0; i < wanted.length; i += 400) {
      const part = wanted.slice(i, i + 400);
      const res = await kv.hmget(MSGID_INDEX_KEY, ...part);
      for (const id of part) if (res && res[id]) out[id] = String(res[id]).toLowerCase();
    }
  } catch {}
  return out;
}

/**
 * Message-ID index: normalized id -> lead email. Written at send time by the
 * sender and the bot (leads-db.indexMessageIds); backfilled once from the
 * leads hash when empty so replies to emails sent before the index existed
 * still match.
 */
async function ensureMessageIdIndex() {
  try {
    const size = await kv.hlen(MSGID_INDEX_KEY);
    if (size > 0) return null;
  } catch { return null; }
  // One-time backfill: scan every lead and persist its ids.
  const all = await getLeadsMap();
  const entries = {};
  for (const [email, lead] of Object.entries(all)) {
    for (const id of [lead.original_message_id, lead.d3_message_id, lead.d7_message_id, lead.auto_reply_message_id]) {
      const n = normId(id);
      if (n) entries[n] = email.toLowerCase();
    }
  }
  const keys = Object.keys(entries);
  for (let i = 0; i < keys.length; i += 400) {
    const obj = {};
    for (const k of keys.slice(i, i + 400)) obj[k] = entries[k];
    try { await kv.hset(MSGID_INDEX_KEY, obj); } catch {}
  }
  return entries;
}

// ─── Recording ────────────────────────────────────────────────────────────────

function replyKey(reply) {
  return `${reply.leadEmail}:${normId(reply.messageId) || `uid${reply.uid}`}`;
}

async function alreadyRecorded(reply) {
  try {
    if (await kv.hexists(REPLIES_KEY, replyKey(reply))) return true;
    // Records written by the previous checker were keyed by envelope date.
    if (reply.headerDate && await kv.hexists(REPLIES_KEY, `${reply.leadEmail}:${reply.headerDate}`)) return true;
  } catch {}
  return false;
}

/** Record a human reply: lead fields, Replies tab, conversation, counters. */
async function recordHumanReply(reply, lead) {
  const isNewMessage = !(await alreadyRecorded(reply));
  const sentAt = touchSentAt(lead, reply.touch);
  let replyAt = reply.date;
  if (sentAt && new Date(replyAt).getTime() < new Date(sentAt).getTime()) replyAt = sentAt;
  const latencyMs = sentAt ? Math.max(0, new Date(replyAt).getTime() - new Date(sentAt).getTime()) : null;

  const updated = await patchLead(reply.leadEmail, (existing) => {
    const st = String(existing.status || '');
    const terminal = st === 'unsubscribed' || st === 'bounced';
    const firstAt = existing.first_replied_at || existing.replied_at || replyAt;
    const lastAt = existing.last_replied_at && existing.last_replied_at > replyAt ? existing.last_replied_at : replyAt;
    return {
      status: terminal ? st : 'replied',
      replied_at: firstAt,
      first_replied_at: firstAt,
      last_replied_at: lastAt,
      reply_count: (Number(existing.reply_count) || 0) + (isNewMessage ? 1 : 0),
      reply_kind: 'human',
      reply_subject: reply.subject,
      reply_preview: reply.preview,
      reply_text: reply.text,
      reply_account: reply.account,
      reply_folder: reply.folder || 'INBOX',
      reply_touch: reply.touch || existing.reply_touch || null,
      reply_latency_ms: existing.reply_latency_ms ?? latencyMs,
      reply_message_id: reply.messageId || null,
      reply_thread_id: reply.threadId || null,
      reply_from_name: reply.fromName || existing.reply_from_name || null,
      reply_cc: reply.cc && reply.cc.length ? reply.cc : (existing.reply_cc || null),
      reply_detected_at: existing.reply_detected_at || new Date().toISOString(),
      ...(reply.from !== reply.leadEmail ? { reply_from_address: reply.from } : {}),
      ...(!existing.first_name && reply.fromName && /^[A-Z][a-z'’-]{1,20}(\s|$)/.test(reply.fromName)
        ? { first_name_from_reply: reply.fromName.split(/\s+/)[0] } : {}),
    };
  });

  if (isNewMessage) {
    const p = kv.pipeline();
    p.hset(REPLIES_KEY, {
      [replyKey(reply)]: {
        from: reply.from,
        fromName: reply.fromName || null,
        company: lead.company || lead.company_name || 'Unknown',
        industry: lead.industry || 'Unknown',
        subject: reply.subject,
        preview: reply.preview,
        text: reply.text,
        date: replyAt,
        receivedAt: reply.date,
        account: reply.account,
        folder: reply.folder || 'INBOX',
        leadEmail: reply.leadEmail,
        campaign: reply.campaign,
        touch: reply.touch,
        latencyMs,
        kind: 'human',
        messageId: reply.messageId || null,
        threadId: reply.threadId || null,
        cc: reply.cc || [],
        matchedBy: reply.matchedBy,
        seen: reply.seen,
      },
    });
    p.hincrby('stats', 'totalReplied', 1);
    try { await p.exec(); } catch {}
    await appendConversation(reply, lead);
  }
  return { isNew: isNewMessage, lead: updated || lead, replyAt, latencyMs };
}

/** Conversation log: every inbound message once, keyed by Message-ID. */
async function appendConversation(reply, lead) {
  try {
    const existing = (await kv.hget(CONVERSATIONS_KEY, reply.leadEmail)) || null;
    const messages = existing?.messages || [];
    const id = normId(reply.messageId) || `uid${reply.uid}`;
    if (messages.some((m) => m && m.dir === 'in' && (m.id === id || m.ts === reply.headerDate))) return;
    // Any reply that arrives after the bot's message is an answer to it (people
    // often reply to the original thread rather than the bot's own message).
    const answersBot = reply.touch === 'bot'
      || Boolean(lead.auto_reply_message_id && reply.threadIds.includes(normId(lead.auto_reply_message_id)))
      || Boolean(lead.auto_replied_at && reply.date > lead.auto_replied_at);
    const entry = {
      email: reply.leadEmail,
      company: lead.company_name || lead.company || existing?.company || '',
      campaign: reply.campaign,
      messages: [...messages, { dir: 'in', id, subject: reply.subject, text: reply.text || reply.preview || '', ts: reply.date, touch: reply.touch, from: reply.from }],
      status: answersBot ? 'slot_answer' : (existing?.status === 'opted_out' ? 'opted_out' : (existing?.status || 'awaiting_human')),
      lastInboundAt: reply.date,
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(CONVERSATIONS_KEY, { [reply.leadEmail]: entry });
  } catch {}
}

/** Non-human inbound (OOO / auto-ack / receipts): log it, adjust the lead, never count it. */
async function recordEvent(reply, lead) {
  const event = {
    kind: reply.kind,
    leadEmail: reply.leadEmail,
    from: reply.from,
    subject: reply.subject,
    preview: reply.preview,
    date: reply.date,
    account: reply.account,
    folder: reply.folder,
    touch: reply.touch,
    oooUntil: reply.oooUntil || null,
  };
  try {
    const p = kv.pipeline();
    p.lpush(EVENTS_KEY, event);
    p.ltrim(EVENTS_KEY, 0, 999);
    await p.exec();
  } catch {}
  if (reply.kind === 'ooo') {
    // Pause follow-ups until they are back (default 5 business days when the
    // date can't be parsed); the sequence resumes automatically afterwards.
    const holdUntil = reply.oooUntil || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await patchLead(reply.leadEmail, {
      ooo_until: holdUntil,
      ooo_seen_at: reply.date,
      followup_hold_until: holdUntil,
      last_auto_response_at: reply.date,
      last_auto_response_kind: 'ooo',
    });
  } else if (reply.kind === 'auto_ack' || reply.kind === 'mdn') {
    await patchLead(reply.leadEmail, { last_auto_response_at: reply.date, last_auto_response_kind: reply.kind });
  }
  return event;
}

/** A hard bounce seen in the inbox: mark the lead bounced right away. */
async function recordBounce(item, own) {
  const email = String(item.email || '').toLowerCase();
  if (!email || own.has(email)) return null;
  const lead = (await getLeadsByEmail([email]))[email];
  if (!lead) return null;
  const st = String(lead.status || '');
  if (st === 'replied' || st === 'bounced' || st === 'unsubscribed') return null;
  if (!wasEmailed(lead)) return null;
  await markLeadBounced(email, item.reason, { source: 'reply-scan', account: item.meta.account });
  return { email, reason: item.reason, account: item.meta.account };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Check all accounts for replies and update the database.
 * @param {object} opts  { deadlineMs?: absolute timestamp the bot phase must finish by }
 */
export async function checkAllReplies(opts = {}) {
  const started = Date.now();
  const deadline = opts.deadlineMs || (started + 100 * 1000);
  const summary = {
    checked: 0,
    totalReplies: 0,      // matched inbound messages (human)
    matchedLeads: 0,      // NEW human replies this run
    newReplies: [],
    autoReplies: [],
    bounces: [],
    events: [],
    errors: [],
    perInbox: [],
    skipped: null,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  };

  const accounts = getSmtpAccounts();
  if (!accounts.length) {
    console.log('[reply-scan] NO SMTP accounts configured — env SMTP_ACCOUNT_1.. missing');
    return { ...summary, error: 'No SMTP accounts configured' };
  }

  // Run lock: the standalone route and the heartbeat piggyback must never scan
  // (and auto-reply) at the same time.
  const lockToken = `${started}-${Math.random().toString(36).slice(2)}`;
  try {
    const got = await kv.set(LOCK_KEY, lockToken, { nx: true, ex: LOCK_TTL_SECONDS });
    if (got !== 'OK') {
      summary.skipped = 'locked';
      summary.durationMs = Date.now() - started;
      return summary;
    }
  } catch {}

  try {
    const own = getOwnAddresses();
    let uidState = {};
    try { uidState = (await kv.hgetall(UID_STATE_KEY)) || {}; } catch {}
    const idIndex = await ensureMessageIdIndex(); // null unless just backfilled
    const ctx = { uidState, own, idIndex };

    // ── Scan every inbox in parallel, each under its own deadline ──
    const settled = await Promise.allSettled(
      accounts.map((account) => withDeadline(scanAccount(account, ctx), ACCOUNT_DEADLINE_MS, `IMAP ${account.email}`))
    );

    const matched = [];
    const bounceItems = [];
    const stateUpdates = {};
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const s = settled[i];
      summary.checked++;
      if (s.status !== 'fulfilled') {
        const message = s.reason?.message || String(s.reason);
        summary.errors.push({ account: account.email, error: message });
        summary.perInbox.push({ account: account.email, ok: false, error: message, host: account.imap.host });
        await recordImapResult(account.email, { ok: false, error: message });
        console.log(`[reply-scan] IMAP ERR ${account.email} via ${account.imap.host} :: ${message}`);
        continue;
      }
      const r = s.value;
      Object.assign(stateUpdates, r.stateUpdates);
      summary.perInbox.push({
        account: account.email,
        ok: r.ok,
        host: account.imap.host,
        folders: r.folders,
        newMessages: r.newMessages,
        candidates: r.candidates,
        matched: r.matched.filter((m) => m.type === 'reply').length,
        events: r.events.length + r.matched.filter((m) => m.type === 'event').length,
        ms: r.ms,
        error: r.error,
      });
      if (r.error) summary.errors.push({ account: account.email, error: r.error });
      for (const f of r.folders) if (f.error && f.error !== 'missing') summary.errors.push({ account: account.email, folder: f.folder, error: f.error });
      await recordImapResult(account.email, {
        ok: r.ok, error: r.error, ms: r.ms, newMessages: r.newMessages, candidates: r.candidates,
        folders: r.folders.map((f) => f.folder),
      });
      console.log(`[reply-scan] IMAP ${r.ok ? 'ok ' : 'ERR'} ${account.email} via ${account.imap.host} — new=${r.newMessages} candidates=${r.candidates} ms=${r.ms}${r.error ? ' :: ' + r.error : ''}`);
      for (const m of r.matched) {
        if (m.type === 'bounce') bounceItems.push(m);
        else matched.push(m);
      }
      summary.events.push(...r.events.filter((e) => e.kind !== 'dsn' || e.severity !== 'hard').slice(0, 50));
    }

    // ── Persist watermarks (only for folders that completed) ──
    if (Object.keys(stateUpdates).length) {
      try { await kv.hset(UID_STATE_KEY, stateUpdates); } catch (err) { summary.errors.push({ error: `watermark: ${err.message}` }); }
    }

    // ── Bounces seen in the inbox ──
    for (const item of bounceItems) {
      try {
        const b = await recordBounce(item, own);
        if (b) summary.bounces.push(b);
      } catch (err) {
        summary.errors.push({ email: item.email, error: `bounce: ${err.message}` });
      }
    }

    // ── Record replies / events (oldest first so first-reply timestamps are right) ──
    matched.sort((a, b) => new Date(a.reply.date) - new Date(b.reply.date));
    const forBot = [];
    for (const m of matched) {
      try {
        if (m.type === 'event') {
          await recordEvent(m.reply, m.lead);
          summary.events.push({ kind: m.reply.kind, leadEmail: m.reply.leadEmail, subject: m.reply.subject, date: m.reply.date, oooUntil: m.reply.oooUntil || null });
          continue;
        }
        summary.totalReplies++;
        const rec = await recordHumanReply(m.reply, m.lead);
        if (rec.isNew) {
          summary.matchedLeads++;
          summary.newReplies.push({
            from: m.reply.from,
            leadEmail: m.reply.leadEmail,
            company: m.lead.company || m.lead.company_name,
            campaign: m.reply.campaign,
            subject: m.reply.subject,
            preview: m.reply.preview,
            date: rec.replyAt,
            touch: m.reply.touch,
            latencyMs: rec.latencyMs,
            account: m.reply.account,
            folder: m.reply.folder,
            matchedBy: m.reply.matchedBy,
          });
          forBot.push({ reply: m.reply, leadEmail: m.reply.leadEmail });
        }
      } catch (err) {
        summary.errors.push({ email: m.reply.leadEmail, error: `record: ${err.message}` });
      }
    }

    // ── Auto-reply bot: queued first (from a previous run that ran out of
    //    time), then this run's new replies, within the remaining budget. ──
    let queued = {};
    try { queued = (await kv.hgetall(PENDING_BOT_KEY)) || {}; } catch {}
    const botWork = [
      ...Object.values(queued).filter((r) => r && r.leadEmail).map((r) => ({ reply: r, leadEmail: r.leadEmail, queued: true })),
      ...forBot,
    ];
    for (const work of botWork) {
      if (Date.now() > deadline - 12000) {
        // Out of time: park it for the next run instead of dropping it.
        try { await kv.hset(PENDING_BOT_KEY, { [work.leadEmail]: work.reply }); } catch {}
        summary.autoReplies.push({ to: work.leadEmail, skipped: 'deferred_no_time' });
        continue;
      }
      try {
        const lead = (await getLeadsByEmail([work.leadEmail]))[work.leadEmail];
        if (!lead) { try { await kv.hdel(PENDING_BOT_KEY, work.leadEmail); } catch {} continue; }
        const autoResult = await maybeAutoReply(work.reply, lead);
        summary.autoReplies.push({ to: work.leadEmail, ...autoResult });
        if (autoResult && autoResult.retry) {
          try { await kv.hset(PENDING_BOT_KEY, { [work.leadEmail]: work.reply }); } catch {}
        } else {
          try { await kv.hdel(PENDING_BOT_KEY, work.leadEmail); } catch {}
        }
      } catch (err) {
        summary.autoReplies.push({ to: work.leadEmail, skipped: `error: ${err.message}` });
        try { await kv.hdel(PENDING_BOT_KEY, work.leadEmail); } catch {}
      }
    }
  } catch (err) {
    summary.errors.push({ error: err.message || String(err) });
  } finally {
    summary.durationMs = Date.now() - started;
    // Durable run record (also what the heartbeat's throttle reads).
    try {
      await kv.set(LAST_RUN_KEY, {
        ts: Date.now(),
        at: new Date().toISOString(),
        durationMs: summary.durationMs,
        checked: summary.checked,
        newReplies: summary.matchedLeads,
        autoReplies: summary.autoReplies.filter((a) => a.sent).length,
        bounces: summary.bounces.length,
        events: summary.events.length,
        errors: summary.errors.length,
        perInbox: summary.perInbox,
        lastErrors: summary.errors.slice(0, 5),
      });
    } catch {}
    // Release the lock only if it is still ours.
    try {
      await kv.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
        [LOCK_KEY],
        [lockToken]
      );
    } catch {}
  }

  console.log(`[reply-scan] done checked=${summary.checked} human=${summary.totalReplies} new=${summary.matchedLeads} bounces=${summary.bounces.length} events=${summary.events.length} errors=${summary.errors.length} ms=${summary.durationMs}`);
  return summary;
}

/** Get all replies from the database (for the dashboard). */
export async function getAllReplies() {
  return getAllRepliesFromDb();
}

/** Last run record (for the Inboxes API / diagnostics). */
export async function getLastReplyCheck() {
  try {
    const v = await kv.get(LAST_RUN_KEY);
    if (!v) return null;
    if (typeof v === 'number') return { ts: v, at: new Date(v).toISOString() };
    return v;
  } catch {
    return null;
  }
}
