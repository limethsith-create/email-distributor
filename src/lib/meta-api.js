/**
 * Meta Graph API Client — Instagram & Facebook Messenger
 *
 * Both platforms use the same Meta Send API.
 * The difference is which Page Access Token you use
 * and which webhook events you subscribe to.
 *
 * Required env vars:
 * - META_PAGE_ACCESS_TOKEN — Facebook Page token (handles both FB + IG)
 * - META_VERIFY_TOKEN — webhook verification token (you pick this)
 * - META_APP_SECRET — for webhook signature validation
 */

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Send a text message via Meta Send API
 * Works for both Facebook Messenger and Instagram
 *
 * @param {string} recipientId - The PSID (Facebook) or IGSID (Instagram)
 * @param {string} text - Message text
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendMessage(recipientId, text) {
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageToken) {
    return { success: false, error: 'META_PAGE_ACCESS_TOKEN not configured' };
  }

  try {
    const response = await fetch(`${GRAPH_API_BASE}/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error.message };
    }

    return { success: true, messageId: data.message_id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get user profile info from Meta
 * @param {string} userId - PSID or IGSID
 * @returns {Promise<{name?: string, profilePic?: string}>}
 */
export async function getUserProfile(userId) {
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageToken) return {};

  try {
    const response = await fetch(
      `${GRAPH_API_BASE}/${userId}?fields=name,profile_pic&access_token=${pageToken}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) return {};
    const data = await response.json();
    return {
      name: data.name || data.first_name || null,
      profilePic: data.profile_pic || null,
    };
  } catch {
    return {};
  }
}

/**
 * Send a "typing on" indicator
 */
export async function sendTypingIndicator(recipientId) {
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageToken) return;

  try {
    await fetch(`${GRAPH_API_BASE}/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: 'typing_on',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

/**
 * Validate webhook signature (X-Hub-Signature-256)
 * @param {string} rawBody - raw request body string
 * @param {string} signature - X-Hub-Signature-256 header value
 * @returns {boolean}
 */
export function validateSignature(rawBody, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !signature) return false;

  // Dynamic import to work in edge runtime
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

/**
 * Parse incoming webhook event into a normalized message
 * @param {object} body - webhook POST body
 * @returns {Array<{platform, senderId, text, messageType, metaMessageId, timestamp, recipientId}>}
 */
export function parseWebhookMessages(body) {
  const messages = [];

  if (!body || !body.entry) return messages;

  const platform = detectPlatform(body);

  for (const entry of body.entry) {
    if (!entry.messaging) continue;

    for (const event of entry.messaging) {
      if (!event.message || event.message.is_echo) continue;

      messages.push({
        platform,
        senderId: event.sender.id,
        recipientId: event.recipient.id,
        text: event.message.text || '',
        messageType: event.message.attachments ? 'attachment' : 'text',
        metaMessageId: event.message.mid,
        timestamp: new Date(event.timestamp).toISOString(),
      });
    }
  }

  return messages;
}

/**
 * Determine platform from webhook body
 * Instagram webhooks have 'instagram' in the object field
 */
export function detectPlatform(body) {
  if (body.object === 'instagram') return 'instagram';
  if (body.object === 'page') return 'facebook';
  return 'unknown';
}
