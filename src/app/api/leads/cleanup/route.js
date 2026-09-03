/**
 * Leads Cleanup Endpoint
 * Reversibly removes leads from the active dashboard by ARCHIVING them to a
 * separate KV hash ('removed_leads') and deleting them from the main 'leads'
 * hash. Nothing is permanently erased — a 'restore' action moves them back.
 *
 * Safeguard: never removes a lead that has been sent, replied, completed,
 * unsubscribed or is mid-send.
 *
 * Destructive and not used by the UI, so every call requires the CRON_SECRET
 * (Authorization: Bearer <secret> or ?token=<secret>) when one is configured.
 *
 * POST { action:'remove', statuses:['skipped_dedup'], dryRun?:true }
 * POST { action:'remove', emails:['a@b.com', ...] }
 * POST { action:'restore', emails?:[...] }   // omit emails to restore all
 * GET                                          // count of archived leads
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { promises as dns } from 'node:dns';
import { getLeadsByEmail } from '@/lib/leads-db';
import { isRoleEmail, normalizeEmail, SEND_SCORE_THRESHOLD } from '@/lib/metrics';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const LEADS_KEY = 'leads';
const ARCHIVE_KEY = 'removed_leads';
const SUPPRESSION_KEY = 'suppression';

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  let token = '';
  try { token = new URL(request.url).searchParams.get('token') || ''; } catch {}
  return safeEqual(bearer, secret) || safeEqual(token, secret);
}

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

// ─────────────────────────────────────────────────────────────
// REQUALIFICATION RULE DATA (targeting + deliverability)
// ─────────────────────────────────────────────────────────────
const EMAIL_OK = /^[A-Za-z0-9._%+'-]+@(?=.{1,253}$)([a-z0-9](-*[a-z0-9])*\.)+[a-z]{2,63}$/;

// Shared/functional inboxes — near-zero cold-reply value.
const ROLE_PREFIXES = new Set([
  'info', 'sales', 'support', 'admin', 'administrator', 'webmaster', 'postmaster', 'hostmaster',
  'abuse', 'noc', 'security', 'root', 'sysadmin', 'help', 'helpdesk', 'billing', 'accounts',
  'accounting', 'ap', 'ar', 'finance', 'invoices', 'invoice', 'payments', 'payroll', 'hr', 'jobs',
  'careers', 'recruiting', 'recruitment', 'marketing', 'newsletter', 'news', 'press', 'media', 'pr',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'bounce', 'bounces', 'notifications',
  'notification', 'alerts', 'alert', 'system', 'mail', 'email', 'feedback', 'subscribe',
  'unsubscribe', 'order', 'orders', 'shop', 'store', 'returns', 'service', 'services',
  'customerservice', 'customercare', 'care', 'enquiry', 'enquiries', 'inquiry', 'inquiries',
  'general', 'staff', 'legal', 'compliance', 'privacy', 'it', 'dev', 'test', 'qa', 'api',
  'office', 'team', 'contact', 'hello', 'reception', 'frontdesk', 'reservations', 'bookings',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'aim.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
  'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'comcast.net', 'verizon.net', 'att.net',
  'sbcglobal.net', 'bellsouth.net', 'cox.net', 'earthlink.net', 'qq.com', '163.com', '126.com',
  'naver.com', 'mail.ru',
]);

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'sharklasers.com', 'grr.la', '10minutemail.com',
  '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'tempmailo.com', 'throwawaymail.com',
  'getnada.com', 'trashmail.com', 'dispostable.com', 'yopmail.com', 'mailnesia.com', 'maildrop.cc',
  'mintemail.com', 'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'moakt.com', 'mailcatch.com',
  'discard.email', '1secmail.com', '1secmail.net', '1secmail.org', 'spambog.com', 'mailsac.com',
  'meltmail.com', 'temp-mail.io', 'burnermail.io',
]);

const TYPO_DOMAINS = new Set([
  'gmial.com', 'gmai.com', 'gmal.com', 'gamil.com', 'gmail.co', 'gmail.con', 'gmail.cm',
  'gmaill.com', 'gnail.com', 'gmail.comm', 'yaho.com', 'yahooo.com', 'yahoo.co', 'yhoo.com',
  'hotmial.com', 'hotmai.com', 'hotmil.com', 'homail.com', 'hotmail.co', 'hotmail.con',
  'outlok.com', 'outook.com', 'outlook.co', 'iclould.com', 'icloud.co',
]);

// Consumer / local / regulated verticals that don't fit a "booked B2B sales call" offer.
const EXCLUDE_INDUSTRY = /(education|school|university|college|construction|contractor|hotel|hospitality|resort|retail|restaurant|cafe|\bfood\b|beverage|healthcare|health\s*care|medical|clinic|dental|pharma|real\s*estate|realtor|realty|automotive|dealership|travel|tourism|fitness|\bgym\b|salon|\bspa\b|beauty|ecommerce|e-commerce|nonprofit|non-profit|church|religio)/i;

// B2B service sellers that live on booked calls — the ICP.
const TARGET_INDUSTRY = /(^\s*usa\s*-|marketing|advert|agenc|consult|professional\s*service|technology|software|saas|\bit\b|managed\s*service|\bmsp\b|finance|financial|fintech|manufactur|logistic|b2b)/i;

// Leads we must never archive (real, active or opted-out contacts). NOTE:
// 'bounced' is intentionally NOT protected — dead addresses should be removed.
const REQUALIFY_PROTECTED = new Set([
  'replied', 'sending', 'sent-d0', 'sent-d3', 'sent-d7', 'sequence_complete', 'sent-d7-complete', 'unsubscribed',
]);
// Statuses that mark an address as already dead / skipped.
const DEAD_STATUSES = new Set([
  'bounced', 'skipped_unverified', 'skipped_generic', 'skipped_no_company', 'skipped_dedup',
  'invalid', 'skipped_dead', 'skipped',
]);

const KNOWN_ACTIONS = new Set(['remove', 'restore', 'requalify', 'import_leads', 'keep_min_score', 'verify_mx', 'reset_history', 'promote']);

function emailParts(email) {
  const e = normalizeEmail(email);
  const parts = e.split('@');
  return { e, local: parts[0] || '', domain: parts[1] || '', atCount: (e.match(/@/g) || []).length };
}

function industryBucket(lead) {
  const ind = String(lead.industry || '').trim();
  if (!ind) return 'ambiguous';
  if (EXCLUDE_INDUSTRY.test(ind)) return 'exclude';
  if (TARGET_INDUSTRY.test(ind)) return 'target';
  return 'ambiguous';
}

function isRoleInbox(e, local) {
  if (ROLE_PREFIXES.has(local)) return true;
  // "info.us", "sales-team": a role word followed by a separator — but only a
  // real word (4+ chars), so "ap.nguyen@" / "hr.patel@" stay people.
  const base = local.split(/[.\-_+]/)[0];
  if (base.length >= 4 && ROLE_PREFIXES.has(base)) return true;
  return isRoleEmail(e);
}

function requalifyReason(email, lead, opts) {
  const { e, local, domain, atCount } = emailParts(email);
  const st = String(lead.status || '').toLowerCase();
  if (DEAD_STATUSES.has(st)) return 'dead_status';
  if (atCount !== 1 || !local || !domain) return 'invalid_syntax';
  if (!EMAIL_OK.test(e) || e.includes('..')) return 'invalid_syntax';
  if (DISPOSABLE.has(domain)) return 'disposable';
  if (TYPO_DOMAINS.has(domain)) return 'typo_domain';
  if (isRoleInbox(e, local)) return 'role_inbox';
  if (opts.removeFreeProviders && FREE_PROVIDERS.has(domain)) return 'free_provider';
  const bucket = industryBucket(lead);
  if (bucket === 'exclude') return 'offtarget_industry';
  if (bucket === 'ambiguous' && opts.removeAmbiguous) return 'ambiguous_industry';
  return null;
}

// MX verdict for a domain: 'REMOVE' (dead), 'KEEP', or 'RETRY' (transient — never remove).
async function mxVerdict(domain) {
  const withTimeout = (p, ms) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej({ code: 'ETIMEOUT' }), ms)),
  ]);
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 3000);
    if (!mx || !mx.length) return 'REMOVE';
    if (mx.every((r) => !r.exchange || r.exchange === '.')) return 'REMOVE';
    return 'KEEP';
  } catch (err) {
    const c = err && err.code;
    if (c === 'ENOTFOUND' || c === 'NXDOMAIN') return 'REMOVE';
    if (c === 'ENODATA') {
      try { await withTimeout(dns.resolve(domain, 'A'), 2500); return 'KEEP'; } catch { return 'REMOVE'; }
    }
    return 'RETRY';
  }
}

function isProtected(lead) {
  if (!lead) return false;
  const st = String(lead.status || '').toLowerCase();
  return Boolean(
    lead.account_used ||
    lead.sent_at ||
    lead.replied_at ||
    lead.suppressed ||
    st.startsWith('sent') ||
    REQUALIFY_PROTECTED.has(st)
  );
}

// ─────────────────────────────────────────────────────────────
// KV helpers — chunked, pipelined writes; re-read-before-write patches
// ─────────────────────────────────────────────────────────────
const HSET_CHUNK = 100;
const CMDS_PER_PIPELINE = 4;

async function chunkedHset(key, obj) {
  const entries = Object.entries(obj);
  for (let i = 0; i < entries.length; i += HSET_CHUNK * CMDS_PER_PIPELINE) {
    const p = kv.pipeline();
    let n = 0;
    for (let j = i; j < Math.min(entries.length, i + HSET_CHUNK * CMDS_PER_PIPELINE); j += HSET_CHUNK) {
      const slice = Object.fromEntries(entries.slice(j, j + HSET_CHUNK));
      if (Object.keys(slice).length) { p.hset(key, slice); n++; }
    }
    if (n) await p.exec();
  }
}

async function chunkedHdel(key, fields) {
  for (let i = 0; i < fields.length; i += HSET_CHUNK * 10) {
    const p = kv.pipeline();
    let n = 0;
    for (let j = i; j < Math.min(fields.length, i + HSET_CHUNK * 10); j += HSET_CHUNK) {
      const slice = fields.slice(j, j + HSET_CHUNK);
      if (slice.length) { p.hdel(key, ...slice); n++; }
    }
    if (n) await p.exec();
  }
}

/**
 * Patch many leads, re-reading each chunk immediately before writing so a
 * snapshot taken earlier in the request can never clobber fields the sender,
 * pixel or reply scanner wrote in the meantime. `fn(existing, email)` returns
 * the fields to merge, or null to skip. Returns the number written.
 */
async function patchMany(emails, fn) {
  let written = 0;
  for (let i = 0; i < emails.length; i += HSET_CHUNK) {
    const part = emails.slice(i, i + HSET_CHUNK);
    const fresh = await getLeadsByEmail(part);
    const now = new Date().toISOString();
    const updates = {};
    for (const email of part) {
      const existing = fresh[email];
      if (!existing) continue;
      const patch = fn(existing, email);
      if (!patch) continue;
      updates[email] = { ...existing, ...patch, email, updatedAt: now };
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      await kv.hset(LEADS_KEY, updates);
      written += keys.length;
    }
  }
  return written;
}

/** Which of these addresses are on the suppression set. */
async function suppressedAmong(emails) {
  const out = new Set();
  for (let i = 0; i < emails.length; i += 400) {
    const part = emails.slice(i, i + 400);
    try {
      const flags = (await kv.smismember(SUPPRESSION_KEY, part)) || [];
      part.forEach((e, j) => { if (flags[j] === 1 || flags[j] === true) out.add(e); });
    } catch {}
  }
  return out;
}

async function allLeadsMap() {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  for (const k of Object.keys(all)) if (!all[k] || typeof all[k] !== 'object') delete all[k];
  return all;
}

export async function POST(request) {
  if (!authorized(request)) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const action = String(body.action || 'remove');

  // An unknown action must never fall through to the destructive default.
  if (!KNOWN_ACTIONS.has(action)) {
    return Response.json({ error: `Unknown action '${action}'`, actions: [...KNOWN_ACTIONS] }, { status: 400 });
  }

  if (action === 'requalify') {
    // Full targeting + deliverability re-qualification. Archives (reversible),
    // never deletes; never touches replied / in-sequence leads. Supports dryRun.
    const dryRun = !!body.dryRun;
    const opts = {
      removeFreeProviders: body.removeFreeProviders !== false, // default ON
      removeAmbiguous: !!body.removeAmbiguous,                  // default OFF (keep unknown-industry)
      dedupeDomain: body.dedupeDomain !== false,               // default ON (one contact per company)
    };

    const all = await allLeadsMap();
    const diag = { total: 0, protectedKept: 0, byRule: {}, industries: {}, scoreDist: {} };
    const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
    const toArchive = {};
    const survivors = [];
    const protectedDomains = new Set();

    for (const [email, lead] of Object.entries(all)) {
      diag.total++;
      bump(diag.industries, industryBucket(lead));
      bump(diag.scoreDist, String(lead.quality_score ?? 'none'));
      if (isProtected(lead)) {
        diag.protectedKept++;
        const d = emailParts(email).domain;
        if (d) protectedDomains.add(d);
        continue;
      }
      const reason = requalifyReason(email, lead, opts);
      if (reason) { bump(diag.byRule, reason); toArchive[email] = { ...lead, requalify_reason: reason }; }
      else survivors.push([email, lead]);
    }

    // One contact per company domain: keep the highest-scored survivor per domain
    // (or drop all survivors whose company we've already emailed).
    if (opts.dedupeDomain) {
      const byDomain = {};
      for (const [email, lead] of survivors) {
        const d = emailParts(email).domain;
        (byDomain[d] = byDomain[d] || []).push([email, lead]);
      }
      for (const [d, group] of Object.entries(byDomain)) {
        group.sort((a, b) => (Number(b[1].quality_score) || 0) - (Number(a[1].quality_score) || 0));
        const start = protectedDomains.has(d) ? 0 : 1;
        for (let i = start; i < group.length; i++) {
          bump(diag.byRule, 'duplicate_domain');
          toArchive[group[i][0]] = { ...group[i][1], requalify_reason: 'duplicate_domain' };
        }
      }
    }

    const removeEmails = Object.keys(toArchive);
    diag.wouldRemove = removeEmails.length;
    diag.wouldKeepActive = diag.total - diag.protectedKept - diag.wouldRemove;
    diag.keepersTotal = diag.total - diag.wouldRemove;

    if (dryRun) return Response.json({ dryRun: true, opts, ...diag });

    if (removeEmails.length) {
      await chunkedHset(ARCHIVE_KEY, toArchive);
      await chunkedHdel(LEADS_KEY, removeEmails);
    }
    return Response.json({ requalified: true, removed: removeEmails.length, opts, ...diag });
  }

  if (action === 'import_leads') {
    // Add externally-sourced leads into the active list. Never clobbers an
    // existing lead (protects sent/replied) unless overwrite:true — and even
    // then the fields are merged onto a fresh read, never a stale snapshot.
    // Suppressed addresses are always skipped.
    const leads = Array.isArray(body.leads) ? body.leads : [];
    const overwrite = !!body.overwrite;
    const now = new Date().toISOString();
    const incoming = new Map();
    let skipped = 0;
    for (const l of leads) {
      const email = normalizeEmail(l && l.email);
      if (!email || !email.includes('@') || incoming.has(email)) { skipped++; continue; }
      incoming.set(email, l);
    }
    const emails = [...incoming.keys()];
    const [existing, suppressed] = emails.length
      ? await Promise.all([getLeadsByEmail(emails), suppressedAmong(emails)])
      : [{}, new Set()];

    const fresh = {};
    const toPatch = [];
    let added = 0, updated = 0, suppressedSkipped = 0;
    for (const email of emails) {
      const l = incoming.get(email);
      if (suppressed.has(email)) { suppressedSkipped++; skipped++; continue; }
      if (existing[email]) {
        if (!overwrite) { skipped++; continue; }
        toPatch.push(email);
        continue;
      }
      fresh[email] = {
        ...l, email,
        status: l.status || 'pending',
        added_at: now,
        createdAt: l.createdAt || now,
        updatedAt: now,
      };
      added++;
    }
    if (Object.keys(fresh).length) await chunkedHset(LEADS_KEY, fresh);
    if (toPatch.length) {
      updated = await patchMany(toPatch, (cur, email) => {
        if (isProtected(cur)) return null;
        const l = incoming.get(email);
        return { ...l, email, status: l.status || cur.status || 'pending', added_at: cur.added_at || now };
      });
      skipped += toPatch.length - updated;
    }
    return Response.json({ import_leads: true, received: leads.length, added: added + updated, skipped, updated, suppressed: suppressedSkipped });
  }

  if (action === 'keep_min_score') {
    // Keep only leads scoring >= minScore (default: the send gate), plus
    // protected (replied / in-sequence) contacts. Everything else is archived.
    const min = Number(body.minScore) || SEND_SCORE_THRESHOLD;
    const dryRun = !!body.dryRun;
    const all = await allLeadsMap();
    const toArchive = {};
    let kept = 0, protectedKept = 0;
    for (const [email, lead] of Object.entries(all)) {
      if (isProtected(lead)) { protectedKept++; continue; }
      const sc = Number(lead.quality_score);
      if (Number.isFinite(sc) && sc >= min) { kept++; continue; }
      toArchive[email] = { ...lead, requalify_reason: 'below_min_score' };
    }
    const emails = Object.keys(toArchive);
    if (dryRun) {
      return Response.json({ dryRun: true, minScore: min, wouldRemove: emails.length, kept, protectedKept, total: Object.keys(all).length });
    }
    if (emails.length) {
      await chunkedHset(ARCHIVE_KEY, toArchive);
      await chunkedHdel(LEADS_KEY, emails);
    }
    return Response.json({ keep_min_score: true, minScore: min, removed: emails.length, kept, protectedKept, remaining: kept + protectedKept });
  }

  if (action === 'verify_mx') {
    // Batched MX / dead-domain check over not-yet-sent leads. Removes addresses
    // whose domain has no mail server (hard bounce); never removes on a transient
    // DNS error. Call repeatedly until remainingUnchecked hits 0.
    const dryRun = !!body.dryRun;
    const limit = Math.min(500, parseInt(body.limit) || 150);
    const all = await allLeadsMap();
    const pending = Object.entries(all).filter(([, l]) => {
      const st = String(l.status || '').toLowerCase();
      return (st === 'pending' || st === 'new') && !l.mx_checked;
    });
    const slice = pending.slice(0, limit);

    // Resolve each unique domain once, with limited concurrency.
    const uniqueDomains = [...new Set(slice.map(([e]) => emailParts(e).domain).filter(Boolean))];
    const verdict = {};
    let idx = 0;
    async function worker() {
      while (idx < uniqueDomains.length) {
        const d = uniqueDomains[idx++];
        verdict[d] = await mxVerdict(d);
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, uniqueDomains.length) }, worker));

    const toArchive = {};
    const keepEmails = [];
    let removed = 0, kept = 0, retried = 0;
    for (const [email, lead] of slice) {
      const d = emailParts(email).domain;
      const v = d ? verdict[d] : 'REMOVE';
      if (v === 'REMOVE') { toArchive[email] = { ...lead, requalify_reason: 'no_mx' }; removed++; }
      else if (v === 'RETRY') { retried++; }
      else { keepEmails.push(email); kept++; }
    }

    if (!dryRun) {
      if (Object.keys(toArchive).length) {
        await chunkedHset(ARCHIVE_KEY, toArchive);
        await chunkedHdel(LEADS_KEY, Object.keys(toArchive));
      }
      if (keepEmails.length) {
        await patchMany(keepEmails, () => ({ mx_checked: true, mx_checked_at: new Date().toISOString() }));
      }
    }
    return Response.json({
      verify_mx: true, dryRun, batch: slice.length, uniqueDomains: uniqueDomains.length,
      removed, kept, retried, remainingUnchecked: pending.length - slice.length,
    });
  }

  if (action === 'reset_history') {
    // Fresh-start reset: only sends from keepFrom (US Eastern date, default
    // 2026-08-10) onward count as real. Every older "sent" lead goes back to
    // 'pending' (so it re-enters the Not-yet-sent pool), old replies/opens/
    // bounce EVENTS are purged, and the running counters start from zero.
    // Bounced leads keep status 'bounced' so we never email dead addresses,
    // but their event timestamps are stripped so they vanish from Activity.
    const keepFrom = String(body.keepFrom || '2026-08-10');
    const etDay = (ts) => {
      try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts)); }
      catch { return ''; }
    };

    const all = await allLeadsMap();
    const updates = {};
    let keptSent = 0, resetToPending = 0, clearedReplies = 0, bouncedKept = 0;

    const STRIP = [
      'sent_at', 'account_used', 'send_count', 'sequence_day', 'original_subject',
      'original_message_id', 'd3_message_id', 'd3_sent_at', 'replied_at', 'reply_subject',
      'reply_preview', 'reply_account', 'auto_replied', 'auto_replied_at',
      'opened_at', 'last_opened_at', 'open_count', 'd7_sent_at', 'd7_message_id', 'reply_folder',
      'reply_from_address', 'reply_kind', 'reply_intent', 'reply_sentiment', 'first_replied_at',
      'last_replied_at', 'reply_count', 'auto_reply_message_id', 'followup_hold_until', 'ooo_until',
      'subject_variant',
    ];

    for (const [email, lead] of Object.entries(all)) {
      const st = String(lead.status || '');

      if (st === 'bounced') {
        bouncedKept++;
        if (lead.bounced_at || lead.bounce_reason) {
          const l2 = { ...lead };
          delete l2.bounced_at; delete l2.bounce_reason; delete l2.bounce_account;
          updates[email] = { ...l2, updatedAt: new Date().toISOString() };
        }
        continue;
      }

      const wasSent = Boolean(lead.account_used || lead.sent_at || st.startsWith('sent') || st === 'sequence_complete' || st === 'replied' || st === 'sending');
      if (!wasSent) continue;

      // A send on/after keepFrom is real: keep the lead (and its reply) as is.
      const sentDay = lead.sent_at ? etDay(lead.sent_at) : '';
      if (sentDay && sentDay >= keepFrom) { keptSent++; continue; }

      // Reset: strip every send/reply/open artifact, back to a clean pending lead.
      const l2 = { ...lead };
      for (const f of STRIP) delete l2[f];
      if (st === 'replied') clearedReplies++;
      resetToPending++;
      updates[email] = { ...l2, status: 'pending', updatedAt: new Date().toISOString() };
    }

    if (body.dryRun) {
      return Response.json({ dryRun: true, keepFrom, keptSent, resetToPending, clearedReplies, bouncedKept });
    }

    await chunkedHset(LEADS_KEY, updates);

    // Purge event stores: replies, conversations, opens, bounce events, scanner state.
    const diag = {};
    const PURGE = [
      'replies_v3', 'conversations', 'bounces', 'email_opens', 'email_opens_first', 'email_opens_first_human',
      'email_open_counts', 'open_events', 'auto_reply_claims', 'msgid_index', 'reply_uid_state',
      'pending_auto_replies',
    ];
    for (const key of PURGE) {
      try { diag[key + '_deleted'] = await kv.del(key); }
      catch (e) { diag[key + '_error'] = e.message; }
    }

    // Rebuild sent_log: keep only entries from keepFrom (ET) onward.
    // Read in small pages — the full list is too large for a single call.
    try {
      const kept = [];
      let total = 0;
      for (let page = 0; page < 40; page++) {
        let batch;
        try { batch = await kv.lrange('sent_log', page * 200, page * 200 + 199); }
        catch (e) { diag.sent_log_page_error = `page ${page}: ${e.message}`; break; }
        if (!batch || !batch.length) break;
        total += batch.length;
        for (const e of batch) {
          const ts = e && (e.timestamp || e.sentAt || e.createdAt);
          if (ts && etDay(ts) >= keepFrom) kept.push(e);
        }
        if (batch.length < 200) break;
      }
      diag.sent_log_before = total;
      diag.sent_log_kept = kept.length;
      await kv.del('sent_log');
      // lrange returns newest-first (lpush order); re-push oldest-first in one
      // variadic lpush per 200 entries so the order is preserved.
      const oldestFirst = kept.slice().reverse();
      for (let i = 0; i < oldestFirst.length; i += 200) {
        await kv.lpush('sent_log', ...oldestFirst.slice(i, i + 200));
      }
    } catch (e) { diag.sent_log_error = e.message; }

    // Running counters restart from zero; readers derive the real numbers
    // from the lead records anyway.
    try {
      await kv.hset('stats', {
        totalSent: 0, totalFailed: 0, totalReplied: 0, totalOpens: 0, uniqueOpens: 0,
        uniqueHumanOpens: 0, totalAutoReplies: 0, totalBounced: 0,
      });
    } catch (e) { diag.stats_error = e.message; }

    return Response.json({ success: true, keepFrom, keptSent, resetToPending, clearedReplies, bouncedKept, diag });
  }

  if (action === 'promote') {
    // Bump quality_score for all leads matching a source (or explicit emails).
    // Used to mark a hand-curated, verified list as send-ready.
    const score = Number(body.score);
    const source = body.source || null;
    const emailSet = (body.emails && body.emails.length)
      ? new Set(body.emails.map((e) => normalizeEmail(e)))
      : null;
    if (!(score >= 1 && score <= 10)) {
      return Response.json({ error: 'score must be 1-10' }, { status: 400 });
    }
    const all = await allLeadsMap();
    const targets = [];
    for (const [email, lead] of Object.entries(all)) {
      if (isProtected(lead)) continue; // never touch sent/replied leads
      const match = emailSet ? emailSet.has(normalizeEmail(email)) : (source && lead.source === source);
      if (match) targets.push(email);
    }
    if (body.dryRun) return Response.json({ dryRun: true, wouldPromote: targets.length, score, source });
    const promoted = await patchMany(targets, (cur) => {
      if (isProtected(cur)) return null;
      return {
        quality_score: score,
        quality_reason: body.reason || cur.quality_reason || 'Hand-curated, verified list.',
        quality_engine: 'curated-verified',
        verified_at: new Date().toISOString(),
      };
    });
    return Response.json({ promoted, score, source });
  }

  if (action === 'restore') {
    const arch = (await kv.hgetall(ARCHIVE_KEY)) || {};
    const emails = (body.emails && body.emails.length)
      ? body.emails.map((e) => normalizeEmail(e))
      : Object.keys(arch);
    const candidates = [...new Set(emails.filter((e) => arch[e] && typeof arch[e] === 'object'))];
    const [live, suppressed] = candidates.length
      ? await Promise.all([getLeadsByEmail(candidates), suppressedAmong(candidates)])
      : [{}, new Set()];
    const toRestore = {};
    let skippedSuppressed = 0, skippedExisting = 0;
    for (const e of candidates) {
      if (suppressed.has(e)) { skippedSuppressed++; continue; }
      // A live record (re-imported since the archive) always wins.
      if (live[e]) { skippedExisting++; continue; }
      const rec = { ...arch[e], email: e, updatedAt: new Date().toISOString() };
      delete rec.requalify_reason;
      toRestore[e] = rec;
    }
    const keys = Object.keys(toRestore);
    if (keys.length) {
      await chunkedHset(LEADS_KEY, toRestore);
      await chunkedHdel(ARCHIVE_KEY, keys);
    }
    return Response.json({ restored: keys.length, skippedSuppressed, skippedExisting });
  }

  // action === 'remove'
  const all = await allLeadsMap();
  const statuses = body.statuses || (body.status ? [body.status] : ['skipped_dedup']);
  const emailSet = (body.emails && body.emails.length)
    ? new Set(body.emails.map((e) => normalizeEmail(e)))
    : null;

  const toRemove = {};
  let protectedSkipped = 0;
  for (const [email, lead] of Object.entries(all)) {
    const st = (lead && lead.status) || '';
    const match = emailSet ? emailSet.has(normalizeEmail(email)) : statuses.includes(st);
    if (!match) continue;
    if (isProtected(lead)) { protectedSkipped++; continue; }
    toRemove[email] = lead;
  }
  const emails = Object.keys(toRemove);

  if (body.dryRun) {
    return Response.json({ dryRun: true, wouldRemove: emails.length, protectedSkipped, statuses });
  }

  if (emails.length) {
    await chunkedHset(ARCHIVE_KEY, toRemove);
    await chunkedHdel(LEADS_KEY, emails);
  }
  return Response.json({ removed: emails.length, protectedSkipped, archivedTo: ARCHIVE_KEY });
}

export async function GET(request) {
  if (!authorized(request)) return unauthorized();
  let archived = 0;
  try { archived = Number(await kv.hlen(ARCHIVE_KEY)) || 0; } catch {}
  return Response.json({ archived });
}
