/**
 * GET /api/mc/ava/status — Ava's brains (docs/HUB-API.md "Ava (AI helper)").
 * Owner and team members.
 *   → { brains: [{ id, name, ready, model, models, lastError, lastOkAt }], ready, search: ['tavily'|'exa'], hear }
 * Never a key. `ready` = at least one brain can answer now. `model` = the
 * model picked for everyday questions, `models` = every usable one, best
 * first (read live from the service, 6 h). `search` = the web search services
 * with a key; `hear` = speech-to-text on the machine (a Groq key).
 */

import { brainsStatus } from '@/lib/ava/brains';
import { searchProviders } from '@/lib/ava/search';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    const brains = await brainsStatus();
    const search = await searchProviders().catch(() => []);
    return Response.json({ brains, ready: brains.some((b) => b.ready), search, hear: brains.some((b) => b.id === 'groq' && !/No key yet/.test(b.lastError || '')) });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
