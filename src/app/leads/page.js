'use client';

import { useState, useEffect } from 'react';

// Only fresh, never-contacted leads are shown. Everything already sent, bounced,
// duplicated, generic or unverified is excluded — we are starting the warmup clean.
const FRESH_STATUS = 'pending';

function regionOf(lead) {
  const ind = (lead.industry || '').trim();
  return (/^USA\s*-/i.test(ind) || /marketing & advertising/i.test(ind)) ? 'US' : 'Sri Lanka';
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px' };

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState('all');

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1')
      .then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // fresh pool only — already-sent leads are removed from view
  const fresh = leads.filter((l) => l.status === FRESH_STATUS).map((l) => ({ ...l, region: regionOf(l) }));
  const visible = region === 'all' ? fresh : fresh.filter((l) => l.region === region);

  const usCount = fresh.filter((l) => l.region === 'US').length;
  const lkCount = fresh.filter((l) => l.region === 'Sri Lanka').length;

  // warmup mode — no sending yet, so all activity counters stay at zero
  const stat = { total: fresh.length, sent: 0, replied: 0, perDay: 0 };

  return (
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Leads</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        Warmup mode — sending is paused. Only fresh, never-contacted leads are shown; everything already sent has been cleared out.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 20 }}>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Total leads</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stat.total}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Already sent</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stat.sent}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Replied</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stat.replied}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Sending / day</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stat.perDay}</div></div>
      </div>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>All leads</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <select value={region} onChange={(e) => setRegion(e.target.value)}
              style={{ background: 'var(--bg-subtle)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}>
              <option value="all">All ({fresh.length})</option>
              <option value="US">US ({usCount})</option>
              <option value="Sri Lanka">Sri Lanka ({lkCount})</option>
            </select>
            <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{visible.length} shown</span>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>No fresh leads in this segment.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Email</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Company</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Region</th>
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, i) => (
                  <tr key={(l.email || '') + i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '13px 20px' }}>{l.email}</td>
                    <td style={{ padding: '13px 20px', color: 'var(--fg-muted)' }}>{l.company_name || '—'}</td>
                    <td style={{ padding: '13px 20px' }}>
                      <span style={{
                        background: l.region === 'US' ? 'rgba(110,86,207,0.18)' : 'rgba(62,207,142,0.14)',
                        color: l.region === 'US' ? '#b3a4f5' : '#3ecf8e',
                        borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 600,
                      }}>{l.region}</span>
                    </td>
                    <td style={{ padding: '13px 20px' }}>
                      <span style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', color: 'var(--fg-muted)', borderRadius: 8, padding: '3px 9px', fontSize: 12 }}>new</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
