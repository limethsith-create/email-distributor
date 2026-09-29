/**
 * A client's email log and prospect conversations for the hub
 * (docs/HUB-API.md "Emails and conversations").
 *
 * What went out for a client, read from what the machine already keeps:
 *   - the lead records (client:{id}:leads): every cold touch's time, subject,
 *     inbox, and whether it bounced or got a reply;
 *   - client:{id}:mailtext (hash, new): `{leadEmail}|{touch}` → the text of
 *     that cold email as sent (≤ 4 000 characters) — one HSET in the
 *     sender's existing pipeline per send;
 *   - client:{id}:prospectmail (hash, new): leadEmail → the machine's own
 *     answers to that prospect ([{at, key, subject, from, to, text}], ≤ 10);
 *   - client:{id}:replies: each prospect reply (text ≤ 2 000 characters);
 *   - client:{id}:onboardthread: the client ↔ owner conversation (what went
 *     to the client).
 * Emails sent before the texts were kept show their subject and a note.
 *
 * Redis: nothing here runs in a tick; only a hub view reads. The list is 11
 * commands (the client, 6 lead index sets in one pipeline, the leads that
 * were written to, replies, machine answers, the conversation); a thread
 * about 9 (the client, the lead, its texts, its answers, replies, hot leads,
 * the sender name, the inboxes, the conversation when it was handed over).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import crypto from 'node:crypto';
import { getClient } from '@/lib/db/client';
import { cfg } from '@/lib/config';

export const TEXT_MAX = 4000;
const PROSPECT_MAX = 10;
const TOUCHES = [
  ['d0', 'sent_at', 'original_subject'],
  ['d3', 'd3_sent_at', 'd3_subject'],
  ['d7', 'd7_sent_at', 'd7_subject'],
  ['d10', 'd10_sent_at', 'd10_subject'],
];
const SENT_STATUSES = ['in_sequence', 'replied', 'bounced', 'suppressed', 'notnow', 'done'];
export const NOT_STORED = '(This email went out before the machine kept email texts, so only its subject is known.)';
const lower = (s) => String(s || '').trim().toLowerCase();
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
const iso = (t) => new Date(t).toISOString();

function asRec(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const o = JSON.parse(v); return Array.isArray(o) ? o : []; } catch { return []; } }
  return [];
}

// ─── writing (sender.js, outbound.js) ────────────────────────────────────────

/** The field of one cold email's text. */
export const textField = (leadEmail, touch) => `${lower(leadEmail)}|${touch}`;

/** Add "keep this cold email's text" to a pipeline the sender already runs. */
export function keepColdText(pipeline, clientId, leadEmail, touch, text) {
  pipeline.hset(K.mailText(clientId), { [textField(leadEmail, touch)]: String(text || '').slice(0, TEXT_MAX) });
}

/** Keep one of the machine's own answers to a prospect (never throws). */
export async function keepProspectMail(clientId, leadEmail, entry) {
  const email = lower(leadEmail);
  if (!email) return;
  try {
    const list = asList(await kv.hget(K.prospectMail(clientId), email));
    list.push({ at: entry.at, key: entry.key || null, subject: entry.subject || '', from: entry.from || null, to: email, text: String(entry.text || '').slice(0, TEXT_MAX) });
    await kv.hset(K.prospectMail(clientId), { [email]: JSON.stringify(list.slice(-PROSPECT_MAX)) });
  } catch { /* the email went; only its copy for the hub is missing */ }
}

// ─── thread ids ──────────────────────────────────────────────────────────────

/** A prospect's thread id: their address in URL-safe base64 (no lookup needed to find the lead). */
export const threadIdOf = (leadEmail) => Buffer.from(lower(leadEmail), 'utf8').toString('base64url');
export function emailOfThread(threadId) {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{4,400}$/.test(threadId)) return null;
  const email = Buffer.from(threadId, 'base64url').toString('utf8');
  return /^[^\s@|]+@[^\s@|]+$/.test(email) && threadIdOf(email) === threadId ? email : null;
}

// ─── shared pieces ───────────────────────────────────────────────────────────

const nameOf = (lead) => lead?.name || [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null;
const companyOf = (lead) => lead?.company || lead?.company_name || null;
const leadView = (lead, email) => ({ email: lead?.email || email, name: nameOf(lead), company: companyOf(lead) });

/** The cold touches that went to a lead, oldest first: [{touch, at, subject}]. */
function touchesOf(lead) {
  return TOUCHES.map(([touch, atF, subjF]) => ({ touch, at: lead[atF], subject: lead[subjF] || (touch === 'd0' ? '' : lead.original_subject ? `Re: ${String(lead.original_subject).replace(/^\s*re:\s*/i, '')}` : '') }))
    .filter((t) => ms(t.at) > 0);
}

/** Their reply kinds as the hub names them. */
export function replyKind(rec) {
  const k = rec?.kind;
  if (k === 'no') return /^(unsubscribe|stop|remove|opt out|opt-out)$/.test(String(rec.rule || '')) ? 'unsubscribe' : 'not_interested';
  return ({ notnow: 'not_now', ooo: 'out_of_office', wrongperson: 'referral' })[k] || k || 'unclear';
}

async function leadsByEmail(clientId, emails) {
  const out = new Map();
  const list = [...new Set(emails.map(lower).filter(Boolean))];
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const res = (await kv.hmget(K.leads(clientId), ...part)) || {};
    part.forEach((e, j) => { const r = asRec(Array.isArray(res) ? res[j] : res[e]); if (r) out.set(e, r); });
  }
  return out;
}

async function repliesOf(clientId) {
  const raw = (await kv.hgetall(K.replies(clientId))) || {};
  return Object.entries(raw).map(([id, v]) => { const r = asRec(v); return r ? { id, ...r } : null; }).filter((r) => r && r.leadEmail);
}

async function prospectMailOf(clientId) {
  const raw = (await kv.hgetall(K.prospectMail(clientId))) || {};
  return new Map(Object.entries(raw).map(([email, v]) => [lower(email), asList(v)]));
}

// ─── GET /api/mc/hub/{id}/emails ─────────────────────────────────────────────

const KINDS = new Set(['first', 'followup', 'bot', 'owner', 'client']);

/**
 * Every email that went out for the client, newest first, paged by time.
 * → { total, sent: [{ id, at, to, toName, company, subject, from, kind, status, threadId }], next } | null (no client).
 */
export async function emailsFor(clientId, { limit = 200, before = null, kind = null } = {}) {
  const client = await getClient(clientId);
  if (!client) return null;
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 500);
  const beforeMs = before ? ms(before) : 0;
  if (before && !beforeMs) throw Object.assign(new Error('before must be an ISO time'), { status: 400 });
  const want = kind && KINDS.has(kind) ? kind : null;

  const p = kv.pipeline();
  for (const s of SENT_STATUSES) p.smembers(K.leadIndex(clientId, s));
  const sets = await p.exec();
  const leads = await leadsByEmail(clientId, sets.flatMap((x) => (Array.isArray(x) ? x : [])));
  const [replies, answers, convo] = await Promise.all([
    repliesOf(clientId),
    prospectMailOf(clientId),
    kv.lrange(K.onboardThread(clientId), 0, -1).then((l) => (l || []).map(asRec).filter(Boolean)).catch(() => []),
  ]);
  const firstReply = new Map();
  for (const r of replies) {
    if (r.kind === 'bounce' || r.kind === 'ooo') continue;
    const e = lower(r.leadEmail);
    const t = ms(r.receivedAt || r.handledAt);
    if (t && (!firstReply.has(e) || t < firstReply.get(e))) firstReply.set(e, t);
  }

  const all = [];
  for (const [email, lead] of leads) {
    const touches = touchesOf(lead);
    const tid = threadIdOf(email);
    const base = { to: email, toName: nameOf(lead), company: companyOf(lead), from: lead.account_used || null, threadId: tid };
    const bounced = lead.status === 'bounced' ? ms(lead.bouncedAt) || Infinity : 0;
    const replied = firstReply.get(email) || (lead.replied_at ? ms(lead.replied_at) : 0);
    const lastBefore = (t) => touches.filter((x) => ms(x.at) <= t).at(-1)?.touch || null;
    const bouncedTouch = bounced && lead.bounceSource !== 'smtp-reject' ? lastBefore(bounced) : null;
    const repliedTouch = replied ? lastBefore(replied) : null;
    for (const t of touches) {
      const status = t.touch === bouncedTouch ? 'bounced' : t.touch === repliedTouch ? 'replied' : 'sent';
      all.push({ id: `${tid}.${t.touch}`, at: iso(ms(t.at)), ...base, subject: t.subject || '', kind: t.touch === 'd0' ? 'first' : 'followup', status });
    }
    // An email the receiving server refused (never delivered): a bounce at send time, or a failed send.
    const next = TOUCHES[touches.length]?.[0] || null;
    const reSubject = lead.original_subject ? `Re: ${String(lead.original_subject).replace(/^\s*re:\s*/i, '')}` : '';
    if (bounced && bounced !== Infinity && lead.bounceSource === 'smtp-reject' && next) {
      all.push({ id: `${tid}.${next}`, at: iso(bounced), ...base, subject: next === 'd0' ? '' : reSubject, kind: next === 'd0' ? 'first' : 'followup', status: 'bounced' });
    } else if (next && lead.last_error_at && ms(lead.last_error_at) > ms(lead.last_touch_at || lead.sent_at) && lead.status !== 'bounced') {
      all.push({ id: `${tid}.${next}.failed`, at: iso(ms(lead.last_error_at)), ...base, subject: next === 'd0' ? '' : reSubject, kind: next === 'd0' ? 'first' : 'followup', status: 'failed' });
    }
  }
  for (const [email, list] of answers) {
    const lead = leads.get(email) || null;
    const tid = threadIdOf(email);
    list.forEach((m, i) => {
      if (!ms(m.at)) return;
      all.push({ id: `${tid}.b${i}`, at: iso(ms(m.at)), to: email, toName: nameOf(lead), company: companyOf(lead), subject: m.subject || '', from: m.from || lead?.account_used || null, kind: 'bot', status: 'sent', threadId: tid });
    });
  }
  for (const e of convo) {
    if (e.dir !== 'out' || !ms(e.at)) continue;
    all.push({
      id: `c.${String(e.id || ms(e.at)).replace(/[^A-Za-z0-9_-]/g, '')}`, at: iso(ms(e.at)), to: e.to || client.contactEmail || null, toName: client.contactName || null, company: client.name || null,
      subject: e.subject || '', from: e.from || null, kind: e.kind === 'owner_reply' ? 'owner' : e.kind === 'auto_reply' ? 'bot' : 'client', status: 'sent', threadId: CLIENT_THREAD,
    });
  }

  const pool = (want ? all.filter((x) => x.kind === want) : all).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const rest = beforeMs ? pool.filter((x) => ms(x.at) < beforeMs) : pool;
  let page = rest.slice(0, max);
  let next = null;
  if (rest.length > max) {
    // Never split emails of the same second across pages: `before` is exclusive.
    const cut = rest[max].at;
    const trimmed = page.filter((x) => x.at !== cut);
    if (trimmed.length) page = trimmed;
    else page = rest.filter((x) => x.at === cut);
    next = rest.length > page.length ? page.at(-1).at : null;
  }
  return { total: pool.length, sent: page, next };
}

// ─── GET /api/mc/hub/{id}/threads ────────────────────────────────────────────

async function hotOf(clientId) {
  const raw = (await kv.hgetall(K.hot(clientId))) || {};
  return Object.entries(raw).map(([id, v]) => { const r = asRec(v); return r ? { id, ...r } : null; }).filter((r) => r && r.leadEmail);
}

function handledByOf(recs, answers, hot, client) {
  const last = recs.at(-1);
  if (client?.legalHoldReply && recs.some((r) => r.id === client.legalHoldReply)) return 'owner';
  if (['legal', 'angry'].includes(last.kind)) return 'owner';
  if (hot.length || recs.some((r) => r.forwardedToClientAt)) return 'client';
  const firstAt = ms(recs[0].receivedAt || recs[0].handledAt);
  if (answers.some((m) => ms(m.at) >= firstAt)) return 'bot';
  return null;
}

/** The times of every message in a prospect's conversation (the same ones threadFor shows). */
function threadTimes(lead, recs, answers, hot) {
  return [
    ...(lead ? touchesOf(lead).map((t) => ms(t.at)) : []),
    ...recs.map((r) => ms(r.receivedAt || r.handledAt)),
    ...answers.map((m) => ms(m.at)),
    ...hot.flatMap((h) => [ms(h.sentAt), ms(h.answeredAt)]),
  ].filter(Boolean);
}

/**
 * One row per prospect who wrote back, newest first.
 * → { threads: [{ threadId, lead: {email, name, company}, lastAt, count, kind, handledBy, snippet }] } | null (no client).
 */
export async function threadsFor(clientId) {
  const client = await getClient(clientId);
  if (!client) return null;
  const [replies, answers, hotAll] = await Promise.all([repliesOf(clientId), prospectMailOf(clientId), hotOf(clientId)]);
  const byLead = new Map();
  for (const r of replies) {
    const e = lower(r.leadEmail);
    if (!byLead.has(e)) byLead.set(e, []);
    byLead.get(e).push(r);
  }
  const leads = await leadsByEmail(clientId, [...byLead.keys()]);
  const threads = [];
  for (const [email, recsRaw] of byLead) {
    const recs = recsRaw.sort((a, b) => ms(a.receivedAt || a.handledAt) - ms(b.receivedAt || b.handledAt));
    const lead = leads.get(email) || null;
    const mine = answers.get(email) || [];
    const hot = hotAll.filter((h) => lower(h.leadEmail) === email);
    const times = threadTimes(lead, recs, mine, hot);
    const last = recs.at(-1);
    threads.push({
      threadId: threadIdOf(email),
      lead: leadView(lead, email),
      lastAt: times.length ? iso(Math.max(...times)) : null,
      count: times.length,
      kind: replyKind(last),
      handledBy: handledByOf(recs, mine, hot, client),
      snippet: String(last.snippet || last.text || '').slice(0, 200),
    });
  }
  threads.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')) || a.threadId.localeCompare(b.threadId));
  return { threads };
}

// ─── GET /api/mc/hub/{id}/threads/{threadId} ─────────────────────────────────

/** The thread id of the client ↔ owner conversation (the onboarding Gmail; also in GET /api/mc/hub/{id} → conversation). */
export const CLIENT_THREAD = 'client';
const addr = (name, email) => (email ? (name ? `${String(name).replace(/[<>"]/g, '')} <${email}>` : email) : null);
const convoId = (messageId) => `out-${crypto.createHash('sha256').update(String(messageId)).digest('hex').slice(0, 16)}`;

async function namesOf(clientId, client) {
  const [senderName, inboxes, ownerName] = await Promise.all([
    kv.hget(K.profile(clientId), 'senderName').catch(() => null),
    kv.smembers(K.inboxes(clientId)).catch(() => []),
    cfg(null, 'OWNER.signerName').catch(() => null),
  ]);
  const ours = new Set((inboxes || []).map(lower));
  const contact = lower(client?.contactEmail);
  /** "Name <address>" for a sending inbox, the client's contact, or (`owner`: an address of ours that is not a sending inbox) the owner's onboarding Gmail. */
  return (email, { owner = false } = {}) => {
    const e = lower(email);
    if (!e) return null;
    if (ours.has(e)) return addr(senderName, e);
    if (e === contact) return addr(client?.contactName, e);
    if (owner) return addr(ownerName, e);
    return e;
  };
}

/** The client ↔ owner conversation as a thread: what went to the client and what they wrote. */
async function clientThread(clientId) {
  const client = await getClient(clientId);
  if (!client) return null;
  const [entries, name] = await Promise.all([
    kv.lrange(K.onboardThread(clientId), 0, -1).then((l) => (l || []).map(asRec).filter(Boolean)),
    namesOf(clientId, client),
  ]);
  const messages = entries.filter((e) => ms(e.at)).map((e) => ({
    at: iso(ms(e.at)),
    dir: e.dir === 'in' ? 'in' : 'out',
    by: e.dir === 'in' ? 'client' : e.kind === 'owner_reply' ? 'owner' : e.kind === 'auto_reply' ? 'bot' : 'system',
    from: name(e.from, { owner: e.dir !== 'in' }), to: name(e.to, { owner: e.dir === 'in' }), subject: e.subject || '', text: String(e.text || ''),
  })).sort((a, b) => a.at.localeCompare(b.at));
  if (!messages.length) return null;
  return { threadId: CLIENT_THREAD, lead: { email: client.contactEmail || null, name: client.contactName || null, company: client.name || null }, messages };
}

/**
 * The whole conversation with one prospect, oldest first: our cold emails (full text), their replies,
 * the machine's answers, the hand-off to the client and the client's answer to it.
 * → { threadId, lead, messages: [{ at, dir: 'out'|'in', by: 'system'|'bot'|'owner'|'client'|'prospect', from, to, subject, text }] } | null (unknown).
 * threadId 'client' is the client ↔ owner conversation.
 */
export async function threadFor(clientId, threadId) {
  if (threadId === CLIENT_THREAD) return clientThread(clientId);
  const email = emailOfThread(threadId);
  if (!email) return null;
  const lead = asRec(await kv.hget(K.leads(clientId), email));
  if (!lead) return null;
  const client = await getClient(clientId);
  const touches = touchesOf(lead);
  const [texts, answersRaw, replies, hotAll, name] = await Promise.all([
    touches.length ? kv.hmget(K.mailText(clientId), ...touches.map((t) => textField(email, t.touch))) : {},
    kv.hget(K.prospectMail(clientId), email),
    repliesOf(clientId),
    hotOf(clientId),
    namesOf(clientId, client),
  ]);
  const them = addr(nameOf(lead), email);
  const messages = [];
  touches.forEach((t, i) => {
    const f = textField(email, t.touch);
    const text = Array.isArray(texts) ? texts[i] : texts?.[f];
    messages.push({ at: iso(ms(t.at)), dir: 'out', by: 'system', from: name(lead.account_used), to: them, subject: t.subject || '', text: text != null && String(text) ? String(text) : NOT_STORED });
  });
  for (const m of asList(answersRaw)) {
    if (!ms(m.at)) continue;
    messages.push({ at: iso(ms(m.at)), dir: 'out', by: 'bot', from: name(m.from || lead.account_used), to: them, subject: m.subject || '', text: String(m.text || '') });
  }
  for (const r of replies.filter((x) => lower(x.leadEmail) === email)) {
    const at = ms(r.receivedAt || r.handledAt);
    if (!at) continue;
    const bounce = r.kind === 'bounce';
    messages.push({ at: iso(at), dir: 'in', by: bounce ? 'system' : 'prospect', from: bounce ? 'Mail Delivery System <mailer-daemon>' : them, to: name(r.inbox || lead.account_used), subject: r.subject || '', text: String(r.text || r.snippet || '') });
  }
  const hot = hotAll.filter((h) => lower(h.leadEmail) === email);
  if (hot.length) {
    // The hand-off email to the client (its words are in the client conversation) and the client's answer.
    const convo = client ? await kv.lrange(K.onboardThread(clientId), 0, -1).then((l) => (l || []).map(asRec).filter(Boolean)).catch(() => []) : [];
    for (const h of hot) {
      const near = (e) => e.dir === 'out' && Math.abs(ms(e.at) - ms(h.sentAt)) <= 5 * 60e3 && (e.template === 'hot_lead' || /^hot\b/i.test(e.subject || ''));
      const sent = (h.hotMessageId ? convo.find((e) => e.id === convoId(h.hotMessageId)) : null)
        || convo.find((e) => near(e) && [email, companyOf(lead)].some((x) => x && String(e.text || '').includes(x)));
      const subject = sent?.subject || `Hot lead — ${companyOf(lead) || email}`;
      if (ms(h.sentAt)) {
        messages.push({ at: iso(ms(h.sentAt)), dir: 'out', by: 'system', from: name(h.inbox || lead.account_used), to: name(sent?.to || client?.contactEmail), subject, text: String(sent?.text || `Handed to ${client?.contactName || 'the client'}: ${nameOf(lead) || email} wrote back (${h.kind || 'reply'}).`) });
      }
      if (ms(h.answeredAt)) {
        messages.push({ at: iso(ms(h.answeredAt)), dir: 'in', by: 'client', from: name(h.answerFrom || client?.contactEmail), to: name(h.inbox || lead.account_used), subject: `Re: ${subject}`, text: String(h.answerText || '(They answered the hand-off email; its words were not kept.)') });
      }
    }
  }
  if (!messages.length) return null;
  messages.sort((a, b) => a.at.localeCompare(b.at) || (a.dir === b.dir ? 0 : a.dir === 'out' ? -1 : 1));
  return { threadId, lead: leadView(lead, email), messages };
}
