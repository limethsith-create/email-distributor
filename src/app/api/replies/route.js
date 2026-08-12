/**
 * Replies API — serves reply data to the dashboard
 */

import { getAllReplies } from '@/lib/reply-checker';
import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const replies = await getAllReplies();

    // Also get reply count from stats
    let replyCount = 0;
    try {
      replyCount = await kv.hget('stats', 'totalReplied') || 0;
    } catch {}

    // Full two-way conversations (auto-reply bot log) for the UI
    let conversations = {};
    try {
      conversations = (await kv.hgetall('conversations')) || {};
    } catch {}

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
