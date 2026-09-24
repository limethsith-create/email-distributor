'use client';

import { useEffect, useState } from 'react';
import { card, button, field, call } from '../../_stagec/ui';

export default function CustomerHit({ params }) {
  const t = params.token;
  const [info, setInfo] = useState(null);
  const [email, setEmail] = useState('');
  const [list, setList] = useState('');
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call(`/api/c/buttons?t=${encodeURIComponent(t)}`).then(setInfo).catch((e) => setError(e.message)); }, [t]);

  async function submit() {
    setBusy(true); setError(null);
    try { setDone(await call('/api/c/customer', { t, email, list })); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  if (error && !info) return <div style={card}><p>{error}</p></div>;
  if (!info) return <div style={card}><p>Loading…</p></div>;
  if (done) return <div style={card}><h2 style={{ marginTop: 0 }}>Sorry about that — handled.</h2><p>{done.apologySent ? 'They have had a short apology from the trial inbox. ' : ''}They will never be emailed again, and {done.blocklisted} address/domain entr{done.blocklisted === 1 ? 'y was' : 'ies were'} added to your do-not-contact list.</p></div>;
  return (
    <div style={card}>
      <h2 style={{ marginTop: 0 }}>You emailed my customer</h2>
      <p>Tell us who it was. We send them a one-line apology, block them for good and check how they got onto the list.</p>
      <label>Their email address</label>
      <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
      <label>Any other customers we should never contact (optional — paste emails or websites)</label>
      <textarea style={{ ...field, minHeight: 90 }} value={list} onChange={(e) => setList(e.target.value)} />
      <button style={button} disabled={busy || !email.includes('@')} onClick={submit}>{busy ? 'Saving…' : 'Block and apologise'}</button>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </div>
  );
}
