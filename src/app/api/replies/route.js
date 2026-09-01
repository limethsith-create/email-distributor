/**
 * Replies API - serves reply data to the dashboard.
 * Junk (bounce / DSN / out-of-office / raw-MIME) entries that predate the
 * reply-checker's bounce filter are stripped here so the Replies tab only
 * ever shows real prospect conversations.
 */

import { getAllReplies } from '@/lib/reply-checker';
import { isJunkReply, isJunkConversation } from '@/lib/junk-filter';
import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const allReplies = await getAllReplies();
    const replies = allReplies.filter(function (r) { return !isJunkReply(r); });

    let replyCount = 0;
    try {
      replyCount = await kv.hget('stats', 'totalReplied') || 0;
    } catch {}

    let rawConversations = {};
    try {
      rawConversations = (await kv.hgetall('conversations')) || {};
    } catch {}
    const conversations = {};
    for (const key of Object.keys(rawConversations)) {
      if (!isJunkConversation(rawConversations[key])) {
        conversations[key] = rawConversations[key];
      }
    }

    return Response.json({
      success: true,
      totalReplies: replies.length,
      statCount: parseInt(replyCount || '0'),
      replies,
      conversations,
    });
  } catch (err) {
    return Response.json({
      success: false,
      error: err.message,
      replies: [],
    }, { status: 500 });
  }
}
