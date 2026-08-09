/**
 * Inbox sending control — the physical ON/OFF switch + daily-limit per inbox.
 *
 * Sending is OFF by default. An inbox only sends when its switch here is ON.
 * The auto-sender reads this same KV key and refuses to send from any inbox
 * that isn't switched on. Each inbox also has a per-day send limit (default 25,
 * the hard max) that you can dial down to ramp volume gradually.
 */

import { kv } from '@vercel/kv';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const dynamic = 'force-dynamic';

const INBOX_ENABLED_KEY = 'inbox_enabled';
const INBOX_CAP_KEY = 'inbox_caps';
const DAILY_SEND_KEY = 'daily_sends';
const SEND_CAP = 25; // hard daily maximum per inbox

function getTodayKey() {
  const slTime = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return slTime.toISOString().split('T')[0];
}

async function sentToday(email) {
  try {
    const c = await kv.hget(DAILY_SEND_KEY, `${email}:${getTodayKey()}`);
    return parseInt(c || '0');
  } catch {
    return 0;
  }
}

function capFromMap(capMap, email) {
  const raw = capMap[(email || '').toLowerCase()];
  if (raw === null || raw === undefined || raw === '') return SEND_CAP;
  const n = parseInt(raw);
  if (isNaN(n)) return SEND_CAP;
  return Math.max(0, Math.min(SEND_CAP, n));
}

export async function GET() {
  const accounts = getSmtpAccounts();
  let enabledMap = {};
  let capMap = {};
  try { enabledMap = (await kv.hgetall(INBOX_ENABLED_KEY)) || {}; } catch {}
  try { capMap = (await kv.hgetall(INBOX_CAP_KEY)) || {}; } catch {}

  // Fallback list so the page still shows the two inboxes even before env is read
  const list = accounts.length ? accounts : [
    { email: 'limethsith@getaviance.site', displayName: 'Limethsith Weerasinghe' },
    { email: 'limethsith.weerasinghe@getaviance.site', displayName: 'Limethsith Weerasinghe' },
  ];

  const inboxes = [];
  for (const a of list) {
    const key = (a.email || '').toLowerCase();
    const on = enabledMap[key] === '1' || enabledMap[key] === 1 || enabledMap[key] === true;
    inboxes.push({
      email: a.email,
      displayName: a.displayName || (a.email || '').split('@')[0],
      enabled: !!on,
      sentToday: await sentToday(a.email),
      cap: capFromMap(capMap, a.email),
      maxCap: SEND_CAP,
    });
  }
  return Response.json({ inboxes, cap: SEND_CAP, maxCap: SEND_CAP });
}

export async function POST(request) {
  try {
    const body = await request.json();

    // Reset today's send counters to zero (fresh start).
    if (body.action === 'reset_counts') {
      const accounts = getSmtpAccounts();
      const list = accounts.length ? accounts : [
        { email: 'limethsith@getaviance.site' },
        { email: 'limethsith.weerasinghe@getaviance.site' },
      ];
      const today = getTodayKey();
      for (const a of list) {
        try { await kv.hset(DAILY_SEND_KEY, { [`${a.email}:${today}`]: 0 }); } catch {}
      }
      return Response.json({ success: true, reset: list.map((a) => a.email) });
    }

    const { email } = body;
    if (!email) return Response.json({ success: false, error: 'email required' }, { status: 400 });
    const key = email.toLowerCase();

    // Set the per-inbox daily limit (clamped 0..SEND_CAP).
    if (body.cap !== undefined) {
      let n = parseInt(body.cap);
      if (isNaN(n)) n = SEND_CAP;
      n = Math.max(0, Math.min(SEND_CAP, n));
      await kv.hset(INBOX_CAP_KEY, { [key]: String(n) });
      return Response.json({ success: true, email: key, cap: n });
    }

    // Flip the on/off switch.
    if (body.enabled !== undefined) {
      await kv.hset(INBOX_ENABLED_KEY, { [key]: body.enabled ? '1' : '0' });
      return Response.json({ success: true, email: key, enabled: !!body.enabled });
    }

    return Response.json({ success: false, error: 'nothing to update' }, { status: 400 });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
