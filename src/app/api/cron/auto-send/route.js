/**
 * Auto-send is DISABLED.
 *
 * This system no longer sends any email (warmup or cold). All sending is
 * handled by a separate external tool. This endpoint used to run the
 * autonomous sender; it now does nothing and never touches an inbox.
 *
 * Kept as a stub so any lingering cron/n8n trigger is a harmless no-op
 * instead of a 404.
 */

export const dynamic = 'force-dynamic';

function disabled() {
  return Response.json({
    disabled: true,
    sent: 0,
    message: 'Auto-send is turned off. Sending is handled by an external tool; this app only records leads.',
  });
}

export async function GET() { return disabled(); }
export async function POST() { return disabled(); }
