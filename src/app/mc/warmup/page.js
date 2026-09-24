'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow, ago, Dot } from '../_ui/ui';

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export default function Warmup() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [h, setH] = useState({ email: '', password: '', displayName: '', provider: 'google' });
  const load = () => api('/api/mc/warmup').then(setD).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  async function post(body, done) {
    setMsg('Working…');
    try { await api('/api/mc/warmup', body); setMsg(done || 'Saved'); await load(); } catch (e) { setMsg(e.message); }
  }
  if (!d) return <p>{msg || 'Loading…'}</p>;
  const helpers = d.members.filter((m) => m.isHelper);
  const inboxes = d.members.filter((m) => !m.isHelper);
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / Warm-up</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Warm-up circle</h1>
        <p className="mono" style={{ fontSize: 12 }}>{d.members.length} members (minimum {d.minPool}) · {helpers.length} helpers · {inboxes.length} trial inboxes · {d.pairs.length} pairs today ({d.day})</p>
      </div>
      {msg && <div style={box}>{msg}</div>}
      {d.members.length < d.minPool && <div style={{ ...box, borderColor: 'var(--warning)' }}>The circle is below the minimum of {d.minPool}. Add helper accounts below (3 Gmail, 3 Outlook, 2 Yahoo, 2 Zoho).</div>}

      <section style={box}>
        <Eyebrow>Pool members</Eyebrow>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['Inbox', 'Client', 'Provider', 'Day', 'Quota', 'Sent today', 'Received', 'Inbox rate 7d', 'Ready', 'Health', 'Last read'].map((x) => <th key={x} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--fg)' }}>{x}</th>)}</tr></thead>
            <tbody>{d.members.map((m) => (
              <tr key={`${m.clientId}|${m.email}`}>
                <td style={{ padding: '6px 8px' }}>{m.email}</td>
                <td style={{ padding: '6px 8px' }}>{m.isHelper ? 'helper' : m.clientId}</td>
                <td style={{ padding: '6px 8px' }}>{m.provider}</td>
                <td style={{ padding: '6px 8px' }}>{m.days ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>{m.quota}</td>
                <td style={{ padding: '6px 8px' }}>{m.sentToday}{m.errorsToday ? ` (${m.errorsToday} failed)` : ''}</td>
                <td style={{ padding: '6px 8px' }}>{m.receivedToday}</td>
                <td style={{ padding: '6px 8px' }}>{pct(m.inboxRate7d)}</td>
                <td style={{ padding: '6px 8px' }}>{m.isHelper ? '—' : m.ready ? 'yes' : 'no'}</td>
                <td style={{ padding: '6px 8px' }}><Dot color={/fail|error/.test(m.health) ? 'var(--danger)' : m.health === 'new' ? 'var(--fg-dim)' : 'var(--success)'} />{m.health}{m.lastReadError ? ` — ${m.lastReadError.slice(0, 60)}` : ''}</td>
                <td style={{ padding: '6px 8px' }}>{ago(m.lastReadAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Helper accounts</Eyebrow>
        {d.helpers.length === 0 && <p>No helper accounts yet.</p>}
        {d.helpers.map((x) => (
          <div key={x.email} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <strong style={{ flex: 1, minWidth: 220 }}>{x.email}</strong>
            <span className="mono" style={{ fontSize: 12 }}>{x.provider} · {x.hasPassword ? 'password stored' : 'NO password'} · {x.health || 'new'}</span>
            <button style={x.enabled !== '0' ? btn : btnGhost} onClick={() => post({ action: 'helperEnabled', email: x.email, enabled: x.enabled === '0' })}>{x.enabled !== '0' ? 'ON' : 'OFF'}</button>
            <button style={btnGhost} onClick={() => confirm(`Remove ${x.email} from the circle?`) && post({ action: 'removeHelper', email: x.email }, 'Removed')}>Remove</button>
          </div>
        ))}
        {!d.encKey && <p style={{ color: 'var(--warning)' }}>ENC_KEY is not set, so helper passwords can’t be saved yet.</p>}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: 12 }}>
          <input style={input} placeholder="helper email" value={h.email} onChange={(e) => setH({ ...h, email: e.target.value })} />
          <input style={input} placeholder="app password" type="password" value={h.password} onChange={(e) => setH({ ...h, password: e.target.value })} />
          <input style={input} placeholder="display name (e.g. Sam Carter)" value={h.displayName} onChange={(e) => setH({ ...h, displayName: e.target.value })} />
          <select style={input} value={h.provider} onChange={(e) => setH({ ...h, provider: e.target.value })}>
            {['google', 'outlook', 'yahoo', 'zoho'].map((p) => <option key={p}>{p}</option>)}
          </select>
          <button style={btn} disabled={!h.email || !h.password} onClick={async () => { await post({ action: 'addHelper', ...h }, 'Helper added'); setH({ email: '', password: '', displayName: '', provider: 'google' }); }}>Add helper</button>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Today’s pairs</Eyebrow>
        {d.pairs.length === 0 ? <p>None yet today.</p> : (
          <ul className="mono" style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>{d.pairs.map((p) => <li key={p.pair}>{p.pair.replace('|', ' ↔ ')} · {ago(p.at)}</li>)}</ul>
        )}
      </section>
    </div>
  );
}
