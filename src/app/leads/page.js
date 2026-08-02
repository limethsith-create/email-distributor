'use client';

import { useState, useEffect } from 'react';

// US-only targeting now (Sri Lanka retired).
function isUSA(lead) {
  const ind = (lead.industry || '').trim();
  return /^USA\s*-/i.test(ind) || /marketing & advertising/i.test(ind);
}
// Already sent = actually emailed before. These are never resent.
function isSent(l) {
  const s = (l.status || '');
  return !!l.account_used || !!l.sent_at || s.startsWith('sent') || s === 'sequence_complete';
}
function isReplied(l) {
  return (l.status || '') === 'replied' || !!l.replied_at;
}
function isReal(l) {
  const s = (l.status || '');
  if (s.startsWith('skipped')) return false;
  if (s === 'bounced') return false;
  return true;
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };

function scoreBadge(v) {
  if (v == null) return <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>—</span>;
  const c = v >= 9 ? { bg: 'rgba(22,163,74,0.14)', fg: '#15803d' } : v >= 6 ? { bg: 'rgba(217,119,6,0.14)', fg: '#b45309' } : { bg: 'rgba(220,38,38,0.12)', fg: '#b91c1c' };
  return <span style={{ background: c.bg, color: c.fg, borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 700 }}>{v}/10</span>;
}

function statusLabel(l) {
  if (isReplied(l)) return { t: 'replied', bg: 'rgba(8,145,178,0.14)', fg: '#0e7490' };
  if (isSent(l)) return { t: 'sent', bg: 'rgba(110,86,207,0.14)', fg: '#6e56cf' };
  return { t: 'new', bg: 'rgba(22,163,74,0.14)', fg: '#15803d' };
}

// ---------------- Scout sub-view ----------------
function ScoutPanel({ leads, loading }) {
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [flash, setFlash] = useState('');
  const [tick, setTick] = useState(0);

  const loadStatus = () => fetch('/api/ai/verify-leads', { cache: 'no-store' }).then((r) => r.json()).then(setStatus).catch(() => {});
  useEffect(() => { loadStatus(); }, [tick]);

  const runNow = async () => {
    setRunning(true); setFlash('');
    try {
      const d = await fetch('/api/ai/verify-leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 25 }) }).then((r) => r.json());
      setFlash(`Scored ${d.scored} lead${d.scored === 1 ? '' : 's'} · ${d.qualified} qualified (${d.hasKey ? 'Gemini' : 'rule-based'})`);
      setTick((t) => t + 1);
    } catch (e) { setFlash('Run failed: ' + e); }
    setRunning(false);
  };

  const scoreColor = (s) => s >= 9 ? { bg: 'rgba(22,163,74,0.14)', fg: '#15803d' } : s >= 6 ? { bg: 'rgba(217,119,6,0.14)', fg: '#b45309' } : { bg: 'rgba(220,38,38,0.12)', fg: '#b91c1c' };
  const ranked = leads.filter((l) => l.quality_score != null).sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));

  return (
    <div>
      {/* agent control */}
      <div style={{ ...card, marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: '#16a34a', flexShrink: 0 }} />
          <div style={{ fontSize: 13.5, color: 'var(--fg)' }}>
            {status
              ? <>Running on <b>{status.hasKey ? 'Gemini AI' : 'rule-based scoring'}</b>. Auto-runs on schedule; scores new leads as they arrive.</>
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

      {/* ICP */}
      {status?.icp && (
        <div style={{ ...card, marginBottom: 18 }}>
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
          <div key={x.k} style={{ ...card }}>
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
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
        ) : ranked.length === 0 ? (
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
                      <td style={{ padding: '12px 20px', color: 'var(--fg-dim)', fontSize: 12 }}>{String(l.quality_engine || '').includes('gemini') ? 'Gemini' : 'rules'}</td>
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

// ---------------- Leads list sub-view ----------------
function LeadsList({ leads, loading }) {
  const [view, setView] = useState('all'); // all | new | sent | qualified

  const base = leads.filter((l) => isReal(l) && isUSA(l));
  const stat = {
    total: base.length,
    qualified: base.filter((l) => !isSent(l) && (Number(l.quality_score) || 0) >= 9).length,
    sent: base.filter(isSent).length,
    replied: base.filter(isReplied).length,
  };
  const visible = base.filter((l) => {
    if (view === 'new') return !isSent(l);
    if (view === 'sent') return isSent(l);
    if (view === 'qualified') return !isSent(l) && (Number(l.quality_score) || 0) >= 9;
    return true;
  });

  const pill = (key, label) => (
    <button key={key} onClick={() => setView(key)}
      style={{ padding: '8px 14px', borderRadius: 9, fontSize: 13.5, fontWeight: 600,
        border: '1px solid ' + (view === key ? 'var(--accent)' : 'var(--border)'),
        background: view === key ? 'var(--accent-soft)' : 'transparent',
        color: view === key ? 'var(--accent)' : 'var(--fg-muted)', cursor: 'pointer' }}>
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {pill('all', 'All')}
        {pill('new', 'New')}
        {pill('qualified', 'Qualified 9+')}
        {pill('sent', 'Already sent')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 20 }}>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Total</div><div style={{ fontSize: 30, fontWeight: 700 }}>{loading ? '—' : stat.total}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Qualified (9+)</div><div style={{ fontSize: 30, fontWeight: 700, color: '#15803d' }}>{loading ? '—' : stat.qualified}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Already sent</div><div style={{ fontSize: 30, fontWeight: 700, color: '#6e56cf' }}>{loading ? '—' : stat.sent}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Replied</div><div style={{ fontSize: 30, fontWeight: 700, color: '#0e7490' }}>{loading ? '—' : stat.replied}</div></div>
      </div>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>{view === 'sent' ? 'Already sent' : view === 'qualified' ? 'Qualified leads' : view === 'new' ? 'New leads' : 'All leads'}</div>
          <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{visible.length} shown</span>
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>No leads in this view.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Score</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Email</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Company</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Niche</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Sent from</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, i) => {
                  const ss = statusLabel(l);
                  return (
                    <tr key={(l.email || '') + i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '13px 20px' }}>{scoreBadge(l.quality_score)}</td>
                      <td style={{ padding: '13px 20px' }}>{l.email}</td>
                      <td style={{ padding: '13px 20px', color: 'var(--fg-muted)' }}>{l.company_name || '—'}</td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ background: 'rgba(16,24,40,0.05)', border: '1px solid var(--border)', borderRadius: 8, padding: '3px 9px', fontSize: 12 }}>{l.industry || '—'}</span>
                      </td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ background: ss.bg, color: ss.fg, borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 600 }}>{ss.t}</span>
                      </td>
                      <td style={{ padding: '13px 20px', color: 'var(--fg-dim)' }}>{l.account_used || '—'}</td>
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

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('leads'); // leads | scout

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1')
      .then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const segBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)}
      style={{ padding: '8px 18px', borderRadius: 9, fontSize: 14, fontWeight: 600, border: 'none',
        background: tab === key ? '#fff' : 'transparent',
        color: tab === key ? 'var(--accent)' : 'var(--fg-muted)',
        boxShadow: tab === key ? '0 1px 2px rgba(16,24,40,0.10)' : 'none', cursor: 'pointer' }}>
      {label}
    </button>
  );

  return (
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Leads</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 16 }}>
        US prospects. Scout scores each one 1–10; only 9+ get sent. Leads already emailed move to Sent and are never contacted again.
      </p>

      {/* segmented control: Leads | Scout */}
      <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 11, background: 'var(--bg-subtle)', border: '1px solid var(--border)', marginBottom: 20 }}>
        {segBtn('leads', 'Lead list')}
        {segBtn('scout', 'Scout — scoring')}
      </div>

      {tab === 'leads' ? <LeadsList leads={leads} loading={loading} /> : <ScoutPanel leads={leads} loading={loading} />}
    </div>
  );
}
