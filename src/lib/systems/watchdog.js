/**
 * Watchdog (SPEC §10.3) — the in-tick half. The other halves live outside
 * the app on purpose: Healthchecks.io (dead-man alarm, pinged at the end of
 * every good tick) and the GitHub Actions backup/keep-alive workflows.
 *
 * Send-stall alarm: the send job records `firstDueUnsentAt` whenever an inbox
 * was due, had cap left, and still nothing went out. If that has been true
 * for WATCHDOG.sendStallMin during US hours, the owner hears about it (at most
 * hourly). A quiet period that is just pacing or a hit cap never alarms.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { alertOwner } from '@/lib/notify';
import { partsIn, isWeekday, ET } from '@/lib/time';

export async function runWatchdog({ now = new Date() } = {}) {
  const hb = (await kv.hgetall(K.heartbeat())) || {};
  const p = partsIn(ET, now);
  const out = { stall: false };
  if (!isWeekday(p.weekday) || p.hour < 8 || p.hour >= 19) return out;

  const stallMin = await cfg(null, 'WATCHDOG.sendStallMin');
  const since = hb.firstDueUnsentAt ? Date.parse(hb.firstDueUnsentAt) : 0;
  if (since && now.getTime() - since > stallMin * 60_000) {
    const minutes = Math.round((now.getTime() - since) / 60_000);
    out.stall = true;
    out.alert = await alertOwner('send_stalled', {
      vars: { minutes },
      body: `An inbox has been due to send for ${minutes} minutes and nothing has gone out.\nLast successful send: ${hb.lastSendAt || 'none recorded'}.`,
      did: 'Nothing yet — the sender retries every minute. Check the Inboxes page for a login or health problem.',
    });
  }
  return out;
}

/** Ping a Healthchecks.io URL (best effort, 5 s). */
export async function pingHealthcheck(url, suffix = '') {
  if (!url) return { ok: false, skipped: 'not configured' };
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}${suffix}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
