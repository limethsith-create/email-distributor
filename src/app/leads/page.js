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

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('all'); // all | new | sent | qualified

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1')
      .then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // US-only, real leads
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
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Leads</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        US prospects. Scout scores each one 1–10; only 9+ get sent. Leads already emailed move to Sent and are never contacted again.
      </p>

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
