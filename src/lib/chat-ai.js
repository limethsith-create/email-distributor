/**
 * AI Auto-Reply Engine — Gemini Flash
 *
 * Generates contextual responses to incoming Instagram/Facebook messages.
 * Designed for Aviance's AI automation services positioning.
 *
 * Falls back to a polite "we'll get back to you" if AI is unavailable.
 */

const SYSTEM_PROMPT = `You are a helpful assistant for Aviance, an AI automation agency based in Sri Lanka. You help businesses automate their operations using AI.

Rules:
- Keep replies SHORT (under 50 words)
- Be warm, friendly, and conversational
- If someone asks about services, briefly mention AI automation for businesses (chatbots, workflow automation, email systems, WhatsApp bots)
- If someone asks pricing, say it depends on the project and offer to set up a quick call
- If someone has a complaint or urgent issue, say you'll get a team member to help right away
- Never make up specific prices, timelines, or promises
- If the message is a greeting, reply naturally and ask how you can help
- Sign off as "Aviance Team" only if it feels natural
- Match the language of the user (if they write in Sinhala or Tamil, reply in that language)
- Do NOT use emojis excessively — one at most`;

const FALLBACK_RESPONSES = {
  greeting: "Hey! Thanks for reaching out. How can we help you today?",
  general: "Thanks for your message! Someone from our team will get back to you shortly.",
  services: "We help businesses automate their operations with AI — chatbots, workflow automation, and more. Want to hop on a quick call to discuss what might work for you?",
};

/**
 * Detect simple message intents for fallback
 */
function detectIntent(text) {
  const lower = (text || '').toLowerCase().trim();

  const greetings = ['hi', 'hello', 'hey', 'hola', 'sup', 'yo', 'good morning', 'good evening', 'ayubowan'];
  if (greetings.some(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + '!'))) {
    return 'greeting';
  }

  const serviceWords = ['service', 'price', 'cost', 'how much', 'what do you', 'automat', 'chatbot', 'ai', 'help me'];
  if (serviceWords.some(w => lower.includes(w))) {
    return 'services';
  }

  return 'general';
}

/**
 * Generate an AI response to an incoming message
 *
 * @param {string} incomingText - The user's message
 * @param {Array} conversationHistory - Recent messages for context [{direction, text}]
 * @param {object} options - { platform, senderName }
 * @returns {Promise<{text: string, aiGenerated: boolean}>}
 */
export async function generateReply(incomingText, conversationHistory = [], options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  // Fallback if no API key
  if (!apiKey) {
    const intent = detectIntent(incomingText);
    return {
      text: FALLBACK_RESPONSES[intent] || FALLBACK_RESPONSES.general,
      aiGenerated: false,
    };
  }

  try {
    // Build conversation context (last 6 messages)
    const recentHistory = conversationHistory.slice(0, 6).reverse();
    const historyText = recentHistory
      .map(m => `${m.direction === 'inbound' ? 'Customer' : 'You'}: ${m.text}`)
      .join('\n');

    const prompt = `${SYSTEM_PROMPT}

Platform: ${options.platform || 'unknown'}
${options.senderName ? `Customer name: ${options.senderName}` : ''}

${historyText ? `Recent conversation:\n${historyText}\n` : ''}
Customer: ${incomingText}

Reply (under 50 words):`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (reply && reply.length > 5 && reply.length < 500) {
      return { text: reply, aiGenerated: true };
    }

    throw new Error('Invalid AI response');
  } catch (err) {
    console.error('AI reply generation failed:', err.message);
    const intent = detectIntent(incomingText);
    return {
      text: FALLBACK_RESPONSES[intent] || FALLBACK_RESPONSES.general,
      aiGenerated: false,
    };
  }
}
