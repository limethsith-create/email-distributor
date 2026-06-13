'use client';

import { useState, useEffect } from 'react';

export default function InboxesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/warmup').then((r) => r.json()).then((d) => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const inboxes = data?.inboxes || [];

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Inboxes</h1>
        <p className="text-[14px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
          The mailboxes that send your cold email, with today&apos;s warmup limits.
        </p>
      </div>

      {loading ? (
        <div className="card p-6 text-[13px]" style={{ color: 'var(--fg-dim)' }}>Loading…</div>
      ) : inboxes.length ? (
        <div className="space-y-3">
          {inboxes.map((ib) => {
            const pct = ib.capPerInbox ? Math.min(100, Math.round((ib.sentToday / ib.capPerInbox) * 100)) : 0;
            return (
              <div key={ib.email} className="card p-5 fade-up">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent-soft)' }}>
                      <span style={{ color: '#b3a4f5' }} className="font-semibold text-[13px]">
                        {(ib.displayName || ib.email)[0].toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium truncate">{ib.email}</div>
                      <div className="text-[12px]" style={{ color: 'var(--fg-dim)' }}>{ib.displayName}</div>
                    </div>
                  </div>
                  <span className="badge badge-success">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success)' }} /> Active
                  </span>
                </div>
                <div className="mt-4">
                  <div className="flex items-center justify-between text-[12px] mb-1.5" style={{ color: 'var(--fg-muted)' }}>
                    <span>Sent today</span>
                    <span>{ib.sentToday} / {ib.capPerInbox} &nbsp;·&nbsp; {ib.remaining} left</span>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-subtle)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#6e56cf,#9d7bf0)' }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card p-6 fade-up">
          <h2 className="text-[15px] font-semibold mb-1">No inboxes connected yet</h2>
          <p className="text-[13px] mb-4" style={{ color: 'var(--fg-muted)' }}>
            Once Cheapinboxes finishes provisioning getaviance.site, add the two mailboxes by setting
            environment variables (no passwords ever live in this UI).
          </p>
          <div className="rounded-lg p-4 text-[12.5px] font-mono leading-relaxed" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--fg-muted)' }}>
            <div>SMTP_HOST=smtp.gmail.com</div>
            <div>SMTP_PORT=465</div>
            <div>SMTP_ACCOUNT_1=limethsith@getaviance.site:APP_PW:Limethsith Weerasinghe</div>
            <div>SMTP_ACCOUNT_2=limethsith.weerasinghe@getaviance.site:APP_PW:Limethsith Weerasinghe</div>
            <div>WARMUP_START_DATE=2026-06-13</div>
          </div>
          <p className="text-[12px] mt-3" style={{ color: 'var(--fg-dim)' }}>
            Add these in Vercel → Settings → Environment Variables, then redeploy. They&apos;ll appear here automatically.
          </p>
        </div>
      )}

      {/* Sending rules */}
      <div className="card p-6 fade-up">
        <h2 className="text-[15px] font-semibold mb-3">Sending rules</h2>
        <ul className="space-y-2 text-[13px]" style={{ color: 'var(--fg-muted)' }}>
          {[
            'Daily cap ramps automatically: 5 → 8 → 12 → 15 per inbox over 4 weeks.',
            'Sends happen at randomized times between 9 AM and 8 PM, every day.',
            'Plain-text style, one link max, always an opt-out line.',
            'Clean your list — bounces hurt the domain fast.',
          ].map((t, i) => (
            <li key={i} className="flex gap-2.5">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="var(--success)" strokeWidth="2" className="mt-0.5 flex-shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
