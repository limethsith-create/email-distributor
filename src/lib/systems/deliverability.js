/**
 * The hub's `deliverability` object (docs/HUB-API.md, v2 additions) for one
 * trial: warm-up circle at a glance, the newest placement tests (seed + spam
 * test), the blacklist check and the bounce lines.
 *
 * Reads stored values only — one pipeline (client hash, placement history,
 * domain fields, warm-up summary) plus three settings — so opening a client
 * in the hub never recomputes the pool, the tests or the 7-day bounce rate:
 *   warm-up summary   written by every warm-up send run (warmup:summary)
 *   placement         client:{id}:placement (canary + spam tests)
 *   blacklists        client:{id}:domain.blacklists (Auth Guard, daily)
 *   bounce.rate7d     client.bounceRate7d (Ramp Planner, daily 00:05 ET)
 * Missing = null (never a guessed 0).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { ET, dayKeyIn } from '@/lib/time';
import { externalStatus } from '@/lib/systems/warmup';

const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function warmupPart(summary, external, now) {
  const s = summary && summary.at ? summary : null;
  const providers = s ? (typeof s.providers === 'string' ? parse(s.providers, {}) : s.providers || {}) : null;
  return {
    pool: s ? num(s.pool) : null,
    helpers: s ? num(s.helpers) : null,
    trialInboxes: s ? num(s.trial) : null,
    avianceInboxes: s ? num(s.aviance) : null,
    families: s ? num(s.families) : null,
    providers,
    // Pairs are claimed per ET day; a summary from an earlier day means no warm-up run yet today.
    todayPairs: s ? (s.day === dayKeyIn(ET, now) ? num(s.todayPairs) : 0) : null,
    at: s ? s.at : null,
    external: external ? { name: external.name, status: external.status, perDay: external.perDay } : null,
  };
}

function placementPart(rows) {
  return (rows || []).map((r) => parse(r, null)).filter(Boolean).slice(0, 10).map((e) => ({
    at: e.at || null,
    tool: e.tool || null,
    inbox: e.inbox || null,
    score: e.score ?? null,
    spamAssassin: e.spamAssassin ?? null,
    inboxRate: e.inboxRate ?? null,
    pass: e.pass ?? null,
    detail: Array.isArray(e.detail) ? e.detail : [],
    reportUrl: e.reportUrl || null,
    error: e.error || null,
  }));
}

function blacklistPart(domain) {
  const d = domain || {};
  const stored = parse(d.blacklists, null);
  if (stored && typeof stored === 'object') {
    return {
      checkedAt: stored.checkedAt || d.blacklistCheckedAt || null,
      status: d.blacklist || (stored.listed?.length ? 'listed' : 'clean'),
      listed: stored.listed || [],
      warnings: stored.warnings || [],
      clean: num(stored.clean),
      unknown: stored.unknown || [],
      lists: stored.lists || [],
    };
  }
  if (d.blacklist) return { checkedAt: d.blacklistCheckedAt || null, status: d.blacklist, listed: [], warnings: [], clean: null, unknown: [], lists: [] };
  return null;
}

/** The HUB-API `deliverability` object for one client. */
export async function deliverabilityView(clientId, { now = new Date() } = {}) {
  const p = kv.pipeline();
  p.hgetall(K.client(clientId));
  p.lrange(K.placement(clientId), 0, 9);
  p.hmget(K.domain(clientId), 'blacklists', 'blacklist', 'blacklistCheckedAt');
  p.hgetall(K.warmupSummary());
  const [client, placementRows, domainRaw, summary] = await p.exec();
  const domain = Array.isArray(domainRaw)
    ? { blacklists: domainRaw[0], blacklist: domainRaw[1], blacklistCheckedAt: domainRaw[2] }
    : (domainRaw || {});
  const bounce = { pause: await cfg(clientId, 'BOUNCE.pause'), max: await cfg(clientId, 'BOUNCE.max') };
  const c = client || {};
  return {
    warmup: warmupPart(summary, await externalStatus(), now),
    placement: placementPart(placementRows),
    blacklists: blacklistPart(domain),
    bounce: {
      rate7d: num(c.bounceRate7d),
      sent7d: num(c.bounceSent7d),
      at: c.bounceRateAt || null,
      pauseAt: num(bounce.pause),
      stopAt: num(bounce.max),
      halved: c.bounceHalved === '1',
    },
    // The Day 1 limits, so the hub's chart lines always match the real settings.
    gates: {
      seedPlacement: num(await cfg(clientId, 'CANARY.gate')),
      mailTesterMin: num(await cfg(clientId, 'PLACEMENT.minScore')),
      spamAssassinMax: num(await cfg(clientId, 'PLACEMENT.maxSpamAssassin')),
      spamTestRequired: Boolean(await cfg(clientId, 'PLACEMENT.gate')),
    },
  };
}
