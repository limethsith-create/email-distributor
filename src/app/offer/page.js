'use client';

import { useState, useEffect } from 'react';

const BASE = `Hi {{name}},

Quick one. Most founders are great at the actual work — it's chasing new clients that quietly eats the week.

That's the part we take off your plate: we run cold email for {{company}} and book you sales calls on a plan that fits — 10, 20, even 50 a month. Inboxes, lists, copy, sending — all done for you. You just show up and close.

And it's fully guaranteed: if we don't hit your number, we refund every cent. No risk on your end at all.

Open to seeing how it'd work?

Best,
Limethsith`;

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };
const mono = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--fg)' };

export default function OfferPage() {
  const [leads, setLeads] = useState([]);
  const [sel, setSel] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/leads?action=list&limit=500&page=1').then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const arr = ((d && d.leads) || []).filter((l) => l.status === 'pending');
        setLeads(arr);
        if (arr[0]) setSel(arr[0].email);
      }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const run = async () => {
    const lead = leads.find((l) => l.email === sel);
    if (!lead) return;
    setBusy(true); setOut(null);
    try {
      const r = await fetch('/api/ai/personalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead }) });
      setOut(await r.json());
    } catch (e) { setOut({ error: String(e) }); }
    setBusy(false);
  };

  const engineBadge = (eng) => {
    const map = {
      gemini: { t: 'Gemini · personalized', bg: 'rgba(22,163,74,0.12)', fg: '#15803d' },
      fallback: { t: 'Fallback (key error)', bg: 'rgba(217,119,6,0.12)', fg: '#b45309' },
      base: { t: 'Base (no key yet)', bg: 'rgba(110,86,207,0.12)', fg: '#6e56cf' },
    };
    const m = map[eng] || map.base;
    return <span style={{ background: m.bg, color: m.fg, borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>{m.t}</span>;
  };

  return (
    <div className="fade-up" style={{ maxWidth: 1080 }}>
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Offer</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 20 }}>
        Your locked base offer, plus an AI agent that tailors it to each company before sending.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 18 }}>
        <div style={{ ...card, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Base offer</div>
            <span style={{ background: 'rgba(110,86,207,0.12)', color: '#6e56cf', borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>Locked</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 6 }}>Subject</div>
          <div style={{ ...mono, marginBottom: 14 }}>{'{{name}} — quick idea for {{company}}'}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 6 }}>Body</div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', ...mono }}>{BASE}</div>
        </div>

        <div style={{ ...card, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>AI agent</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 14 }}>
            Runs on Google Gemini — independent of Claude. Reads the company + industry and rewrites the opener and offer line to fit, keeping the guarantee.
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)}
              style={{ flex: 1, background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 11px', fontSize: 13 }}>
              {leads.length === 0 && <option value="">No fresh leads</option>}
              {leads.map((l) => <option key={l.email} value={l.email}>{(l.company_name || l.email)}</option>)}
            </select>
            <button onClick={run} disabled={busy || !sel}
              style={{ background: busy || !sel ? 'var(--border-strong)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13.5, fontWeight: 600, cursor: busy || !sel ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy ? 'Thinking…' : 'Personalize'}
            </button>
          </div>

          {!out ? (
            <div style={{ background: 'var(--bg)', border: '1px dashed var(--border-strong)', borderRadius: 10, padding: 24, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 13 }}>
              Pick a company and hit Personalize to preview what the agent would send.
            </div>
          ) : out.error ? (
            <div style={{ color: '#b45309', fontSize: 13 }}>Error: {out.error}</div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                {engineBadge(out.engine)}
                {out.note && <span style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>{out.note}</span>}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 6 }}>Subject</div>
              <div style={{ ...mono, marginBottom: 12 }}>{out.subject}</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 6 }}>Body</div>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', ...mono }}>{out.body}</div>
            </div>
          )}
        </div>
      </div>

      <div style={{ ...card, padding: '16px 20px', marginTop: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: '#d97706', flexShrink: 0 }} />
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          To switch the agent from the rule-based fallback to full Gemini AI, add a free <b>GEMINI_API_KEY</b> in your Vercel project settings. Until then it still personalizes by industry, just more simply.
        </div>
      </div>
    </div>
  );
}
