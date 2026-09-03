/**
 * Open-tracking pixel endpoint
 *
 * Each outgoing email embeds an invisible 1x1 image pointing here with a signed
 * token (`v2.<payload>.<sig>`, see lib/tokens) that carries the recipient, the
 * touch (d0 / d3 / d7) and the send time. Legacy v1 tokens (plain base64url of
 * the email) are still accepted.
 *
 * Every hit is classified before it is counted:
 *   gmail-proxy  Google's image proxy — a real open (Gmail only fetches on view)
 *   yahoo-proxy  Yahoo's image proxy — a real open
 *   apple-mpp    Apple Mail Privacy Protection prefetch — real only if it comes
 *                a while after delivery (an immediate hit is the prefetch)
 *   scanner      link scanners, security gateways, crawlers, empty UA
 *   client       anything else (desktop / mobile mail clients)
 *
 * Opens live ONLY in the `email_opens` hash (+ counters). The lead record is
 * never rewritten here: the old route's hget→hset of the whole lead raced
 * with the sender and produced duplicate follow-ups. Every reader merges the
 * store via `mergeOpens` (lib/metrics).
 *
 * KV keys
 *   email_opens              Hash  email -> merged open record (see below)
 *   email_opens_first        Hash  email -> ISO of the very first hit
 *   email_opens_first_human  Hash  email -> ISO of the first human hit
 *   email_open_counts        Hash  email -> total hits (atomic)
 *   open_events              List  newest-first hit log (capped at 5000)
 *   stats                    Hash  totalOpens / uniqueOpens / uniqueHumanOpens
 *
 * It ALWAYS returns the transparent pixel, even on error, so a mail client
 * never sees a broken image. Three KV round trips at most per recorded hit.
 */

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { verifyTrackingToken, decodeLegacyTrackingToken } from '@/lib/tokens';
import { getLead } from '@/lib/leads-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPENS_KEY = 'email_opens';
const FIRST_KEY = 'email_opens_first';
const FIRST_HUMAN_KEY = 'email_opens_first_human';
const COUNTS_KEY = 'email_open_counts';
const EVENTS_KEY = 'open_events';
const STATS_KEY = 'stats';
const EVENTS_MAX = 5000;

const MINUTE = 60 * 1000;

// 1x1 transparent GIF (42 bytes).
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const PIXEL_HEADERS = {
  'Content-Type': 'image/gif',
  'Content-Length': String(PIXEL.length),
  // Never let a proxy cache the pixel, so repeat opens still register.
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
  'X-Robots-Tag': 'noindex',
};

function pixelResponse(withBody = true) {
  return new Response(withBody ? PIXEL : null, { status: 200, headers: PIXEL_HEADERS });
}

// ─── Hit classification ──────────────────────────────────────────────────────

const SCANNER_RE = /bot|crawl|spider|scan|monitor|curl|wget|python|Go-http|Java\/|okhttp|HeadlessChrome|Barracuda|Mimecast|Proofpoint|urldefense|Symantec|Sophos|FireEye|Zscaler|Trend ?Micro|Cisco|ESET|Kaspersky|McAfee|Bitdefender|Avast|Safe ?Links|MSOffice|Microsoft Office/i;
// Apple Mail Privacy Protection prefetch UA: a bare Safari engine string with
// no Version/Safari token.
const APPLE_MPP_RE = /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_\d+\) AppleWebKit\/605\.1\.15 \(KHTML, like Gecko\)$/;

function classify(ua) {
  const u = String(ua || '').trim();
  if (!u) return 'scanner';
  if (/GoogleImageProxy/i.test(u)) return 'gmail-proxy';
  if (/YahooMailProxy/i.test(u)) return 'yahoo-proxy';
  if (APPLE_MPP_RE.test(u)) return 'apple-mpp';
  if (SCANNER_RE.test(u)) return 'scanner';
  return 'client';
}

function ignoredIps() {
  return new Set(String(process.env.TRACKING_IGNORE_IPS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function parseToken(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (t.startsWith('v2.')) return verifyTrackingToken(t);
  const email = decodeLegacyTrackingToken(t);
  return email ? { email, touch: null, sentAt: 0 } : null;
}

/** Most recent touch on the lead record: { touch, at (ms) }. */
function lastTouch(lead) {
  let best = { touch: null, at: 0 };
  for (const [touch, key] of [['d0', 'sent_at'], ['d3', 'd3_sent_at'], ['d7', 'd7_sent_at']]) {
    const at = Date.parse(lead?.[key] || '') || 0;
    if (at && at >= best.at) best = { touch, at };
  }
  return best;
}

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) : t;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bump(map, key) {
  const out = { ...(map && typeof map === 'object' ? map : {}) };
  out[key] = num(out[key]) + 1;
  return out;
}

// ─── Recording ───────────────────────────────────────────────────────────────

async function recordOpen(token, meta) {
  const email = String(token.email || '').toLowerCase();
  if (!email) return;

  // Round trip 1: the lead must exist (drops forged tokens). Read only.
  const lead = await getLead(email);
  if (!lead) return;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const last = lastTouch(lead);
  const touch = token.touch || last.touch || 'd0';
  const sentAtMs = token.sentAt || last.at || 0;
  const sinceSend = sentAtMs ? Math.max(0, nowMs - sentAtMs) : null;
  const cls = classify(meta.ua);

  const reasons = [];
  if (cls === 'scanner') reasons.push('scanner');
  if (cls === 'apple-mpp' && sinceSend !== null && sinceSend < 15 * MINUTE) reasons.push('apple-mpp-prefetch');
  if (cls === 'client' && sinceSend !== null && sinceSend < 60 * 1000) reasons.push('too-soon');
  if (cls === 'gmail-proxy' && sinceSend !== null && sinceSend < 20 * 1000) reasons.push('sender-render');
  if (meta.ip && ignoredIps().has(meta.ip)) reasons.push('ignored-ip');
  const human = reasons.length === 0;

  // Round trip 2: current record + atomic first/count markers.
  const p1 = kv.pipeline();
  p1.hget(OPENS_KEY, email);
  p1.hsetnx(FIRST_KEY, email, nowIso);
  if (human) p1.hsetnx(FIRST_HUMAN_KEY, email, nowIso);
  p1.hincrby(COUNTS_KEY, email, 1);
  p1.hincrby(STATS_KEY, 'totalOpens', 1);
  const r1 = await p1.exec();
  let i = 0;
  const existingRaw = r1[i++];
  const firstRes = num(r1[i++]);
  const firstHumanRes = human ? num(r1[i++]) : 0;
  const atomicCount = Math.max(1, num(r1[i++]));

  const existing = existingRaw && typeof existingRaw === 'object' ? existingRaw : null;
  // Counts recorded before the atomic counter existed are carried forward.
  const count = Math.max(atomicCount, (existing ? num(existing.count) : num(lead.open_count)) + 1);
  // Records written before classification existed carry no `firstHumanAt`;
  // their opens were counted as opens, so they stay counted (as human). The
  // same goes for opens the old route wrote straight onto the lead record.
  const legacy = Boolean(existing) && !Object.prototype.hasOwnProperty.call(existing, 'firstHumanAt');
  const leadOpenedAt = lead.opened_at || null;
  const priorFirstAt = existing ? (existing.firstAt || existing.openedAt || null) : leadOpenedAt;
  const priorFirstHumanAt = existing ? (existing.firstHumanAt || (legacy ? priorFirstAt : null)) : leadOpenedAt;
  const priorHumanCount = existing ? (legacy ? num(existing.count) : num(existing.humanCount)) : num(lead.open_count);

  const firstEver = firstRes === 1 && !existing && !leadOpenedAt;
  const firstHuman = human && firstHumanRes === 1 && !priorFirstHumanAt;

  const firstAt = priorFirstAt || nowIso;
  const firstHumanAt = priorFirstHumanAt || (human ? nowIso : null);
  const lastHumanAt = human ? nowIso : (existing ? (existing.lastHumanAt || (legacy ? (existing.lastOpenedAt || existing.lastAt || null) : null)) : null);
  const touches = bump(existing?.touches, touch);
  const humanTouches = human ? bump(existing?.humanTouches, touch) : { ...(existing?.humanTouches || {}) };

  const record = {
    email,
    count,
    humanCount: priorHumanCount + (human ? 1 : 0),
    firstAt,
    firstHumanAt,
    lastAt: nowIso,
    lastHumanAt,
    lastClass: cls,
    lastUa: clip(meta.ua, 160),
    country: meta.country || existing?.country || null,
    ipHash: meta.ipHash || existing?.ipHash || null,
    touches,
    humanTouches,
    firstTouch: existing?.firstTouch || touch,
    suspectReasons: reasons,
    // Legacy aliases read by older code paths.
    openedAt: firstAt,
    lastOpenedAt: nowIso,
  };

  const event = {
    email,
    touch,
    class: cls,
    human,
    country: meta.country || null,
    ua: clip(meta.ua, 120),
    at: nowIso,
    sinceSendMs: sinceSend,
  };

  // Round trip 3: counters that depend on "first", the merged record, the log.
  const p2 = kv.pipeline();
  if (firstEver) p2.hincrby(STATS_KEY, 'uniqueOpens', 1);
  if (firstHuman) p2.hincrby(STATS_KEY, 'uniqueHumanOpens', 1);
  p2.hset(OPENS_KEY, { [email]: record });
  p2.lpush(EVENTS_KEY, event);
  p2.ltrim(EVENTS_KEY, 0, EVENTS_MAX - 1);
  await p2.exec();
}

function requestMeta(request) {
  const h = request.headers;
  const ip = String(h.get('x-forwarded-for') || '').split(',')[0].trim();
  return {
    ua: String(h.get('user-agent') || ''),
    country: String(h.get('x-vercel-ip-country') || '').toUpperCase() || null,
    ip,
    ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) : null,
    accept: String(h.get('accept') || ''),
    fetchDest: String(h.get('sec-fetch-dest') || ''),
  };
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const token = parseToken(url.searchParams.get('t'));
    if (token) {
      // Awaited (not fire-and-forget) so the serverless runtime never kills the
      // write; the pixel still goes out the moment recording finishes.
      await recordOpen(token, requestMeta(request));
    }
  } catch {
    /* never block the pixel on an error */
  }
  return pixelResponse();
}

/**
 * HEAD probes come from link scanners and security gateways checking the URL,
 * never from a person reading the email. Without this handler Next would run
 * GET for HEAD and count every probe as an open.
 */
export async function HEAD() {
  return pixelResponse(false);
}
