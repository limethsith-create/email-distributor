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

  return (
    <div className="fade-up" style={{ maxWidth: 900 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}><span className="idx">04</span>&nbsp;/&nbsp;ACTIVITY</div>
      <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1, marginBottom: 8 }}>Daily activity</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 20, maxWidth: 560 }}>
        How many emails went out each day. Click a day to see exactly who got one.
      </p>

      <div className="rule" style={{ marginBottom: 22 }} />

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
            const sentCount = (d.sent || []).length;
            return (
              <div key={d.date} style={{ ...card, overflow: 'hidden' }}>
                <button onClick={() => setOpen((o) => ({ ...o, [d.date]: !o[d.date] }))}
                  style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 22px' }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{prettyDay(d.date)}</div>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <span style={{ fontSize: 30, fontWeight: 800, color: '#e0290f', lineHeight: 1 }}>{sentCount}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>sent</span>
                    <span style={{ color: 'var(--fg-dim)', fontSize: 18, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                  </div>
                </button>

                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '14px 22px', fontSize: 13 }}>
                    {sentCount > 0 ? (
                      d.sent.slice(0, 50).map((x, i) => (
                        <div key={i} style={{ color: 'var(--fg-muted)', padding: '3px 0' }}>
                          {x.to} {x.company ? <span style={{ color: 'var(--fg-dim)' }}>· {x.company}</span> : null} {x.from ? <span style={{ color: 'var(--fg-dim)' }}>· from {x.from}</span> : null}
                        </div>
                      ))
                    ) : (
                      <div style={{ color: 'var(--fg-dim)' }}>No sends recorded this day.</div>
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
