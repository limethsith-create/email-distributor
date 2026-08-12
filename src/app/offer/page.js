'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };
const mono = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--fg)' };
const label = { fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 6 };

export default function OfferPage() {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [err, setErr] = useState('');

  const [leads, setLeads] = useState([]);
  const [sel, setSel] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/offer').then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (d && d.offer) { setSubject(d.offer.subject || ''); setBody(d.offer.body || ''); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
    fetch('/api/leads?action=list&limit=3000&page=1').then((r) => r.json()).then((d) => {
      if (!alive) return;
      const arr = ((d && d.leads) || []).filter((l) => l.status === 'pending');
      setLeads(arr);
      if (arr[0]) setSel(arr[0].email);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setErr(''); setSaving(true); setSavedAt(null);
    try {
      const r = await fetch('/api/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, body }) });
      const d = await r.json();
      if (d.success) setSavedAt(Date.now());
      else setErr(d.error || 'Could not save.');
    } catch (e) { setErr(String(e)); }
    setSaving(false);
  };

  const run = async () => {
    const lead = leads.find((l) => l.email === sel);
    if (!lead) return;
    setBusy(true); setOut(null);
    try {
      const r = await fetch('/api/ai/personalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead }) });
      setOut(await r.json());
    } catch (e) { setOut({ error: String(e) }); }
    setBusy(false);
  };

  const engineBadge = (eng) => {
    const map = {
      gemini: { t: 'Gemini · personalized', bg: 'rgba(22,163,74,0.12)', fg: '#15803d' },
      fallback: { t: 'Fallback (key error)', bg: 'rgba(217,119,6,0.12)', fg: '#b45309' },
      base: { t: 'Rule-based (no key yet)', bg: 'rgba(224,41,15,0.12)', fg: '#e0290f' },
    };
    const m = map[eng] || map.base;
    return <span style={{ background: m.bg, color: m.fg, borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>{m.t}</span>;
  };

  return (
    <div className="fade-up" style={{ maxWidth: 1080 }}>
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Offer</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 20 }}>
        Live sending uses the built-in 3-step sequence (initial, day-3, day-7) that ends on your money-back guarantee.
        This editor is a scratchpad + preview: save a draft and test how the personalizer would adapt it per company.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 18 }}>
        {/* editable base offer */}
        <div style={{ ...card, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Base offer</div>
            <span style={{ background: 'rgba(22,163,74,0.12)', color: '#15803d', borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>Editable</span>
          </div>

          <div style={label}>Subject</div>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!loaded}
            style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, marginBottom: 14, fontFamily: 'ui-monospace, Menlo, monospace' }} />

          <div style={label}>Body</div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!loaded} rows={16}
            style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', ...mono, resize: 'vertical' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <button onClick={save} disabled={saving || !loaded}
              style={{ background: saving ? 'var(--border-strong)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}>
              {saving ? 'Saving…' : 'Save offer'}
            </button>
            {savedAt && <span style={{ fontSize: 12.5, color: '#15803d' }}>Saved ✓</span>}
            {err && <span style={{ fontSize: 12.5, color: '#b45309' }}>{err}</span>}
          </div>
        </div>

        {/* AI preview */}
        <div style={{ ...card, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>AI agent preview</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 14 }}>
            Runs on Google Gemini — independent of Claude. Uses your saved offer above and rewrites the opener + offer line to fit each company, keeping the guarantee. (Save first to preview the latest wording.)
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)}
              style={{ flex: 1, background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 11px', fontSize: 13 }}>
              {leads.length === 0 && <option value="">No fresh leads</option>}
              {leads.map((l) => <option key={l.email} value={l.email}>{(l.company_name || l.email)}</option>)}
            </select>
            <button onClick={run} disabled={busy || !sel}
              style={{ background: busy || !sel ? 'var(--border-strong)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13.5, fontWeight: 600, cursor: busy || !sel ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy ? 'Thinking…' : 'Personalize'}
            </button>
          </div>

          {!out ? (
            <div style={{ background: 'var(--bg)', border: '1px dashed var(--border-strong)', borderRadius: 10, padding: 24, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 13 }}>
              Pick a company and hit Personalize to preview what the agent would send.
            </div>
          ) : out.error ? (
            <div style={{ color: '#b45309', fontSize: 13 }}>Error: {out.error}</div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {engineBadge(out.engine)}
              </div>
              <div style={label}>Subject</div>
              <div style={{ ...mono, marginBottom: 12 }}>{out.subject}</div>
              <div style={label}>Body</div>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', ...mono }}>{out.body}</div>
            </div>
          )}
        </div>
      </div>

      <div style={{ ...card, padding: '16px 20px', marginTop: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: '#d97706', flexShrink: 0 }} />
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          To switch the agent from the rule-based fallback to full Gemini AI, add a free <b>GEMINI_API_KEY</b> in your Vercel project settings. Until then it still personalizes by industry, just more simply.
        </div>
      </div>
    </div>
  );
}
