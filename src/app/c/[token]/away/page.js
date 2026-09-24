'use client';

import { useEffect, useState } from 'react';
import { card, button, field, call } from '../../_stagec/ui';

export default function Away({ params }) {
  const t = params.token;
  const [info, setInfo] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call(`/api/c/buttons?t=${encodeURIComponent(t)}`).then(setInfo).catch((e) => setError(e.message)); }, [t]);

  async function submit() {
    setBusy(true); setError(null);
    try { setDone(await call('/api/c/away', { t, from, to })); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  if (error && !info) return <div style={card}><p>{error}</p></div>;
  if (!info) return <div style={card}><p>Loading…</p></div>;
  if (done) return <div style={card}><h2 style={{ marginTop: 0 }}>Got it.</h2><p>From {from} to {to} we send half as many emails, so meetings are not booked into an empty calendar.</p></div>;
  return (
    <div style={card}>
      <h2 style={{ marginTop: 0 }}>I’m away</h2>
      <p>Tell us the days you can’t take calls. We halve the sending on those days.</p>
      <label>First day away</label>
      <input style={field} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <label>Last day away</label>
      <input style={field} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      {info.away?.length > 0 && <p style={{ fontSize: 13 }}>Already set: {info.away.map((r) => `${r.from} → ${r.to}`).join(', ')}</p>}
      <button style={button} disabled={busy || !from || !to} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </div>
  );
}
