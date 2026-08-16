'use client';

// Dashboard — overview KPIs incl. open tracking (opens + open rate).
import { useState, useEffect } from 'react';

const C = {
  sent: '#e0290f',
  grid: 'rgba(0,0,0,0.08)',
  axis: 'var(--fg-dim)',
};

// Fresh start: only count sends recorded on/after the campaign start.
const CAMPAIGN_START = '2026-08-01T09:30:00Z';
function afterStart(ts) { return ts && String(ts) >= CAMPAIGN_START; }
function isReal(l) {
  const s = (l.status || '');
  return !s.startsWith('skipped') && s !== 'bounced';
}
function isSent(l) { return afterStart(l.sent_at); }
function isReplied(l) { return afterStart(l.replied_at); }
function isOpened(l) { return afterStart(l.opened_at); }

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };

function KPI({ idx, label, value, sub }) {
  return (
    <div style={{ ...card, padding: '18px 20px' }}>
      <div className="eyebrow"><span className="idx">{idx}</span>&nbsp;&nbsp;{label}</div>
      <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 10, lineHeight: 1 }}>{value}</div>
      {sub && <div className="mono" style={{ color: 'var(--fg-dim)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{sub}</div>}
    </div>
  );
}

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
      <div className="mono" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sends will appear here as they happen</div>
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
        <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.sent} stopOpacity="0.22" /><stop offset="100%" stopColor={C.sent} stopOpacity="0.02" /></linearGradient>
      </defs>
      {grids.map((g, i) => <line key={i} x1={padL} x2={W - padR} y1={padT + ih - g * ih} y2={padT + ih - g * ih} stroke={C.grid} strokeWidth="1" />)}
      {grids.map((g, i) => <text key={'t' + i} x={padL} y={padT + ih - g * ih - 4} fill={C.axis} fontSize="10" fontFamily="JetBrains Mono, monospace">{Math.round(g * max)}</text>)}
      <path d={area} fill="url(#gSent)" />
      <path d={line} fill="none" stroke={C.sent} strokeWidth="2" />
      {pts.map((p, i) => <circle key={'c' + i} cx={x(i)} cy={y(p.v)} r="2.5" fill={C.sent} />)}
      {labelIdx.map((i) => <text key={'x' + i} x={x(i)} y={H - 8} fill={C.axis} fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{pts[i].d.slice(5)}</text>)}
    </svg>
  );
}

export default function Dashboard() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inboxes, setInboxes] = useState([]);

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=3000&page=1').then((r) => r.json())
      .then((d) => { if (alive) { setLeads(Array.isArray(d) ? d : (d.leads || [])); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    fetch('/api/inboxes-control', { cache: 'no-store' }).then((r) => r.json())
      .then((d) => { if (alive) setInboxes(d.inboxes || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const real = leads.filter(isReal);
  const total = real.length;
  const sentLeads = real.filter(isSent);
  const repliedLeads = real.filter(isReplied);
  const openedLeads = real.filter(isOpened);
  const newLeads = real.filter((l) => !isSent(l));
  const emailsSent = sentLeads.length;
  const openRate = emailsSent ? Math.round((openedLeads.length / emailsSent) * 100) : 0;
  const pts = buildSentSeries(real);

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}><span className="idx">00</span>&nbsp;/&nbsp;OVERVIEW</div>
          <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>Dashboard</h1>
        </div>
        <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid #111', padding: '7px 12px', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg)' }}>
          <span style={{ width: 7, height: 7, background: 'var(--accent)', display: 'inline-block' }} /> Live · booked-calls engine
        </span>
      </div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '14px 0 22px', maxWidth: 620 }}>
        Your leads and send records at a glance — the outbound engine that books qualified sales calls onto client calendars.
      </p>

      <div className="rule" style={{ marginBottom: 22 }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 20 }}>
        <KPI idx="01" label="Total leads" value={loading ? '—' : total} sub={`${newLeads.length} not yet sent`} />
        <KPI idx="02" label="Inboxes live" value={inboxes.length ? inboxes.filter((i) => i.enabled).length : '—'}
          sub={inboxes.length ? inboxes.map((i) => i.cap + '/day').join(' · ') : 'loading'} />
        <KPI idx="03" label="Emails sent" value={loading ? '—' : emailsSent} sub="this campaign" />
        <KPI idx="04" label="Opened" value={loading ? '—' : openedLeads.length} sub={loading ? '' : `${openRate}% open rate`} />
        <KPI idx="05" label="Replied" value={loading ? '—' : repliedLeads.length} sub="recorded" />
      </div>

      <div style={{ ...card, padding: '20px 22px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="eyebrow"><span className="idx">06</span>&nbsp;/&nbsp;SENDS PER DAY</div>
          <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}><span style={{ width: 10, height: 3, background: C.sent, display: 'inline-block' }} /> Sent</span>
        </div>
        {loading ? <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)' }}>Loading…</div> : <SentChart pts={pts} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 18 }}>
        <div style={{ ...card, padding: '20px 22px' }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}><span className="idx">07</span>&nbsp;/&nbsp;INBOXES</div>
          {(inboxes.length ? inboxes : [{ email: 'Loading…', enabled: false, sentToday: 0, cap: 0 }]).map((b) => (
            <div key={b.email} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ width: 7, height: 7, background: b.enabled ? '#16a34a' : 'var(--fg-dim)', flexShrink: 0 }} />
                <span style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</span>
              </div>
              <span className="mono" style={{ fontSize: 10.5, color: b.enabled ? '#15803d' : 'var(--fg-dim)', border: '1px solid ' + (b.enabled ? 'rgba(22,163,74,0.4)' : 'var(--border)'), padding: '3px 8px', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {b.enabled ? `On · ${b.sentToday}/${b.cap}` : 'Off'}
              </span>
            </div>
          ))}
          <div className="mono" style={{ marginTop: 14, fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sending spread across US business hours</div>
        </div>

        <div style={{ ...card, padding: '20px 22px' }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}><span className="idx">08</span>&nbsp;/&nbsp;PIPELINE</div>
          {[
            { k: 'Not yet sent', v: newLeads.length, c: '#0a0a0a' },
            { k: 'Already sent', v: sentLeads.length, c: '#e0290f' },
            { k: 'Opened', v: openedLeads.length, c: '#c8811f' },
            { k: 'Replied', v: repliedLeads.length, c: '#9a9a9a' },
          ].map((r) => (
            <div key={r.k} style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 8 }}>
                <span style={{ color: 'var(--fg-muted)' }}>{r.k}</span><span style={{ fontWeight: 700 }}>{loading ? '—' : r.v}</span>
              </div>
              <div style={{ height: 6, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: (total ? Math.round((r.v / total) * 100) : 0) + '%', background: r.c }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
