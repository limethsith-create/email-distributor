/**
 * The "we start on …" email (docs/IMPROVE-PASS.md C.3) — the owner's words:
 * "Then an email saying we start at this time."
 *
 * Template `welcome_two_dates` (the key and its first vars are kept; the
 * words are the templates' own). Sent ONCE per Day 1, when Day 1 is fixed:
 * the readiness gate turned green and the trial is `ready` (systems/
 * readiness.js) — never at the setup check any more, when Day 1 was only the
 * ramp's estimate. In their daytime (08:00–20:00 in their zone): a gate that
 * turns green at night leaves it to the `welcome` job in the morning
 * (client hash intakeStep 'welcome'). When Day 1 moves, `day1_moved` goes
 * instead with the same facts (readiness.announceMove passes startVars), and
 * a move that happens as the gate turns green IS the start email for that
 * date (trial `startEmailFor`).
 *
 * The facts it carries (startVars), all in their zone: the date, the first
 * send moment, the sending window, the name and inbox the prospects will see.
 * Tracked and watched like every milestone email (systems/mailwatch.js).
 */

import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getTrial, getProfile, updateClient } from '@/lib/db/client';
import { getInboxRecords } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { io, sendClient, firstNameOf, ownerName, formatDay } from '@/lib/systems/intake-io';
import { zonedToUtc } from '@/lib/systems/stagec-common';
import { partsIn, addDays, ET } from '@/lib/time';

const SYSTEM = 'startemail';
/** Client states in which Day 1 is fixed (the gate was green). */
export const FIXED_STATES = new Set(['ready', 'sending']);
/** Their daytime: when an automatic email to them may go. */
export const DAYTIME = ['08:00', '20:00'];

/** 08:00–20:00 on their own clock? */
export function inTheirDaytime(now, tz = ET) {
  const p = partsIn(tz, now);
  return p.hhmm >= DAYTIME[0] && p.hhmm < DAYTIME[1];
}

/** '9:00' → '9:00 am', '17:00' → '5:00 pm'. */
export function clockWord(hhmm) {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** 'a and b', 'a, b and c'. */
const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The facts of the start, pure (docs/IMPROVE-PASS.md C.3). `window` =
 * SEND.windowLeadTz (in each prospect's own zone); the first send is Day 1 at
 * its start, US Eastern (the Sender's clock), written in their zone by `when`
 * ({ zoneName, text(t), clock(t) } — the Calendar's words; without it, Eastern).
 * → { day1Date, day30Date, startWhen, startTime, theirZoneName, sendWindow,
 *     windowStart, windowEnd, senderName, inboxName, inboxAddress, inboxes }
 */
export function startFacts({ day1Date, day30Date = null, window = ['09:00', '17:00'], senderName = '', inboxes = [], when = null }) {
  const [y, m, d] = String(day1Date).split('-').map(Number);
  const [h, mi] = String(window[0] || '09:00').split(':').map(Number);
  const first = zonedToUtc(y, m, d, h || 9, mi || 0, 0, ET);
  const addrs = (inboxes || []).map((r) => String(r.email || r).toLowerCase()).filter(Boolean);
  const name = String(senderName || '').trim();
  const zoneName = when ? when.zoneName : 'Eastern Time';
  return {
    day1Date: formatDay(day1Date),
    day30Date: formatDay(day30Date || addDays(day1Date, 29)),
    startWhen: when ? when.text(first) : `${formatDay(day1Date)} at ${clockWord(window[0])} Eastern Time`,
    startTime: when ? when.clock(first) : clockWord(window[0]),
    theirZoneName: zoneName,
    windowStart: clockWord(window[0]),
    windowEnd: clockWord(window[1]),
    sendWindow: `between ${clockWord(window[0])} and ${clockWord(window[1])} on weekdays, in each prospect's own time zone`,
    senderName: name || (addrs[0] || ''),
    inboxAddress: addrs[0] || '',
    inboxName: addrs[0] ? (name ? `${name} <${addrs[0]}>` : addrs[0]) : name,
    inboxes: andList(addrs),
  };
}

/**
 * The start facts for this client (their zone, the Sender's window, the name
 * and inboxes the prospects will see) — the vars `welcome_two_dates` and
 * `day1_moved` both get.
 */
export async function startVars(clientId, day1Date, { day30Date = null } = {}) {
  const cal = await import('@/lib/systems/calendar');
  const [profile, recs, window, calS, theirZone] = await Promise.all([
    getProfile(clientId).catch(() => ({})), getInboxRecords(clientId).catch(() => []), cfg(clientId, 'SEND.windowLeadTz'), cal.calendarSettings(), cal.zoneOfClient(clientId),
  ]);
  const on = recs.filter((r) => r.enabled === '1' || r.enabled === 1 || r.enabled === true);
  const inboxes = (on.length ? on : recs).map((r) => r.email).sort();
  const shown = recs.find((r) => r.email === inboxes[0])?.displayName;
  return startFacts({
    day1Date, day30Date, window: Array.isArray(window) && window.length === 2 ? window : ['09:00', '17:00'],
    senderName: profile?.senderName || shown || '', inboxes,
    when: { zoneName: cal.zoneInfo(theirZone).name, text: (t) => cal.theirWhen(t, theirZone, calS), clock: (t) => cal.clockIn(t, theirZone) },
  });
}

/**
 * Send the "we start on …" email for the trial's Day 1 — once per Day 1, only
 * when Day 1 is fixed, in their daytime.
 * → { sent } | { already } | { waiting: 'daytime' } | { skipped: why }.
 * A failed send throws (the Notifier keeps it for the delivery watch's retry).
 */
export async function sendStartEmail(clientId, { now = io.now(), notify = null } = {}) {
  assertClientId(clientId);
  const [client, trial] = await Promise.all([getClient(clientId), getTrial(clientId)]);
  if (!client || !client.contactEmail) return { skipped: 'no contact email' };
  const clearWait = async () => { if (client.intakeStep === 'welcome') await updateClient(clientId, { intakeStep: '' }); };
  if (!trial?.day1Date || !FIXED_STATES.has(client.state)) { await clearWait(); return { skipped: 'Day 1 is not fixed yet' }; }
  if (trial.startEmailFor === trial.day1Date) { await clearWait(); return { already: true }; }
  const { zoneOfClient } = await import('@/lib/systems/calendar');
  const zone = await zoneOfClient(clientId);
  if (!inTheirDaytime(now, zone)) {
    if (client.intakeStep !== 'welcome') await updateClient(clientId, { intakeStep: 'welcome' });
    await logEvent(clientId, SYSTEM, 'waits', { until: `08:00 ${zone}`, day1: trial.day1Date });
    return { waiting: 'daytime' };
  }
  const vars = {
    firstName: firstNameOf(client.contactName), ownerName: await ownerName(clientId), callMinutes: await cfg(clientId, 'LAUNCH.callMinutes'),
    ...(await startVars(clientId, trial.day1Date, { day30Date: trial.day30Date || null })),
  };
  const opts = { dedupe: `welcome_two_dates:${trial.day1Date}`, now };
  const res = notify ? await notify(clientId, 'welcome_two_dates', vars, opts) : await sendClient(clientId, 'welcome_two_dates', vars, opts);
  await kv.hset(K.trial(clientId), { welcomeSentAt: now.toISOString(), startEmailFor: trial.day1Date });
  await clearWait();
  await logEvent(clientId, SYSTEM, 'sent', { day1: trial.day1Date, zone, deduped: Boolean(res?.deduped) || undefined });
  return { sent: true, day1: trial.day1Date };
}
