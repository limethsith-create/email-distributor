import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAllClients, getTrial } from '@/lib/db/client';
import { getAlertLog } from '@/lib/notify';
import { trialDay, dayKeyIn, ET } from '@/lib/time';
import { hasEncKey } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [hb, clients, alerts, migrations] = await Promise.all([
    kv.hgetall(K.heartbeat()).catch(() => ({})),
    getAllClients(),
    getAlertLog(200),
    kv.hgetall(K.migrations()).catch(() => ({})),
  ]);
  const today = dayKeyIn(ET);
  const rows = await Promise.all(clients.map(async (c) => {
    const [trial, total] = await Promise.all([getTrial(c.id), kv.hgetall(K.countersTotal(c.id)).catch(() => ({}))]);
    const open = alerts.filter((a) => a.clientId === c.id && !a.acknowledged).length;
    return { id: c.id, name: c.name || c.id, state: c.state, plan: c.plan, trialDay: trialDay(trial), day1Date: trial.day1Date || null, day30Date: trial.day30Date || null, counters: total || {}, openAlerts: open };
  }));
  const lastTickAt = hb?.lastTickAt || null;
  return Response.json({
    heartbeat: {
      lastTickAt,
      ageSec: lastTickAt ? Math.round((Date.now() - Date.parse(lastTickAt)) / 1000) : null,
      source: hb?.lastTickSource || null,
      ticksToday: Number(hb?.[`ticks:${today}`]) || 0,
      lastSendAt: hb?.lastSendAt || null,
    },
    setup: {
      migrated: Boolean(migrations?.phase1),
      encKey: hasEncKey(),
      cronSecret: Boolean(process.env.CRON_SECRET),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      healthchecks: Boolean(process.env.HC_PING_URL),
      ownerInbox: Boolean(process.env.OWNER_INBOX),
    },
    activeTrials: rows.filter((r) => r.plan === 'trial' && !['declined', 'closed_silent', 'converted', 'retired', 'deleted'].includes(r.state)).length,
    openAlerts: alerts.filter((a) => !a.acknowledged).length,
    clients: rows.sort((a, b) => b.openAlerts - a.openAlerts || a.id.localeCompare(b.id)),
  });
}
