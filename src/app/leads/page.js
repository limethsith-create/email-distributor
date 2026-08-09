'use client';

import { useState, useEffect } from 'react';

// A lead is "real" if it isn't scraper junk (skipped/bounced).
function isReal(l) {
  const s = (l.status || '');
  if (s.startsWith('skipped')) return false;
  if (s === 'bounced') return false;
  return true;
}
function isSent(l) {
  const s = (l.status || '');
  return !!l.account_used || !!l.sent_at || s.startsWith('sent') || s === 'sequence_complete';
}
function isReplied(l) {
  return (l.status || '') === 'replied' || !!l.replied_at;
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
  const [view, setView] = useState('all'); // all | new | sent | replied
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=100000&page=1')
      .then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Every real lead — no US-only or score gate. All leads live here now.
  const base = leads.filter(isReal);

  const stat = {
    total: base.length,
    fresh: base.filter((l) => !isSent(l)).length,
    sent: base.filter(isSent).length,
    replied: base.filter(isReplied).length,
  };

  const ql = q.trim().toLowerCase();
  const visible = base.filter((l) => {
    if (view === 'new' && isSent(l)) return false;
    if (view === 'sent' && !isSent(l)) return false;
    if (view === 'replied' && !isReplied(l)) return false;
    if (ql) {
      const hay = ((l.email || '') + ' ' + (l.company_name || '') + ' ' + (l.industry || '')).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
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
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 16 }}>
        Every lead in your system, in one place. Leads already emailed move to Sent and are never contacted again.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 18 }}>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Total leads</div><div style={{ fontSize: 30, fontWeight: 700 }}>{loading ? '—' : stat.total}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Not yet sent</div><div style={{ fontSize: 30, fontWeight: 700, color: '#15803d' }}>{loading ? '—' : stat.fresh}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Already sent</div><div style={{ fontSize: 30, fontWeight: 700, color: '#6e56cf' }}>{loading ? '—' : stat.sent}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Replied</div><div style={{ fontSize: 30, fontWeight: 700, color: '#0e7490' }}>{loading ? '—' : stat.replied}</div></div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {pill('all', 'All')}
        {pill('new', 'Not yet sent')}
        {pill('sent', 'Already sent')}
        {pill('replied', 'Replied')}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email, company, niche…"
          style={{ marginLeft: 'auto', minWidth: 220, flex: '0 1 300px', padding: '8px 12px', borderRadius: 9,
            border: '1px solid var(--border)', background: 'var(--card)', fontSize: 13.5, color: 'var(--fg)' }} />
      </div>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>{view === 'sent' ? 'Already sent' : view === 'new' ? 'Not yet sent' : view === 'replied' ? 'Replied' : 'All leads'}</div>
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
                {visible.slice(0, 3000).map((l, i) => {
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
            {visible.length > 3000 && (
              <div style={{ padding: '12px 20px', textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12.5, borderTop: '1px solid var(--border)' }}>
                Showing first 3,000 of {visible.length}. Use search to narrow down.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
