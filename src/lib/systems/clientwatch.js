/**
 * Client Watch (SPEC §8.8) — hourly. Tracks the client's side of the
 * agreement: hot leads left unanswered, the last email seen from the client,
 * calendar test, approvals.
 *
 *   3 hot leads unanswered > 24 h, or quiet 2 business days with hot leads
 *   pending                            → owner alert client_quiet_warning
 *   quiet 5 business days, hot pending → state paused (client_quiet),
 *                                        client paused_quiet, owner alert
 *   quiet 14 business days             → trial ends (endReason client_quiet)
 *   client writes again while paused_quiet → sending resumes
 *
 * Client page buttons live here too: "You emailed my customer", "Stop the
 * trial", "I'm away".
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getProfile, getTrial, setState, SENDING_STATES } from '@/lib/db/client';
import { getLead, saveLead, addToBlocklist, hostOf } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { mintToken, readToken, pageUrl, TTL } from '@/lib/pagetokens';
import { addDays } from '@/lib/time';
import { isFreeMailDomain } from '@/lib/metrics';
import { sendToProspect, notifyClientSafe } from '@/lib/systems/outbound';
import { alert, isTrialClient, lower, parseJson, truthy, businessDaysBetween, ccfg } from '@/lib/systems/stagec-common';

/** Pending (unanswered) hot leads. */
async function pendingHot(clientId) {
  const hot = (await kv.hgetall(K.hot(clientId))) || {};
  return Object.values(hot).filter((h) => h && !h.answeredAt && h.sentAt);
}

export async function runClientWatch(clientId, { now = new Date() } = {}) {
  if (!isTrialClient(clientId)) return { skipped: 'not a trial client' };
  const [client, trial, profile] = await Promise.all([getClient(clientId), getTrial(clientId), getProfile(clientId)]);
  if (!client) return { skipped: 'no client' };
  const pending = await pendingHot(clientId);
  const unanswered = Number(trial.unansweredHot) || 0;
  const warnDays = await ccfg(clientId, 'CLIENT.quietWarnDays');
  const pauseDays = await ccfg(clientId, 'CLIENT.pauseDays');
  const endDays = await ccfg(clientId, 'CLIENT.endDays');
  const oldestPending = pending.map((h) => Date.parse(h.sentAt)).sort((a, b) => a - b)[0] || null;
  const lastActivity = trial.lastClientActivityAt ? Date.parse(trial.lastClientActivityAt) : 0;
  const quietSince = oldestPending ? Math.max(oldestPending, lastActivity) : null;
  const quietDays = quietSince ? businessDaysBetween(quietSince, now.getTime()) : 0;
  const out = { pending: pending.length, unansweredHot: unanswered, quietDays, bookingTested: truthy(profile.bookingTested) };

  // Resume after a quiet pause as soon as the client has written again.
  if (client.state === 'paused' && client.pausedReason === 'client_quiet' && lastActivity > Date.parse(client.pausedAt || 0) && client.emergencyActive !== '1') {
    const to = client.pausedFrom === 'extension' ? 'extension' : 'sending';
    await setState(clientId, to, 'client replied — quiet pause lifted');
    await kv.hset(K.client(clientId), { pausedReason: '', pausedAt: '' });
    out.resumed = to;
    return out;
  }

  if (unanswered >= 3 || (pending.length && quietDays >= warnDays)) {
    await alert('client_quiet_warning', { clientId, vars: { clientId }, body: `${clientId}: ${unanswered} hot lead(s) unanswered past 24 h; ${pending.length} pending; ${quietDays} business day(s) since the client last wrote while leads wait.`, did: `Nothing yet. Sending pauses at ${pauseDays} business days quiet.` });
    out.warned = true;
  }

  if (pending.length && quietDays >= pauseDays && SENDING_STATES.has(client.state)) {
    const from = client.state;
    if (await setState(clientId, 'paused', 'client quiet')) {
      await kv.hset(K.client(clientId), { pausedReason: 'client_quiet', pausedAt: now.toISOString(), pausedFrom: from });
      await notifyClientSafe(clientId, 'paused_quiet', { pending: pending.length, days: quietDays }, { from: 'trial', dedupe: `paused_quiet:${now.toISOString().slice(0, 10)}` });
      await alert('paused_quiet', { clientId, vars: { clientId }, body: `${clientId} has ${pending.length} hot lead(s) waiting and has been quiet for ${quietDays} business days.`, did: 'Sending is paused (warm-up continues). The client got paused_quiet; sending restarts when they write back.' });
      out.paused = true;
    }
  }

  if (client.state === 'paused' && client.pausedReason === 'client_quiet' && quietDays >= endDays && !trial.endedAt) {
    await kv.hset(K.trial(clientId), { endedAt: now.toISOString(), endReason: 'client_quiet' });
    await logEvent(clientId, 'clientwatch', 'trial_ended', { reason: 'client_quiet', quietDays });
    await alert('trial_ended_quiet', { clientId, vars: { clientId }, body: `${clientId} has been quiet for ${quietDays} business days with hot leads waiting. Per the agreement the trial ends.`, did: 'trial.endReason = client_quiet, endedAt set. Stage D sends the final report and handover.' });
    out.ended = true;
  }
  return out;
}

// ─── Client page buttons ─────────────────────────────────────────────────────

/** One token for the three client buttons (customer hit / stop / away), 14 days. */
export async function clientButtonLinks(clientId) {
  const token = await mintToken(clientId, 'buttons', { ttl: TTL.long });
  return { customerUrl: pageUrl(token, 'customer'), stopUrl: pageUrl(token, 'stop'), awayUrl: pageUrl(token, 'away') };
}

/** "You emailed my customer": apology, blocklist, alert with how it slipped. */
export async function customerHit(clientId, { email, list = '', now = new Date() }) {
  const addr = lower(email);
  if (!addr.includes('@')) return { ok: false, error: 'enter the email address we wrote to' };
  const lead = await getLead(clientId, addr);
  const extra = String(list || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x && (x.includes('@') || x.includes('.')));
  let apology = { sent: false, reason: 'we never emailed this address' };
  if (lead && lead.sent_at) {
    // Apologise before blocklisting (the Compliance Guard refuses blocklisted recipients).
    apology = await sendToProspect(clientId, 'apology_customer', { lead, thread: { subject: lead.original_subject, messageId: lead.original_message_id, references: [lead.original_message_id].filter(Boolean) }, dedupe: `apology_customer:${addr}`, now });
    await saveLead(clientId, { ...lead, status: 'suppressed', suppressReason: 'client customer', customerHitAt: now.toISOString() }, lead.status);
  }
  // Never blocklist a whole free-mail domain (gmail.com etc.) — only the address.
  const added = await addToBlocklist(clientId, addr, ...(isFreeMailDomain(addr) ? [] : [hostOf(addr)]), ...extra.filter((x) => x.includes('@') || !isFreeMailDomain(`x@${x}`)));
  await kv.hset(K.trial(clientId), { lastClientActivityAt: now.toISOString() });
  const how = lead ? `source: ${lead.source || 'unknown'}${lead.sourceUrl || lead.crawlPage ? `, found on ${lead.sourceUrl || lead.crawlPage}` : ''}; first touch ${lead.sent_at || 'never'}` : 'not on our list';
  await logEvent(clientId, 'clientwatch', 'customer_hit', { email: addr, how, blocklisted: added });
  await alert('customer_hit', { clientId, scope: `${clientId}:${addr}`, vars: { clientId }, body: `The client says ${addr} is one of their customers.\nHow it slipped: ${how}.\nBlocklist entries added: ${added}.`, did: `${apology.sent ? 'Apology sent from the trial inbox. ' : ''}Address, domain and the pasted list are on the blocklist.` });
  return { ok: true, apologySent: Boolean(apology.sent), blocklisted: added };
}

/** "Stop the trial": same-day stop; Stage D sends report + list; domain retired in 7 days. */
export async function stopTrial(clientId, { now = new Date() } = {}) {
  const [client, trial] = await Promise.all([getClient(clientId), getTrial(clientId)]);
  if (!client) return { ok: false, error: 'no client' };
  if (trial.stoppedAt) return { ok: true, already: true };
  const at = now.toISOString();
  await kv.hset(K.trial(clientId), { stoppedAt: at, endedAt: trial.endedAt || at, endReason: 'client_stopped', retireAt: addDays(at.slice(0, 10), 7) });
  if (SENDING_STATES.has(client.state)) {
    if (await setState(clientId, 'paused', 'client pressed Stop the trial')) await kv.hset(K.client(clientId), { pausedReason: 'client_stopped', pausedAt: at, pausedFrom: client.state });
  }
  await logEvent(clientId, 'clientwatch', 'trial_stopped_by_client', { at });
  await alert('trial_stopped_by_client', { clientId, vars: { clientId }, body: `${client.name || clientId} pressed "Stop the trial".`, did: 'Cold sending stopped now. trial.endReason = client_stopped, retireAt in 7 days; the report + list go out with the handover.' });
  return { ok: true };
}

/** "I'm away": store a date range; the Sender halves volume on those days. */
export async function setAway(clientId, { from, to, now = new Date() }) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || to < from) return { ok: false, error: 'pick a start and end date (end on or after start)' };
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 60) return { ok: false, error: 'at most 60 days at a time' };
  const profile = await getProfile(clientId);
  const ranges = (parseJson(profile.awayRanges, []) || []).filter((r) => r && r.to >= now.toISOString().slice(0, 10));
  ranges.push({ from, to, setAt: now.toISOString() });
  await kv.hset(K.profile(clientId), { awayRanges: JSON.stringify(ranges) });
  await kv.hset(K.trial(clientId), { lastClientActivityAt: now.toISOString() });
  await logEvent(clientId, 'clientwatch', 'away_set', { from, to });
  return { ok: true, ranges };
}

/**
 * Shared handler for the client-button APIs (/api/c/buttons, /api/c/customer,
 * /api/c/stop, /api/c/away) → { status, body }.
 */
export async function handleButtons(body = {}, forced = null) {
  const tok = await readToken(body.t, { purpose: 'buttons' });
  if (!tok) return { status: 404, body: { ok: false, error: 'This link has expired. Reply to any of our emails and we will act on it by hand.' } };
  const clientId = tok.clientId;
  const action = forced || body.action;
  let res;
  if (action === 'customer') res = await customerHit(clientId, { email: body.email, list: body.list || '' });
  else if (action === 'stop') {
    if (body.confirm !== true) return { status: 400, body: { ok: false, error: 'Please confirm.' } };
    res = await stopTrial(clientId);
  } else if (action === 'away') res = await setAway(clientId, { from: body.from, to: body.to });
  else return { status: 400, body: { ok: false, error: 'unknown action' } };
  return { status: res.ok ? 200 : 400, body: res };
}
