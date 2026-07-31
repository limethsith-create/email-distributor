'use client';

import { useState, useEffect } from 'react';

const REAL_STATUSES = ['pending', 'sent-d0', 'sent-d3', 'sequence_complete', 'replied'];

function isUSA(lead) {
  const ind = (lead.industry || '').trim();
  return /^USA\s*-/i.test(ind) || /marketing & advertising/i.test(ind);
}

function statusStyle(status) {
  if (status === 'pending') return { bg: 'rgba(110,86,207,0.18)', fg: '#b3a4f5' };
  if (status === 'replied') return { bg: 'rgba(62,207,142,0.16)', fg: '#3ecf8e' };
  if (status && status.startsWith('sent')) return { bg: 'rgba(255,255,255,0.06)', fg: 'var(--fg-muted)' };
  if (status === 'sequence_complete') return { bg: 'rgba(255,255,255,0.06)', fg: 'var(--fg-muted)' };
  return { bg: 'rgba(255,255,255,0.05)', fg: 'var(--fg-dim)' };
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px' };

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState('usa');
  const [niche, setNiche] = useState('all');

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1')
      .then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // keep only real leads (hide duplicates, bounced, generic, no-company, unverified)
  const real = leads.filter((l) => REAL_STATUSES.includes(l.status));
  const usaAll = real.filter(isUSA);
  const localAll = real.filter((l) => !isUSA(l));
  const active = region === 'usa' ? usaAll : localAll;

  const niches = ['all', ...Array.from(new Set(active.map((l) => l.industry || 'other'))).sort()];
  const visible = niche === 'all' ? active : active.filter((l) => (l.industry || 'other') === niche);

  const count = (arr, f) => arr.filter(f).length;
  const stat = {
    total: active.length,
    pending: count(active, (l) => l.status === 'pending'),
    sent: count(active, (l) => (l.status || '').startsWith('sent') || l.status === 'sequence_complete'),
    replied: count(active, (l) => l.status === 'replied'),
  };

  const tabBtn = (key, label, n) => (
    <button
      key={key}
      onClick={() => { setRegion(key); setNiche('all'); }}
      style={{
        padding: '9px 18px', borderRadius: 10, fontSize: 14, fontWeight: 600,
        border: '1px solid ' + (region === key ? '#6e56cf' : 'var(--border)'),
        background: region === key ? 'var(--accent-soft)' : 'transparent',
        color: region === key ? '#b3a4f5' : 'var(--fg-muted)', cursor: 'pointer',
      }}
    >
      {label} <span style={{ opacity: 0.7 }}>· {n}</span>
    </button>
  );

  return (
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Leads</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        Cleaned pipeline — duplicates, bounces, generic and unverified addresses are hidden. Split by market.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        {tabBtn('usa', 'USA', usaAll.length)}
        {tabBtn('local', 'Local (Sri Lanka)', localAll.length)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 20 }}>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Total</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stat.total}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Fresh (pending)</div><div style={{ fontSize: 30, fontWeight: 700, color: '#b3a4f5' }}>{stat.pending}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Already sent</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stat.sent}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Replied</div><div style={{ fontSize: 30, fontWeight: 700, color: '#3ecf8e' }}>{stat.replied}</div></div>
      </div>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>{region === 'usa' ? 'USA leads' : 'Local leads'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <select value={niche} onChange={(e) => setNiche(e.target.value)}
              style={{ background: 'var(--bg-subtle)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}>
              {niches.map((n) => <option key={n} value={n}>{n === 'all' ? 'All niches' : n}</option>)}
            </select>
            <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{visible.length} shown</span>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>No leads in this segment.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Email</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Company</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Niche</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Sent from</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, i) => {
                  const ss = statusStyle(l.status);
                  return (
                    <tr key={(l.email || '') + i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '13px 20px' }}>{l.email}</td>
                      <td style={{ padding: '13px 20px', color: 'var(--fg-muted)' }}>{l.company_name || '—'}</td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', borderRadius: 8, padding: '3px 9px', fontSize: 12 }}>{l.industry || '—'}</span>
                      </td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ background: ss.bg, color: ss.fg, borderRadius: 8, padding: '3px 9px', fontSize: 12 }}>{l.status}</span>
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
