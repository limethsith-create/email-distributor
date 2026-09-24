/** Client button API (SPEC §8.8 / §7.3): "away". Public; authorised by the signed `buttons` token. */
import { handleButtons } from '@/lib/systems/clientwatch';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { status, body } = await handleButtons(await request.json().catch(() => ({})), 'away');
  return Response.json(body, { status });
}
