'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow, ago, Dot } from '../_ui/ui';

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
const EMPTY = { email: '', password: '', displayName: '', provider: 'google', imapUser: '' };

export default function Warmup() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [h, setH] = useState(EMPTY);
  const load = () => api('/api/mc/warmup').then(setD).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  async function post(body, done) {
    setMsg('Working…');
    try { await api('/api/mc/warmup', body); setMsg(done || 'Saved'); await load(); } catch (e) { setMsg(e.message); }
  }
  if (!d) return <p>{msg || 'Loading…'}</p>;
  const helpers = d.members.filter((m) => m.isHelper);
  const aviance = d.members.filter((m) => m.isAviance);
  const inboxes = d.members.filter((m) => !m.isHelper && !m.isAviance);
  const presets = d.presets || [];
  const usable = presets.filter((p) => p.helper);
  const blocked = presets.filter((p) => !p.helper);
  const chosen = presets.find((p) => p.id === h.provider) || usable[0];
  const providers = Object.entries(d.summary?.providers || {}).map(([k, n]) => `${k} ${n}`).join(' · ');
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / Warm-up</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Warm-up circle</h1>
        <p className="mono" style={{ fontSize: 12 }}>
          {d.members.length} members (minimum {d.minPool}) · {inboxes.length} trial inboxes · {aviance.length} aviance · {helpers.length} helpers · {d.summary?.families ?? '—'} mail families · {d.pairs.length} pairs today ({d.day})
        </p>
        {providers && <p className="mono" style={{ fontSize: 12, margin: 0 }}>{providers}</p>}
      </div>
      {msg && <div style={box}>{msg}</div>}
      {d.members.length < d.minPool && <div style={{ ...box, borderColor: 'var(--warning)' }}>The circle is below the minimum of {d.minPool}. Add free helper accounts below — mix the families (Gmail, Yahoo or AOL, iCloud, GMX or WEB.DE, Yandex) so every trial inbox pairs with a different filter.</div>}
      {d.minFamilies > 0 && (d.summary?.families ?? 0) < d.minFamilies && <div style={{ ...box, borderColor: 'var(--warning)' }}>Only {d.summary?.families ?? 0} mail famil{(d.summary?.families ?? 0) === 1 ? 'y' : 'ies'} in the circle. The trial inboxes are Google Workspace, so helpers from other families (Yahoo or AOL, iCloud, GMX or WEB.DE, Yandex) warm them against more spam filters than extra Gmail accounts do.</div>}

      <section style={box}>
        <Eyebrow>Pool members</Eyebrow>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['Inbox', 'Who', 'Provider', 'Day', 'Quota', 'Sent today', 'Received', 'Inbox rate 7d', 'Ready', 'Health', 'Last read'].map((x) => <th key={x} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--fg)' }}>{x}</th>)}</tr></thead>
            <tbody>{d.members.map((m) => (
              <tr key={`${m.clientId}|${m.email}`}>
                <td style={{ padding: '6px 8px' }}>{m.email}</td>
                <td style={{ padding: '6px 8px' }}>{m.isHelper ? 'helper' : m.isAviance ? 'aviance (own)' : m.clientId}</td>
                <td style={{ padding: '6px 8px' }}>{m.label || m.provider}</td>
                <td style={{ padding: '6px 8px' }}>{m.days ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>{m.quota}</td>
                <td style={{ padding: '6px 8px' }}>{m.sentToday}{m.errorsToday ? ` (${m.errorsToday} failed)` : ''}</td>
                <td style={{ padding: '6px 8px' }}>{m.receivedToday}</td>
                <td style={{ padding: '6px 8px' }}>{pct(m.inboxRate7d)}</td>
                <td style={{ padding: '6px 8px' }}>{m.isHelper || m.isAviance ? '—' : m.ready ? 'yes' : 'no'}</td>
                <td style={{ padding: '6px 8px' }}><Dot color={/fail|error/.test(m.health) ? 'var(--danger)' : m.health === 'new' ? 'var(--fg-dim)' : 'var(--success)'} />{m.health}{m.lastReadError ? ` — ${m.lastReadError.slice(0, 60)}` : ''}</td>
                <td style={{ padding: '6px 8px' }}>{ago(m.lastReadAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      {d.aviance && (
        <section style={box}>
          <Eyebrow>Your own inboxes (aviance)</Eyebrow>
          <p style={{ margin: '4px 0' }}>{d.aviance.included ? `Included in the circle (WARMUP.includeAviance): ${aviance.length} inbox(es) stored in Mission Control. Env-only accounts are not included.` : 'Not included (WARMUP.includeAviance is off in /mc/config).'}</p>
          {(d.aviance.loginFailed || []).map((x) => (
            <div key={x.email} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0' }}>
              <span style={{ flex: 1 }}>{x.email} — warm-up login failed {ago(x.since)}</span>
              <button style={btnGhost} onClick={() => post({ action: 'retryMember', clientId: 'aviance', email: x.email }, 'Back in the circle')}>Retry</button>
            </div>
          ))}
        </section>
      )}

      <section style={box}>
        <Eyebrow>External warm-up network</Eyebrow>
        {d.external
          ? <p style={{ margin: '4px 0' }}>{d.external.name}: {d.external.status} ({d.external.perDay}/day per trial inbox, managed by you in its own dashboard). The circle sends that much less so the 15/day ceiling holds.</p>
          : <p style={{ margin: '4px 0' }}>None. No free warm-up network can be connected automatically in 2026 (see docs/research/v2-deliverability.md). If you connect trial inboxes to one by hand (e.g. AutoMailer’s free plan), set EXTERNAL_WARMUP in /mc/config so the circle sends less.</p>}
      </section>

      <section style={box}>
        <Eyebrow>Helper accounts</Eyebrow>
        {d.helpers.length === 0 && <p>No helper accounts yet.</p>}
        {d.helpers.map((x) => (
          <div key={x.email} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <strong style={{ flex: 1, minWidth: 220 }}>{x.email}</strong>
            <span className="mono" style={{ fontSize: 12 }}>{x.provider} · {x.hasPassword ? 'password stored' : 'NO password'} · {x.health || 'new'}{x.providerOk ? '' : ' · provider not supported'}</span>
            {x.health === 'auth_failed' && <button style={btnGhost} onClick={() => post({ action: 'retryMember', clientId: '_helper', email: x.email }, 'Retrying')}>Retry</button>}
            <button style={x.enabled !== '0' ? btn : btnGhost} onClick={() => post({ action: 'helperEnabled', email: x.email, enabled: x.enabled === '0' })}>{x.enabled !== '0' ? 'ON' : 'OFF'}</button>
            <button style={btnGhost} onClick={() => confirm(`Remove ${x.email} from the circle?`) && post({ action: 'removeHelper', email: x.email }, 'Removed')}>Remove</button>
            {!x.providerOk && x.providerNote && <p style={{ flexBasis: '100%', margin: 0, fontSize: 12, color: 'var(--warning)' }}>{x.providerNote}</p>}
          </div>
        ))}
        {!d.encKey && <p style={{ color: 'var(--warning)' }}>ENC_KEY is not set, so helper passwords can’t be saved yet.</p>}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: 12 }}>
          <select style={input} value={h.provider} onChange={(e) => setH({ ...h, provider: e.target.value })}>
            {usable.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input style={input} placeholder="helper email" value={h.email} onChange={(e) => setH({ ...h, email: e.target.value })} />
          <input style={input} placeholder="app password" type="password" value={h.password} onChange={(e) => setH({ ...h, password: e.target.value })} />
          <input style={input} placeholder="display name (e.g. Sam Carter)" value={h.displayName} onChange={(e) => setH({ ...h, displayName: e.target.value })} />
          {h.provider === 'icloud' && <input style={input} placeholder="IMAP user (default: part before @)" value={h.imapUser} onChange={(e) => setH({ ...h, imapUser: e.target.value })} />}
          <button style={btn} disabled={!h.email || !h.password} onClick={async () => { await post({ action: 'addHelper', ...h }, 'Helper added'); setH(EMPTY); }}>Add helper</button>
        </div>
        {chosen && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>{chosen.note}</p>
            <ol style={{ margin: '4px 0', paddingLeft: 18 }}>{chosen.setup.map((s) => <li key={s}>{s}</li>)}</ol>
            <p className="mono" style={{ fontSize: 11, margin: 0 }}>IMAP {chosen.imap} · SMTP {chosen.smtp} · spam folder {chosen.spam}</p>
          </div>
        )}
        {blocked.length > 0 && (
          <details style={{ marginTop: 10, fontSize: 12 }}>
            <summary>Providers that cannot be free helpers</summary>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{blocked.map((p) => <li key={p.id}><strong>{p.label}</strong>: {p.note}</li>)}</ul>
          </details>
        )}
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
