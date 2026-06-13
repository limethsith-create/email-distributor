/**
 * Meta Webhook Endpoint — Instagram & Facebook Messenger
 *
 * GET  → Webhook verification (Meta sends this during setup)
 * POST → Incoming messages from Instagram DMs and Facebook Messenger
 *
 * Flow:
 * 1. Meta sends message to this webhook
 * 2. We store the message in our database
 * 3. We generate an AI reply (Gemini Flash)
 * 4. We send the reply back via Meta Send API
 * 5. We store our reply in the database too
 *
 * Setup: In Meta Developer Console, subscribe to:
 * - Facebook Page: messages, messaging_postbacks
 * - Instagram: messages
 */

import { sendMessage, sendTypingIndicator, getUserProfile, detectPlatform } from '@/lib/meta-api';
import { addMessage, getMessages, getOrCreateConversation } from '@/lib/chat-db';
import { generateReply } from '@/lib/chat-ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET — Webhook Verification
 * Meta sends a GET request to verify your webhook URL during setup.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Webhook verified successfully');
    return new Response(challenge, { status: 200 });
  }

  return new Response('Forbidden', { status: 403 });
}

/**
 * POST — Incoming Messages
 */
export async function POST(request) {
  try {
    const body = await request.json();

    // Determine platform
    const platform = detectPlatform(body);
    if (platform === 'unknown') {
      return Response.json({ status: 'ignored', reason: 'unknown platform' });
    }

    // Process each entry
    if (!body.entry) {
      return Response.json({ status: 'ok' });
    }

    for (const entry of body.entry) {
      if (!entry.messaging) continue;

      for (const event of entry.messaging) {
        // Skip echoes (messages we sent)
        if (event.message?.is_echo) continue;

        // Skip non-message events (postbacks, reactions, etc. — handle later if needed)
        if (!event.message) continue;

        const senderId = event.sender.id;
        const messageText = event.message.text || '';
        const messageType = event.message.attachments ? 'attachment' : 'text';
        const metaMessageId = event.message.mid;
        const timestamp = event.timestamp
          ? new Date(event.timestamp).toISOString()
          : new Date().toISOString();

        // Get sender name (cached in conversation)
        let senderName = null;
        const existingConv = await getOrCreateConversation(platform, senderId);
        if (existingConv.senderName === 'Unknown') {
          try {
            const profile = await getUserProfile(senderId);
            senderName = profile.name || null;
          } catch {}
        } else {
          senderName = existingConv.senderName;
        }

        // Store incoming message
        await addMessage(platform, senderId, {
          direction: 'inbound',
          text: messageText,
          messageType,
          metaMessageId,
          timestamp,
          senderName,
        });

        // Only auto-reply to text messages
        if (messageType !== 'text' || !messageText.trim()) continue;

        // Show typing indicator
        await sendTypingIndicator(senderId);

        // Small delay to feel natural
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

        // Get conversation history for context
        const history = await getMessages(platform, senderId, { limit: 6 });

        // Generate AI reply
        const aiReply = await generateReply(messageText, history, {
          platform,
          senderName,
        });

        // Send reply via Meta API
        const sendResult = await sendMessage(senderId, aiReply.text);

        // Store our reply
        if (sendResult.success) {
          await addMessage(platform, senderId, {
            direction: 'outbound',
            text: aiReply.text,
            messageType: 'text',
            metaMessageId: sendResult.messageId,
            timestamp: new Date().toISOString(),
            aiGenerated: aiReply.aiGenerated,
          });
        } else {
          console.error(`Failed to send reply to ${senderId}:`, sendResult.error);
        }
      }
    }

    // Meta requires 200 OK within 20 seconds or it retries
    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    // Still return 200 to prevent Meta from retrying
    return Response.json({ status: 'error', message: err.message }, { status: 200 });
  }
}
