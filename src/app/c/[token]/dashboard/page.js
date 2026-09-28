'use client';

/**
 * The client's own dashboard (systems/clientdash.js): their sending as it
 * happens — the five numbers, the last 30 days, their inboxes, the newest
 * replies and their booked calls. Read-only; refreshes every five minutes.
 */

import { useEffect, useState } from 'react';

const card = { border: '1px solid var(--border)', padding: 18, background: 'var(--card)' };
const muted = { color: 'var(--fg-muted)' };
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const pct = (v) => (v == null ? '—' : `${Math.round(Number(v) * 100)}%`);
const day = (v) => { try { return new Date(v).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return ''; } };
const when = (v) => { try { return new Date(v).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const KIND = { interested: 'Interested', question: 'Question', unclear: 'Needs a look', not_interested: 'Not interested', not_now: 'Not now', referral: 'Referral', out_of_office: 'Out of office', unsubscribe: 'Unsubscribed', bounce: 'Bounce' };
const FIVE = [['sent', 'Emails sent'], ['replies', 'Replies'], ['positive', 'Interested'], ['booked', 'Calls booked'], ['qualified', 'Qualified calls']];

function Bars({ days, sent, replies }) {
  const max = Math.max(1, ...sent.map((v) => Number(v) || 0));
  const W = 600; const H = 140; const slot = W / Math.max(1, days.length); const bw = Math.max(2, slot * 0.7);
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Emails sent per day, last 30 days">
      {days.map((d, i) => {
        const v = Number(sent[i]) || 0; const h = (v / max) * H; const r = Number(replies[i]) || 0;
        return (
          <g key={d}>
            <rect x={i * slot + (slot - bw) / 2} y={H - h} width={bw} height={Math.max(h, v ? 1 : 0)} fill="var(--fg)" opacity="0.85"><title>{`${day(d + 'T12:00:00Z')}: ${v} sent${r ? `, ${r} ${r === 1 ? 'reply' : 'replies'}` : ''}`}</title></rect>
            {r > 0 && <circle cx={i * slot + slot / 2} cy={Math.max(6, H - h - 8)} r="4" fill="var(--accent, #e11)" />}
          </g>
        );
      })}
      <line x1="0" x2={W} y1={H} y2={H} stroke="var(--border)" />
      <text x="0" y={H + 14} fontSize="11" fill="currentColor">{days[0] ? day(days[0] + 'T12:00:00Z') : ''}</text>
      <text x={W} y={H + 14} fontSize="11" fill="currentColor" textAnchor="end">{days.length ? day(days[days.length - 1] + 'T12:00:00Z') : ''}</text>
    </svg>
  );
}

export default function DashboardPage({ params }) {
  const token = params.token;
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = () => fetch(`/api/c/dashboard?token=${encodeURIComponent(token)}`).then((r) => r.json()).then((j) => (j.ok ? (setD(j), setErr('')) : setErr(j.error || 'Not found'))).catch(() => setErr('Could not load the page. Check your connection and refresh.'));
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [token]);

  if (err && !d) return <p style={{ maxWidth: 760, margin: '10vh auto', padding: 16 }}>{err}</p>;
  if (!d) return <p style={{ maxWidth: 760, margin: '10vh auto', padding: 16 }}>Loading…</p>;
  const five = d.five || {};
  const l = d.last30;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '8px 0 48px', display: 'grid', gap: 18 }}>
      <div>
        <div className="mono" style={{ fontSize: 13, ...muted }}>Aviance — {d.plan}</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: '4px 0' }}>{d.company}</h1>
        <p style={{ margin: 0 }}>{d.status}{!d.paid && d.day != null && d.day > 0 ? ` · Day ${d.day} of 30` : ''}</p>
        <p style={{ margin: '4px 0 0', fontSize: 13, ...muted }}>Updated {when(d.updatedAt)} · refreshes on its own</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        {FIVE.map(([k, label]) => (
          <div key={k} style={card}>
            <div style={{ fontSize: 13, ...muted }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{n(five[k])}</div>
          </div>
        ))}
      </div>

      {l && l.days && l.days.length > 0 && (
        <div style={card}>
          <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>Last 30 days</h2>
          <p style={{ margin: '0 0 10px', fontSize: 14, ...muted }}>{n(l.totals.sent)} emails sent · {n(l.totals.replies)} replies · {n(l.totals.positive)} interested · {n(l.totals.booked)} calls booked. A red dot marks a day with a reply.</p>
          <Bars days={l.days} sent={l.sent} replies={l.replies} />
        </div>
      )}

      <div style={card}>
        <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Your inboxes</h2>
        {d.inboxes.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead><tr style={{ textAlign: 'left' }}><th style={{ padding: '6px 8px' }}>Inbox</th><th style={{ padding: '6px 8px' }}>Emails a day</th><th style={{ padding: '6px 8px' }}>Landing in the inbox</th><th style={{ padding: '6px 8px' }}>Health</th></tr></thead>
              <tbody>{d.inboxes.map((i) => (
                <tr key={i.email} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px' }} className="mono">{i.email}</td>
                  <td style={{ padding: '6px 8px' }}>{n(i.dailyCap)}</td>
                  <td style={{ padding: '6px 8px' }}>{pct(i.inboxRate7d)}</td>
                  <td style={{ padding: '6px 8px' }}>{i.health === 'ok' ? 'Good' : 'Being looked at'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p style={{ margin: 0, ...muted }}>Your inboxes are being set up.</p>}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Newest replies</h2>
        {d.replies.length ? (
          <div style={{ display: 'grid', gap: 10 }}>{d.replies.map((r, i) => (
            <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : 0, paddingTop: i ? 10 : 0 }}>
              <div style={{ fontSize: 14 }}><b>{KIND[r.kind] || 'Reply'}</b> <span style={muted}>· {r.from} · {when(r.at)}</span></div>
              {r.snippet && <div style={{ fontSize: 14, marginTop: 2 }}>{r.snippet}</div>}
            </div>
          ))}</div>
        ) : <p style={{ margin: 0, ...muted }}>No replies yet. Anything hot comes to your inbox the same day.</p>}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Booked calls</h2>
        {d.bookings.length ? (
          <div style={{ display: 'grid', gap: 6 }}>{d.bookings.map((b, i) => (
            <div key={i} style={{ fontSize: 14 }}><b>{when(b.at)}</b> <span style={muted}>· {b.with} · {b.status || 'booked'}</span></div>
          ))}</div>
        ) : <p style={{ margin: 0, ...muted }}>No calls booked yet.</p>}
      </div>
    </div>
  );
}
