'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };

function scoreColor(s) {
  if (s >= 9) return { bg: 'rgba(22,163,74,0.14)', fg: '#15803d' };      // qualified
  if (s >= 6) return { bg: 'rgba(217,119,6,0.14)', fg: '#b45309' };      // maybe
  return { bg: 'rgba(220,38,38,0.12)', fg: '#b91c1c' };                  // weak
}

export default function ScoutPage() {
  const [status, setStatus] = useState(null);
  const [leads, setLeads] = useState([]);
  const [running, setRunning] = useState(false);
  const [flash, setFlash] = useState('');

  const loadStatus = () => fetch('/api/ai/verify-leads', { cache: 'no-store' }).then((r) => r.json()).then(setStatus).catch(() => {});
  const loadLeads = () => fetch('/api/leads?action=list&limit=3000&page=1', { cache: 'no-store' }).then((r) => r.json())
    .then((d) => setLeads(((d && d.leads) || []).filter((l) => l.quality_score != null))).catch(() => {});

  useEffect(() => { loadStatus(); loadLeads(); }, []);

  const runNow = async () => {
    setRunning(true); setFlash('');
    try {
      const d = await fetch('/api/ai/verify-leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 25 }) }).then((r) => r.json());
      setFlash(`Scored ${d.scored} lead${d.scored === 1 ? '' : 's'} · ${d.qualified} qualified (${d.hasKey ? 'Gemini' : 'rule-based'})`);
      await loadStatus(); await loadLeads();
    } catch (e) { setFlash('Run failed: ' + e); }
    setRunning(false);
  };

  const ranked = [...leads].sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));

  return (
    <div className="fade-up" style={{ maxWidth: 1080 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h1 className="text-[26px] font-bold tracking-tight">Scout</h1>
        <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>Verification agent</span>
      </div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 20 }}>
        Scout scores every new lead 1–10 on deliverability and fit, on its own. Only leads scored {status?.threshold ?? 9}+ are ever sent.
      </p>

      {/* agent control card */}
      <div style={{ ...card, padding: '18px 20px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: '#16a34a', flexShrink: 0 }} />
          <div style={{ fontSize: 13.5, color: 'var(--fg)' }}>
            {status
              ? <>Running on <b>{status.hasKey ? 'Gemini AI' : 'rule-based scoring'}</b>. Auto-runs on the schedule; scores new leads as they arrive.</>
              : 'Loading…'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {flash && <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{flash}</span>}
          <button onClick={runNow} disabled={running}
            style={{ background: running ? 'var(--border-strong)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13.5, fontWeight: 600, cursor: running ? 'default' : 'pointer' }}>
            {running ? 'Scoring…' : 'Run now'}
          </button>
        </div>
      </div>

      {/* Ideal Customer Profile */}
      {status?.icp && (
        <div style={{ ...card, padding: '18px 20px', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Ideal Customer Profile</div>
            <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>what Scout scores against</span>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: 12 }}>{status.icp.summary}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>Green flags</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                {status.icp.greenFlags.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', marginBottom: 6 }}>Not a fit</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                {status.icp.redFlags.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 20 }}>
        {[
          { k: 'Fresh leads', v: status?.pending, c: 'var(--fg)' },
          { k: 'Scored', v: status?.scored, c: '#6e56cf' },
          { k: `Qualified (${status?.threshold ?? 9}+)`, v: status?.qualified, c: '#15803d' },
          { k: 'Not yet scored', v: status?.unscored, c: '#b45309' },
        ].map((x) => (
          <div key={x.k} style={{ ...card, padding: '16px 18px' }}>
            <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>{x.k}</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: x.c }}>{status ? (x.v ?? 0) : '—'}</div>
          </div>
        ))}
      </div>

      {/* ranked table */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>Scored leads</div>
          <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{ranked.length} rated</span>
        </div>
        {ranked.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13.5 }}>
            No leads scored yet. Hit “Run now” and Scout will rate your fresh leads.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Score</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Email</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Company</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Why</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>By</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((l, i) => {
                  const c = scoreColor(l.quality_score);
                  return (
                    <tr key={(l.email || '') + i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '12px 20px' }}>
                        <span style={{ background: c.bg, color: c.fg, borderRadius: 8, padding: '4px 10px', fontSize: 13, fontWeight: 700 }}>{l.quality_score}/10</span>
                      </td>
                      <td style={{ padding: '12px 20px' }}>{l.email}</td>
                      <td style={{ padding: '12px 20px', color: 'var(--fg-muted)' }}>{l.company_name || '—'}</td>
                      <td style={{ padding: '12px 20px', color: 'var(--fg-dim)', maxWidth: 320 }}>{l.quality_reason || '—'}</td>
                      <td style={{ padding: '12px 20px', color: 'var(--fg-dim)', fontSize: 12 }}>{l.quality_engine === 'gemini' ? 'Gemini' : 'rules'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
