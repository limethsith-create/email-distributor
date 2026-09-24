'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow } from '../_ui/ui';

export default function TestMode() {
  const [d, setD] = useState(null);
  const [day, setDay] = useState('1');
  const [msg, setMsg] = useState('');
  const load = () => api('/api/mc/test').then(setD).catch((e) => setMsg(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  async function post(body, label) {
    setMsg('Working…');
    try { const r = await api('/api/mc/test', body); setMsg(`${label}: ${JSON.stringify(r).slice(0, 300)}`); load(); } catch (e) { setMsg(e.message); }
  }

  if (!d) return <p>{msg || 'Loading…'}</p>;
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / Test Mode</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Run a whole trial in an afternoon</h1>
        <p style={{ color: 'var(--fg-muted)' }}>The client <span className="mono">_test</span> runs on a fast clock (1 day = 1 hour by default). Its leads are the warm-up helper accounts and your own addresses, so real emails only go to inboxes you own.</p>
      </div>
      {msg && <div style={{ ...box, fontSize: 13 }} className="mono">{msg}</div>}

      <section style={{ ...box, display: 'grid', gap: 10 }}>
        <Eyebrow>Status</Eyebrow>
        {d.running ? (
          <p className="mono" style={{ margin: 0 }}>state {d.state} · day {d.day ?? '—'} · clock {d.virtualNow?.slice(0, 16).replace('T', ' ')} UTC · ×{d.clockScale}{d.heartbeatLoss ? ' · heartbeat pings paused' : ''}</p>
        ) : <p style={{ margin: 0 }}>No test running.</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!d.running && <button style={btn} onClick={() => post({ action: 'start', from: 'apply' }, 'Started')}>Start trial (from apply)</button>}
          {!d.running && <button style={btnGhost} onClick={() => post({ action: 'start', from: 'sending' }, 'Started')}>Start at Day 1 (skip intake)</button>}
          {d.running && <button style={btnGhost} onClick={() => post({ action: 'tick' }, 'Tick')}>Run due jobs now</button>}
          {d.running && <button style={btnGhost} onClick={() => confirm('Delete the whole test client?') && post({ action: 'reset' }, 'Reset')}>Reset</button>}
        </div>
      </section>

      {d.running && (
        <>
          <section style={{ ...box, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Eyebrow>Jump to day</Eyebrow>
            <input style={{ ...input, width: 90 }} value={day} onChange={(e) => setDay(e.target.value)} />
            <button style={btn} onClick={() => post({ action: 'jump', day }, `Day ${day}`)}>Jump</button>
            {[-7, 1, 20, 29, 30, 31, 33, 37, 44, 45, 60].map((n) => <button key={n} style={btnGhost} onClick={() => post({ action: 'jump', day: n }, `Day ${n}`)}>{n}</button>)}
          </section>
          <section style={{ ...box, display: 'grid', gap: 8 }}>
            <Eyebrow>Simulate</Eyebrow>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {d.replyKinds.map((k) => <button key={k} style={btnGhost} onClick={() => post({ action: 'simulate', kind: k }, `Reply ${k}`)}>reply: {k}</button>)}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['sends', 'booking', 'held', 'noshow', 'bounce_spike', 'heartbeat_loss'].map((k) => <button key={k} style={btnGhost} onClick={() => post({ action: 'simulate', kind: k }, k)}>{k.replace('_', ' ')}</button>)}
            </div>
          </section>
          <section style={box}>
            <Eyebrow>Event log</Eyebrow>
            {d.events.map((e, i) => (
              <div key={i} className="mono" style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                {String(e.at).slice(0, 16).replace('T', ' ')} · {e.system} · {e.event} {e.detail ? JSON.stringify(e.detail).slice(0, 160) : ''}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
