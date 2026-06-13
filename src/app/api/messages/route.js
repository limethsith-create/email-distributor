/**
 * Messages API — serves chat data to the dashboard
 *
 * GET /api/messages?action=conversations — list all conversations
 * GET /api/messages?action=messages&platform=instagram&senderId=123 — get messages
 * GET /api/messages?action=stats — chat stats
 * POST /api/messages — send a manual reply from the dashboard
 */

import { listConversations, getMessages, markAsRead, getChatStats, addMessage, archiveConversation } from '@/lib/chat-db';
import { sendMessage } from '@/lib/meta-api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'conversations';

  try {
    switch (action) {
      case 'conversations': {
        const platform = searchParams.get('platform') || null;
        const limit = parseInt(searchParams.get('limit') || '50');
        const conversations = await listConversations({ platform, limit });
        return Response.json({ conversations });
      }

      case 'messages': {
        const platform = searchParams.get('platform');
        const senderId = searchParams.get('senderId');
        if (!platform || !senderId) {
          return Response.json({ error: 'platform and senderId required' }, { status: 400 });
        }
        const limit = parseInt(searchParams.get('limit') || '50');
        const messages = await getMessages(platform, senderId, { limit });

        // Mark as read when viewing
        await markAsRead(platform, senderId);

        return Response.json({ messages });
      }

      case 'stats': {
        const stats = await getChatStats();
        return Response.json(stats);
      }

      default:
        return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST — Send a manual reply from the dashboard
 * Body: { platform, senderId, text }
 */
export async function POST(request) {
  try {
    const { platform, senderId, text } = await request.json();

    if (!platform || !senderId || !text) {
      return Response.json({ error: 'platform, senderId, and text required' }, { status: 400 });
    }

    // Send via Meta API
    const result = await sendMessage(senderId, text);

    if (!result.success) {
      return Response.json({ error: result.error }, { status: 500 });
    }

    // Store in our database
    const msg = await addMessage(platform, senderId, {
      direction: 'outbound',
      text,
      messageType: 'text',
      metaMessageId: result.messageId,
      aiGenerated: false,
    });

    return Response.json({ success: true, message: msg });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
