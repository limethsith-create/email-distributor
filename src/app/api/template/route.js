/**
 * Custom email template storage (subject + body).
 * Saved to Vercel KV so it persists and can be reused across the app.
 */

import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

const TEMPLATE_KEY = 'custom_template';

const DEFAULT_TEMPLATE = {
  subject: '{{name}} — quick question about {{company}}',
  body: `Hi {{name}},

I came across {{company}} and had a quick thought on something that might save your team a few hours a week.

Worth a short reply to see if it's relevant?

Best,
Limethsith`,
};

export async function GET() {
  try {
    const saved = await kv.get(TEMPLATE_KEY).catch(() => null);
    return Response.json({ success: true, template: saved || DEFAULT_TEMPLATE });
  } catch {
    return Response.json({ success: true, template: DEFAULT_TEMPLATE });
  }
}

export async function POST(request) {
  try {
    const { subject, body } = await request.json();
    if (!subject || !body) {
      return Response.json({ success: false, error: 'Subject and body are required' }, { status: 400 });
    }
    await kv.set(TEMPLATE_KEY, { subject, body, updatedAt: new Date().toISOString() });
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
