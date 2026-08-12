/**
 * Base offer storage (subject + body), persisted to Vercel KV so it can be
 * edited from the dashboard and reused by the AI personalizer + any sender.
 */

import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

const OFFER_KEY = 'base_offer';

const DEFAULT_OFFER = {
  subject: '{{name}} — quick idea for {{company}}',
  body: `Hi {{name}},

Quick one. Most founders are great at the actual work — it's chasing new clients that quietly eats the week.

That's the part we take off your plate: we run cold email for {{company}} and book you sales calls on a plan that fits — 10, 20, even 50 a month. Inboxes, lists, copy, sending — all done for you. You just show up and close.

And it's fully guaranteed: if we don't hit your number, we refund every cent. No risk on your end at all.

Open to seeing how it'd work?

Best,
Limethsith`,
};

export async function GET() {
  try {
    const saved = await kv.get(OFFER_KEY).catch(() => null);
    return Response.json({ success: true, offer: saved || DEFAULT_OFFER, isDefault: !saved });
  } catch {
    return Response.json({ success: true, offer: DEFAULT_OFFER, isDefault: true });
  }
}

export async function POST(request) {
  try {
    const { subject, body } = await request.json();
    if (!subject || !subject.trim() || !body || !body.trim()) {
      return Response.json({ success: false, error: 'Subject and body are both required.' }, { status: 400 });
    }
    const offer = { subject: subject.trim(), body: body.trim(), updatedAt: new Date().toISOString() };
    await kv.set(OFFER_KEY, offer);
    return Response.json({ success: true, offer });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
