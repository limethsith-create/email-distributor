/** GET /api/c/threads?token= — the client's page, "Conversations": one row per prospect who wrote back (as GET /api/mc/hub/{id}/threads). */

import { threadsFor } from '@/lib/systems/maillog';
import { withSharedClient } from '../_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  return withSharedClient(request, (id) => threadsFor(id));
}
