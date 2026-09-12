/**
 * Replies API - serves reply data to the dashboard.
 * Junk (bounce / DSN / out-of-office / raw-MIME) entries that predate the
 * reply-checker's bounce filter are stripped here so the Replies tab only
 * ever shows real prospect conversations.
 *
 * Imports the reply store from leads-db (not reply-checker) so the dashboard's
 * cold start never loads imapflow / nodemailer.
 */

import { getAllReplies } from '@/lib/leads-db';
import { isJunkReply, isJunkConversation } from '@/lib/junk-filter';
import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

const EVENTS_KEY = 'reply_events';
const EVENTS_LIMIT = 50;

function countBy(items, pick) {
  const out = {};
  for (const item of items) {
    const key = pick(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export async function GET() {
  try {
    const [allReplies, replyCount, rawConversations, rawEvents] = await Promise.all([
      getAllReplies().catch(function () { return []; }),
      kv.hget('stats', 'totalReplied').catch(function () { return 0; }),
      kv.hgetall('conversations').catch(function () { return {}; }),
      kv.lrange(EVENTS_KEY, 0, EVENTS_LIMIT - 1).catch(function () { return []; }),
    ]);

    const replies = (allReplies || []).filter(function (r) { return !isJunkReply(r); });

    const conversations = {};
    const convSource = rawConversations && typeof rawConversations === 'object' ? rawConversations : {};
    for (const key of Object.keys(convSource)) {
      if (!isJunkConversation(convSource[key])) {
        conversations[key] = convSource[key];
      }
    }

    const events = (Array.isArray(rawEvents) ? rawEvents : []).filter(function (e) { return e && typeof e === 'object'; });

    // Real human replies: classified 'human' by the scanner, or legacy records
    // with no kind that survived the junk filter.
    const humanReplies = replies.filter(function (r) {
      const kind = String(r.kind || '').toLowerCase();
      return kind === 'human' || kind === '';
    }).length;

    const byIntent = countBy(Object.values(conversations), function (c) {
      return c && c.intent ? String(c.intent).toLowerCase() : null;
    });
    const byCampaign = countBy(replies, function (r) {
      return r && r.campaign ? String(r.campaign).toLowerCase() : null;
    });

    return Response.json({
      success: true,
      totalReplies: replies.length,
      statCount: parseInt(replyCount || '0'),
      replies,
      conversations,
      events,
      humanReplies,
      byIntent,
      byCampaign,
    });
  } catch (err) {
    return Response.json({
      success: false,
      error: err.message,
      replies: [],
    }, { status: 500 });
  }
}
