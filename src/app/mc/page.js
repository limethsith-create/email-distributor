'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { box, btn, btnGhost, api, Eyebrow, ago, Dot } from './_ui/ui';

const COLOUR = { green: 'var(--success)', yellow: 'var(--warning)', red: 'var(--danger)' };
const pctText = (u) => (u?.pct == null ? 'not measured' : `${u.pct}%`);

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

  async function pauseResume(c) {
    const to = c.state === 'paused' ? 'sending' : 'paused';
    if (!confirm(`${to === 'paused' ? 'Pause' : 'Resume'} ${c.name}?`)) return;
    try { await api(`/api/mc/clients/${c.id}`, { action: 'setState', to, reason: `owner ${to === 'paused' ? 'paused' : 'resumed'} from the board` }); load(); } catch (e) { setMsg(e.message); }
  }

  if (!data) return <p>{msg || 'Loading…'}</p>;
  const hb = data.heartbeat;
  const hbColor = hb.ageSec == null ? 'var(--fg-dim)' : hb.ageSec < 180 ? 'var(--success)' : hb.ageSec < 900 ? 'var(--warning)' : 'var(--danger)';
  const s = data.setup;
  const missing = Object.entries({ 'ENC_KEY': s.encKey, 'CRON_SECRET': s.cronSecret, 'Telegram bot': s.telegram, 'Healthchecks URL': s.healthchecks, 'OWNER_INBOX': s.ownerInbox }).filter(([, ok]) => !ok).map(([k]) => k);
  const u = data.usage;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Every trial, one screen</h1>
      </div>

      <div style={{ ...box, display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', fontSize: 14 }}>
        <span><Dot color={hbColor} />Heartbeat {hb.lastTickAt ? ago(hb.lastTickAt) : 'never'} {hb.source ? `(${hb.source})` : ''}</span>
        <span>Ticks today: {hb.ticksToday}</span>
        <span>Redis: {pctText(u.redis)}</span>
        <span>Places: {pctText(u.places)}</span>
        <span>Reoon credits left: {u.reoon.remaining == null ? 'not measured' : u.reoon.remaining}</span>
        <span>Active trials: {data.activeTrials} / {data.maxActiveTrials}</span>
        <span style={{ color: data.extensions > 1 ? 'var(--danger)' : 'inherit' }}>Extensions: {data.extensions}</span>
        <Link href="/mc/alerts">Open alerts: {data.openAlerts}</Link>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!s.migrated && <button style={btn} onClick={() => act('migrate')}>Run first-time setup</button>}
          <button style={btnGhost} onClick={() => act('test-alert')}>Send test alert</button>
        </span>
      </div>
      {missing.length > 0 && <div style={{ ...box, borderColor: 'var(--warning)' }}>Still to set in Vercel: {missing.join(', ')}</div>}
      {msg && <div style={box}>{msg}</div>}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {data.clients.length === 0 && <p>No clients yet. Run first-time setup to create the Aviance client.</p>}
        {data.clients.map((c) => (
          <div key={c.id} style={{ ...box, display: 'grid', gap: 6, borderLeft: `4px solid ${COLOUR[c.health]}` }}>
            <Link href={`/mc/clients/${c.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <strong style={{ fontSize: 17 }}><Dot color={COLOUR[c.health]} />{c.name}</strong>
            </Link>
            <span className="mono" style={{ fontSize: 12 }}>
              {c.state}{c.trialDay != null ? ` · day ${c.trialDay}` : ''}{c.day1Date ? ` · D1 ${c.day1Date}` : ''}{c.day30Date ? ` · D30 ${c.day30Date}` : ''}
            </span>
            <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              sent {c.five.sent ?? '—'} · replies {c.five.replies ?? '—'} · positive {c.five.positive ?? '—'} · booked {c.five.booked ?? '—'} · qualified {c.five.qualified ?? '—'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              inbox rate {c.inboxRate == null ? '—' : `${Math.round(c.inboxRate * 100)}%`} · last tick {c.lastJobAt ? ago(c.lastJobAt) : 'never'}
            </span>
            {c.healthReasons.length > 0 && <span style={{ fontSize: 12, color: COLOUR[c.health] }}>{c.healthReasons.join(' · ')}</span>}
            {c.openAlerts > 0 && <Link href="/mc/alerts" style={{ color: 'var(--danger)', fontSize: 13 }}>{c.openAlerts} open alert(s)</Link>}
            {['sending', 'paused'].includes(c.state) && (
              <button style={{ ...btnGhost, justifySelf: 'start', padding: '4px 10px' }} onClick={() => pauseResume(c)}>{c.state === 'paused' ? 'Resume' : 'Pause'}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
