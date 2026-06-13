'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="card p-5 fade-up">
      <div className="stat-label">{label}</div>
      <div className="stat-value mt-1.5" style={accent ? { color: '#b3a4f5' } : {}}>{value}</div>
      {sub && <div className="text-[12px] mt-1" style={{ color: 'var(--fg-dim)' }}>{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/warmup')
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const stages = data?.stages || [
    { week: 1, cap: 5 }, { week: 2, cap: 8 }, { week: 3, cap: 12 }, { week: 4, cap: 15 },
  ];
  const currentWeek = data?.week || 1;

  return (
    <div className="space-y-7">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[14px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
            Cold outreach for getaviance.site — running on autopilot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge" style={data?.windowOpenNow
            ? { background: 'var(--success-soft)', color: 'var(--success)' }
            : { background: 'var(--border)', color: 'var(--fg-muted)' }}>
            <span className="w-1.5 h-1.5 rounded-full dot-pulse"
              style={{ background: data?.windowOpenNow ? 'var(--success)' : 'var(--fg-dim)' }} />
            {data?.windowOpenNow ? 'Sending window open' : 'Outside send window'}
          </span>
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Warmup week" value={loading ? '—' : `Week ${currentWeek}`}
          sub={data ? `Day ${data.daysElapsed} since start` : ''} accent />
        <StatCard label="Cap per inbox / day" value={loading ? '—' : data?.capPerInbox ?? '—'}
          sub="auto-ramping" />
        <StatCard label="Sent today" value={loading ? '—' : data?.sentToday ?? 0}
          sub={data ? `of ${data.dailyCapacity} max` : ''} />
        <StatCard label="Inboxes" value={loading ? '—' : data?.inboxCount ?? 0}
          sub={data?.inboxCount ? 'connected' : 'none yet'} />
      </div>

      {/* Warmup ramp visual */}
      <div className="card p-6 fade-up">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[15px] font-semibold">Warmup ramp</h2>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
              New inboxes ramp slowly over 4 weeks so they never get flagged. Fully automatic.
            </p>
          </div>
          <span className="badge badge-accent">Auto</span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {stages.map((s) => {
            const active = s.week === currentWeek;
            const done = s.week < currentWeek;
            return (
              <div key={s.week} className="rounded-xl p-4 text-center transition-all"
                style={{
                  background: active ? 'var(--accent-soft)' : 'var(--bg-subtle)',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  opacity: done ? 0.55 : 1,
                }}>
                <div className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>Week {s.week}</div>
                <div className="text-[24px] font-semibold mt-1"
                  style={{ color: active ? '#b3a4f5' : 'var(--fg)' }}>{s.cap}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--fg-dim)' }}>per inbox/day</div>
                {active && <div className="text-[10px] mt-2 font-medium" style={{ color: 'var(--success)' }}>● current</div>}
                {done && <div className="text-[10px] mt-2" style={{ color: 'var(--fg-dim)' }}>done</div>}
              </div>
            );
          })}
        </div>
        <div className="mt-5 pt-4 flex items-center gap-2 text-[13px]"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--fg-muted)' }}>
          <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Sends are spread randomly between <b className="text-[var(--fg)]">&nbsp;9 AM – 8 PM&nbsp;</b>, every day of the week.
        </div>
      </div>

      {/* Inbox quick status + quick actions */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-6 fade-up">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[15px] font-semibold">Inboxes</h2>
            <Link href="/inboxes" className="text-[13px]" style={{ color: '#b3a4f5' }}>Manage →</Link>
          </div>
          {loading ? (
            <p className="text-[13px]" style={{ color: 'var(--fg-dim)' }}>Loading…</p>
          ) : data?.inboxes?.length ? (
            <div className="space-y-2.5">
              {data.inboxes.map((ib) => (
                <div key={ib.email} className="flex items-center justify-between rounded-lg p-3"
                  style={{ background: 'var(--bg-subtle)' }}>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{ib.email}</div>
                    <div className="text-[11px]" style={{ color: 'var(--fg-dim)' }}>{ib.displayName}</div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <div className="text-[13px] font-semibold">{ib.sentToday}/{ib.capPerInbox}</div>
                    <div className="text-[11px]" style={{ color: 'var(--fg-dim)' }}>today</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px]" style={{ color: 'var(--fg-muted)' }}>
              No inboxes connected yet. Add them once provisioning finishes —
              <Link href="/inboxes" style={{ color: '#b3a4f5' }}> setup guide</Link>.
            </div>
          )}
        </div>

        <div className="card p-6 fade-up">
          <h2 className="text-[15px] font-semibold mb-4">Quick actions</h2>
          <div className="space-y-2.5">
            <Link href="/leads" className="flex items-center gap-3 rounded-lg p-3 card-hover transition-all"
              style={{ background: 'var(--bg-subtle)' }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-soft)' }}>
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#b3a4f5" strokeWidth="1.6"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
              </div>
              <div><div className="text-[13px] font-medium">Upload leads</div><div className="text-[11px]" style={{ color: 'var(--fg-dim)' }}>Import a CSV of recipients</div></div>
            </Link>
            <Link href="/compose" className="flex items-center gap-3 rounded-lg p-3 card-hover transition-all"
              style={{ background: 'var(--bg-subtle)' }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-soft)' }}>
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#b3a4f5" strokeWidth="1.6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
              </div>
              <div><div className="text-[13px] font-medium">Edit email template</div><div className="text-[11px]" style={{ color: 'var(--fg-dim)' }}>Your cold email + variables</div></div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
