'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { box, btn, btnGhost, api, Eyebrow, ago, Dot } from './_ui/ui';

export default function Board() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const load = () => api('/api/mc/board').then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  async function act(action) {
    setMsg('Working…');
    try {
      const r = await api('/api/mc/setup', { action });
      setMsg(action === 'migrate' ? `Done: ${r.done.join('; ') || 'nothing to do'}` : `Test alert: ${JSON.stringify(r.channels)}`);
      load();
    } catch (e) { setMsg(e.message); }
  }

  if (!data) return <p>{msg || 'Loading…'}</p>;
  const hb = data.heartbeat;
  const hbColor = hb.ageSec == null ? 'var(--fg-dim)' : hb.ageSec < 180 ? 'var(--success)' : hb.ageSec < 900 ? 'var(--warning)' : 'var(--danger)';
  const s = data.setup;
  const missing = Object.entries({ 'ENC_KEY': s.encKey, 'CRON_SECRET': s.cronSecret, 'Telegram bot': s.telegram, 'Healthchecks URL': s.healthchecks, 'OWNER_INBOX': s.ownerInbox }).filter(([, ok]) => !ok).map(([k]) => k);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Every trial, one screen</h1>
      </div>

      <div style={{ ...box, display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
        <span><Dot color={hbColor} />Heartbeat {hb.lastTickAt ? ago(hb.lastTickAt) : 'never'} {hb.source ? `(${hb.source})` : ''}</span>
        <span>Ticks today: {hb.ticksToday}</span>
        <span>Last send: {ago(hb.lastSendAt)}</span>
        <span>Active trials: {data.activeTrials} / 3</span>
        <Link href="/mc/alerts">Open alerts: {data.openAlerts}</Link>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!s.migrated && <button style={btn} onClick={() => act('migrate')}>Run first-time setup</button>}
          <button style={btnGhost} onClick={() => act('test-alert')}>Send test alert</button>
        </span>
      </div>
      {missing.length > 0 && <div style={{ ...box, borderColor: 'var(--warning)' }}>Still to set in Vercel: {missing.join(', ')}</div>}
      {msg && <div style={box}>{msg}</div>}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {data.clients.length === 0 && <p>No clients yet. Run first-time setup to create the Aviance client.</p>}
        {data.clients.map((c) => (
          <Link key={c.id} href={`/mc/clients/${c.id}`} style={{ ...box, textDecoration: 'none', color: 'inherit', display: 'grid', gap: 6 }}>
            <strong style={{ fontSize: 17 }}>{c.name}</strong>
            <span className="mono" style={{ fontSize: 12 }}>{c.state}{c.trialDay != null ? ` · day ${c.trialDay}` : ''}</span>
            <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              sent {c.counters.sent ?? '—'} · replies {c.counters.replies ?? '—'} · positive {c.counters.positive ?? '—'} · booked {c.counters.booked ?? '—'} · qualified {c.counters.qualified ?? '—'}
            </span>
            {c.openAlerts > 0 && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{c.openAlerts} open alert(s)</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}
