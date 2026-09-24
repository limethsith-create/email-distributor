/**
 * Canary Test (SPEC §7.7). Each trial inbox sends one plain, marked email to
 * each helper account (up to BUILD.canaryHelpers); at least
 * BUILD.canaryCheckAfterMin later every helper is read over IMAP and the
 * landings counted. placement = landed in Inbox / canary emails sent to the
 * helpers that could be read (a mail that never arrived is not an inbox
 * landing).
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
import { alertOwner } from '@/lib/notify';
import { ET, dayKeyIn, trialDay, partsIn, addDays } from '@/lib/time';
import { getHelpers, HELPER, sendMarked, processMailbox, statsFor, statBump } from '@/lib/systems/warmup';

const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

function member(rec, clientId) {
  return { key: `${clientId}|${rec.email}`, clientId, email: rec.email, provider: rec.provider || 'google', isHelper: clientId === HELPER, record: rec };
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
export async function canaryDue(client, now = new Date()) {
  const trial = await getTrial(client.id);
  const day = trialDay(trial, now);
  const startDay = await cfg(client.id, 'BUILD.canaryGateDay');
  if (day == null || day < startDay) return null;
  const at = await cfg(client.id, 'BUILD.canaryAt');
  const p = partsIn(ET, now);
  if (p.hhmm < at) return null;
  const run = (await kv.hgetall(K.canary(client.id, p.dayKey))) || {};
  if (run.phase === 'done') return null;
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

  if (!run.phase) {
    const nHelpers = await cfg(id, 'BUILD.canaryHelpers');
    const helpers = (await getHelpers()).filter((h) => h.passwordEnc && h.enabled !== '0' && h.health !== 'auth_failed').slice(0, nHelpers);
    const inboxes = (await getInboxRecords(id)).filter((r) => r.passwordEnc && r.warmupEnabled !== '0');
    if (!helpers.length || !inboxes.length) {
      await kv.hset(key, { phase: 'done', startedAt: now.toISOString(), doneAt: now.toISOString(), result: JSON.stringify({ overall: null, reason: !helpers.length ? 'no helper accounts' : 'no inboxes' }) });
      await kv.expire(key, 40 * 86400);
      await alertOwner('canary_incomplete', { clientId: id, vars: { clientId: id }, body: `The canary could not run: ${!helpers.length ? 'there are no working helper accounts' : 'the client has no inboxes'}.`, did: 'No placement was recorded today; Day 1 cannot pass the canary gate without one.' });
      return { phase: 'done', placement: null };
    }
    const queue = [];
    for (const r of inboxes) {
      // The canary counts toward the inbox's warm-up ceiling (15/day, SPEC §14.8).
      const room = HARD_WARMUP_CAP - ((await statsFor(r.email, day)).sent || 0);
      for (const h of helpers.slice(0, Math.max(0, room))) queue.push({ inbox: r.email, helper: h.email, provider: h.provider || 'google' });
    }
    run = { phase: 'sending', tag: `${id}.${day}`, queue: JSON.stringify(queue), sent: '[]', failed: '[]', checked: '[]', landed: '{}', startedAt: now.toISOString() };
    await kv.hset(key, run);
    await kv.expire(key, 40 * 86400);
    await logEvent(id, 'canary', 'started', { inboxes: inboxes.length, helpers: helpers.length, emails: queue.length });
  }

  const giveUpMin = await cfg(id, 'BUILD.canaryGiveUpMin');
  const expired = now.getTime() - Date.parse(run.startedAt) >= giveUpMin * 60e3;

  if (run.phase === 'sending') {
    const queue = parse(run.queue, []);
    const sent = parse(run.sent, []);
    const failed = parse(run.failed, []);
    const perRun = await cfg(id, 'BUILD.canarySendsPerRun');
    const inboxRecs = Object.fromEntries((await getInboxRecords(id)).map((r) => [r.email, r]));
    const helperRecs = Object.fromEntries((await getHelpers()).map((h) => [h.email, h]));
    let n = 0;
    while (queue.length && n < perRun && Date.now() < deadline - 4000) {
      const job = queue.shift();
      n++;
      const from = inboxRecs[job.inbox];
      const to = helperRecs[job.helper];
      if (!from || !to) { failed.push({ ...job, error: 'gone' }); continue; }
      let res;
      try {
        res = await sendMarked(member(from, id), member(to, HELPER), { deps, kind: 'c', tag: run.tag });
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
    const helperRecs = Object.fromEntries((await getHelpers()).map((h) => [h.email, h]));
    const errors = parse(run.errors, {});
    for (const h of helpersToRead.slice(0, perRun)) {
      if (Date.now() > deadline - 5000) break;
      const rec = helperRecs[h];
      if (!rec) { checked.push(h); continue; }
      const r = await processMailbox(member(rec, HELPER), { mode: 'canary', tag: run.tag, now, deadline, deps });
      if (!r.ok) { errors[h] = r.error; continue; }
      checked.push(h);
      const prov = rec.provider || 'google';
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
  const warn = await cfg(id, 'CANARY.warn');
  const emergency = await cfg(id, 'CANARY.emergency');
  const day = dayKeyIn(ET, now);
  await kv.hset(key, { phase: 'done', doneAt: now.toISOString(), result: JSON.stringify(res) });
  for (const [email, row] of Object.entries(res.perInbox)) {
    if (row.placement != null) await patchInbox(id, email, { canaryPlacement: row.placement.toFixed(3), canaryCheckedAt: now.toISOString() });
  }
  await logEvent(id, 'canary', 'done', { overall: res.overall, min: res.min, perProvider: res.perProvider });
  if (res.overall == null) {
    await alertOwner('canary_incomplete', { clientId: id, vars: { clientId: id }, body: 'No canary email could be measured today (sends failed or no helper mailbox could be read).', did: 'No placement was recorded; the Day 1 gate stays closed until one is.' });
    return { phase: 'done', placement: null };
  }
  await updateClient(id, { canaryPlacement: res.overall.toFixed(3), canaryMinPlacement: res.min == null ? '' : res.min.toFixed(3), canaryDay: day });
  const pct = `${Math.round(res.overall * 100)}%`;
  if (res.overall < warn || (res.min != null && res.min < warn)) {
    await alertOwner('placement_low', { clientId: id, vars: { clientId: id, rate: pct }, body: `Canary placement today: ${pct} overall, lowest inbox ${Math.round((res.min ?? 0) * 100)}%.\n${Object.entries(res.perInbox).map(([e, r]) => `${e}: ${r.inbox}/${r.sent}`).join('\n')}`, did: SENDING_STATES.has(client.state) ? 'Logged; the Emergency Runner is asked to act if any inbox is under the emergency line.' : 'Day 1 cannot start until every inbox is at the gate line.' });
  }
  if (res.min != null && res.min < emergency && SENDING_STATES.has(client.state)) {
    await updateClient(id, { emergencyRequested: 'canary', emergencyRequestedAt: now.toISOString() });
    await logEvent(id, 'canary', 'emergency_requested', { min: res.min });
  }
  return { phase: 'done', placement: res.overall, min: res.min };
}

/** Latest finished canary (today or yesterday) → { day, overall, min, perInbox } or null. */
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
