'use client';

// Dashboard — combined overview for BOTH campaigns plus a per-campaign results
// table and an interactive sends-per-day chart (hover/focus a day to see exactly
// what happened on it; a table view carries the same numbers without hovering).
import { useState, useEffect, useMemo, useRef } from 'react';

// Fresh start: only count sends recorded on/after the campaign start.
const CAMPAIGN_START = '2026-08-01T09:30:00Z';
function afterStart(ts) { return ts && String(ts) >= CAMPAIGN_START; }

// ── Open-tracking blackout ──────────────────────────────────────────────
// The tracking pixel was gated behind OPEN_TRACKING === 'on'. When that env
// var went missing, every email shipped WITHOUT a pixel, so opens could not be
// recorded at all — the recipients may well have opened, we simply have no
// signal. Counting those sends in the open-rate denominator understates the
// real rate, so they're excluded from the RATE only. They still count fully
// toward "Emails sent". Restored 2026-08-26 (pixel now on by default).
const TRACKING_GAP_START = '2026-08-21T00:00:00Z';
const TRACKING_GAP_END = '2026-08-26T04:20:00Z';
function isTrackable(l) {
  const t = l.sent_at;
  if (!afterStart(t)) return false;
  const ts = String(t);
  return !(ts >= TRACKING_GAP_START && ts < TRACKING_GAP_END);
}
function isReal(l) {
  const s = (l.status || '');
  return !s.startsWith('skipped') && s !== 'bounced';
}
function isSent(l) { return afterStart(l.sent_at); }
function isReplied(l) { return afterStart(l.replied_at); }
function isOpened(l) { return afterStart(l.opened_at); }

// ── Campaigns ───────────────────────────────────────────────────────────
const CAMPAIGNS = [
  { id: 'free-leads', idx: '00', name: 'Free Leads', token: 'var(--c-free)' },
  { id: 'offer', idx: '01', name: 'Guaranteed Calls', token: 'var(--c-offer)' },
];
function campaignOf(l) {
  return String(l.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : 'offer';
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

// ── Daily series ────────────────────────────────────────────────────────
// Every touch is placed on the day it actually went out (day 0, day 3 and
// day 7 each carry their own timestamp), and opens/replies are placed on the
// day they were recorded — so a column is a real day of activity, not a proxy.
const dayOf = (ts) => String(ts).slice(0, 10);

function buildDaily(leads) {
  const map = new Map();
  const bump = (d, key, n = 1) => {
    if (!d) return;
    let row = map.get(d);
    if (!row) { row = { d, sent: 0, 'free-leads': 0, offer: 0, opened: 0, replied: 0 }; map.set(d, row); }
    row[key] += n;
  };
  for (const l of leads) {
    const c = campaignOf(l);
    for (const ts of [l.sent_at, l.d3_sent_at, l.d7_sent_at]) {
      if (!afterStart(ts)) continue;
      bump(dayOf(ts), 'sent');
      bump(dayOf(ts), c);
    }
    if (afterStart(l.opened_at)) bump(dayOf(l.opened_at), 'opened');
    if (afterStart(l.replied_at)) bump(dayOf(l.replied_at), 'replied');
  }
  const days = [...map.keys()].sort();
  if (!days.length) return [];
  // Fill the gaps so a quiet day reads as zero instead of vanishing.
  const out = [];
  const cur = new Date(days[0] + 'T00:00:00Z');
  const end = new Date(days[days.length - 1] + 'T00:00:00Z');
  while (cur <= end) {
    const key = cur.toISOString().slice(0, 10);
    out.push(map.get(key) || { d: key, sent: 0, 'free-leads': 0, offer: 0, opened: 0, replied: 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function niceMax(v) {
  if (v <= 4) return Math.max(v, 4);
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    const c = m * pow;
    if (c >= v) return Math.ceil(c);
  }
  return Math.ceil(v / pow) * pow;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parseDay(d) { return new Date(d + 'T00:00:00Z'); }
function longDate(d) { const t = parseDay(d); return `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MO[t.getUTCMonth()]}`; }
function shortDate(d) { const t = parseDay(d); return `${t.getUTCDate()} ${MO[t.getUTCMonth()]}`; }
function isWeekend(d) { const g = parseDay(d).getUTCDay(); return g === 0 || g === 6; }

function KPI({ idx, label, value, sub }) {
  return (
    <div style={{ ...card, padding: '18px 20px' }}>
      <div className="eyebrow"><span className="idx">{idx}</span>&nbsp;&nbsp;{label}</div>
      <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 10, lineHeight: 1 }}>{value}</div>
      {sub && <div className="mono" style={{ color: 'var(--fg-dim)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{sub}</div>}
    </div>
  );
}

// ── Sends per day ───────────────────────────────────────────────────────
function SendsChart({ rows }) {
  const [active, setActive] = useState(null);
  const wrapRef = useRef(null);

  const W = 920, H = 300, padL = 46, padR = 18, padT = 20, padB = 36;
  const iw = W - padL - padR, ih = H - padT - padB;

  if (!rows.length) {
    return (
      <div style={{ height: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)', gap: 6 }}>
        <div style={{ fontSize: 14 }}>No emails sent yet</div>
        <div className="mono" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sends will appear here as they happen</div>
      </div>
    );
  }

  const max = niceMax(Math.max(...rows.map((r) => r.sent), 1));
  const band = iw / rows.length;
  const bw = Math.max(3, Math.min(24, band - 6));
  const cx = (i) => padL + band * i + band / 2;
  const y = (v) => padT + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((g) => Math.round(g * max)).filter((v, i, a) => a.indexOf(v) === i);

  // Column with a 4px rounded cap and a square baseline.
  const colPath = (i, v) => {
    const h = padT + ih - y(v);
    const x0 = cx(i) - bw / 2, x1 = cx(i) + bw / 2, yTop = y(v), yBot = padT + ih;
    const r = Math.min(4, bw / 2, h);
    if (h <= 0.5) return '';
    return `M ${x0} ${yBot} L ${x0} ${yTop + r} Q ${x0} ${yTop} ${x0 + r} ${yTop} L ${x1 - r} ${yTop} Q ${x1} ${yTop} ${x1} ${yTop + r} L ${x1} ${yBot} Z`;
  };

  // X labels: never more than ~7, always including the last day.
  const step = Math.max(1, Math.ceil(rows.length / 7));
  const labelIdx = [];
  for (let i = rows.length - 1; i >= 0; i -= step) labelIdx.unshift(i);

  const a = active != null ? rows[active] : null;
  const tipLeft = active != null ? (cx(active) / W) * 100 : 0;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }}
        role="img" aria-label="Emails sent per day">
        {/* weekends, recessive */}
        {rows.map((r, i) => isWeekend(r.d) ? (
          <rect key={'w' + i} x={padL + band * i} y={padT} width={band} height={ih} fill="var(--viz-weekend)" />
        ) : null)}

        {/* hairline grid + y ticks */}
        {ticks.map((t, i) => (
          <g key={'g' + i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth="1" shapeRendering="crispEdges" />
            <text x={padL - 10} y={y(t) + 3.5} textAnchor="end" fill="var(--viz-muted)" fontSize="10.5"
              style={{ fontVariantNumeric: 'tabular-nums' }} fontFamily="var(--font-mono, ui-monospace, monospace)">{t}</text>
          </g>
        ))}

        {/* crosshair sits behind the columns so it never cuts across a bar */}
        {a && (
          <line x1={cx(active)} x2={cx(active)} y1={padT} y2={padT + ih} stroke="var(--viz-axis)" strokeWidth="1" shapeRendering="crispEdges" />
        )}

        {/* columns — full strength always; the active day is marked by the
            crosshair and its own value label, never by fading the rest out */}
        {rows.map((r, i) => r.sent > 0 ? (
          <path key={'b' + i} d={colPath(i, r.sent)} fill="var(--viz-series)" />
        ) : null)}

        {/* the one direct label: the day being read */}
        {a && a.sent > 0 && (
          <text x={cx(active)} y={y(a.sent) - 9} textAnchor="middle" fill="var(--fg)" fontSize="12.5" fontWeight="700"
            style={{ fontVariantNumeric: 'tabular-nums' }}>{a.sent}</text>
        )}

        {/* x labels */}
        {labelIdx.map((i) => (
          <text key={'x' + i} x={cx(i)} y={H - 12} textAnchor="middle" fill="var(--viz-muted)" fontSize="10.5"
            fontFamily="var(--font-mono, ui-monospace, monospace)">{shortDate(rows[i].d)}</text>
        ))}

        {/* hit targets — full column height, keyboard reachable */}
        {rows.map((r, i) => (
          <rect key={'h' + i} x={padL + band * i} y={padT} width={band} height={ih} fill="transparent"
            tabIndex={0} role="button"
            aria-label={`${longDate(r.d)}: ${r.sent} sent, ${r.opened} opened, ${r.replied} replied`}
            onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)}
            onMouseLeave={() => setActive((p) => (p === i ? null : p))} onBlur={() => setActive(null)}
            style={{ cursor: 'crosshair', outline: 'none' }} />
        ))}
      </svg>

      {a && (
        <div style={{
          position: 'absolute', top: 6, left: `${tipLeft}%`,
          transform: `translateX(${tipLeft > 62 ? '-100%' : tipLeft < 12 ? '0' : '-50%'})`,
          background: 'var(--card)', border: '1px solid var(--border-strong)', padding: '11px 13px',
          minWidth: 186, pointerEvents: 'none', zIndex: 3, boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
        }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>{longDate(a.d)}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 6 }}>
            <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>{a.sent}</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{a.sent === 1 ? 'email sent' : 'emails sent'}</span>
          </div>
          <div style={{ marginTop: 10, display: 'grid', gap: 5 }}>
            {CAMPAIGNS.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ width: 12, height: 2, background: c.token, flexShrink: 0 }} />
                <span style={{ color: 'var(--fg-muted)', flex: 1 }}>{c.name}</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{a[c.id]}</b>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 9, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'grid', gap: 5 }}>
            <div style={{ display: 'flex', gap: 8, fontSize: 12.5 }}>
              <span style={{ color: 'var(--fg-muted)', flex: 1 }}>Opened</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{a.opened}</b>
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 12.5 }}>
              <span style={{ color: 'var(--fg-muted)', flex: 1 }}>Replied</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{a.replied}</b>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DayTable({ rows }) {
  const th = { textAlign: 'right', padding: '7px 10px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td = { textAlign: 'right', padding: '7px 10px', fontSize: 13, fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--border)' };
  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
        <thead>
          <tr>
            <th className="mono" style={{ ...th, textAlign: 'left' }}>Day</th>
            <th className="mono" style={th}>Sent</th>
            <th className="mono" style={th}>Free Leads</th>
            <th className="mono" style={th}>Guaranteed Calls</th>
            <th className="mono" style={th}>Opened</th>
            <th className="mono" style={th}>Replied</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.d}>
              <td style={{ ...td, textAlign: 'left', whiteSpace: 'nowrap' }}>{longDate(r.d)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{r.sent}</td>
              <td style={td}>{r['free-leads']}</td>
              <td style={td}>{r.offer}</td>
              <td style={td}>{r.opened}</td>
              <td style={td}>{r.replied}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inboxes, setInboxes] = useState([]);
  const [showTable, setShowTable] = useState(false);

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

  const real = useMemo(() => leads.filter(isReal), [leads]);
  const daily = useMemo(() => buildDaily(real), [real]);

  const total = real.length;
  const sentLeads = real.filter(isSent);
  const repliedLeads = real.filter(isReplied);
  const openedLeads = real.filter(isOpened);
  const newLeads = real.filter((l) => !isSent(l));
  const contacted = sentLeads.length;
  const emailsSent = daily.reduce((s, r) => s + r.sent, 0);
  const trackableLeads = sentLeads.filter(isTrackable);
  const untracked = contacted - trackableLeads.length;
  const openRate = pct(openedLeads.length, trackableLeads.length);
  const replyRate = pct(repliedLeads.length, contacted);

  // Per-campaign results — both campaigns, always both rows, plus the total.
  const byCampaign = CAMPAIGNS.map((c) => {
    const ls = real.filter((l) => campaignOf(l) === c.id);
    const s = ls.filter(isSent);
    const trackable = s.filter(isTrackable);
    const op = ls.filter(isOpened);
    const rp = ls.filter(isReplied);
    const touches = ls.reduce((n, l) => n
      + (afterStart(l.sent_at) ? 1 : 0)
      + (afterStart(l.d3_sent_at) ? 1 : 0)
      + (afterStart(l.d7_sent_at) ? 1 : 0), 0);
    return {
      ...c, leads: ls.length, queued: ls.length - s.length, contacted: s.length,
      touches, opened: op.length, replied: rp.length,
      openRate: pct(op.length, trackable.length), replyRate: pct(rp.length, s.length),
      inboxes: inboxes.filter((i) => (i.campaign || 'offer') === c.id),
    };
  });

  const totalsRow = {
    name: 'All campaigns', leads: total, queued: newLeads.length, contacted,
    touches: emailsSent, opened: openedLeads.length, replied: repliedLeads.length,
    openRate, replyRate,
  };

  const busiest = daily.reduce((b, r) => (r.sent > (b?.sent || 0) ? r : b), null);
  const activeDays = daily.filter((r) => r.sent > 0).length;

  const th = { textAlign: 'right', padding: '9px 12px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td = { textAlign: 'right', padding: '13px 12px', fontSize: 14, fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--border)' };

  return (
    <div className="fade-up">
      {/* Chart chrome tokens — declared for all three theme states so the
          plot never borrows the host page's theme. */}
      <style>{`
        .viz { --viz-series:#e0290f; --viz-grid:#e6e4de; --viz-axis:#c3c2b7;
               --viz-muted:#898781; --viz-weekend:rgba(11,11,11,0.028);
               --c-free:#0f8f63; --c-offer:#e0290f; }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) .viz {
            --viz-series:#ef5535; --viz-grid:#2c2c2a; --viz-axis:#454440;
            --viz-muted:#8f8d86; --viz-weekend:rgba(255,255,255,0.035);
            --c-free:#199e70; --c-offer:#ef5535; }
        }
        :root[data-theme="dark"] .viz {
          --viz-series:#ef5535; --viz-grid:#2c2c2a; --viz-axis:#454440;
          --viz-muted:#8f8d86; --viz-weekend:rgba(255,255,255,0.035);
          --c-free:#199e70; --c-offer:#ef5535; }
        .viz rect[tabindex]:focus-visible { outline:2px solid var(--viz-series); outline-offset:-2px; }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}><span className="idx">00</span>&nbsp;/&nbsp;OVERVIEW</div>
          <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>Dashboard</h1>
        </div>
        <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid #111', padding: '7px 12px', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg)' }}>
          <span style={{ width: 7, height: 7, background: 'var(--accent)', display: 'inline-block' }} /> Live · booked-calls engine
        </span>
      </div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '14px 0 22px', maxWidth: 640 }}>
        Both campaigns, combined. Every number below counts Free Leads and Guaranteed Calls together;
        the results table splits them, and each day on the chart opens up on hover.
      </p>

      <div className="rule" style={{ marginBottom: 22 }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 20 }}>
        <KPI idx="01" label="Total leads" value={loading ? '—' : fmt(total)} sub={`${fmt(newLeads.length)} not yet sent`} />
        <KPI idx="02" label="Inboxes live" value={inboxes.length ? inboxes.filter((i) => i.enabled).length : '—'}
          sub={inboxes.length ? `${inboxes.length} connected · ${inboxes.reduce((s, i) => s + (i.cap || 0), 0)}/day max` : 'loading'} />
        <KPI idx="03" label="Emails sent" value={loading ? '—' : fmt(emailsSent)} sub={`${fmt(contacted)} leads contacted`} />
        <KPI idx="04" label="Opened" value={loading ? '—' : fmt(openedLeads.length)}
          sub={loading ? '' : (untracked > 0 ? `${openRate}% open rate · ${untracked} untracked` : `${openRate}% open rate`)} />
        <KPI idx="05" label="Replied" value={loading ? '—' : fmt(repliedLeads.length)} sub={loading ? '' : `${replyRate}% reply rate`} />
      </div>

      {/* ── Results by campaign ─────────────────────────────────────────── */}
      <div className="viz" style={{ ...card, padding: '20px 22px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <div className="eyebrow"><span className="idx">06</span>&nbsp;/&nbsp;RESULTS BY CAMPAIGN</div>
          <span style={{ fontSize: 12.5, color: 'var(--fg-dim)' }}>Rates are measured against leads contacted</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 660 }}>
            <thead>
              <tr>
                <th className="mono" style={{ ...th, textAlign: 'left' }}>Campaign</th>
                <th className="mono" style={th}>Leads</th>
                <th className="mono" style={th}>Queued</th>
                <th className="mono" style={th}>Contacted</th>
                <th className="mono" style={th}>Emails sent</th>
                <th className="mono" style={th}>Opened</th>
                <th className="mono" style={th}>Open rate</th>
                <th className="mono" style={th}>Replied</th>
                <th className="mono" style={th}>Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {byCampaign.map((c) => (
                <tr key={c.id}>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{ width: 9, height: 9, background: c.token, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{c.name}</div>
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: 2, whiteSpace: 'nowrap' }}>
                          {c.inboxes.length ? c.inboxes.map((i) => i.email.split('@')[0]).join(' · ') : 'no inbox assigned'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={td}>{loading ? '—' : fmt(c.leads)}</td>
                  <td style={{ ...td, color: 'var(--fg-muted)' }}>{loading ? '—' : fmt(c.queued)}</td>
                  <td style={td}>{loading ? '—' : fmt(c.contacted)}</td>
                  <td style={td}>{loading ? '—' : fmt(c.touches)}</td>
                  <td style={td}>{loading ? '—' : fmt(c.opened)}</td>
                  <td style={td}>{loading ? '—' : `${c.openRate}%`}</td>
                  <td style={td}>{loading ? '—' : fmt(c.replied)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{loading ? '—' : `${c.replyRate}%`}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, textAlign: 'left', fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{totalsRow.name}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : fmt(totalsRow.leads)}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)', color: 'var(--fg-muted)' }}>{loading ? '—' : fmt(totalsRow.queued)}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : fmt(totalsRow.contacted)}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : fmt(totalsRow.touches)}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : fmt(totalsRow.opened)}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : `${totalsRow.openRate}%`}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : fmt(totalsRow.replied)}</td>
                <td style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border-strong)' }}>{loading ? '—' : `${totalsRow.replyRate}%`}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Sends per day ───────────────────────────────────────────────── */}
      <div className="viz" style={{ ...card, padding: '20px 22px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginBottom: 4 }}>
          <div>
            <div className="eyebrow"><span className="idx">07</span>&nbsp;/&nbsp;EMAILS SENT PER DAY</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 8 }}>
              {loading || !daily.length ? 'Every touch — first email, day 3 and day 7 — on the day it went out.'
                : <>Hover or tab to a day for its full breakdown · {fmt(emailsSent)} emails across {activeDays} sending {activeDays === 1 ? 'day' : 'days'}{busiest && busiest.sent > 0 ? ` · busiest ${longDate(busiest.d)} (${busiest.sent})` : ''}</>}
            </div>
          </div>
          <button onClick={() => setShowTable((v) => !v)} className="mono"
            style={{ fontFamily: 'inherit', cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--fg)', padding: '7px 12px', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', borderRadius: 2, flexShrink: 0 }}>
            {showTable ? 'Hide table' : 'Table view'}
          </button>
        </div>
        {loading
          ? <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)' }}>Loading…</div>
          : <SendsChart rows={daily} />}
        {showTable && !loading && daily.length > 0 && <DayTable rows={daily} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 18 }}>
        <div className="viz" style={{ ...card, padding: '20px 22px' }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}><span className="idx">08</span>&nbsp;/&nbsp;INBOXES</div>
          {(inboxes.length ? inboxes : [{ email: 'Loading…', enabled: false, sentToday: 0, cap: 0 }]).map((b) => {
            const c = CAMPAIGNS.find((x) => x.id === (b.campaign || 'offer')) || CAMPAIGNS[1];
            return (
              <div key={b.email} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ width: 7, height: 7, background: b.enabled ? '#16a34a' : 'var(--fg-dim)', flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</div>
                    {inboxes.length > 0 && (
                      <div className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        <span style={{ display: 'inline-block', width: 7, height: 7, background: c.token, marginRight: 6 }} />{c.name}
                      </div>
                    )}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 10.5, color: b.enabled ? '#15803d' : 'var(--fg-dim)', border: '1px solid ' + (b.enabled ? 'rgba(22,163,74,0.4)' : 'var(--border)'), padding: '3px 8px', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {b.enabled ? `On · ${b.sentToday}/${b.cap}` : 'Off'}
                </span>
              </div>
            );
          })}
          <div className="mono" style={{ marginTop: 14, fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sending spread across US business hours</div>
        </div>

        <div style={{ ...card, padding: '20px 22px' }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}><span className="idx">09</span>&nbsp;/&nbsp;PIPELINE</div>
          {[
            { k: 'Not yet sent', v: newLeads.length, c: '#0a0a0a' },
            { k: 'Already sent', v: sentLeads.length, c: '#e0290f' },
            { k: 'Opened', v: openedLeads.length, c: '#c8811f' },
            { k: 'Replied', v: repliedLeads.length, c: '#9a9a9a' },
          ].map((r) => (
            <div key={r.k} style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 8 }}>
                <span style={{ color: 'var(--fg-muted)' }}>{r.k}</span>
                <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{loading ? '—' : fmt(r.v)}</span>
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
