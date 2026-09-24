/** Learning Library for Mission Control (SPEC §8.11). GET → per-niche variant table (aggregate, no personal data). */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { listNiches, parseRaw, rankVariants, bestOf } from '@/lib/systems/learning';

export const dynamic = 'force-dynamic';

export async function GET() {
  const minSends = await cfg(null, 'LEARNING.minSends');
  const niches = [];
  for (const niche of await listNiches()) {
    const parsed = parseRaw((await kv.hgetall(K.learningRaw(niche))) || {});
    const view = (await kv.hgetall(K.learning(niche))) || {};
    niches.push({
      niche,
      variants: Object.entries(parsed.variants).map(([variant, r]) => ({ variant, ...r })).sort((a, b) => a.variant.localeCompare(b.variant)),
      rank: rankVariants(parsed.variants, minSends).map((r) => r.variant),
      bestHour: bestOf(parsed.hours, minSends),
      bestCity: bestOf(parsed.cities, minSends),
      emergencies: parsed.emergencies,
      rankedAt: view._rankedAt || null,
    });
  }
  return Response.json({ niches, minSends });
}
