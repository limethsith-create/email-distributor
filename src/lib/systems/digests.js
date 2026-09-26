/**
 * Owner digests (SPEC §10.2).
 *
 * Morning (08:00 Asia/Colombo, daily): leads with the Price Scout escalations
 * (shopping list not bought 48 h after it was sent, shopping.escalatedAt) and
 * the clients whose Booking Link Tester is still untested (SPEC §6.4 step 7,
 * §6.7 step 4). Then "All green" when nothing is open, or
 * per client each open alert and what the system already did in the last 24
 * hours; plus every promise due today or overdue (Promise Register) and any
 * config drift (overrides that differ from the defaults, SPEC §10.3).
 *
 * Monday (08:00 Asia/Colombo): the KPI numbers from the KPIs SOP — share of
 * finished trials that booked ≥ 1 call, reviews captured, trial-to-paid,
 * extensions running (max KPI.maxExtensions), time per trial from the
 * owner's recorded minutes ("not measured" when nobody recorded any), and the
 * health colour of every live client. Includes `aviance`.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg, globalOverrides, defaultOf } from '@/lib/config';
import { getProfile, getTrial } from '@/lib/db/client';
import { trialDay } from '@/lib/time';
import { clientNow } from '@/lib/testclock';
import { getAllClients } from '@/lib/db/client';
import { getEvents } from '@/lib/db/events';
import { alertOwner, getAlertLog } from '@/lib/notify';
import { dayKeyIn, OWNER_TZ } from '@/lib/time';
import { boardData } from '@/lib/systems/boarddata';
import { promisesDue } from '@/lib/systems/promiseregister';
import { getLedger, cfgTree } from '@/lib/systems/dshared';
import { ALERTS } from '@/lib/templates/owner';
import { isConnected as cheapInboxesConnected } from '@/lib/ext/cheapinboxes';

function didSummary(events, since) {
  const recent = events.filter((e) => e.at && Date.parse(e.at) >= since && e.event !== 'job_error');
  if (!recent.length) return null;
  const parts = [];
  const states = recent.filter((e) => e.system === 'state' && e.event === 'changed').reverse().map((e) => `${e.detail?.from}→${e.detail?.to}`);
  if (states.length) parts.push(`state ${states.join(', ')}`);
  const mails = recent.filter((e) => e.event === 'client_email_sent').map((e) => e.detail?.key).filter(Boolean);
  if (mails.length) parts.push(`emailed ${[...new Set(mails)].join(', ')}`);
  const other = recent.length - states.length - mails.length;
  if (other > 0) parts.push(`${other} other logged step${other === 1 ? '' : 's'}`);
  return parts.join('; ');
}

export async function configDrift() {
  const o = await globalOverrides();
  return Object.entries(o).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaultOf(k))).map(([k, v]) => `${k} = ${JSON.stringify(v)} (default ${JSON.stringify(defaultOf(k))})`);
}

export async function morningDigest({ now = new Date(), send = true } = {}) {
  const clients = await getAllClients();
  // Problems only: news (ALERTS[key].info — a purchase found, a bot answer) is not an open alert to list every morning.
  const alerts = (await getAlertLog(500)).filter((a) => !a.acknowledged && (a.urgent || !ALERTS[a.key]?.info));
  const since = now.getTime() - 24 * 3600_000;
  const ciOn = await cheapInboxesConnected().catch(() => false);
  const sections = [];
  const dueLines = [];
  const topLines = [];
  for (const c of clients) {
    if (c.state === 'deleted' || c.id === 'aviance') continue;
    if (c.state === 'awaiting_purchase') {
      const shop = (await kv.hgetall(K.shopping(c.id))) || {};
      if (shop.escalatedAt && !shop.boughtAt) {
        const hours = shop.sentAt ? Math.floor((now.getTime() - Date.parse(shop.sentAt)) / 3600e3) : null;
        const how = ciOn ? 'Buy them on CheapInboxes — the hub shows exactly what; the machine connects everything after.' : `Paste the logins on /mc/clients/${c.id}/purchase.`;
        topLines.push(`NOT BOUGHT: ${c.name || c.id} — shopping list sent ${hours != null ? `${hours} h ago` : 'earlier'} (${shop.chosenDomain || 'see the list'}). ${how}`);
      }
    }
    if (['warming', 'ready'].includes(c.state)) {
      const profile = await getProfile(c.id);
      const tested = ['1', 'true', 1, true].includes(profile.bookingTested);
      if (!tested && (profile.bookingRequestSentAt || profile.bookingCheckStatus === 'problems')) {
        const day = trialDay(await getTrial(c.id), clientNow(c, now));
        const why = profile.bookingCheckStatus === 'problems' ? 'the link check found problems' : 'the client has not tapped "It worked"';
        topLines.push(`Booking link untested: ${c.name || c.id}${day != null ? ` (Day ${day})` : ''} — ${why}; Day 1 waits for it.`);
      }
    }
  }
  for (const c of clients) {
    if (c.state === 'deleted') continue;
    const open = alerts.filter((a) => a.clientId === c.id);
    const { dueToday, overdue } = await promisesDue(c.id, now);
    for (const p of overdue) dueLines.push(`OVERDUE ${c.name || c.id}: ${p.text} (due ${String(p.dueAt).slice(0, 10)})`);
    for (const p of dueToday) dueLines.push(`Today ${c.name || c.id}: ${p.text}`);
    if (!open.length) continue;
    const did = didSummary(await getEvents(c.id, 300), since);
    sections.push([
      `${c.name || c.id} (${c.state})`,
      ...open.map((a) => `  • ${a.title}${a.urgent ? ' [urgent]' : ''} — ${String(a.at).slice(0, 16).replace('T', ' ')} UTC`),
      `  What the system did (24 h): ${did || 'nothing logged'}`,
    ].join('\n'));
  }
  const globalOpen = alerts.filter((a) => !a.clientId);
  if (globalOpen.length) sections.push(['System', ...globalOpen.map((a) => `  • ${a.title}${a.urgent ? ' [urgent]' : ''}`)].join('\n'));
  const drift = await configDrift();
  const allGreen = sections.length === 0 && dueLines.length === 0 && topLines.length === 0;
  const body = [
    ...(topLines.length ? [...topLines, ''] : []),
    allGreen ? 'All green.' : `${sections.length} client${sections.length === 1 ? '' : 's'} with open alerts${dueLines.length ? `, ${dueLines.length} promise${dueLines.length === 1 ? '' : 's'} due` : ''}.`,
    ...(sections.length ? ['', ...sections] : []),
    ...(dueLines.length ? ['', 'Promises:', ...dueLines.map((l) => `  • ${l}`)] : []),
    ...(drift.length ? ['', 'Config differs from the defaults:', ...drift.map((l) => `  • ${l}`)] : []),
  ].join('\n');
  const date = dayKeyIn(OWNER_TZ, now);
  const res = send ? await alertOwner('morning_digest', { vars: { date }, body, did: allGreen ? 'Nothing needed you.' : 'Every item above is already logged in Mission Control.' }) : null;
  return { allGreen, body, sent: res?.sent ?? false };
}

const share = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}% (${n} of ${d})` : 'no finished trials yet');

export async function mondayDigest({ now = new Date(), send = true } = {}) {
  const kpi = await cfgTree(null, 'KPI');
  const ledger = (await getLedger()).filter((r) => r.id !== '_test');
  const finished = ledger.filter((r) => r.converted === true || r.notNowAt || r.retiredAt);
  const booked = finished.filter((r) => Number(r.booked) > 0).length;
  const reviews = finished.filter((r) => r.reviewCapturedAt).length;
  const paid = finished.filter((r) => r.converted === true).length;
  const board = await boardData(now);
  const extensions = board.extensions;
  const timed = ledger.filter((r) => Number(r.ownerMinutes) > 0);
  const timeLine = timed.length
    ? `${(timed.reduce((a, r) => a + Number(r.ownerMinutes), 0) / timed.length / 60).toFixed(1)} h per trial (from ${timed.length} trial${timed.length === 1 ? '' : 's'} with recorded minutes; target ≤ ${kpi.hoursPerTrial} h)`
    : 'not measured';
  const colours = board.clients.filter((c) => c.state !== 'deleted').map((c) => `  • ${c.health.toUpperCase()} ${c.name} (${c.state}${c.trialDay != null ? `, day ${c.trialDay}` : ''})${c.healthReasons.length ? ` — ${c.healthReasons.join('; ')}` : ''}`);
  const body = [
    `Trials that booked ≥ 1 call: ${share(booked, finished.length)} — target ${Math.round(kpi.bookedShare * 100)}%`,
    `Reviews captured: ${share(reviews, finished.length)} — target ${Math.round(kpi.reviewShare * 100)}%`,
    `Trial to paid: ${share(paid, finished.length)} — target ${Math.round(kpi.paidShare * 100)}%`,
    `Extensions running: ${extensions} — max ${kpi.maxExtensions}${extensions > kpi.maxExtensions ? ' (OVER)' : ''}`,
    `Time per trial: ${timeLine}`,
    '',
    'Health:',
    ...(colours.length ? colours : ['  • no clients']),
  ].join('\n');
  // The owner's own date, like the morning digest: it goes out Monday 08:00 in Sri Lanka, which is
  // still Sunday in the US — "Monday KPIs — <Sunday's date>" read wrong.
  const date = dayKeyIn(OWNER_TZ, now);
  const res = send ? await alertOwner('monday_digest', { vars: { date }, body, did: 'Numbers from stored counters and the trial ledger only.' }) : null;
  return { body, sent: res?.sent ?? false, finished: finished.length };
}
