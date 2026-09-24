/**
 * One bounded IMAP pass over one trial inbox (used by the Reply Handler, the
 * bounce scan and the Booking Watcher). Modelled on reply-checker.js: UID
 * watermark per folder, header classification before any body download,
 * every phase under a timeout.
 *
 * scanMailbox(account, {
 *   folders: ['INBOX'] | includeSpam: true,
 *   uidState: { [folder]: { uidValidity, lastUid } },
 *   maxMessages, firstScanDays,
 *   wantBody(meta) → bool,  wantIcs(meta) → bool,
 * }) → { ok, error, messages: [meta], uidState: { [folder]: {...} } }
 *
 * The watermark only advances past messages that were returned, so a run
 * that stops at `maxMessages` continues where it left off next time.
 */

import { parseHeaders, splitIds, classifyKind, findTextPart, readStream, htmlToText } from '@/lib/mail-utils';

const FETCH_HEADERS = [
  'auto-submitted', 'precedence', 'x-auto-response-suppress', 'x-autoreply', 'x-autorespond',
  'return-path', 'reply-to', 'references', 'in-reply-to', 'list-id', 'list-unsubscribe',
  'x-failed-recipients', 'content-type', 'x-aviance-warm', 'message-id',
];
const MAX_BODY = 24 * 1024;
const MAX_ICS = 64 * 1024;

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(t));
}

/** Calendar parts (text/calendar, application/ics, *.ics) in an imapflow bodyStructure. */
export function findIcsParts(node, out = []) {
  if (!node) return out;
  if (node.childNodes && node.childNodes.length) { for (const c of node.childNodes) findIcsParts(c, out); return out; }
  const type = String(node.type || '').toLowerCase();
  const name = String(node.dispositionParameters?.filename || node.parameters?.name || '').toLowerCase();
  if (type === 'text/calendar' || type === 'application/ics' || name.endsWith('.ics')) out.push(node.part || 'TEXT');
  return out;
}

async function resolveSpam(client, account) {
  try {
    const list = await client.list();
    const junk = list.find((f) => f.specialUse === '\\Junk');
    if (junk) return junk.path;
    if (list.find((f) => f.path === account.spamFolder)) return account.spamFolder;
    const guess = list.find((f) => /^(\[gmail\]\/)?(spam|junk( e-?mail)?)$/i.test(f.path));
    return guess ? guess.path : null;
  } catch {
    return account.spamFolder || null;
  }
}

function describe(msg, folder, account) {
  const env = msg.envelope || {};
  const headers = parseHeaders(msg.headers);
  const from = String(env.from?.[0]?.address || '').toLowerCase();
  const subject = String(env.subject || '');
  const inReplyTo = splitIds([env.inReplyTo, headers['in-reply-to']]);
  const references = splitIds(headers.references);
  const date = msg.internalDate ? new Date(msg.internalDate).toISOString() : (env.date ? new Date(env.date).toISOString() : new Date().toISOString());
  return {
    uid: msg.uid,
    folder,
    inbox: account.email,
    messageId: env.messageId || headers['message-id'] || null,
    from,
    fromName: String(env.from?.[0]?.name || '').trim(),
    to: (env.to || []).map((a) => String(a.address || '').toLowerCase()).filter(Boolean),
    cc: (env.cc || []).map((a) => String(a.address || '').toLowerCase()).filter(Boolean),
    subject,
    date,
    headers,
    inReplyTo,
    references,
    threadIds: [...new Set([...inReplyTo, ...references])],
    kind: classifyKind({ headers, subject, from, contentType: String(msg.bodyStructure?.type || '') }),
    hasIcs: findIcsParts(msg.bodyStructure).length > 0,
    bodyStructure: msg.bodyStructure || null,
  };
}

export async function scanMailbox(account, { folders = ['INBOX'], includeSpam = false, uidState = {}, maxMessages = 30, firstScanDays = 7, wantBody = () => true, wantIcs = (m) => m.hasIcs, timeoutMs = 25_000 } = {}) {
  const { ImapFlow } = await import('imapflow');
  const out = { ok: false, error: null, messages: [], uidState: {} };
  const client = new ImapFlow({
    host: account.imap.host, port: account.imap.port || 993, secure: true,
    auth: { user: account.email, pass: account.appPassword || account.password },
    logger: false, disableAutoIdle: true,
    connectionTimeout: 12000, greetingTimeout: 8000, socketTimeout: 20000,
  });
  const started = Date.now();
  try {
    await withTimeout(client.connect(), 15000, 'imap connect');
    const list = [...folders];
    if (includeSpam) { const spam = await resolveSpam(client, account); if (spam && !list.includes(spam)) list.push(spam); }
    for (const folder of list) {
      if (out.messages.length >= maxMessages || Date.now() - started > timeoutMs) break;
      let lock;
      try { lock = await client.getMailboxLock(folder); } catch { continue; }
      try {
        const mb = client.mailbox || {};
        const saved = uidState[folder] || null;
        const uidValidity = mb.uidValidity !== undefined ? String(mb.uidValidity) : null;
        const fresh = !saved || !uidValidity || String(saved.uidValidity) !== uidValidity;
        const lastUid = fresh ? 0 : Number(saved.lastUid) || 0;
        const uidNext = Number(mb.uidNext) || 0;
        if (!fresh && uidNext && uidNext - 1 <= lastUid) { out.uidState[folder] = { uidValidity, lastUid }; continue; }
        const range = fresh ? { since: new Date(Date.now() - firstScanDays * 864e5) } : `${lastUid + 1}:*`;
        const batch = [];
        for await (const msg of client.fetch(range, { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: FETCH_HEADERS }, { uid: true })) {
          if (!fresh && msg.uid <= lastUid) continue;
          batch.push(describe(msg, folder, account));
        }
        batch.sort((a, b) => a.uid - b.uid);
        let high = lastUid;
        for (const meta of batch) {
          if (out.messages.length >= maxMessages || Date.now() - started > timeoutMs) break;
          if (wantBody(meta)) {
            try {
              const part = findTextPart(meta.bodyStructure) || { part: 'TEXT', type: 'text/plain' };
              const { content } = await client.download(meta.uid, part.part, { uid: true, maxBytes: MAX_BODY });
              let text = await readStream(content, MAX_BODY);
              if (part.type === 'text/html') text = htmlToText(text);
              meta.text = text;
            } catch { meta.text = ''; }
          }
          if (meta.hasIcs && wantIcs(meta)) {
            meta.ics = [];
            for (const p of findIcsParts(meta.bodyStructure).slice(0, 2)) {
              try { const { content } = await client.download(meta.uid, p, { uid: true, maxBytes: MAX_ICS }); meta.ics.push(await readStream(content, MAX_ICS)); } catch {}
            }
          }
          delete meta.bodyStructure;
          out.messages.push(meta);
          high = Math.max(high, meta.uid);
        }
        out.uidState[folder] = { uidValidity, lastUid: high };
      } finally {
        try { lock.release(); } catch {}
      }
    }
    out.ok = true;
  } catch (err) {
    out.error = `${err.code ? `${err.code}: ` : ''}${err.message || String(err)}`;
  } finally {
    try { await withTimeout(client.logout(), 2000, 'logout'); } catch { try { client.close(); } catch {} }
  }
  return out;
}
