/**
 * Inbox sending control — the physical ON/OFF switch per inbox.
 *
 * Sending is OFF by default. An inbox only sends when its switch here is ON.
 * The auto-sender reads this same KV key and refuses to send from any inbox
 * that isn't switched on.
 */

import { kv } from '@vercel/kv';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const dynamic = 'force-dynamic';

const INBOX_ENABLED_KEY = 'inbox_enabled';
const DAILY_SEND_KEY = 'daily_sends';
const SEND_CAP = 25;

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

export async function GET() {
  const accounts = getSmtpAccounts();
  let enabledMap = {};
  try { enabledMap = (await kv.hgetall(INBOX_ENABLED_KEY)) || {}; } catch {}

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
      cap: SEND_CAP,
    });
  }
  return Response.json({ inboxes, cap: SEND_CAP });
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

    const { email, enabled } = body;
    if (!email) return Response.json({ success: false, error: 'email required' }, { status: 400 });
    await kv.hset(INBOX_ENABLED_KEY, { [email.toLowerCase()]: enabled ? '1' : '0' });
    return Response.json({ success: true, email: email.toLowerCase(), enabled: !!enabled });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
