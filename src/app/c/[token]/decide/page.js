'use client';

/**
 * Day 30 Decision page (SPEC §9.4): five numbers, one recommendation, the
 * month-one bonus with a live countdown, three buttons and the FAQ.
 */

import { useEffect, useState } from 'react';

const card = { border: '1px solid var(--border)', padding: 18, background: 'var(--card)' };
const btn = { padding: '12px 18px', border: '1.5px solid var(--fg)', background: 'var(--fg)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' };
const ghost = { ...btn, background: 'transparent', color: 'var(--fg)' };

function left(ms) {
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

export default function DecidePage({ params }) {
  const token = params.token;
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [tick, setTick] = useState(Date.now());

  const load = () => fetch(`/api/c/decide?token=${encodeURIComponent(token)}`).then((r) => r.json()).then((j) => (j.ok ? setD({ ...j, loadedAt: Date.now() }) : setErr(j.error || 'Not found'))).catch(() => setErr('Could not load the page.'));
  useEffect(() => { load(); const t = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(t); }, [token]);

  async function act(action) {
    if (action === 'notnow' && !confirm('Not now — are you sure? The trial domain retires on Day 45.')) return;
    setBusy(action);
    try {
      const r = await fetch('/api/c/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, action }) });
      const j = await r.json();
      if (!j.ok) setErr(j.error || 'That did not go through.');
      else { setResult(j); await load(); }
    } catch { setErr('That did not go through. Please try again.'); }
    setBusy('');
  }

  if (err && !d) return <p style={{ maxWidth: 640, margin: '40px auto' }}>{err}</p>;
  if (!d) return <p style={{ maxWidth: 640, margin: '40px auto' }}>Loading…</p>;

  // The server's clock is authoritative (Test Mode runs a scaled clock).
  const skew = Date.parse(d.now) - d.loadedAt;
  const remaining = d.bonus ? Date.parse(d.bonus.expiresAt) - (tick + skew) : 0;
  const rec = d.recommendation;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 20 }}>
      <div>
        <div className="eyebrow">Day 30</div>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: '6px 0 0' }}>{d.clientName} — your trial, in five numbers</h1>
      </div>

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {d.numbers.map((n) => (
          <div key={n.key} style={card}>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{n.value == null ? '—' : n.value.toLocaleString('en-US')}</div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{n.label}{n.value == null ? ' (not recorded)' : ''}</div>
          </div>
        ))}
      </div>

      <div style={card}>
        <div className="eyebrow">One recommendation</div>
        {rec ? (
          <>
            <h2 style={{ fontSize: 22, margin: '6px 0' }}>{rec.planName ? `${rec.planName} — ${rec.price} a month` : 'No plan yet'}</h2>
            <p style={{ lineHeight: 1.6 }}>{rec.text}</p>
          </>
        ) : <p>The numbers are still being finalised. Check back shortly.</p>}
      </div>

      {d.bonus && (
        <div style={{ ...card, borderColor: remaining > 0 ? 'var(--accent)' : 'var(--border)' }}>
          <div className="eyebrow">Month-one bonus</div>
          <p style={{ margin: '6px 0', fontSize: 16 }}><strong>{d.bonus.calls} calls for the price of {d.bonus.forCalls}</strong> if you start within 24 hours of the Day 30 email.</p>
          <p className="mono" style={{ margin: 0 }}>{remaining > 0 ? `Ends in ${left(remaining)}` : 'This window has closed. The plan itself is unchanged.'}</p>
        </div>
      )}

      {result && <div style={{ ...card, borderColor: 'var(--success)' }}>
        {result.outcome === 'converted' && <p>Done — welcome aboard. Your invoice is on its way by email.</p>}
        {result.outcome === 'talk' && <p>Thanks — we’ve emailed you times to talk{result.slots ? `: ${result.slots.slice(0, 3).join(' · ')}` : ''}.</p>}
        {result.outcome === 'not_now' && <p>Understood. Everything from the trial is yours; the domain retires on Day 45.</p>}
      </div>}
      {err && d && <div style={{ ...card, borderColor: 'var(--danger)' }}>{err}</div>}

      {d.open ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {rec?.plan && d.state !== 'converted' && <button style={btn} disabled={!!busy} onClick={() => act('start')}>{busy === 'start' ? 'Starting…' : `Start ${rec.planName}`}</button>}
          {d.state !== 'converted' && <button style={ghost} disabled={!!busy || d.decided === 'talk'} onClick={() => act('talk')}>{d.decided === 'talk' ? 'Talk requested' : 'Talk to someone'}</button>}
          {d.state === 'deciding' && <button style={ghost} disabled={!!busy} onClick={() => act('notnow')}>Not now</button>}
        </div>
      ) : d.state === 'converted' ? <p><strong>You’re on the plan.</strong> Thank you.</p>
        : <p>The decision opens on Day 30{d.opensOn ? ` (${d.opensOn})` : ''}. The numbers above are live until then.</p>}

      {d.faq.length > 0 && (
        <div style={card}>
          <div className="eyebrow">Questions people ask</div>
          {d.faq.map((f) => (
            <div key={f.q} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <strong>“{f.q}”</strong>
              <p style={{ margin: '4px 0 0', lineHeight: 1.5 }}>{f.a}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
