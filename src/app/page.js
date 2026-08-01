'use client';

import { useState, useEffect } from 'react';

const C = {
  sent: '#6e56cf',
  grid: 'rgba(16,24,40,0.07)',
  axis: 'var(--fg-dim)',
};

// Fresh start: only count sends recorded on/after the campaign start.
// Older pre-warmup sends are kept on the leads but don't count here.
const CAMPAIGN_START = '2026-08-01T00:00:00Z';
function afterStart(ts) { return ts && String(ts) >= CAMPAIGN_START; }
function isReal(l) {
  const s = (l.status || '');
  return !s.startsWith('skipped') && s !== 'bounced';
}

function isSent(l) {
  return afterStart(l.sent_at);
}
function isReplied(l) {
  return afterStart(l.replied_at);
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };

function KPI({ label, value, sub, accent, icon }) {
  return (
    <div style={{ ...card, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: accent + '18', color: accent }}>{icon}</div>
        <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>{label}</div>
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>{value}</div>
      {sub && <div style={{ color: 'var(--fg-dim)', fontSize: 12.5, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// per-day emails-sent series from sent_at
function buildSentSeries(leads) {
  const byDay = {};
  for (const l of leads) {
    if (!isSent(l) || !l.sent_at) continue;
    const d = String(l.sent_at).slice(0, 10);
    byDay[d] = (byDay[d] || 0) + (l.send_count || 1);
  }
  const days = Object.keys(byDay).sort();
  return days.map((d) => ({ d, v: byDay[d] }));
}

function SentChart({ pts }) {
  const W = 860, H = 260, padL = 8, padR = 8, padT = 14, padB = 26;
  if (!pts.length) {
    return <div style={{ height: H, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)', gap: 6 }}>
      <div style={{ fontSize: 14 }}>No emails sent yet</div>
      <div style={{ fontSize: 12 }}>Sends recorded here will appear as they happen.</div>
    </div>;
  }
  const max = Math.max(...pts.map((p) => p.v), 1);
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i) => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => padT + ih - (v / max) * ih;
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(pts.length - 1).toFixed(1)} ${y(0)} L ${x(0).toFixed(1)} ${y(0)} Z`;
  const grids = [0, 0.25, 0.5, 0.75, 1];
  const labelIdx = pts.length <= 6 ? pts.map((_, i) => i) : [0, Math.floor(pts.length / 3), Math.floor((2 * pts.length) / 3), pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.sent} stopOpacity="0.28" /><stop offset="100%" stopColor={C.sent} stopOpacity="0.02" /></linearGradient>
      </defs>
      {grids.map((g, i) => <line key={i} x1={padL} x2={W - padR} y1={padT + ih - g * ih} y2={padT + ih - g * ih} stroke={C.grid} strokeWidth="1" />)}
      {grids.map((g, i) => <text key={'t' + i} x={padL} y={padT + ih - g * ih - 4} fill={C.axis} fontSize="10">{Math.round(g * max)}</text>)}
      <path d={area} fill="url(#gSent)" />
      <path d={line} fill="none" stroke={C.sent} strokeWidth="2" />
      {labelIdx.map((i) => <text key={'x' + i} x={x(i)} y={H - 8} fill={C.axis} fontSize="10" textAnchor="middle">{pts[i].d.slice(5)}</text>)}
    </svg>
  );
}

export default function Dashboard() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1').then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const real = leads.filter(isReal);
  const total = real.length;
  const sentLeads = real.filter(isSent);
  const repliedLeads = real.filter(isReplied);
  const newLeads = real.filter((l) => !isSent(l));
  const emailsSent = sentLeads.length;
  const pts = buildSentSeries(real);

  const inboxes = [
    { email: 'limethsith@getaviance.site' },
    { email: 'limethsith.weerasinghe@getaviance.site' },
  ];

  return (
    <div className="fade-up" style={{ maxWidth: 1180 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 className="text-[26px] font-bold tracking-tight">Dashboard</h1>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(22,163,74,0.10)', color: '#15803d', border: '1px solid rgba(22,163,74,0.25)', borderRadius: 999, padding: '5px 12px', fontSize: 12.5, fontWeight: 600 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: '#16a34a', display: 'inline-block' }} /> Warming up · sending handled externally
        </span>
      </div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 20 }}>Leads and send records at a glance. This system doesn’t send email — it records it.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 18 }}>
        <KPI label="Total leads" value={loading ? '—' : total} sub={`${newLeads.length} new`} accent="#6e56cf"
          icon={<svg width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.1a9.4 9.4 0 006.7-.6 4.1 4.1 0 00-7.5-2.5M15 19.1v.1A12.3 12.3 0 018.6 21c-2.3 0-4.5-.6-6.4-1.8v-.1a6.4 6.4 0 0112-3M12 6.4a3.4 3.4 0 11-6.8 0 3.4 3.4 0 016.8 0z" /></svg>} />
        <KPI label="Inboxes warming" value="2" sub="AutoMailer · external" accent="#16a34a"
          icon={<svg width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M15.4 5.2A8.3 8.3 0 0112 21 8.3 8.3 0 016 7a8.3 8.3 0 003 2.6A9 9 0 0112.4 2.7a8.2 8.2 0 003 2.5z" /></svg>} />
        <KPI label="Emails sent" value={loading ? '—' : emailsSent} sub="recorded" accent="#d97706"
          icon={<svg width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.3 3.5a.6.6 0 01.8-.7l16.5 8.2a.6.6 0 010 1L4 20.2a.6.6 0 01-.8-.7L6 12zm0 0h6" /></svg>} />
        <KPI label="Replied" value={loading ? '—' : repliedLeads.length} sub="recorded" accent="#0891b2"
          icon={<svg width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M8 10.5h8M8 14h5m-9 5.5 3.5-2h8A2.5 2.5 0 0018 15V7a2.5 2.5 0 00-2.5-2.5h-9A2.5 2.5 0 004 7v12.5z" /></svg>} />
      </div>

      <div style={{ ...card, padding: '20px 22px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Emails sent</div>
            <div style={{ color: 'var(--fg-dim)', fontSize: 12.5 }}>Recorded sends per day</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--fg-muted)' }}><span style={{ width: 10, height: 10, borderRadius: 3, background: C.sent }} /> Sent</span>
        </div>
        {loading ? <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)' }}>Loading…</div> : <SentChart pts={pts} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 18 }}>
        <div style={{ ...card, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Inbox warmup</div>
          {inboxes.map((b) => (
            <div key={b.email} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: '#16a34a', flexShrink: 0 }} />
                <span style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</span>
              </div>
              <span style={{ fontSize: 11.5, color: '#15803d', background: 'rgba(22,163,74,0.12)', borderRadius: 8, padding: '3px 9px', flexShrink: 0 }}>Warming</span>
            </div>
          ))}
          <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--fg-dim)' }}>Warmup runs in AutoMailer (external). This system never sends.</div>
        </div>

        <div style={{ ...card, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Pipeline</div>
          {[
            { k: 'New (not yet sent)', v: newLeads.length, c: '#6e56cf' },
            { k: 'Already sent', v: sentLeads.length, c: '#d97706' },
            { k: 'Replied', v: repliedLeads.length, c: '#0891b2' },
          ].map((r) => (
            <div key={r.k} style={{ padding: '11px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 7 }}>
                <span style={{ color: 'var(--fg-muted)' }}>{r.k}</span><span style={{ fontWeight: 600 }}>{loading ? '—' : r.v}</span>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: 'rgba(16,24,40,0.06)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: (total ? Math.round((r.v / total) * 100) : 0) + '%', background: r.c, borderRadius: 999 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
