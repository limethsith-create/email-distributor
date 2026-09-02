'use client';

import { useState, useEffect, useCallback } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };
const ACCENT = '#e0290f';

const CAMPAIGN_META = {
  'free-leads': {
    idx: '00',
    name: 'Free Leads',
    tagline: 'The goodwill hook — 5 researched leads, free, on a one-word reply.',
    detail: 'Proves the targeting before any pitch. A prospect replies "SEND IT", receives 5 researched buyers in their market the same day, and the reply bot carries the conversation toward a booked call.',
  },
  'offer': {
    idx: '01',
    name: 'Guaranteed Calls',
    tagline: 'The direct pitch — booked sales calls, in writing.',
    detail: 'Live within 3 weeks or the next month is free. No-shows replaced, shortfalls roll over, no setup fee, month-to-month. Every touch carries the branded one-pager with full terms and founding rates.',
  },
};

function Stat({ label, value, accent }) {
  return (
    <div style={{ flex: 1, minWidth: 90 }}>
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: accent ? ACCENT : 'var(--fg)' }}>{value}</div>
      <div className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-dim)', marginTop: 6 }}>{label}</div>
    </div>
  );
}

function CampaignCard({ id, stats, preview, onAssign, busy }) {
  const meta = CAMPAIGN_META[id];
  const [showCopy, setShowCopy] = useState(false);
  const [count, setCount] = useState(25);
  const s = stats || { total: 0, queued: 0, contacted: 0, replied: 0 };

  return (
    <div style={{ ...card, padding: '22px 24px', flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div className="eyebrow"><span className="idx">{meta.idx}</span>&nbsp;&nbsp;CAMPAIGN</div>
          <span className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#0a7a3d', border: '1px solid #0a7a3d', padding: '4px 9px' }}>
            ● Active
          </span>
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', margin: '10px 0 4px' }}>{meta.name}</h2>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-muted)' }}>{meta.tagline}</div>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fg-muted)', margin: '10px 0 0' }}>{meta.detail}</p>
      </div>

      <div className="rule-soft" />

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Stat label="Leads" value={s.total} />
        <Stat label="Queued" value={s.queued} />
        <Stat label="Contacted" value={s.contacted} />
        <Stat label="Replied" value={s.replied} accent />
      </div>

      <div className="rule-soft" />

      <div>
        <button
          onClick={() => setShowCopy(!showCopy)}
          className="mono"
          style={{ fontFamily: 'inherit', cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--fg)', padding: '8px 14px', fontSize: 12 }}>
          {showCopy ? 'Hide day-0 email' : 'Preview day-0 email'}
        </button>
        {showCopy && preview && (
          <div style={{ marginTop: 12, border: '1px solid var(--border)', background: 'var(--bg-subtle)', padding: '14px 16px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>Subject: <span style={{ fontWeight: 400 }}>{preview.subject}</span></div>
            <div style={{ fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', color: 'var(--fg-muted)' }}>{preview.body}</div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="number" min={1} max={500} value={count}
          onChange={(e) => setCount(parseInt(e.target.value) || 1)}
          style={{ width: 70, fontFamily: 'inherit', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 2, fontSize: 13 }}
        />
        <button
          disabled={busy}
          onClick={() => onAssign(id, count)}
          style={{ fontFamily: 'inherit', cursor: 'pointer', border: `1px solid ${ACCENT}`, background: ACCENT, color: '#fff', padding: '8px 14px', fontSize: 13, borderRadius: 2 }}>
          {busy ? 'Assigning…' : 'Assign unsent leads'}
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>moves queued leads into this campaign</span>
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    fetch('/api/campaigns', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function assign(campaign, count) {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'assign', campaign, count }),
      });
      const d = await r.json();
      setMsg(d.success ? `Assigned ${d.assigned} lead${d.assigned === 1 ? '' : 's'} to ${CAMPAIGN_META[campaign].name}.` : (d.error || 'Could not assign.'));
      load();
    } catch {
      setMsg('Could not assign.');
    }
    setBusy(false);
    setTimeout(() => setMsg(''), 4000);
  }

  return (
    <div className="fade-up">
      <div className="eyebrow" style={{ marginBottom: 10 }}><span className="idx">05</span>&nbsp;/&nbsp;CAMPAIGNS</div>
      <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>Campaigns</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '14px 0 22px', maxWidth: 640 }}>
        Two campaigns send simultaneously from the same engine. Every lead belongs to one of them; the sender
        picks that campaign&rsquo;s copy and one-pager automatically, and replies from both land in the Replies tab.
      </p>

      <div className="rule" style={{ marginBottom: 22 }} />

      {msg && (
        <div className="mono" style={{ marginBottom: 16, fontSize: 12, color: ACCENT }}>{msg}</div>
      )}

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <CampaignCard id="free-leads" stats={data?.stats?.['free-leads']} preview={data?.previews?.['free-leads']} onAssign={assign} busy={busy} />
          <CampaignCard id="offer" stats={data?.stats?.['offer']} preview={data?.previews?.['offer']} onAssign={assign} busy={busy} />
        </div>
      )}
    </div>
  );
}
