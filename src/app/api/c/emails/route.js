/**
 * GET /api/c/emails?token=&limit=200&before=ISO — the client's page, "Emails sent": every email that went to
 * their prospects, newest first, paged like GET /api/mc/hub/{id}/emails (never the emails to the client).
 */

import { emailsFor } from '@/lib/systems/maillog';
import { withSharedClient } from '../_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  return withSharedClient(request, (id, q) => emailsFor(id, { limit: q.get('limit') || 200, before: q.get('before') || null, shared: true }));
}
