'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };

function Toggle({ on, busy, onClick }) {
  return (
    <button onClick={onClick} disabled={busy} aria-pressed={on}
      style={{
        width: 52, height: 30, borderRadius: 999, position: 'relative', cursor: busy ? 'default' : 'pointer',
        border: '1px solid ' + (on ? '#16a34a' : 'var(--border-strong)'),
        background: on ? '#16a34a' : 'var(--card-hover)', transition: 'all .18s', flexShrink: 0, opacity: busy ? 0.6 : 1,
      }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 24 : 2, width: 24, height: 24, borderRadius: 999,
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left .18s',
      }} />
    </button>
  );
}

export default function InboxesPage() {
  const [inboxes, setInboxes] = useState(null);
  const [cap, setCap] = useState(25);
  const [busy, setBusy] = useState('');

  const load = () => fetch('/api/inboxes-control', { cache: 'no-store' }).then((r) => r.json())
    .then((d) => { setInboxes(d.inboxes || []); if (d.cap) setCap(d.cap); })
    .catch(() => setInboxes([]));

  useEffect(() => { load(); }, []);

  const toggle = async (ib) => {
    const next = !ib.enabled;
    setBusy(ib.email);
    // optimistic
    setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, enabled: next } : x));
    try {
      await fetch('/api/inboxes-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ib.email, enabled: next }) });
    } catch {
      // revert on failure
      setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, enabled: !next } : x));
    }
    setBusy('');
  };

  const anyOn = (inboxes || []).some((i) => i.enabled);

  return (
    <div className="fade-up" style={{ maxWidth: 1080 }}>
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Inboxes</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        Each inbox has a physical switch. Off means it never sends. Turn it on and that inbox starts sending up to {cap} emails/day.
      </p>

      {/* master status banner */}
      <div style={{ ...card, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12,
        borderColor: anyOn ? 'rgba(22,163,74,0.35)' : 'var(--border)' }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: anyOn ? '#16a34a' : 'var(--fg-dim)', flexShrink: 0 }} />
        <div style={{ fontSize: 13.5, color: 'var(--fg)' }}>
          {inboxes == null ? 'Checking…' : anyOn
            ? <><b>Sending is live.</b> One or more inboxes are switched on and will send on schedule.</>
            : <><b>Sending is off.</b> No inbox is switched on — nothing will send.</>}
        </div>
      </div>

      {inboxes == null ? (
        <div style={{ ...card, padding: 24, color: 'var(--fg-dim)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {inboxes.map((ib) => {
            const pct = ib.cap ? Math.min(100, Math.round((ib.sentToday / ib.cap) * 100)) : 0;
            return (
              <div key={ib.email} style={{ ...card, padding: '18px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 700, fontSize: 15, flexShrink: 0 }}>
                      {(ib.displayName || ib.email)[0].toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ib.email}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--fg-dim)' }}>{ib.displayName}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: ib.enabled ? '#15803d' : 'var(--fg-dim)' }}>
                      {ib.enabled ? `On · ${ib.cap}/day` : 'Off'}
                    </span>
                    <Toggle on={ib.enabled} busy={busy === ib.email} onClick={() => toggle(ib)} />
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>
                    <span>Sent today</span>
                    <span>{ib.sentToday} / {ib.cap}</span>
                  </div>
                  <div style={{ height: 7, borderRadius: 999, background: 'rgba(16,24,40,0.06)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: pct + '%', borderRadius: 999, background: ib.enabled ? '#16a34a' : 'var(--border-strong)', transition: 'width .3s' }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ ...card, padding: '18px 20px', marginTop: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>How the switch works</div>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--fg-muted)', fontSize: 13.5, lineHeight: 1.9 }}>
          <li>Off by default — the system sends nothing until you switch an inbox on.</li>
          <li>Switched on, that inbox sends up to {cap} emails/day, spaced with random gaps between 9 AM and 8 PM.</li>
          <li>Turn it back off any time and it stops sending immediately.</li>
          <li>Warmup itself keeps running in AutoMailer regardless of these switches.</li>
        </ul>
      </div>
    </div>
  );
}
