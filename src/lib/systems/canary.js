/**
 * Canary Test (SPEC §7.7). Each trial inbox sends one plain, marked email to
 * each seed mailbox (up to BUILD.canaryHelpers); at least
 * BUILD.canaryCheckAfterMin later every seed is read over IMAP and the
 * landings counted. placement = landed in Inbox / canary emails sent to the
 * seeds that could be read (a mail that never arrived is not an inbox
 * landing).
 *
 * Seeds (docs/IMPROVE-PASS.md D): the working helper accounts first, then —
 * while there are fewer than BUILD.canaryHelpers — other members of the
 * warm-up circle on another domain (the aviance inboxes, other trials'
 * inboxes; never the client's own). Before, only helpers counted, so a circle
 * made of other inboxes held Day 1 until the owner added helpers. With fewer
 * seeds than usual, seeds that are not helpers, or one mail filter only, the
 * result carries a plain `note` (first in the placement entry's detail).
 *
 * Runs daily from 07:30 ET, from Day −3 (the gate) onwards, as a small state
 * machine in client:{id}:canary:{day} so every tick does bounded work:
 * sending (a few SMTP sends per run) → waiting (15 min) → checking (a couple
 * of helper mailboxes per run) → done.
 *
 * Outputs: inbox `canaryPlacement`, client `canaryPlacement` (overall),
 * `canaryMinPlacement`, `canaryDay`. Alerts placement_low (< CANARY.warn).
 * Below CANARY.emergency while sending → client `emergencyRequested = canary`
 * for Stage C's Emergency Runner.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, HARD_WARMUP_CAP } from '@/lib/config';
import { getTrial, updateClient, SENDING_STATES } from '@/lib/db/client';
import { getInboxRecords, patchInbox } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { ackAlerts, alertOwner } from '@/lib/notify';
import { ET, dayKeyIn, trialDay, partsIn, addDays } from '@/lib/time';
import { getHelpers, getPool, HELPER, AVIANCE, sendMarked, processMailbox, statsFor, statBump } from '@/lib/systems/warmup';
import { recordPlacement } from '@/lib/systems/placement';
import { familyOf, PROVIDERS } from '@/lib/smtp-providers';

const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

function member(rec, clientId) {
  return { key: `${clientId}|${rec.email}`, clientId, email: rec.email, provider: rec.provider || 'google', isHelper: clientId === HELPER, record: rec };
}

const domainOf = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';
/** Under this many seeds the canary still runs (as before), but its note says the number is thin. */
export const THIN_SEEDS = 4;

/**
 * Today's seed mailboxes for a client, from the warm-up circle as getPool
 * reads it: the working helpers first, then the aviance inboxes, then other
 * trials' inboxes — never the client's own or one on its domain, never one
 * whose warm-up login failed — up to `want`.
 * → [{ email, clientId, provider, isHelper }]
 */
export async function canarySeeds(clientId, { now = new Date(), want = 10, pool = null } = {}) {
  const own = new Set((await getInboxRecords(clientId)).map((r) => domainOf(r.email)));
  const members = pool || (await getPool({ now, sync: false }));
  const rank = (m) => (m.isHelper ? 0 : m.isAviance || m.clientId === AVIANCE ? 1 : 2);
  return members
    .filter((m) => m.clientId !== clientId && !own.has(domainOf(m.email)) && m.record?.warmupHealth !== 'auth_failed')
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, Math.max(0, Number(want) || 0))
    .map((m) => ({ email: m.email, clientId: m.clientId, provider: m.provider || m.record?.provider || 'google', isHelper: Boolean(m.isHelper) }));
}

/**
 * Whether today's canary is low enough to wake the owner (pure). An inbox is
 * tested with only a handful of seed emails (often 8), so one inbox with two
 * of them in spam reads 75% on a normal day. The urgent alert therefore
 * needs one of: the whole run under `warn` (every email counted — the bigger
 * sample); an inbox under `warn` today AND on its last canary day; or an
 * inbox under `emergency` with at least 3 emails missing the inbox. A one-day
 * dip of one inbox is only logged (`dips`). The Day 1 gate and the Emergency
 * Runner keep their own lines — this only decides the alert.
 * → { alert: boolean, dips: string[] }
 */
export function placementLow(res, prev = {}, { warn = 0.85, emergency = 0.70 } = {}) {
  if (!res || res.overall == null) return { alert: false, dips: [] };
  let alert = res.overall < warn;
  const dips = [];
  for (const [email, row] of Object.entries(res.perInbox || {})) {
    if (row.placement == null || row.placement >= warn) continue;
    const missed = Math.max(0, (Number(row.sent) || 0) - (Number(row.inbox) || 0));
    const before = prev[email];
    if ((before != null && Number.isFinite(before) && before < warn) || (row.placement < emergency && missed >= 3)) alert = true;
    else dips.push(email);
  }
  return { alert, dips: alert ? [] : dips };
}

/**
 * The plain note on a canary run (pure): fewer seeds than `want`, seeds that
 * are not helpers, or one mail filter only. null for `want` helpers on more
 * than one filter.
 */
export function canaryNote(seeds, want = 10, { enough = 8 } = {}) {
  const n = (seeds || []).length;
  if (!n) return null;
  const helpers = seeds.filter((x) => x.isHelper !== false).length;
  const others = n - helpers;
  const families = new Set(seeds.map((x) => familyOf(x.provider || 'google')));
  // `enough` = the warm-up circle's minimum (WARMUP.minPool): the helpers the hub asks the owner for. At that many
  // helpers on more than one filter there is nothing to say — the note is for a test that really was thin.
  const target = Math.max(1, Math.min(want, enough));
  if (helpers >= target && families.size > 1) return null;
  const who = !others ? ''
    : !helpers ? ' (other inboxes in the warm-up circle — no warm-up helpers yet)'
      : ` (${helpers} warm-up helper${helpers === 1 ? '' : 's'} and ${others} other inbox${others === 1 ? '' : 'es'} in the warm-up circle)`;
  const parts = [`Tested with ${n} mailbox${n === 1 ? '' : 'es'}${who}${n < target ? ` — ${target} or more gives a steadier number` : ''}.`];
  if (n < THIN_SEEDS) parts.push(`With fewer than ${THIN_SEEDS}, one email in spam moves the rate a lot — add warm-up helpers for a steadier number.`);
  if (families.size === 1 && n > 1) {
    const p = seeds[0].provider || 'google';
    const name = familyOf(p) === familyOf('google') ? 'Gmail / Google Workspace' : PROVIDERS[p]?.helperLabel || PROVIDERS[p]?.label || p;
    parts.push(`All of them use the same mail filter (${name}), so other providers were not tested.`);
  }
  return parts.join(' ');
}

/**
 * A run's seeds by address, ready for sendMarked / processMailbox: helpers
 * from their records, circle inboxes from their client's records. A run
 * started before seeds were stored used the helpers only.
 */
async function seedsOf(run) {
  const seeds = parse(run.seeds, null);
  const helpers = Object.fromEntries((await getHelpers()).map((h) => [h.email, h]));
  if (!Array.isArray(seeds)) return Object.fromEntries(Object.entries(helpers).map(([e, rec]) => [e, member(rec, HELPER)]));
  const out = {};
  const byClient = {};
  for (const x of seeds) {
    if (x.isHelper || x.clientId === HELPER) { if (helpers[x.email]) out[x.email] = member(helpers[x.email], HELPER); continue; }
    byClient[x.clientId] ||= Object.fromEntries((await getInboxRecords(x.clientId).catch(() => [])).map((r) => [r.email, r]));
    const rec = byClient[x.clientId][x.email];
    if (rec?.passwordEnc) out[x.email] = member(rec, x.clientId);
  }
  return out;
}

/** Pure: placement per inbox from sends + checks. */
export function computePlacement({ sent = [], checked = [], landed = {} }) {
  const readable = new Set(checked);
  const perInbox = {};
  const perProvider = {};
  for (const s of sent) {
    if (!readable.has(s.helper)) continue;
    const row = (perInbox[s.inbox] ||= { sent: 0, inbox: 0, spam: 0 });
    row.sent++;
    const prov = (perProvider[s.provider || 'unknown'] ||= { sent: 0, inbox: 0 });
    prov.sent++;
  }
  for (const [key, c] of Object.entries(landed)) {
    const [inbox, provider] = key.split('>');
    if (!perInbox[inbox]) continue;
    perInbox[inbox].inbox += c.inbox || 0;
    perInbox[inbox].spam += c.spam || 0;
    if (perProvider[provider]) perProvider[provider].inbox += c.inbox || 0;
  }
  let tot = 0;
  let ok = 0;
  let min = null;
  for (const row of Object.values(perInbox)) {
    row.inbox = Math.min(row.inbox, row.sent);
    row.placement = row.sent ? row.inbox / row.sent : null;
    tot += row.sent;
    ok += row.inbox;
    if (row.placement != null) min = min == null ? row.placement : Math.min(min, row.placement);
  }
  for (const p of Object.values(perProvider)) p.placement = p.sent ? Math.min(p.inbox, p.sent) / p.sent : null;
  return { perInbox, perProvider, overall: tot ? ok / tot : null, min };
}

/** Is the canary due for this client now? (period for the scheduler, else null) */
/**
 * Due every 5 minutes from BUILD.canaryAt until today's canary is settled
 * (client.canaryCheckedDay = today: finished, or not a canary day yet).
 * Reads nothing beyond the client hash the tick already loaded; the trial
 * day gate (Day −3 onwards) is checked by the run, once a day.
 */
export async function canaryDue(client, now = new Date()) {
  const at = await cfg(client.id, 'BUILD.canaryAt');
  const p = partsIn(ET, now);
  if (p.hhmm < at) return null;
  if (client.canaryCheckedDay === p.dayKey) return null;
  const m = Math.floor(p.minuteOfDay / 5) * 5;
  return `${p.dayKey}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * One bounded step of today's canary for a client.
 */
export async function runCanary({ client, now = new Date(), deadline = Date.now() + 15_000, deps = {} } = {}) {
  const id = client.id;
  const day = dayKeyIn(ET, now);
  const key = K.canary(id, day);
  let run = (await kv.hgetall(key)) || {};
  if (run.phase === 'done') { await updateClient(id, { canaryCheckedDay: day }); return { phase: 'done' }; }

  if (!run.phase) {
    // Canary days start at the Day −3 gate (BUILD.canaryGateDay).
    const tday = trialDay(await getTrial(id), now);
    const startDay = await cfg(id, 'BUILD.canaryGateDay');
    if (tday == null || tday < startDay) {
      await updateClient(id, { canaryCheckedDay: day });
      return { skipped: `trial day ${tday} is before the canary gate (Day ${startDay})` };
    }
    const want = await cfg(id, 'BUILD.canaryHelpers');
    const seeds = await canarySeeds(id, { now, want });
    const inboxes = (await getInboxRecords(id)).filter((r) => r.passwordEnc && r.warmupEnabled !== '0');
    if (!seeds.length || !inboxes.length) {
      await kv.hset(key, { phase: 'done', startedAt: now.toISOString(), doneAt: now.toISOString(), result: JSON.stringify({ overall: null, reason: !seeds.length ? 'no helper accounts and no other inbox in the warm-up circle' : 'no inboxes' }) });
      await kv.expire(key, 40 * 86400);
      await updateClient(id, { canaryCheckedDay: day });
      await alertOwner('canary_incomplete', { clientId: id, vars: { clientId: id }, body: `The canary could not run: ${!seeds.length ? 'there are no working helper accounts and no other inbox in the warm-up circle to test with (add helpers in Settings › Warm-up)' : 'the client has no inboxes'}.`, did: 'No placement was recorded today; Day 1 cannot pass the canary gate without one.' });
      return { phase: 'done', placement: null };
    }
    const queue = [];
    for (const r of inboxes) {
      // The canary counts toward the inbox's warm-up ceiling (15/day, SPEC §14.8).
      const room = HARD_WARMUP_CAP - ((await statsFor(r.email, day)).sent || 0);
      for (const h of seeds.slice(0, Math.max(0, room))) queue.push({ inbox: r.email, helper: h.email, provider: h.provider || 'google' });
    }
    run = { phase: 'sending', tag: `${id}.${day}`, queue: JSON.stringify(queue), seeds: JSON.stringify(seeds), want: String(want), sent: '[]', failed: '[]', checked: '[]', landed: '{}', startedAt: now.toISOString() };
    await kv.hset(key, run);
    await kv.expire(key, 40 * 86400);
    await logEvent(id, 'canary', 'started', { inboxes: inboxes.length, helpers: seeds.filter((x) => x.isHelper).length, seeds: seeds.length, emails: queue.length });
  }

  const giveUpMin = await cfg(id, 'BUILD.canaryGiveUpMin');
  const expired = now.getTime() - Date.parse(run.startedAt) >= giveUpMin * 60e3;

  if (run.phase === 'sending') {
    const queue = parse(run.queue, []);
    const sent = parse(run.sent, []);
    const failed = parse(run.failed, []);
    const perRun = await cfg(id, 'BUILD.canarySendsPerRun');
    const inboxRecs = Object.fromEntries((await getInboxRecords(id)).map((r) => [r.email, r]));
    const seedMembers = await seedsOf(run);
    let n = 0;
    while (queue.length && n < perRun && Date.now() < deadline - 4000) {
      const job = queue.shift();
      n++;
      const from = inboxRecs[job.inbox];
      const to = seedMembers[job.helper];
      if (!from || !to) { failed.push({ ...job, error: 'gone' }); continue; }
      let res;
      try {
        res = await sendMarked(member(from, id), to, { deps, kind: 'c', tag: run.tag });
      } catch (err) {
        res = { success: false, error: err.message };
      }
      if (res.success) {
        sent.push(job);
        await statBump(job.inbox, 'sent', 1, now);
      } else {
        failed.push({ ...job, error: String(res.error || '').slice(0, 120) });
      }
    }
    const fields = { queue: JSON.stringify(queue), sent: JSON.stringify(sent), failed: JSON.stringify(failed) };
    if (!queue.length) Object.assign(fields, { phase: 'waiting', sentDoneAt: now.toISOString() });
    await kv.hset(key, fields);
    return { phase: fields.phase || 'sending', sent: sent.length, failed: failed.length };
  }

  if (run.phase === 'waiting') {
    const after = await cfg(id, 'BUILD.canaryCheckAfterMin');
    if (now.getTime() - Date.parse(run.sentDoneAt) < after * 60e3) return { phase: 'waiting' };
    await kv.hset(key, { phase: 'checking' });
    run.phase = 'checking';
  }

  if (run.phase === 'checking') {
    const sent = parse(run.sent, []);
    const checked = parse(run.checked, []);
    const landed = parse(run.landed, {});
    const helpersToRead = [...new Set(sent.map((s) => s.helper))].filter((h) => !checked.includes(h));
    const perRun = await cfg(id, 'BUILD.canaryChecksPerRun');
    const seedMembers = await seedsOf(run);
    const errors = parse(run.errors, {});
    for (const h of helpersToRead.slice(0, perRun)) {
      if (Date.now() > deadline - 5000) break;
      const seed = seedMembers[h];
      if (!seed) { checked.push(h); continue; }
      const r = await processMailbox(seed, { mode: 'canary', tag: run.tag, now, deadline, deps });
      if (!r.ok) { errors[h] = r.error; continue; }
      checked.push(h);
      const prov = seed.record.provider || 'google';
      for (const [sender, c] of Object.entries(r.bySender)) {
        const k = `${sender}>${prov}`;
        const row = (landed[k] ||= { inbox: 0, spam: 0 });
        row.inbox += c.inbox || 0;
        row.spam += c.spam || 0;
      }
    }
    await kv.hset(key, { checked: JSON.stringify(checked), landed: JSON.stringify(landed), errors: JSON.stringify(errors) });
    const remaining = helpersToRead.filter((h) => !checked.includes(h));
    if (remaining.length && !expired) return { phase: 'checking', checked: checked.length, remaining: remaining.length };
    return finalize({ client, run: { ...run, sent: JSON.stringify(sent), checked: JSON.stringify(checked), landed: JSON.stringify(landed), errors: JSON.stringify(errors) }, key, now });
  }

  if (expired && run.phase !== 'done') return finalize({ client, run, key, now });
  return { phase: run.phase };
}

async function finalize({ client, run, key, now }) {
  const id = client.id;
  const res = computePlacement({ sent: parse(run.sent, []), checked: parse(run.checked, []), landed: parse(run.landed, {}) });
  // How many mailboxes it tested with, and a plain note when that was thin (runs from before seeds were stored: none).
  const seeds = parse(run.seeds, null);
  if (Array.isArray(seeds)) {
    res.seeds = seeds.length;
    const note = canaryNote(seeds, Number(run.want) || seeds.length, { enough: Number(await cfg(id, 'WARMUP.minPool')) || 8 });
    if (note) res.note = note;
  }
  const warn = await cfg(id, 'CANARY.warn');
  const emergency = await cfg(id, 'CANARY.emergency');
  const day = dayKeyIn(ET, now);
  await kv.hset(key, { phase: 'done', doneAt: now.toISOString(), result: JSON.stringify(res) });
  await updateClient(id, { canaryCheckedDay: day });
  // Each inbox's result from its last canary day, read before today's replaces it (for the dip rule below).
  const prev = Object.fromEntries((await getInboxRecords(id)).map((r) => [r.email, r.canaryPlacement === '' || r.canaryPlacement == null ? null : Number(r.canaryPlacement)]));
  for (const [email, row] of Object.entries(res.perInbox)) {
    if (row.placement != null) await patchInbox(id, email, { canaryPlacement: row.placement.toFixed(3), canaryCheckedAt: now.toISOString() });
  }
  await logEvent(id, 'canary', 'done', { overall: res.overall, min: res.min, perProvider: res.perProvider });
  if (res.overall == null) {
    await alertOwner('canary_incomplete', { clientId: id, vars: { clientId: id }, body: 'No canary email could be measured today (sends failed or no helper mailbox could be read).', did: 'No placement was recorded; the Day 1 gate stays closed until one is.' });
    return { phase: 'done', placement: null };
  }
  await updateClient(id, { canaryPlacement: res.overall.toFixed(3), canaryMinPlacement: res.min == null ? '' : res.min.toFixed(3), canaryDay: day });
  // The seed test joins the client's placement history (hub: deliverability.placement).
  await recordPlacement(id, {
    at: now.toISOString(), day, tool: 'seed', inbox: null, score: null,
    inboxRate: Math.round(res.overall * 1000) / 1000,
    detail: [
      ...(res.note ? [res.note] : []),
      ...Object.entries(res.perProvider || {}).map(([p, r]) => `${p}: ${r.placement == null ? 'not read' : `${Math.round(r.placement * 100)}% inbox`} (${Math.min(r.inbox, r.sent)}/${r.sent})`),
      ...Object.entries(res.perInbox || {}).map(([e, r]) => `${e}: ${r.inbox}/${r.sent} in the inbox`),
    ],
    reportUrl: null,
  }).catch(() => {});
  const pct = `${Math.round(res.overall * 100)}%`;
  const low = placementLow(res, prev, { warn, emergency });
  // A good day again: yesterday's placement_low (urgent) is handled.
  if (!(res.overall < warn || (res.min != null && res.min < warn))) await ackAlerts(id, ['placement_low'], { reason: 'canary placement back above the line', now });
  if (low.dips.length) await logEvent(id, 'canary', 'dip', { inboxes: low.dips, note: 'one inbox under the line on one day only — watched, not alerted (a second day under it alerts)' });
  if (low.alert) {
    await alertOwner('placement_low', { clientId: id, vars: { clientId: id, rate: pct }, body: `Canary placement today: ${pct} overall, lowest inbox ${Math.round((res.min ?? 0) * 100)}%.\n${Object.entries(res.perInbox).map(([e, r]) => `${e}: ${r.inbox}/${r.sent}`).join('\n')}`, did: SENDING_STATES.has(client.state) ? 'Logged; the Emergency Runner is asked to act if any inbox is under the emergency line.' : 'Day 1 cannot start until every inbox is at the gate line.' });
  }
  if (res.min != null && res.min < emergency && SENDING_STATES.has(client.state)) {
    await updateClient(id, { emergencyRequested: 'canary', emergencyRequestedAt: now.toISOString() });
    await logEvent(id, 'canary', 'emergency_requested', { min: res.min });
  }
  return { phase: 'done', placement: res.overall, min: res.min };
}

/** Latest finished canary (today or yesterday) → { day, overall, min, perInbox, seeds?, note? } or null. */
/** The newest finished canary run before `day` (within `lookback` days), or null — the Day 1 gate pools it with the latest. */
export async function priorCanary(clientId, day, { lookback = 3 } = {}) {
  for (let i = 1; i <= lookback; i++) {
    const d = addDays(day, -i);
    const run = (await kv.hgetall(K.canary(clientId, d))) || {};
    if (run.phase === 'done') return { day: d, ...parse(run.result, {}) };
  }
  return null;
}

/**
 * The Day 1 gate's reading of the seed test (pure). One run tests each inbox
 * with only a handful of emails (often 8), so one normal day can read 6 of 8.
 * The gate therefore pools the latest run with the one before it (the canary
 * runs daily from Day −3): every inbox, and the whole run, must reach `gate`
 * over both runs together — and the latest run alone must be at least
 * `emergency` for every inbox, so a collapse today is never averaged away.
 * With no earlier run it is the latest run alone, as strict as before.
 * → { ok, overall, perInbox: { email: { latest, pooled, sent } }, pooled: boolean }
 */
export function gateCanary(latest, prior = null, { gate = 0.85, emergency = 0.70 } = {}) {
  const out = { ok: false, overall: null, perInbox: {}, pooled: false };
  const rows = latest?.perInbox ? Object.entries(latest.perInbox) : [];
  if (!rows.length) return out;
  let inbox = 0;
  let sent = 0;
  let ok = true;
  for (const [email, row] of rows) {
    const before = prior?.perInbox?.[email];
    const both = before && Number(before.sent) > 0 && row.placement != null;
    const s = (Number(row.sent) || 0) + (both ? Number(before.sent) : 0);
    const n = Math.min(Number(row.inbox) || 0, Number(row.sent) || 0) + (both ? Math.min(Number(before.inbox) || 0, Number(before.sent)) : 0);
    const pooled = row.placement == null || !s ? null : n / s;
    if (both) out.pooled = true;
    out.perInbox[email] = { latest: row.placement ?? null, pooled, sent: s };
    if (row.placement == null || row.placement < emergency || pooled == null || pooled < gate) ok = false;
    if (pooled != null) { inbox += n; sent += s; }
  }
  out.overall = sent ? inbox / sent : null;
  out.ok = ok && out.overall != null && out.overall >= gate;
  return out;
}

export async function latestCanary(clientId, now = new Date()) {
  const today = dayKeyIn(ET, now);
  for (const d of [today, addDays(today, -1)]) {
    const run = (await kv.hgetall(K.canary(clientId, d))) || {};
    if (run.phase === 'done') {
      const r = parse(run.result, {});
      return { day: d, ...r };
    }
  }
  return null;
}
