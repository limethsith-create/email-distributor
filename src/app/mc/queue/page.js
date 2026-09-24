'use client';

/**
 * /mc/queue — applicants waiting for a trial slot (SPEC §10.1), in order,
 * with their expected dates. Promote moves one into onboarding now (even
 * over the 3-trial cap — the owner's call); Decline sends decline_fit with
 * the reason typed here.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { box, btn, btnGhost, input, api, Eyebrow } from '@/app/mc/_ui/ui';

export default function Queue() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [reasons, setReasons] = useState({});
  const load = () => api('/api/mc/queue').then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  async function act(action, clientId) {
    if (action === 'decline' && !String(reasons[clientId] || '').trim()) { setMsg('Type the reason first — it goes to the applicant.'); return; }
    if (action === 'promote' && data.capacity.active >= data.capacity.max && !window.confirm(`${data.capacity.active} trials are already active (cap ${data.capacity.max}). Promote anyway?`)) return;
    setMsg('Working…');
    try {
      await api('/api/mc/queue', { action, clientId, reason: reasons[clientId] });
      setMsg(action === 'promote' ? 'Promoted — the onboarding link is on its way.' : 'Declined and emailed.');
      load();
    } catch (e) { setMsg(e.message); }
  }

  if (!data) return <p>{msg || 'Loading…'}</p>;
  const c = data.capacity;
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Trial queue</h1>
        <p style={{ color: 'var(--fg-muted)' }}>Active trials {c.active} / {c.max}{c.inExtension ? ' · an extension is running, so no new trials start' : ''}.</p>
      </div>
      {msg && <div style={box}>{msg}</div>}
      {data.rows.length === 0 && <div style={box}>Nobody is waiting.</div>}
      {data.rows.map((r, i) => (
        <div key={r.id} style={{ ...box, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong>#{i + 1} <Link href={`/mc/clients/${r.id}`}>{r.name || r.id}</Link></strong>
            <span className="mono" style={{ fontSize: 12 }}>{r.mainDomain}</span>
            <span style={{ fontSize: 13 }}>{r.contactName} · {r.contactEmail}</span>
            <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>queued {r.queuedAt ? new Date(r.queuedAt).toLocaleDateString() : '—'} · expected {r.expectedDate || 'no date yet'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn} onClick={() => act('promote', r.id)}>Promote</button>
            <input style={{ ...input, maxWidth: 420 }} placeholder="Reason for declining (sent to the applicant)" value={reasons[r.id] || ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} />
            <button style={btnGhost} onClick={() => act('decline', r.id)}>Decline</button>
          </div>
        </div>
      ))}
    </div>
  );
}
