/**
 * Replies cleanup - permanently purge junk (bounce / DSN / raw-MIME) entries
 * from KV so they never come back.
 *
 *   GET /api/replies/cleanup?token=CRON_SECRET            -> dry run (lists what WOULD be removed)
 *   GET /api/replies/cleanup?token=CRON_SECRET&confirm=1  -> actually deletes them
 *
 * Uses the exact same predicates the Replies tab uses to hide junk, so what a
 * dry run lists is exactly what gets deleted.
 */

import { kv } from '@vercel/kv';
import { isJunkReply, isJunkConversation } from '@/lib/junk-filter';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const REPLIES_KEY = 'replies_v3';
const CONVERSATIONS_KEY = 'conversations';

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  const { searchParams } = new URL(request.url);
  if (cronSecret) {
    const token = searchParams.get('token');
    const authHeader = request.headers.get('authorization');
    if (authHeader !== 'Bearer ' + cronSecret && token !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const confirm = searchParams.get('confirm') === '1';

  try {
    const replies = await kv.hgetall(REPLIES_KEY).catch(function () { return {}; });
    const conversations = await kv.hgetall(CONVERSATIONS_KEY).catch(function () { return {}; });

    const junkReplyKeys = Object.keys(replies || {}).filter(function (k) {
      return isJunkReply((replies || {})[k]);
    });
    const junkConvKeys = Object.keys(conversations || {}).filter(function (k) {
      return isJunkConversation((conversations || {})[k]);
    });

    if (confirm) {
      if (junkReplyKeys.length) await kv.hdel(REPLIES_KEY, ...junkReplyKeys);
      if (junkConvKeys.length) await kv.hdel(CONVERSATIONS_KEY, ...junkConvKeys);
    }

    return Response.json({
      success: true,
      mode: confirm ? 'deleted' : 'dry_run',
      removed: {
        replies: junkReplyKeys.length,
        conversations: junkConvKeys.length,
      },
      keys: { replies: junkReplyKeys, conversations: junkConvKeys },
      note: confirm ? 'Junk entries permanently removed.' : 'Dry run - add &confirm=1 to delete.',
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
