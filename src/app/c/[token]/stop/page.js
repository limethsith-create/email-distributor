'use client';

import { useEffect, useState } from 'react';
import { card, button, call } from '../../_stagec/ui';

export default function StopTrial({ params }) {
  const t = params.token;
  const [info, setInfo] = useState(null);
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call(`/api/c/buttons?t=${encodeURIComponent(t)}`).then(setInfo).catch((e) => setError(e.message)); }, [t]);

  async function submit() {
    setBusy(true); setError(null);
    try { await call('/api/c/stop', { t, confirm: true }); setDone(true); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  if (error && !info) return <div style={card}><p>{error}</p></div>;
  if (!info) return <div style={card}><p>Loading…</p></div>;
  if (done) return <div style={card}><h2 style={{ marginTop: 0 }}>Stopped.</h2><p>No more emails go out from today. You will get the report and your full list, and the trial domain is retired within seven days.</p></div>;
  return (
    <div style={card}>
      <h2 style={{ marginTop: 0 }}>Stop the trial</h2>
      <p>This stops all sending today{info.clientName ? ` for ${info.clientName}` : ''}. You still get the report of what your market said and the full list; the trial domain and inboxes are retired within seven days.</p>
      <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> Yes, stop the trial</label>
      <button style={button} disabled={busy || !sure} onClick={submit}>{busy ? 'Stopping…' : 'Stop the trial'}</button>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </div>
  );
}
