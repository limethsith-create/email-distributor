'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };

function prettyDay(d) {
  if (!d) return '';
  try {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return d; }
}

function Metric({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 74 }}>
      <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function ActivityPage() {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState({}); // date -> bool

  useEffect(() => {
    let alive = true;
    fetch('/api/daily-log', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) { setDays((d && d.days) || []); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const totals = days.reduce((a, d) => ({
    sent: a.sent + (d.summary?.totalSent || 0),
    replies: a.replies + (d.summary?.totalReplies || 0),
    opens: a.opens + (d.summary?.totalOpens || 0),
    bounces: a.bounces + (d.summary?.totalBounces || 0),
  }), { sent: 0, replies: 0, opens: 0, bounces: 0 });

  return (
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Daily activity</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        A day-by-day log of everything the system did — emails sent, opens, replies, and bounces.
      </p>

      {/* lifetime totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 22 }}>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Sent (all time)</div><div style={{ fontSize: 30, fontWeight: 700, color: '#e0290f' }}>{loading ? '—' : totals.sent}</div></div>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Opens</div><div style={{ fontSize: 30, fontWeight: 700, color: '#0891b2' }}>{loading ? '—' : totals.opens}</div></div>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Replies</div><div style={{ fontSize: 30, fontWeight: 700, color: '#16a34a' }}>{loading ? '—' : totals.replies}</div></div>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Bounces</div><div style={{ fontSize: 30, fontWeight: 700, color: '#dc2626' }}>{loading ? '—' : totals.bounces}</div></div>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
      ) : days.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>
          No activity logged yet. Days appear here once emails start going out.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {days.map((d) => {
            const isOpen = !!open[d.date];
            const s = d.summary || {};
            return (
              <div key={d.date} style={{ ...card, overflow: 'hidden' }}>
                <button onClick={() => setOpen((o) => ({ ...o, [d.date]: !o[d.date] }))}
                  style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 20px', flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>{prettyDay(d.date)}</div>
                  <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
                    <Metric label="sent" value={s.totalSent || 0} color="#e0290f" />
                    <Metric label="opens" value={s.totalOpens || 0} color="#0891b2" />
                    <Metric label="replies" value={s.totalReplies || 0} color="#16a34a" />
                    <Metric label="bounces" value={s.totalBounces || 0} color="#dc2626" />
                    <span style={{ color: 'var(--fg-dim)', fontSize: 18, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                  </div>
                </button>

                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '14px 20px', fontSize: 13 }}>
                    {(d.sent || []).length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 600, color: '#e0290f', marginBottom: 6 }}>Sent ({d.sent.length})</div>
                        {d.sent.slice(0, 50).map((x, i) => (
                          <div key={i} style={{ color: 'var(--fg-muted)', padding: '2px 0' }}>
                            {x.to} {x.company ? <span style={{ color: 'var(--fg-dim)' }}>· {x.company}</span> : null} {x.from ? <span style={{ color: 'var(--fg-dim)' }}>· from {x.from}</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                    {(d.replies || []).length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 600, color: '#16a34a', marginBottom: 6 }}>Replies ({d.replies.length})</div>
                        {d.replies.map((x, i) => (
                          <div key={i} style={{ color: 'var(--fg-muted)', padding: '2px 0' }}>
                            {x.from} {x.subject ? <span style={{ color: 'var(--fg-dim)' }}>· {x.subject}</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                    {(d.bounces || []).length > 0 && (
                      <div style={{ marginBottom: 4 }}>
                        <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: 6 }}>Bounces ({d.bounces.length})</div>
                        {d.bounces.map((x, i) => (
                          <div key={i} style={{ color: 'var(--fg-muted)', padding: '2px 0' }}>
                            {x.email} {x.reason ? <span style={{ color: 'var(--fg-dim)' }}>· {x.reason}</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                    {Object.keys(d.accountBreakdown || {}).length > 0 && (
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: 12 }}>
                        {Object.entries(d.accountBreakdown).map(([acc, n]) => `${acc}: ${n}`).join('  ·  ')}
                      </div>
                    )}
                    {!(d.sent || []).length && !(d.replies || []).length && !(d.bounces || []).length && (
                      <div style={{ color: 'var(--fg-dim)' }}>No detailed records for this day.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
