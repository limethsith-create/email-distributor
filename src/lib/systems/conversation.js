/**
 * One conversation per client (docs/REPLYBOT-MEET.md §1) — the owner's words:
 * "a place inside each of the people where I can see the messages between us".
 *
 * The list is the onboarding call's thread (client:{id}:onboardthread — the
 * key is kept, old entries stay valid): every email the machine sends to the
 * client's contact (any notifyClient template → kind 'system', the onboarding
 * and calendar emails, the owner's replies, the reply bot's answers) and every
 * email from them found in the ONBOARDCALL inbox, oldest first, the 200 newest
 * kept. `onboardCall.thread` in the hub is the same list.
 *
 * Beside it, client:{id}:convo (hash) keeps what a reply and the reply bot
 * need for ANY client, with or without an onboarding call:
 *   lastInAt, lastInMessageId, lastInSubject  their last message (threading)
 *   messageIds (JSON)                         every Message-ID we know of (References)
 *   lastAnswerAt                              the owner's or the bot's last answer
 *   botOff ('1')                              the owner's per-client switch
 *   botPending (JSON), botDay, botCount       the reply bot (systems/replybot.js)
 * and the client hash carries `msgWaitingAt` (their newest message still
 * without an answer) so a board row knows "answer them" without reading the
 * list — `needsReplyFor` is the one rule both use.
 *
 * Pure parts (entryView, needsReplyFor, conversationView) are unit-tested; the
 * rest is small reads and writes. No AI anywhere.
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { logEvent } from '@/lib/db/events';
import { normId } from '@/lib/mail-utils';
import { io, asArray, asObject } from '@/lib/systems/intake-io';
import { shortHash, lower } from '@/lib/systems/stagec-common';

export const THREAD_CAP = 200;
export const TEXT_MAX = 4000;
/** Kinds of entry (docs/REPLYBOT-MEET.md §1). */
export const KINDS = new Set(['acceptance', 'reminder', 'reply', 'owner_reply', 'booking', 'auto_reply', 'system']);

// ─── small helpers ───────────────────────────────────────────────────────────

const ms = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const isoOrNull = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const flag = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0';

/** '<Id@host>' as sent — Message-IDs keep their case in headers; only comparisons use normId. */
export const bracket = (id) => `<${String(id || '').trim().replace(/^<|>$/g, '').trim()}>`;

/** Every Message-ID in `list` plus `id`, oldest first (last 30), one copy each, bracketed. */
export function withId(list, id) {
  const seen = new Set();
  const out = [];
  for (const x of [...asArray(list), ...(id ? [id] : [])]) {
    const k = normId(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(bracket(x));
  }
  return out.slice(-30);
}

/** 'Re: Fwd: Re: Hello' → 'Hello' (our follow-ups add one 'Re: ' back). */
export const stripRe = (subject) => String(subject || '').replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

// ─── the list ────────────────────────────────────────────────────────────────

export async function readThread(clientId) {
  return ((await kv.lrange(K.onboardThread(clientId), 0, -1)) || []).map(asObject).filter(Boolean);
}

/** Append one entry (text cut to 4 000 characters), keep the 200 newest. */
export async function pushEntry(clientId, entry) {
  await kv.rpush(K.onboardThread(clientId), { ...entry, text: String(entry.text || '').slice(0, TEXT_MAX) });
  await kv.ltrim(K.onboardThread(clientId), -THREAD_CAP, -1);
}

/**
 * An entry as the hub gets it (old entries have no auto / rule / template).
 * `rule` on an `in` entry is what the reply bot read in it; on an `out` entry
 * with `auto` it is the rule the bot answered.
 */
export function entryView(t) {
  const e = asObject(t);
  if (!e) return null;
  const dir = e.dir === 'in' ? 'in' : 'out';
  const kind = KINDS.has(e.kind) ? e.kind : dir === 'in' ? 'reply' : 'owner_reply';
  return {
    id: String(e.id || ''), dir, at: isoOrNull(e.at), from: e.from || null, to: e.to || null, subject: e.subject || '',
    text: String(e.text || '').slice(0, TEXT_MAX), kind,
    auto: e.auto === true || e.auto === 'true',
    rule: e.rule || null,
    template: kind === 'system' ? e.template || null : null,
  };
}

// ─── the convo hash ──────────────────────────────────────────────────────────

export async function readConvo(clientId) {
  return (await kv.hgetall(K.convo(clientId))) || {};
}

/** hset the values, hdel the nulls. */
export async function patchConvo(clientId, fields) {
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
  const del = Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k);
  if (Object.keys(set).length) await kv.hset(K.convo(clientId), set);
  if (del.length) await kv.hdel(K.convo(clientId), ...del);
}

/**
 * A message from them was added to the list. `needsAnswer` false for a
 * thank-you the bot read as one (nothing to answer). A message dated before
 * the last answer (the inbox was read late) is already answered.
 */
export async function noteInbound(clientId, { at, messageId = null, subject = '', needsAnswer = true } = {}) {
  const c = await readConvo(clientId);
  const fields = {
    lastInAt: ms(c.lastInAt) > ms(at) ? c.lastInAt : at,
    lastInSubject: subject || c.lastInSubject || null,
    ...(messageId ? { lastInMessageId: bracket(messageId), messageIds: JSON.stringify(withId(c.messageIds, messageId)) } : {}),
  };
  await patchConvo(clientId, fields);
  if (needsAnswer && !(ms(c.lastAnswerAt) >= ms(at))) {
    // Their newest message waiting for an answer (cleared by the next answer).
    const waiting = await kv.hget(K.client(clientId), 'msgWaitingAt');
    if (!(ms(waiting) >= ms(at))) await kv.hset(K.client(clientId), { msgWaitingAt: at });
  }
}

/** The owner or the bot answered them (or a thank-you needs nothing): nothing of theirs waits any more. */
export async function noteAnswered(clientId, at, { messageId = null } = {}) {
  const c = await readConvo(clientId);
  await patchConvo(clientId, {
    lastAnswerAt: ms(c.lastAnswerAt) > ms(at) ? c.lastAnswerAt : at,
    ...(messageId ? { messageIds: JSON.stringify(withId(c.messageIds, messageId)) } : {}),
  });
  await kv.hdel(K.client(clientId), 'msgWaitingAt');
}

/**
 * notifyClient's hook: an email that went to the client's contact becomes an
 * `out` entry (kind 'system' + the template key, unless the caller says what
 * it is). Never throws — the email already went.
 */
export async function logClientEmail(clientId, key, res, { kind = 'system', auto = false, rule = null } = {}) {
  try {
    assertClientId(clientId);
    const at = io.now().toISOString();
    await pushEntry(clientId, {
      id: `out-${shortHash(res?.messageId || `${at}|${key}`)}`, dir: 'out', at, from: res?.from || null, to: lower(res?.to) || null,
      subject: res?.subject || '', text: res?.text || '', kind: KINDS.has(kind) ? kind : 'system',
      ...(auto ? { auto: true, rule } : {}), ...(kind === 'system' ? { template: key } : {}),
    });
    if (res?.messageId) {
      const c = await readConvo(clientId);
      await patchConvo(clientId, { messageIds: JSON.stringify(withId(c.messageIds, res.messageId)) });
    }
  } catch (err) {
    await logEvent(clientId, 'conversation', 'log_failed', { key, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
  }
}

// ─── the hub's `conversation` (pure) ─────────────────────────────────────────

/**
 * Their last message has no answer yet (the ONE rule for the hub's
 * `conversation.needsReply`, the board row's `simple.needsReply` and the
 * "answer them" to-do), pure:
 *  - `client.msgWaitingAt` — their newest message that needs an answer (a
 *    thank-you the bot read as one does not); the owner's reply, the bot's
 *    answer or the calendar confirming the time they wrote clear it — and it
 *    is still answered by a later booking of the onboarding call, as the
 *    onboarding card has always counted it;
 *  - or, during the onboarding call, the call's own rule (replies recorded
 *    before this conversation existed).
 */
export function needsReplyFor(client = {}, call = {}) {
  const c = client || {};
  const r = call || {};
  const answered = Math.max(ms(r.lastAnsweredAt) || 0, ms(r.lastOwnerReplyAt) || 0, ms(r.bookedAt) || 0);
  const waiting = ms(c.msgWaitingAt);
  if (waiting != null && waiting > answered) return true;
  const last = ms(r.lastReplyAt);
  return last != null && !flag(r.heldAt) && !flag(r.noShowAt) && last > answered;
}

/** Their newest message (kind reply) and our newest email. */
function lastTimes(thread) {
  let lastIn = null;
  let lastOut = null;
  for (const e of thread) {
    const t = ms(e.at);
    if (t == null) continue;
    if (e.dir === 'in' && e.kind === 'reply') lastIn = Math.max(lastIn || 0, t);
    if (e.dir === 'out') lastOut = Math.max(lastOut || 0, t);
  }
  return { lastInAt: lastIn == null ? null : new Date(lastIn).toISOString(), lastOutAt: lastOut == null ? null : new Date(lastOut).toISOString() };
}

/**
 * The hub's `conversation` (docs/REPLYBOT-MEET.md §1), pure.
 *  thread    the stored list
 *  client    the client hash (msgWaitingAt)
 *  convo     the client:{id}:convo hash
 *  call      the onboarding-call hash (its bookings and answers count as answers)
 *  bot       { enabled (everyone), maxPerDay, answersNow, why } from systems/replybot.js
 *  sender    { email } of the inbox replies go from, or null
 */
export function conversationView({ thread = [], client = {}, convo = {}, call = {}, bot = {}, sender = null, dayKey = null } = {}) {
  const entries = (thread || []).map(entryView).filter(Boolean);
  const clientOff = flag(convo.botOff);
  const pending = asObject(convo.botPending);
  const sentToday = dayKey && convo.botDay === dayKey ? Number(convo.botCount) || 0 : 0;
  return {
    thread: entries,
    needsReply: needsReplyFor(client, call),
    ...lastTimes(entries),
    bot: {
      enabled: Boolean(bot.enabled) && !clientOff,
      sentToday,
      maxPerDay: Number(bot.maxPerDay) || 0,
      // Additions: the two switches apart, whether it can answer this client now, and an answer waiting to go.
      everyone: Boolean(bot.enabled),
      forClient: !clientOff,
      answersNow: Boolean(bot.enabled) && !clientOff && Boolean(bot.answersNow),
      why: bot.why || (clientOff ? 'You turned the reply bot off for this client.' : null),
      pending: pending ? { rule: pending.rule || null, messageAt: isoOrNull(pending.at), answerAfter: isoOrNull(pending.after) } : null,
    },
    canReply: Boolean(sender && sender.email),
    fromInbox: sender?.email || null,
  };
}

// ─── the owner's reply to any client ─────────────────────────────────────────

export class MessagesError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const REPLY_MAX = 2000;

/**
 * The owner's reply from the hub, for ANY client (docs/REPLYBOT-MEET.md §1).
 * With an onboarding conversation it is the onboarding card's reply (same
 * inbox, same thread). Otherwise it goes from the ONBOARDCALL inbox too,
 * In-Reply-To their last message (else our last email), References every
 * Message-ID we know, "Re: " their last subject — and shows as owner_reply.
 */
export async function ownerMessage(clientId, text, { now = io.now() } = {}) {
  const call = await import('@/lib/systems/onboardcall');
  const raw = await call.readCall(clientId);
  if (flag(raw.sentAt)) return call.ownerReply(clientId, text, { now });
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new MessagesError('Write the reply first.');
  if (body.length > REPLY_MAX) throw new MessagesError(`Keep the reply under ${REPLY_MAX.toLocaleString('en-US')} characters (it has ${body.length.toLocaleString('en-US')}).`);
  const { getClient } = await import('@/lib/db/client');
  const client = await getClient(clientId);
  if (!client) throw new MessagesError('not found', 404);
  if (!client.contactEmail) throw new MessagesError('They have no email address on file.', 409);
  const claim = await kv.set(K.onceClaim('onboard_reply', clientId, shortHash(body)), now.toISOString(), { nx: true, ex: 120 });
  if (claim !== 'OK') return { duplicate: true };
  const { sendClient, ownerName } = await import('@/lib/systems/intake-io');
  const c = await readConvo(clientId);
  const thread = await readThread(clientId);
  const lastOut = [...thread].reverse().find((e) => e.dir === 'out' && e.subject);
  const ids = asArray(c.messageIds).map(bracket);
  const inReplyTo = c.lastInMessageId ? bracket(c.lastInMessageId) : ids[ids.length - 1] || null;
  const vars = { threadSubject: stripRe(c.lastInSubject) || stripRe(lastOut?.subject) || 'Your trial', text: call.withSignOff(body, await ownerName(clientId)) };
  let res;
  try {
    res = await sendClient(clientId, 'onboard_owner_reply', vars, { dedupe: null, thread: false, ...(inReplyTo ? { inReplyTo, references: ids.length ? ids : [inReplyTo] } : {}) });
  } catch (err) {
    await kv.del(K.onceClaim('onboard_reply', clientId, shortHash(body)));
    throw err;
  }
  const at = now.toISOString();
  await pushEntry(clientId, { id: `out-${shortHash(res.messageId || `${at}|owner`)}`, dir: 'out', at, from: res.from || null, to: lower(client.contactEmail), subject: res.subject || `Re: ${vars.threadSubject}`, text: res.text || vars.text, kind: 'owner_reply' });
  await noteAnswered(clientId, at, { messageId: res.messageId || null });
  const { dropPending } = await import('@/lib/systems/replybot');
  await dropPending(clientId);
  await logEvent(clientId, 'conversation', 'owner_replied', { chars: body.length });
  return { sent: true };
}

/** GET /api/mc/clients/{id}/messages → the conversation (null for an unknown client). */
export async function conversationFor(clientId, { now = io.now(), client = null } = {}) {
  const { getClient } = await import('@/lib/db/client');
  const c = client || await getClient(clientId);
  if (!c) return null;
  const { botViewFor } = await import('@/lib/systems/replybot');
  const { readCall } = await import('@/lib/systems/onboardcall');
  const { onboardSender } = await import('@/lib/notify');
  const [thread, convo, call] = await Promise.all([readThread(clientId), readConvo(clientId), readCall(clientId)]);
  let sender = null;
  try { sender = await onboardSender(); } catch { sender = null; }
  const bot = await botViewFor(c, call, { now });
  return conversationView({ thread, client: c, convo, call, bot, sender, dayKey: bot.dayKey });
}

/**
 * POST /api/mc/clients/{id}/messages:
 *   { action: 'reply', text }  → the owner's reply (any client)
 *   { action: 'botOff' } / { action: 'botOn' }  → the reply bot for THIS client
 * → { ok, conversation }
 */
export async function messagesAction(clientId, body = {}, { now = io.now() } = {}) {
  assertClientId(clientId);
  const { getClient } = await import('@/lib/db/client');
  const client = await getClient(clientId);
  if (!client) throw new MessagesError('not found', 404);
  switch (body.action) {
    case 'reply': await ownerMessage(clientId, body.text, { now }); break;
    case 'botOff': {
      await patchConvo(clientId, { botOff: '1' });
      // An answer the bot was waiting to send is now the owner's (he is looking at it).
      const { dropPending } = await import('@/lib/systems/replybot');
      await dropPending(clientId);
      await logEvent(clientId, 'conversation', 'bot_off', {});
      break;
    }
    case 'botOn':
      await patchConvo(clientId, { botOff: null });
      await logEvent(clientId, 'conversation', 'bot_on', {});
      break;
    default: throw new MessagesError('Unknown action — use reply, botOn or botOff.');
  }
  return { ok: true, conversation: await conversationFor(clientId, { now }) };
}
