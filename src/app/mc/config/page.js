'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow } from '../_ui/ui';

const TABLE_KEYS = new Set(['US_HOLIDAYS', 'PLANS', 'BONUS', 'PLAN_SHOPPING']);
const isTable = (s) => TABLE_KEYS.has(s.key) || (Array.isArray(s.value) && s.value.some((x) => x && typeof x === 'object'));

function Row({ s, onSaved }) {
  const [text, setText] = useState(JSON.stringify(s.value, null, 2));
  const [msg, setMsg] = useState('');
  useEffect(() => { setText(JSON.stringify(s.value, null, 2)); }, [s.value]);
  const multiline = typeof s.value === 'object' && s.value !== null;
  async function save() {
    let value;
    try { value = JSON.parse(text); } catch { setMsg('Not valid JSON (text needs "quotes").'); return; }
    try { await api('/api/mc/config', { action: 'set', key: s.key, value }); setMsg('Saved'); onSaved(); } catch (e) { setMsg(e.message); }
  }
  async function reset() {
    try { await api('/api/mc/config', { action: 'reset', key: s.key }); setMsg('Reset to default'); onSaved(); } catch (e) { setMsg(e.message); }
  }
  return (
    <div style={{ display: 'grid', gap: 6, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong className="mono">{s.key}</strong>
        {s.overridden && <span style={{ color: 'var(--warning)', fontSize: 12 }}>changed from default</span>}
        {s.toSet && <span style={{ color: 'var(--danger)', fontSize: 12 }}>has values still to set</span>}
      </div>
      {multiline
        ? <textarea className="mono" rows={Math.min(14, text.split('\n').length + 1)} style={{ ...input, fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} />
        : <input className="mono" style={input} value={text} onChange={(e) => setText(e.target.value)} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button style={btn} onClick={save}>Save</button>
        {s.overridden && <button style={btnGhost} onClick={reset}>Reset</button>}
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{msg}</span>
      </div>
    </div>
  );
}

export default function ConfigPage() {
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = () => api('/api/mc/config').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!d) return <p>{err || 'Loading…'}</p>;
  const rows = d.settings.filter((s) => !q || s.key.toLowerCase().includes(q.toLowerCase()));
  const toSet = d.settings.filter((s) => s.toSet).map((s) => s.key);
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / Config</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Every number the machine uses</h1>
        <p style={{ color: 'var(--fg-muted)' }}>Values are JSON: numbers plain, text in &quot;quotes&quot;, lists in [ ], null = not set. A new value must keep the default’s shape. The hard sending limits (25 cold / 15 warm-up per inbox per day) hold whatever is typed here.</p>
      </div>
      {toSet.length > 0 && <div style={{ ...box, borderColor: 'var(--danger)' }}>Still to set: {toSet.join(', ')}</div>}
      <input style={input} placeholder="Filter settings…" value={q} onChange={(e) => setQ(e.target.value)} />
      <section style={box}>
        <Eyebrow>Tables</Eyebrow>
        {rows.filter(isTable).map((s) => <Row key={s.key} s={s} onSaved={load} />)}
      </section>
      <section style={box}>
        <Eyebrow>Settings</Eyebrow>
        {rows.filter((s) => !isTable(s)).map((s) => <Row key={s.key} s={s} onSaved={load} />)}
      </section>
    </div>
  );
}
