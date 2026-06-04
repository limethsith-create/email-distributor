'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Tiny sparkline (SVG) ──────────────────────────────────────────
function Sparkline({ data, color = '#3b82f6', height = 32, width = 120 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const linePath = `M${pts.join(' L')}`;
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sp-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#sp-${color.replace('#','')})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Mini area chart ───────────────────────────────────────────────
function AreaChart({ data, height = 180 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: 13 }}>
        Not enough data for chart
      </div>
    );
  }
  const width = 600;
  const padX = 36;
  const padY = 24;
  const padBottom = 28;
  const max = Math.max(...data.map(d => d.count)) || 1;
  const chartW = width - padX * 2;
  const chartH = height - padY - padBottom;

  const pts = data.map((d, i) => {
    const x = padX + (i / (data.length - 1)) * chartW;
    const y = padY + chartH - (d.count / max) * chartH;
    return { x, y };
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = `${line} L${pts[pts.length-1].x},${padY + chartH} L${pts[0].x},${padY + chartH} Z`;

  const yTicks = [0, Math.round(max / 2), max];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((t, i) => {
        const y = padY + chartH - (t / max) * chartH;
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
            <text x={padX - 8} y={y + 3} textAnchor="end" fill="#71717a" fontSize="10" fontFamily="system-ui">{t}</text>
          </g>
        );
      })}
      <path d={area} fill="url(#chartFill)" />
      <path d={line} fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => {
        if (data.length <= 7 || i % Math.ceil(data.length / 6) === 0 || i === data.length - 1) {
          const x = padX + (i / (data.length - 1)) * chartW;
          return (
            <text key={i} x={x} y={height - 6} textAnchor="middle" fill="#71717a" fontSize="10" fontFamily="system-ui">
              {d.label}
            </text>
          );
        }
        return null;
      })}
    </svg>
  );
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function Skel({ w, h, r = 6, style = {} }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: r,
      background: 'rgba(255,255,255,0.04)',
      ...style,
    }} />
  );
}

function statusColor(s) {
  if (!s) return '#71717a';
  const sl = s.toLowerCase();
  if (sl === 'sent' || sl === 'delivered') return '#22c55e';
  if (sl === 'bounced' || sl === 'failed') return '#ef4444';
  if (sl === 'replied') return '#a855f7';
  if (sl === 'opened') return '#3b82f6';
  return '#71717a';
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [sentLog, setSentLog] = useState([]);
  const [warmup, setWarmup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fadeIn, setFadeIn] = useState(false);
  const mounted = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [sRes, lRes, wRes] = await Promise.allSettled([
        fetch('/api/leads?action=stats'),
        fetch('/api/leads?action=sent_log&limit=200'),
        fetch('/api/warmup'),
      ]);
      if (!mounted.current) return;
      if (sRes.status === 'fulfilled' && sRes.value.ok) setStats(await sRes.value.json());
      if (lRes.status === 'fulfilled' && lRes.value.ok) {
        const d = await lRes.value.json();
        setSentLog(d.log || []);
      }
      if (wRes.status === 'fulfilled' && wRes.value.ok) {
        const d = await wRes.value.json();
        if (d.success) setWarmup(d);
      }
    } catch (_) { /* swallow */ }
    if (mounted.current) setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    fetchAll();
    const iv = setInterval(fetchAll, 60000);
    requestAnimationFrame(() => setFadeIn(true));
    return () => { mounted.current = false; clearInterval(iv); };
  }, [fetchAll]);

  const totalSent = stats?.totalSent ?? 0;
  const bounced = stats?.bounced ?? stats?.totalBounced ?? 0;
  const replied = stats?.replied ?? 0;
  const delivered = totalSent - bounced;
  const bounceRate = totalSent > 0 ? ((bounced / totalSent) * 100).toFixed(1) : '0.0';
  const replyRate = totalSent > 0 ? ((replied / totalSent) * 100).toFixed(1) : '0.0';

  const dailyMap = {};
  sentLog.forEach(e => {
    const d = e.timestamp ? e.timestamp.slice(0, 10) : null;
    if (d) dailyMap[d] = (dailyMap[d] || 0) + 1;
  });
  const sortedDays = Object.keys(dailyMap).sort();
  const last7 = sortedDays.slice(-7);
  const sparkData = last7.map(d => dailyMap[d]);
  const chartData = last7.map(d => ({
    label: new Date(d + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    count: dailyMap[d],
  }));

  const accounts = warmup?.accounts || [];
  const recent = sentLog.slice(0, 8);

  const stageBg = (color) => {
    if (!color) return 'rgba(255,255,255,0.06)';
    if (color.startsWith('#')) return color + '1a';
    return color;
  };
  const stageFg = (color) => color || '#a1a1aa';

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const S = {
    page: { maxWidth: 960, opacity: fadeIn ? 1 : 0, transition: 'opacity 0.45s ease' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 36 },
    title: { fontSize: 20, fontWeight: 500, color: '#fafafa', margin: 0, letterSpacing: '-0.01em', lineHeight: 1.3 },
    date: { fontSize: 13, color: '#71717a', marginTop: 4 },
    live: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#71717a', marginTop: 4 },
    liveDot: { width: 6, height: 6, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.5)' },
    metricsRow: { display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 1, marginBottom: 40 },
    heroCard: { background: '#18181b', borderRadius: 10, padding: '28px 28px 20px', position: 'relative', overflow: 'hidden', transition: 'box-shadow 0.2s ease' },
    smallCard: { background: 'transparent', borderRadius: 10, padding: '24px 20px 18px', transition: 'background 0.2s ease' },
    metricLabel: { fontSize: 12, color: '#71717a', marginBottom: 6, fontWeight: 400 },
    heroNum: { fontSize: 34, fontWeight: 600, color: '#fafafa', letterSpacing: '-0.03em', lineHeight: 1 },
    smallNum: { fontSize: 22, fontWeight: 600, color: '#fafafa', letterSpacing: '-0.02em', lineHeight: 1 },
    pill: { display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 20, marginLeft: 8, lineHeight: '18px' },
    sectionTitle: { fontSize: 14, fontWeight: 500, color: '#a1a1aa', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 },
    sectionCount: { fontSize: 11, color: '#71717a', background: 'rgba(255,255,255,0.04)', padding: '1px 7px', borderRadius: 10, fontWeight: 400 },
    accountRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 13 },
    accountDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
    accountEmail: { color: '#fafafa', fontWeight: 400, minWidth: 180 },
    accountMeta: { color: '#71717a', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 },
    progressTrack: { width: 80, height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, overflow: 'hidden', flexShrink: 0 },
    progressFill: { height: '100%', borderRadius: 1 },
    tableRow: (i) => ({ display: 'grid', gridTemplateColumns: '8px 1.2fr 1.4fr auto', alignItems: 'center', gap: 12, padding: '9px 4px', fontSize: 13, background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)', borderRadius: 4 }),
    dot: (color) => ({ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }),
    chartWrap: { marginBottom: 40 },
    chartBox: { background: '#18181b', borderRadius: 10, padding: '20px 16px 8px' },
    emptyText: { color: '#71717a', fontSize: 13, padding: '20px 0' },
  };

  if (loading) {
    return (
      <div style={S.page}>
        <div style={S.header}><div><Skel w={110} h={22} /><Skel w={180} h={14} style={{ marginTop: 8 }} /></div></div>
        <div style={S.metricsRow}><Skel w="100%" h={120} r={10} /><Skel w="100%" h={120} r={10} /><Skel w="100%" h={120} r={10} /><Skel w="100%" h={120} r={10} /></div>
        <Skel w="100%" h={200} r={10} style={{ marginBottom: 32 }} />
        <Skel w={130} h={16} style={{ marginBottom: 12 }} />
        {[...Array(4)].map((_, i) => (<Skel key={i} w="100%" h={40} r={4} style={{ marginBottom: 2 }} />))}
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.header}><div><h1 style={S.title}>Dashboard</h1><p style={S.date}>{today}</p></div><div style={S.live}><div style={S.liveDot} />Live</div></div>

      <div style={S.metricsRow}>
        <div style={S.heroCard} onMouseEnter={e => e.currentTarget.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.08)'} onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
          <div style={S.metricLabel}>Emails Sent</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div style={S.heroNum}>{totalSent.toLocaleString()}</div>
            <div style={{ opacity: 0.7, marginBottom: 4 }}><Sparkline data={sparkData.length >= 2 ? sparkData : [0, 0]} color="#3b82f6" width={100} height={28} /></div>
          </div>
          {stats?.sentD0 != null && (<div style={{ fontSize: 12, color: '#71717a', marginTop: 10 }}>{stats.sentD0} today{stats.sentD3 != null && <span style={{ marginLeft: 12 }}>{stats.sentD3} last 3 days</span>}</div>)}
        </div>

        <div style={S.smallCard} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.025)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <div style={S.metricLabel}>Delivered</div><div style={S.smallNum}>{delivered.toLocaleString()}</div>
        </div>

        <div style={S.smallCard} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.025)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <div style={S.metricLabel}>Bounced</div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={S.smallNum}>{bounced.toLocaleString()}</span>{bounced > 0 && (<span style={{ ...S.pill, background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>{bounceRate}%</span>)}</div>
        </div>

        <div style={S.smallCard} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.025)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <div style={S.metricLabel}>Replied</div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={S.smallNum}>{replied.toLocaleString()}</span>{replied > 0 && (<span style={{ ...S.pill, background: 'rgba(168,85,247,0.1)', color: '#c084fc' }}>{replyRate}%</span>)}</div>
        </div>
      </div>

      {chartData.length >= 2 && (<div style={S.chartWrap}><div style={S.sectionTitle}>Send Activity</div><div style={S.chartBox}><AreaChart data={chartData} height={170} /></div></div>)}

      {accounts.length > 0 && (
        <div style={{ marginBottom: 40 }}>
          <div style={S.sectionTitle}>Sender Accounts<span style={S.sectionCount}>{accounts.length}</span></div>
          <div>
            {accounts.map((a, i) => {
              const pct = a.maxPerDay > 0 ? Math.min((a.totalSent || 0) / a.maxPerDay, 1) : 0;
              const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4', '#f97316', '#8b5cf6'];
              const dotColor = colors[i % colors.length];
              return (
                <div key={a.email} style={{ ...S.accountRow, borderBottom: i === accounts.length - 1 ? 'none' : S.accountRow.borderBottom }}>
                  <div style={{ ...S.accountDot, background: dotColor }} />
                  <div style={S.accountEmail}>{a.displayName || a.email}</div>
                  {a.stageName && (<span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: stageBg(a.stageColor), color: stageFg(a.stageColor), fontWeight: 500, whiteSpace: 'nowrap' }}>{a.stageName}</span>)}
                  <div style={{ ...S.accountMeta, flex: 1, justifyContent: 'flex-end' }}>
                    {a.daysSinceFirst != null && <span>Day {a.daysSinceFirst}</span>}
                    {a.maxPerDay != null && <span>{a.maxPerDay}/day</span>}
                    <div style={S.progressTrack}><div style={{ ...S.progressFill, width: `${pct * 100}%`, background: dotColor, opacity: 0.7 }} /></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div style={S.sectionTitle}>Recent Sends{recent.length > 0 && <span style={S.sectionCount}>{sentLog.length} total</span>}</div>
        {recent.length === 0 ? (<p style={S.emptyText}>No sends recorded yet.</p>) : (
          <div>
            {recent.map((r, i) => (
              <div key={i} style={S.tableRow(i)}>
                <div style={S.dot(statusColor(r.status))} />
                <div style={{ color: '#fafafa', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company || r.to}</div>
                <div style={{ color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.to}</div>
                <div style={{ color: '#52525b', fontSize: 12, whiteSpace: 'nowrap', textAlign: 'right' }}>{timeAgo(r.timestamp)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
