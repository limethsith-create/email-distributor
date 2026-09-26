/**
 * Health colour (SPEC §10.1, from the KPIs SOP):
 *   red    = behind pace AND unanswered hot leads, or any urgent alert open
 *   yellow = behind pace OR client quiet CLIENT.quietWarnDays business days
 *            OR any warning alert open (not news: ALERTS[key].info) OR an overdue promise
 *   green  = otherwise
 *
 * "Behind pace" for a trial = Day ≥ 15 (the off-pace check) in a running
 * state with no qualified call yet. A missing counter is reported as a
 * reason, never assumed to be 0.
 */

import { isWeekday, partsIn, ET, dayKeyIn } from '@/lib/time';
import { ALERTS } from '@/lib/templates/owner';

const RUNNING = new Set(['sending', 'paused', 'extension']);

function businessDaysSince(iso, now) {
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return null;
  let n = 0;
  for (let t = start + 864e5; t <= now.getTime(); t += 864e5) if (isWeekday(partsIn(ET, new Date(t)).weekday)) n++;
  return n;
}

export function overduePromises(promises, now = new Date()) {
  const today = dayKeyIn(ET, now);
  return (promises || []).filter((p) => !p.doneAt && p.dueAt && String(p.dueAt).slice(0, 10) < today);
}

/**
 * @param {object} x { client, trial, totals, day, alerts (open, this client), promises, now, quietWarnDays }
 * @returns {{colour: 'green'|'yellow'|'red', reasons: string[]}}
 */
export function computeHealth({ client, trial = {}, totals = {}, day = null, alerts = [], promises = [], now = new Date(), quietWarnDays = 2 }) {
  const reasons = [];
  let behind = false;
  if (RUNNING.has(client.state) && day != null && day >= 15) {
    if (!Number.isFinite(totals.qualified)) reasons.push('qualified counter missing');
    else if (totals.qualified === 0) { behind = true; reasons.push(`behind pace: 0 qualified at Day ${day}`); }
  }
  const hot = Number(trial.unansweredHot) || 0;
  if (hot > 0) reasons.push(`${hot} unanswered hot lead${hot === 1 ? '' : 's'}`);
  const lastSeen = trial.lastClientEmailAt || trial.lastClientActivityAt || client.lastClientActivityAt || null;
  let quiet = false;
  if (RUNNING.has(client.state) && lastSeen) {
    const bd = businessDaysSince(lastSeen, now);
    if (bd != null && bd >= quietWarnDays) { quiet = true; reasons.push(`client quiet ${bd} business days`); }
  }
  // News and to-do-carried heads-ups (ALERTS[key].info) are not warnings: they never colour the trial.
  const warnings = alerts.filter((a) => a.urgent || !ALERTS[a.key]?.info);
  const urgent = warnings.filter((a) => a.urgent);
  if (urgent.length) reasons.push(`${urgent.length} urgent alert${urgent.length === 1 ? '' : 's'} open`);
  else if (warnings.length) reasons.push(`${warnings.length} alert${warnings.length === 1 ? '' : 's'} open`);
  const overdue = overduePromises(promises, now);
  if (overdue.length) reasons.push(`${overdue.length} overdue promise${overdue.length === 1 ? '' : 's'}`);

  let colour = 'green';
  if ((behind && hot > 0) || urgent.length) colour = 'red';
  else if (behind || quiet || warnings.length || overdue.length) colour = 'yellow';
  return { colour, reasons };
}

export const COLOUR_RANK = { red: 0, yellow: 1, green: 2 };
