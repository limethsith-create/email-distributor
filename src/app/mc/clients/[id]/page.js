'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow, ago } from '../../_ui/ui';

const LABELS = {
  senderName: 'Sender name (signs every email)',
  senderTitle: 'Sender title',
  senderPrefix: 'Sender address prefix',
  postalAddress: 'Postal address (legally required in every email footer)',
  calendarUrl: 'Calendar link for booked calls',
  defaultNiche: 'Default niche — fills "we book sales calls for {niche}"',
  defaultIcp: 'Default ICP — fills "a verified list of {ICP}"',
  sellsTo: 'What they sell and to whom',
  industry: 'Industry keywords',
  capacityPerWeek: 'Calls per week they can take',
  winCondition: 'Win condition',
};

export default function ClientPage({ params }) {
  const id = params.id;
  const [d, setD] = useState(null);
  const [form, setForm] = useState({});
  const [inbox, setInbox] = useState({ email: '', password: '', displayName: '', provider: 'google' });
  const [msg, setMsg] = useState('');
  const url = `/api/mc/clients/${id}`;

  const load = () => api(url).then((r) => { setD(r); setForm(r.profile || {}); }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [id]);

  async function post(body, done) {
    setMsg('Working…');
    try { const r = await api(url, body); setMsg(done || 'Saved'); await load(); return r; } catch (e) { setMsg(e.message); }
  }

  if (!d) return <p>{msg || 'Loading…'}</p>;
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / {id}</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>{d.client.name || id}</h1>
        <p className="mono" style={{ fontSize: 12 }}>state: {d.client.state} · plan: {d.client.plan} · since {ago(d.client.createdAt)}</p>
      </div>
      {msg && <div style={box}>{msg}</div>}

      <section style={box}>
        <Eyebrow>Profile</Eyebrow>
        <div style={{ display: 'grid', gap: 10 }}>
          {d.profileFields.map((f) => (
            <label key={f} style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              {LABELS[f] || f}
              {f === 'postalAddress' || f === 'sellsTo' || f === 'winCondition'
                ? <textarea rows={2} style={input} value={form[f] || ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
                : <input style={input} value={form[f] || ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />}
            </label>
          ))}
          <button style={btn} onClick={() => post({ action: 'profile', fields: form })}>Save profile</button>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Inboxes</Eyebrow>
        {d.inboxes.length === 0 && <p>No inboxes stored in the database yet.</p>}
        {d.inboxes.map((i) => (
          <div key={i.email} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <strong style={{ flex: 1, minWidth: 220 }}>{i.email}</strong>
            <span className="mono" style={{ fontSize: 12 }}>{i.provider} · {i.hasPassword ? 'password stored' : 'NO password'}</span>
            <button style={i.enabled === '1' ? btn : btnGhost} onClick={() => post({ action: 'inboxEnabled', email: i.email, enabled: i.enabled !== '1' })}>{i.enabled === '1' ? 'ON' : 'OFF'}</button>
            <button style={btnGhost} onClick={() => confirm(`Remove ${i.email}?`) && post({ action: 'removeInbox', email: i.email })}>Remove</button>
          </div>
        ))}
        {!d.encKey && <p style={{ color: 'var(--warning)' }}>ENC_KEY is not set in Vercel, so new inbox passwords can’t be saved yet.</p>}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: 12 }}>
          <input style={input} placeholder="inbox email" value={inbox.email} onChange={(e) => setInbox({ ...inbox, email: e.target.value })} />
          <input style={input} placeholder="app password" type="password" value={inbox.password} onChange={(e) => setInbox({ ...inbox, password: e.target.value })} />
          <input style={input} placeholder="display name" value={inbox.displayName} onChange={(e) => setInbox({ ...inbox, displayName: e.target.value })} />
          <select style={input} value={inbox.provider} onChange={(e) => setInbox({ ...inbox, provider: e.target.value })}>
            {['google', 'outlook', 'yahoo', 'zoho', 'namecheap'].map((p) => <option key={p}>{p}</option>)}
          </select>
          <button style={btn} disabled={!inbox.email || !inbox.password} onClick={async () => { await post({ action: 'addInbox', ...inbox }, 'Inbox saved (switched OFF)'); setInbox({ email: '', password: '', displayName: '', provider: 'google' }); }}>Add inbox</button>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Jobs</Eyebrow>
        {Object.entries(d.jobs).map(([name, last]) => (
          <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', flexWrap: 'wrap' }}>
            <span className="mono" style={{ minWidth: 110 }}>{name}</span>
            <span style={{ flex: 1, fontSize: 13, color: last && !last.ok ? 'var(--danger)' : 'var(--fg-muted)' }}>
              {last ? `${last.ok ? 'ok' : `failed: ${last.error}`} · ${ago(last.at)} · ${last.ms} ms` : 'not run yet'}
            </span>
            <button style={btnGhost} onClick={() => post({ action: 'runJob', job: name }, `Ran ${name}`)}>Run now</button>
          </div>
        ))}
      </section>

      <section style={box}>
        <Eyebrow>Timeline</Eyebrow>
        {d.events.length === 0 && <p>No events yet.</p>}
        {d.events.map((e, i) => (
          <div key={i} className="mono" style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
            {e.at.slice(0, 16).replace('T', ' ')} · {e.system} · {e.event} {e.detail ? JSON.stringify(e.detail) : ''}
          </div>
        ))}
      </section>
    </div>
  );
}
