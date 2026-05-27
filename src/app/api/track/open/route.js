import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

// 1x1 transparent GIF pixel
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      const email = Buffer.from(id, 'base64').toString('utf-8');
      const userAgent = request.headers.get('user-agent') || 'unknown';
      const now = new Date().toISOString();

      // Get existing open record to increment count
      const existing = await kv.hget('email_opens', email);
      const count = existing ? (existing.count || 0) + 1 : 1;

      // Store open event in email_opens hash
      await kv.hset('email_opens', {
        [email]: {
          email,
          openedAt: existing?.openedAt || now,
          count,
          userAgent,
          lastOpenedAt: now,
        },
      });

      // Update the lead record in leads hash
      const lead = await kv.hget('leads', email);
      if (lead) {
        await kv.hset('leads', {
          [email]: {
            ...lead,
            opened: true,
            openedAt: lead.openedAt || now,
          },
        });
      }
    }
  } catch (error) {
    console.error('Tracking pixel error:', error);
  }

  // Always return the pixel regardless of tracking success
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}
