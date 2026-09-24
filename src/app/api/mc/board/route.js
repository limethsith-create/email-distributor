import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { dayKeyIn, ET } from '@/lib/time';
import { hasEncKey } from '@/lib/crypto';
import { boardData } from '@/lib/systems/boarddata';

export const dynamic = 'force-dynamic';

/** Mission Control board (SPEC §10.1): one card per client, "needs you" first, plus the global bar. */
export async function GET() {
  const now = new Date();
  const [data, hb, migrations] = await Promise.all([
    boardData(now),
    kv.hgetall(K.heartbeat()).catch(() => ({})),
    kv.hgetall(K.migrations()).catch(() => ({})),
  ]);
  return Response.json({
    ...data,
    heartbeat: { ...data.heartbeat, ticksToday: Number(hb?.[`ticks:${dayKeyIn(ET, now)}`]) || 0 },
    setup: {
      migrated: Boolean(migrations?.phase1),
      encKey: hasEncKey(),
      cronSecret: Boolean(process.env.CRON_SECRET),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      healthchecks: Boolean(process.env.HC_PING_URL),
      ownerInbox: Boolean(process.env.OWNER_INBOX),
    },
  });
}
