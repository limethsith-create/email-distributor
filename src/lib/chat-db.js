/**
 * Chat Database — Vercel KV (Upstash Redis)
 * Stores all Instagram & Facebook Messenger conversations.
 *
 * Data model:
 * - conversations:{platform}:{senderId} → conversation metadata
 * - messages:{platform}:{senderId} → list of messages (newest first)
 * - chat_stats → global counters
 */

import { kv } from '@vercel/kv';

const CONV_PREFIX = 'conversations';
const MSG_PREFIX = 'messages';
const CHAT_STATS_KEY = 'chat_stats';
const CONV_INDEX_KEY = 'conv_index'; // sorted set: score=lastMessageAt, member=platform:senderId

// ─── Conversations ───

/**
 * Get or create a conversation
 */
export async function getOrCreateConversation(platform, senderId, senderName = null) {
  const key = `${CONV_PREFIX}:${platform}:${senderId}`;

  try {
    const existing = await kv.hgetall(key);
    if (existing && existing.senderId) {
      return existing;
    }
  } catch {}

  const conversation = {
    senderId,
    platform, // 'instagram' or 'facebook'
    senderName: senderName || 'Unknown',
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: '',
    messageCount: 0,
    unread: 0,
    status: 'active', // active, archived
  };

  await kv.hset(key, conversation);
  await kv.zadd(CONV_INDEX_KEY, { score: Date.now(), member: `${platform}:${senderId}` });

  return conversation;
}

/**
 * Update conversation metadata after a new message
 */
export async function updateConversation(platform, senderId, updates) {
  const key = `${CONV_PREFIX}:${platform}:${senderId}`;
  await kv.hset(key, {
    ...updates,
    lastMessageAt: new Date().toISOString(),
  });
  // Update sort order in index
  await kv.zadd(CONV_INDEX_KEY, { score: Date.now(), member: `${platform}:${senderId}` });
}

/**
 * Get a single conversation
 */
export async function getConversation(platform, senderId) {
  const key = `${CONV_PREFIX}:${platform}:${senderId}`;
  try {
    return await kv.hgetall(key);
  } catch {
    return null;
  }
}

/**
 * List all conversations, newest first
 */
export async function listConversations({ platform = null, limit = 50, offset = 0 } = {}) {
  try {
    // Get all conversation keys from sorted index (newest first)
    const members = await kv.zrange(CONV_INDEX_KEY, '+inf', '-inf', {
      byScore: true,
      rev: true,
      offset,
      count: limit,
    });

    if (!members || members.length === 0) return [];

    const conversations = [];
    for (const member of members) {
      const [plat, ...senderParts] = member.split(':');
      const sid = senderParts.join(':');

      // Filter by platform if specified
      if (platform && plat !== platform) continue;

      const conv = await kv.hgetall(`${CONV_PREFIX}:${plat}:${sid}`);
      if (conv && conv.senderId) {
        conversations.push(conv);
      }
    }

    return conversations;
  } catch {
    return [];
  }
}

/**
 * Mark conversation as read
 */
export async function markAsRead(platform, senderId) {
  const key = `${CONV_PREFIX}:${platform}:${senderId}`;
  await kv.hset(key, { unread: 0 });
}

/**
 * Archive a conversation
 */
export async function archiveConversation(platform, senderId) {
  const key = `${CONV_PREFIX}:${platform}:${senderId}`;
  await kv.hset(key, { status: 'archived' });
}

// ─── Messages ───

/**
 * Store a new message
 */
export async function addMessage(platform, senderId, message) {
  const msgKey = `${MSG_PREFIX}:${platform}:${senderId}`;

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    platform,
    senderId,
    direction: message.direction, // 'inbound' or 'outbound'
    text: message.text || '',
    timestamp: message.timestamp || new Date().toISOString(),
    senderName: message.senderName || null,
    messageType: message.messageType || 'text', // text, image, sticker, etc.
    metaMessageId: message.metaMessageId || null, // Meta's message ID
    aiGenerated: message.aiGenerated || false,
  };

  // Push to message list (newest first)
  await kv.lpush(msgKey, msg);
  // Keep last 500 messages per conversation
  await kv.ltrim(msgKey, 0, 499);

  // Update conversation metadata
  const conv = await getOrCreateConversation(platform, senderId, message.senderName);
  const updates = {
    lastMessagePreview: (msg.text || '').substring(0, 100),
    messageCount: (conv.messageCount || 0) + 1,
  };

  if (message.senderName && conv.senderName === 'Unknown') {
    updates.senderName = message.senderName;
  }

  if (msg.direction === 'inbound') {
    updates.unread = (conv.unread || 0) + 1;
  }

  await updateConversation(platform, senderId, updates);

  // Update global stats
  try {
    await kv.hincrby(CHAT_STATS_KEY, `total_${msg.direction}`, 1);
    await kv.hincrby(CHAT_STATS_KEY, `${platform}_${msg.direction}`, 1);
  } catch {}

  return msg;
}

/**
 * Get messages for a conversation
 */
export async function getMessages(platform, senderId, { limit = 50, offset = 0 } = {}) {
  const msgKey = `${MSG_PREFIX}:${platform}:${senderId}`;
  try {
    const messages = await kv.lrange(msgKey, offset, offset + limit - 1);
    return messages || [];
  } catch {
    return [];
  }
}

// ─── Stats ───

export async function getChatStats() {
  try {
    const stats = await kv.hgetall(CHAT_STATS_KEY) || {};
    const allConvs = await kv.zcard(CONV_INDEX_KEY) || 0;

    return {
      totalConversations: allConvs,
      totalInbound: parseInt(stats.total_inbound || 0),
      totalOutbound: parseInt(stats.total_outbound || 0),
      instagramInbound: parseInt(stats.instagram_inbound || 0),
      instagramOutbound: parseInt(stats.instagram_outbound || 0),
      facebookInbound: parseInt(stats.facebook_inbound || 0),
      facebookOutbound: parseInt(stats.facebook_outbound || 0),
    };
  } catch {
    return { totalConversations: 0, totalInbound: 0, totalOutbound: 0 };
  }
}
