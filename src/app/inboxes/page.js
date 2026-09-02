'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };

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

// Which campaign this inbox sends — two segmented buttons.
const CAMPAIGN_LABELS = {
  'free-leads': { name: 'Free Leads', short: '00 · FREE LEADS', color: '#0a7a3d' },
  'offer': { name: 'Guaranteed Calls', short: '01 · GUARANTEED CALLS', color: '#e0290f' },
};

function CampaignPicker({ value, busy, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {['free-leads', 'offer'].map((c) => {
        const on = value === c;
        const meta = CAMPAIGN_LABELS[c];
        return (
          <button key={c} disabled={busy} onClick={() => !on && onChange(c)}
            className="mono"
            style={{
              fontFamily: 'inherit', cursor: busy || on ? 'default' : 'pointer',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              padding: '7px 12px', borderRadius: 2,
              border: '1px solid ' + (on ? meta.color : 'var(--border-strong)'),
              background: on ? meta.color : 'transparent',
              color: on ? '#fff' : 'var(--fg-muted)',
              opacity: busy ? 0.6 : 1, transition: 'all .15s',
            }}>
            {meta.name}
          </button>
        );
      })}
    </div>
  );
}

// Stepper for the per-inbox daily send limit.
function CapStepper({ value, max, busy, onChange }) {
  const step = (delta) => onChange(Math.max(0, Math.min(max, value + delta)));
  const btn = {
    width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border-strong)',
    background: 'var(--card-hover)', color: 'var(--fg)', fontSize: 17, fontWeight: 600,
    cursor: busy ? 'default' : 'pointer', lineHeight: 1, opacity: busy ? 0.5 : 1,
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button style={btn} disabled={busy || value <= 0} onClick={() => step(-1)}>−</button>
      <div style={{ minWidth: 58, textAlign: 'center', fontSize: 14, fontWeight: 600 }}>
        {value}<span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}> /{max}</span>
      </div>
      <button style={btn} disabled={busy || value >= max} onClick={() => step(1)}>+</button>
    </div>
  );
}

export default function InboxesPage() {
  const [inboxes, setInboxes] = useState(null);
  const [maxCap, setMaxCap] = useState(25);
  const [busy, setBusy] = useState('');

  const load = () => fetch('/api/inboxes-control', { cache: 'no-store' }).then((r) => r.json())
    .then((d) => { setInboxes(d.inboxes || []); if (d.maxCap) setMaxCap(d.maxCap); })
    .catch(() => setInboxes([]));

  useEffect(() => { load(); }, []);

  const toggle = async (ib) => {
    const next = !ib.enabled;
    setBusy(ib.email);
    setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, enabled: next } : x));
    try {
      await fetch('/api/inboxes-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ib.email, enabled: next }) });
    } catch {
      setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, enabled: !next } : x));
    }
    setBusy('');
  };

  const setCap = async (ib, cap) => {
    setBusy(ib.email + ':cap');
    const prev = ib.cap;
    setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, cap } : x));
    try {
      await fetch('/api/inboxes-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ib.email, cap }) });
    } catch {
      setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, cap: prev } : x));
    }
    setBusy('');
  };

  const setCampaign = async (ib, campaign) => {
    setBusy(ib.email + ':campaign');
    const prev = ib.campaign;
    setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, campaign } : x));
    try {
      await fetch('/api/inboxes-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ib.email, campaign }) });
    } catch {
      setInboxes((arr) => arr.map((x) => x.email === ib.email ? { ...x, campaign: prev } : x));
    }
    setBusy('');
  };

  const anyOn = (inboxes || []).some((i) => i.enabled);

  return (
    <div className="fade-up" style={{ maxWidth: 1080 }}>
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Inboxes</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        Each inbox has a physical switch and a daily send limit. Off means it never sends. Turn it on and it sends up to its
        daily limit — dial the limit down to ramp volume gradually, then raise it as your inboxes prove out.
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
            const capBusy = busy === ib.email + ':cap';
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
                    <span className="mono" style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: (CAMPAIGN_LABELS[ib.campaign] || CAMPAIGN_LABELS.offer).color,
                      border: '1px solid ' + (CAMPAIGN_LABELS[ib.campaign] || CAMPAIGN_LABELS.offer).color,
                      padding: '4px 9px',
                    }}>
                      {(CAMPAIGN_LABELS[ib.campaign] || CAMPAIGN_LABELS.offer).short}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: ib.enabled ? '#15803d' : 'var(--fg-dim)' }}>
                      {ib.enabled ? `On · ${ib.cap}/day` : 'Off'}
                    </span>
                    <Toggle on={ib.enabled} busy={busy === ib.email} onClick={() => toggle(ib)} />
                  </div>
                </div>

                {/* campaign assignment */}
                <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
                  padding: '12px 14px', borderRadius: 12, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Campaign</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                      This inbox only sends {(CAMPAIGN_LABELS[ib.campaign] || CAMPAIGN_LABELS.offer).name} emails.
                    </div>
                  </div>
                  <CampaignPicker value={ib.campaign || 'offer'} busy={busy === ib.email + ':campaign'} onChange={(c) => setCampaign(ib, c)} />
                </div>

                {/* daily limit control */}
                <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
                  padding: '12px 14px', borderRadius: 12, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Daily send limit</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>Emails this inbox may send per day (max {ib.maxCap || maxCap}).</div>
                  </div>
                  <CapStepper value={ib.cap} max={ib.maxCap || maxCap} busy={capBusy} onChange={(v) => setCap(ib, v)} />
                </div>

                <div style={{ marginTop: 14 }}>
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
          <li>Each inbox is assigned to exactly one campaign — it only sends that campaign&rsquo;s emails, so Free Leads and Guaranteed Calls never mix in one inbox.</li>
          <li>Switched on, that inbox sends up to its daily limit, spaced with random gaps between 9 AM and 8 PM.</li>
          <li>Ramp gradually: start the limit low (e.g. 8), raise it every few days as deliverability holds.</li>
          <li>Turn it back off any time and it stops sending immediately.</li>
          <li>Warmup itself keeps running in AutoMailer regardless of these switches.</li>
        </ul>
      </div>
    </div>
  );
}
