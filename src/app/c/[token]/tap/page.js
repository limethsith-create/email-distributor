'use client';

import { useEffect, useState } from 'react';
import { card, button, ghost, field, call } from '../../_stagec/ui';

const LABELS = {
  showed: 'Showed',
  noshow: 'No-show',
  wrongfit: 'Wrong fit',
  dispute: 'Doesn’t count',
  client_noshow: 'I could not make it (my side)',
};

export default function TapPage({ params, searchParams }) {
  const t = params.token;
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [action, setAction] = useState(searchParams?.a && LABELS[searchParams.a] ? searchParams.a : null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { call(`/api/c/tap?t=${encodeURIComponent(t)}`).then(setInfo).catch((e) => setError(e.message)); }, [t]);

  async function submit() {
    setBusy(true); setError(null);
    try { await call('/api/c/tap', { t, action, reason: reason || null, note: note || null }); setDone(action); } catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (error && !info) return <div style={card}><p>{error}</p></div>;
  if (!info) return <div style={card}><p>Loading…</p></div>;
  const b = info.booking;
  if (done) return <div style={card}><h2 style={{ marginTop: 0 }}>Thanks — recorded.</h2><p>{LABELS[done]} for the call with {b.name}{b.company ? ` at ${b.company}` : ''}.</p></div>;

  return (
    <div style={card}>
      <h2 style={{ marginTop: 0 }}>How did the call go?</h2>
      <p>{b.name}{b.company ? ` at ${b.company}` : ''}{b.when ? ` — ${b.when}` : ''}</p>
      {b.tapped && <p style={{ color: '#a15c00' }}>Already recorded as “{b.status}”. Tapping again changes it.</p>}
      <div>
        {['showed', 'noshow', 'wrongfit', 'dispute'].map((a) => (
          <button key={a} style={action === a ? button : ghost} onClick={() => setAction(a)}>{LABELS[a]}</button>
        ))}
      </div>
      <p style={{ fontSize: 13 }}><a href="#" onClick={(e) => { e.preventDefault(); setAction('client_noshow'); }}>{LABELS.client_noshow}</a></p>
      {action === 'dispute' && (
        <div>
          <label>Which of the four points did it fail? (required)</label>
          <select style={field} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose one…</option>
            {Object.entries(info.reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      )}
      {(action || b.manualMatch) && (
        <div>
          <label>{b.manualMatch ? 'Who was this call with? (we could not match the booking)' : 'Anything to add? (optional)'}</label>
          <textarea style={{ ...field, minHeight: 70 }} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {action && <button style={button} disabled={busy || (action === 'dispute' && !reason)} onClick={submit}>{busy ? 'Saving…' : `Confirm: ${LABELS[action]}`}</button>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </div>
  );
}
