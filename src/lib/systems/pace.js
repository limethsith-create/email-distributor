/**
 * Pace Checks + rescue moves (SPEC §8.9). 18:00 ET on trial Days 3, 7, 12,
 * 15, 20, 25. Each check reads stored counters only, applies its fix
 * automatically, and logs the applied fix to client:{id}:pacelog for the
 * Friday update's "what we changed" line. No check ever changes the segment
 * or the profile.
 *
 *   3  bounce > 3 % of the first 50, or placement < 85 %  → Emergency Runner
 *   7  reply rate < 1 % of sends                          → backup subject + first line (version 2)
 *   12 positive = 0                                       → best variant only + narrow to the best city/size slice
 *   15 qualified = 0                                      → offpace_day15 + gaps 3-2-3 + early send time
 *   20 positive ≥ 3 and booked = 0                        → soft interested reply + nudge at +2 days
 *   25 held ≥ 1 and wrongfit ≥ 1                          → drop the wrong-fit size band / title from new sends
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getProfile, getTrial } from '@/lib/db/client';
import { getLead } from '@/lib/db/leads';
import { requireCounters } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { trialDay } from '@/lib/time';
import { clientStats, bestOf } from '@/lib/systems/learning';
import { getBookings } from '@/lib/systems/bookings';
import { notifyClientSafe } from '@/lib/systems/outbound';
import { alert, isTrialClient, lower, parseJson, nicheOf, ccfg } from '@/lib/systems/stagec-common';

const pct = (n) => `${Math.round(n * 1000) / 10}%`;

async function logFix(clientId, entry) {
  const rec = { at: new Date().toISOString(), ...entry };
  const p = kv.pipeline();
  p.lpush(K.pacelog(clientId), rec);
  p.ltrim(K.pacelog(clientId), 0, 199);
  await p.exec();
  await logEvent(clientId, 'pace', 'fix_applied', rec);
  return rec;
}

export async function getPaceLog(clientId, limit = 50) {
  try { return (await kv.lrange(K.pacelog(clientId), 0, limit - 1)) || []; } catch { return []; }
}

/** Load a backup sequence for the niche (Stage B file templates/sequence/{niche}.backup.json). */
export async function loadBackupSequence(niche) {
  for (const name of [niche, 'default']) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    try {
      const mod = await import(`@/lib/templates/sequence/${name}.backup.json`);
      if (mod && mod.default) return mod.default;
    } catch {}
  }
  return null;
}

/** The four questions of the trial doc §7, first failing one, in plain words. */
export function diagnose(t, { bounceMax = 0.02, replyMin = 0.015, positiveMin = 0.01 } = {}) {
  const sent = t.sent || 0;
  if (sent && t.bounces / sent >= bounceMax) return 'the emails are not landing reliably (bounces are over the 2% line).';
  if (sent && t.replies / sent < replyMin) return 'the message or the list: too few people are answering.';
  if (sent && t.positive / sent < positiveMin) return 'the offer or the market: people answer, but few want it.';
  return 'positive replies are not turning into meetings — the booking step.';
}

const FIELDS = ['sent', 'bounces', 'replies', 'positive', 'booked', 'held', 'qualified', 'wrongfit', 'companiesContacted'];

/**
 * Run the check for the client's current trial day. Returns { day, test, fix }.
 * `force` = { day } lets tests and Mission Control run a specific day.
 */
export async function runPace(clientId, { now = new Date(), day: forced = null } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const [client, trial, profile] = await Promise.all([getClient(clientId), getTrial(clientId), getProfile(clientId)]);
  const day = forced ?? trialDay(trial, now);
  const days = await ccfg(clientId, 'PACE.days');
  if (!days.includes(day)) return { skipped: `day ${day} is not a pace day` };
  const req = await requireCounters(clientId, FIELDS);
  if (!req.ok) {
    await alert('report_blocked', { clientId, scope: `${clientId}:pace:${day}`, vars: { clientId, report: `pace day ${day}` }, body: `Pace check Day ${day} for ${clientId} cannot run: counters missing (${req.missing.join(', ')}).`, did: 'No fix applied (numbers are never guessed).' });
    return { day, blocked: req.missing };
  }
  const t = req.values;
  const rate = (n) => (t.sent ? n / t.sent : 0);

  if (day === 3) {
    const bounceRate = rate(t.bounces);
    const placement = client.canaryPlacement !== undefined && client.canaryPlacement !== '' ? Number(client.canaryPlacement) : null;
    const gate = await ccfg(clientId, 'CANARY.gate');
    const smokeMax = await ccfg(clientId, 'SEND.smokeTestBounceMax');
    const fail = bounceRate > smokeMax ? `bounce ${pct(bounceRate)} of ${t.sent}` : (placement !== null && placement < gate ? `placement ${pct(placement)}` : null);
    if (!fail) return { day, test: 'pass' };
    await kv.hset(K.client(clientId), { emergencyRequested: 'pace_day3', emergencyRequestedAt: now.toISOString() });
    return { day, test: fail, fix: await logFix(clientId, { day, test: fail, fix: 'Emergency Runner started (stop, re-verify, re-test)' }) };
  }

  if (day === 7) {
    const min = await ccfg(clientId, 'PACE.replyMin');
    if (rate(t.replies) >= min) return { day, test: 'pass' };
    const backup = await loadBackupSequence(nicheOf(client || {}, profile));
    if (!backup) {
      await alert('copy_blocked', { clientId, scope: `${clientId}:backup`, vars: { clientId, rule: 'no backup copy file' }, body: `Pace Day 7: reply rate ${pct(rate(t.replies))} is under ${pct(min)}, but there is no templates/sequence/{niche}.backup.json to switch to.`, did: 'Nothing changed. Add the backup copy file.' });
      return { day, test: `reply rate ${pct(rate(t.replies))}`, fix: null };
    }
    const cur = (await kv.hgetall(K.sequence(clientId))) || {};
    const a = backup.variantA || (backup.touches ? backup : null);
    const b = backup.variantB || a;
    const fields = { variantA: JSON.stringify(a), variantB: JSON.stringify(b), version: 2, versionChangedAt: now.toISOString(), versionChangedBy: 'pace_day7' };
    if (cur.variantA) fields.variantA_v1 = typeof cur.variantA === 'string' ? cur.variantA : JSON.stringify(cur.variantA);
    if (cur.variantB) fields.variantB_v1 = typeof cur.variantB === 'string' ? cur.variantB : JSON.stringify(cur.variantB);
    await kv.hset(K.sequence(clientId), fields);
    return { day, test: `reply rate ${pct(rate(t.replies))}`, fix: await logFix(clientId, { day, test: `reply rate ${pct(rate(t.replies))} < ${pct(min)}`, fix: 'New sends use the backup subject line and first line (sequence version 2)' }) };
  }

  if (day === 12) {
    if (t.positive > 0) return { day, test: 'pass' };
    const stats = await clientStats(clientId);
    const cur = (await kv.hgetall(K.sequence(clientId))) || {};
    const version = Number(cur.version) || 1;
    const rr = (v) => { const r = stats.variants[`${v}${version}`] || stats.variants[`${v}1`]; return r && r.sends ? r.replies / r.sends : -1; };
    const best = rr('B') > rr('A') ? 'B' : 'A';
    await kv.hset(K.sequence(clientId), { active: best, activeChangedBy: 'pace_day12', activeChangedAt: now.toISOString() });
    const minSends = 10;
    const city = bestOf(stats.cities, minSends);
    const size = bestOf(stats.sizes, minSends);
    const slice = [city && { field: 'city', value: city.name, replyRate: city.replyRate }, size && { field: 'sizeBand', value: size.name, replyRate: size.replyRate }].filter(Boolean).sort((x, y) => y.replyRate - x.replyRate)[0] || null;
    if (slice && slice.replyRate > 0) await kv.hset(K.pace(clientId), { narrowSlice: JSON.stringify({ field: slice.field, value: slice.value }) });
    const sliceText = slice && slice.replyRate > 0 ? `; new sends lead with ${slice.field === 'city' ? slice.value : `${slice.value} staff`} (best reply rate so far)` : '; no slice has replies yet, so the list order is unchanged';
    return { day, test: 'positive = 0', fix: await logFix(clientId, { day, test: 'zero positive replies', fix: `Both inboxes moved onto variant ${best}${sliceText}` }) };
  }

  if (day === 15) {
    if (t.qualified > 0) return { day, test: 'pass' };
    await kv.hset(K.pace(clientId), { compressed: '1', earlySend: '1' });
    const fix = 'remaining follow-ups tightened to 3-2-3 days and sends moved to early morning in each prospect’s time zone';
    const bounceMax = await ccfg(clientId, 'BOUNCE.max');
    const positiveMin = await ccfg(clientId, 'PACE.positiveMin');
    const vars = { companies: t.companiesContacted, replies: t.replies, positive: t.positive, diagnosis: diagnose(t, { bounceMax, positiveMin }), fix };
    await notifyClientSafe(clientId, 'offpace_day15', vars, { dedupe: 'offpace_day15' });
    return { day, test: 'qualified = 0', fix: await logFix(clientId, { day, test: 'zero qualified calls at half-time', fix: `${fix}; offpace_day15 sent to the client` }) };
  }

  if (day === 20) {
    if (!(t.positive >= 3 && t.booked === 0)) return { day, test: 'pass' };
    await kv.hset(K.pace(clientId), { softInterested: '1' });
    return { day, test: `positive ${t.positive}, booked 0`, fix: await logFix(clientId, { day, test: `${t.positive} positive replies, 0 booked`, fix: 'Interested replies now offer a 15-minute “worth a look?” call, with a follow-up nudge after 2 days' }) };
  }

  if (day === 25) {
    if (!(t.held >= 1 && t.wrongfit >= 1)) return { day, test: 'pass' };
    const bookings = Object.values(await getBookings(clientId)).filter((b) => b.status === 'wrongfit' && b.leadEmail);
    const sizeBands = new Set();
    const titles = new Set();
    for (const b of bookings) {
      const lead = await getLead(clientId, b.leadEmail);
      if (lead?.sizeBand) sizeBands.add(lead.sizeBand);
      if (lead?.title) titles.add(lower(lead.title));
    }
    const existing = parseJson((await kv.hget(K.pace(clientId), 'exclude')), {}) || {};
    const exclude = { sizeBands: [...new Set([...(existing.sizeBands || []), ...sizeBands])], titles: [...new Set([...(existing.titles || []), ...titles])] };
    await kv.hset(K.pace(clientId), { exclude: JSON.stringify(exclude) });
    const what = [exclude.sizeBands.length && `size band ${exclude.sizeBands.join(', ')}`, exclude.titles.length && `title ${exclude.titles.join(', ')}`].filter(Boolean).join(' and ') || 'nothing (the wrong-fit calls had no size or title on file)';
    return { day, test: `held ${t.held}, wrongfit ${t.wrongfit}`, fix: await logFix(clientId, { day, test: `${t.wrongfit} wrong-fit call(s)`, fix: `New sends skip ${what}; noted for the Day 29 report` }) };
  }
  return { day, test: 'no check' };
}
