/**
 * Ava's warm-up (GET /api/mc/ava/warm, docs/HUB-API.md "Ava (AI helper)") —
 * the hub calls it when the Ava panel opens, so the first question does not
 * pay for a cold start: the guide and its search index, the Business facts,
 * the search keys and every brain's model list are loaded into this server
 * instance (and Redis). No AI call, nothing spent.
 */

import { keyedBrains } from '@/lib/ava/brains';
import { modelsFor } from '@/lib/ava/models';
import { guideChunks, indexFor } from '@/lib/ava/kb';
import { factsForQuestion } from '@/lib/ava/facts';
import { searchProviders } from '@/lib/ava/search';

export const WARM = { modelsWaitMs: 4000 };

/** → { ok, ready, brains: [{ id, model, source }], guide: chunks, search: [...], ms }. Never throws. */
export async function warmAva({ now = () => Date.now() } = {}) {
  const t0 = now();
  const [brains, facts, search] = await Promise.all([
    keyedBrains().catch(() => []),
    factsForQuestion().catch(() => ({ text: '' })),
    searchProviders().catch(() => []),
  ]);
  const guide = guideChunks().length;
  indexFor(facts?.text || '');
  const cap = new Promise((r) => { const t = setTimeout(() => r(null), WARM.modelsWaitMs); t.unref?.(); });
  const lists = await Promise.all(brains.map((b) => Promise.race([modelsFor(b, { wait: true }).catch(() => null), cap])));
  return {
    ok: true,
    ready: brains.length > 0,
    brains: brains.map((b, i) => ({ id: b.id, model: lists[i]?.fast || null, quick: lists[i]?.quick || null, source: lists[i]?.source || 'loading' })),
    guide,
    search,
    ms: now() - t0,
  };
}
