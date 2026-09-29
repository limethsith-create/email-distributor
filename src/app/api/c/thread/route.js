/**
 * GET /api/c/thread?token=&id= — one whole conversation for the client's page (as GET
 * /api/mc/hub/{id}/threads/{threadId}); id `client` is the conversation with us (the Messages tab), money left out.
 */

import { threadFor } from '@/lib/systems/maillog';
import { withSharedClient } from '../_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  return withSharedClient(request, (id, q) => threadFor(id, String(q.get('id') || ''), { shared: true }));
}
