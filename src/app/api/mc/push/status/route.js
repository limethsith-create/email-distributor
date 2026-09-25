/** GET /api/mc/push/status?endpoint= — is this phone subscribed, and how many are. */
import { pushStatus } from '@/lib/push';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const endpoint = new URL(request.url).searchParams.get('endpoint');
  return Response.json(await pushStatus(endpoint));
}
