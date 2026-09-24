'use client';

import { useEffect, useState } from 'react';
import { box, api, Eyebrow, ago } from '../_ui/ui';

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

export default function Learning() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/mc/learning').then(setData).catch((e) => setError(e.message)); }, []);
  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Eyebrow>Mission Control / Learning Library</Eyebrow>
      <p style={{ margin: 0, fontSize: 13 }}>Aggregate numbers per niche and copy variant (A1 = variant A, version 1). Ranked by booked rate, then positive, then reply rate; a variant needs {data.minSends} sends to be ranked.</p>
      {data.niches.length === 0 && <p>No sends recorded yet.</p>}
      {data.niches.map((n) => (
        <div key={n.niche} style={box}>
          <h3 style={{ marginTop: 0 }}>{n.niche}</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead><tr>{['Variant', 'Sends', 'Replies', 'Positive', 'Booked', 'Reply %', 'Positive %', 'Rank'].map((h) => <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 4 }}>{h}</th>)}</tr></thead>
            <tbody>
              {n.variants.map((v) => (
                <tr key={v.variant}>
                  <td style={{ padding: 4 }}>{v.variant}</td><td>{v.sends}</td><td>{v.replies}</td><td>{v.positive}</td><td>{v.booked}</td>
                  <td>{pct(v.replies, v.sends)}</td><td>{pct(v.positive, v.sends)}</td>
                  <td>{n.rank.indexOf(v.variant) >= 0 ? `#${n.rank.indexOf(v.variant) + 1}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 13, marginBottom: 0 }}>
            Best send hour: {n.bestHour ? `${n.bestHour.name}:00 local (${pct(n.bestHour.replies, n.bestHour.sends)} of ${n.bestHour.sends})` : 'not enough data'} ·
            Best city: {n.bestCity ? `${n.bestCity.name} (${pct(n.bestCity.replies, n.bestCity.sends)} of ${n.bestCity.sends})` : 'not enough data'} ·
            Emergencies: {Object.entries(n.emergencies).map(([k, c]) => `${k} ×${c}`).join(', ') || 'none'} ·
            Ranked {n.rankedAt ? ago(n.rankedAt) : 'not yet (weekly)'}
          </p>
        </div>
      ))}
    </div>
  );
}
