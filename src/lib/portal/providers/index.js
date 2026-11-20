/**
 * Where a client's numbers come from. A provider is
 *   { name, kind, available(clientId) → bool, daily(clientId, days:string[]) → [{day, sent, replies, interested, booked}] }
 * and the numbers screen adds up every available provider's daily rows.
 *
 * Adding Instantly or Smartlead later: write providers/instantly.js with `available()` returning true only when the
 * client has an API key saved (read it from the client's own config, never from code), and `daily()` calling that
 * service's campaign-analytics endpoint for those days and mapping its sent / reply / interested / meeting counts to
 * the four fields above. Add it to PROVIDERS below. Nothing else changes. Until a real one exists, only native is listed.
 */
import native from './native';

export const PROVIDERS = [native];

/** Merge providers' daily rows by day. Returns { days:[{day,sent,replies,interested,booked}], sources:[{name,kind}] }. */
export async function mergedDaily(clientId, days, providers = PROVIDERS) {
  const out = new Map(days.map((day) => [day, { day, sent: 0, replies: 0, interested: 0, booked: 0 }]));
  const sources = [];
  for (const p of providers) {
    let ok = false;
    try { ok = await p.available(clientId); } catch { ok = false; }
    if (!ok) continue;
    let rows = [];
    try { rows = (await p.daily(clientId, days)) || []; } catch (err) { console.error('[portal] provider failed', p.name, err?.message); continue; }
    sources.push({ name: p.name, kind: p.kind });
    for (const r of rows) {
      const t = out.get(r.day);
      if (!t) continue;
      for (const f of ['sent', 'replies', 'interested', 'booked']) t[f] += Number(r[f]) || 0;
    }
  }
  return { days: [...out.values()], sources };
}
