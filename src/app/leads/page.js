'use client';

import { useState, useEffect } from 'react';

function isUSA(lead) {
  const ind = (lead.industry || '').trim();
  return /^USA\s*-/i.test(ind) || /marketing & advertising/i.test(ind);
}
function isSent(l) {
  const s = (l.status || '');
  return !!l.sent_at || s.startsWith('sent') || s === 'sequence_complete';
}
function isReplied(l) {
  return (l.status || '') === 'replied' || !!l.replied_at;
}
function isSending(l) {
  return isSent(l) && !isReplied(l) && (l.status || '') !== 'sequence_complete';
}
function isNew(l) {
  return (l.status || '') === 'pending';
}

// only show real leads — hide dedup/generic/no-company/unverified junk & bounces
function isReal(l) {
  const s = (l.status || '');
  if (s.startsWith('skipped')) return false;
  if (s === 'bounced') return false;
  return true;
}

function statusLabel(l) {
  if (isReplied(l)) return { t: 'replied', bg: 'rgba(8,145,178,0.14)', fg: '#0e7490' };
  if (isSending(l)) return { t: 'sending', bg: 'rgba(217,119,6,0.14)', fg: '#b45309' };
  if (isSent(l)) return { t: 'sent', bg: 'rgba(110,86,207,0.14)', fg: '#6e56cf' };
  if (isNew(l)) return { t: 'new', bg: 'rgba(22,163,74,0.14)', fg: '#15803d' };
  return { t: l.status || '—', bg: 'rgba(16,24,40,0.06)', fg: 'var(--fg-muted)' };
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState('all'); // all | usa | lk
  const [view, setView] = useState('all');      // all | new | sent

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1')
      .then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const real = leads.filter(isReal);
  const byRegion = real.filter((l) => region === 'all' ? true : region === 'usa' ? isUSA(l) : !isUSA(l));

  const stat = {
    total: byRegion.length,
    sent: byRegion.filter(isSent).length,
    replied: byRegion.filter(isReplied).length,
    sending: byRegion.filter(isSending).length,
  };

  const visible = byRegion.filter((l) => view === 'all' ? true : view === 'new' ? isNew(l) : isSent(l));

  const pill = (key, label, active, set) => (
    <button key={key} onClick={() => set(key)}
      style={{ padding: '8px 14px', borderRadius: 9, fontSize: 13.5, fontWeight: 600,
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg-muted)', cursor: 'pointer' }}>
      {label}
    </button>
  );

  return (
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Leads</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        Every lead stays here — sent ones are kept and recorded, never deleted. Filter by market and switch between new and sent.
      </p>

      {/* filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-dim)', marginBottom: 6 }}>Market</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {pill('all', 'All', region === 'all', setRegion)}
            {pill('usa', 'US', region === 'usa', setRegion)}
            {pill('lk', 'Sri Lanka', region === 'lk', setRegion)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-dim)', marginBottom: 6 }}>View</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {pill('all', 'All', view === 'all', setView)}
            {pill('new', 'New', view === 'new', setView)}
            {pill('sent', 'Sent', view === 'sent', setView)}
          </div>
        </div>
      </div>

      {/* stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 20 }}>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Total</div><div style={{ fontSize: 30, fontWeight: 700 }}>{loading ? '—' : stat.total}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Already sent</div><div style={{ fontSize: 30, fontWeight: 700, color: '#6e56cf' }}>{loading ? '—' : stat.sent}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Sending</div><div style={{ fontSize: 30, fontWeight: 700, color: '#b45309' }}>{loading ? '—' : stat.sending}</div></div>
        <div style={card}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Replied</div><div style={{ fontSize: 30, fontWeight: 700, color: '#0e7490' }}>{loading ? '—' : stat.replied}</div></div>
      </div>

      {/* table */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>{view === 'new' ? 'New leads' : view === 'sent' ? 'Sent leads' : 'All leads'}</div>
          <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{visible.length} shown</span>
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
                  <th style={{ padding: '11px 20px', fontWeight: 500 }}>Sent at</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, i) => {
                  const ss = statusLabel(l);
                  return (
                    <tr key={(l.email || '') + i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '13px 20px' }}>{l.email}</td>
                      <td style={{ padding: '13px 20px', color: 'var(--fg-muted)' }}>{l.company_name || '—'}</td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ background: 'rgba(16,24,40,0.05)', border: '1px solid var(--border)', borderRadius: 8, padding: '3px 9px', fontSize: 12 }}>{l.industry || '—'}</span>
                      </td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ background: ss.bg, color: ss.fg, borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 600 }}>{ss.t}</span>
                      </td>
                      <td style={{ padding: '13px 20px', color: 'var(--fg-dim)' }}>{l.account_used || '—'}</td>
                      <td style={{ padding: '13px 20px', color: 'var(--fg-dim)' }}>{l.sent_at ? String(l.sent_at).slice(0, 10) : '—'}</td>
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
