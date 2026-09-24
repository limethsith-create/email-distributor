'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/mc/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(body.error || 'Sign-in failed'); return; }
    const next = new URLSearchParams(window.location.search).get('next') || '/mc';
    window.location.href = next.startsWith('/') ? next : '/mc';
  }

  return (
    <div style={{ maxWidth: 360, margin: '12vh auto', padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 16 }}>Mission Control</h1>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <input type="password" autoFocus placeholder="Admin password" value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ padding: '10px 12px', border: '1.5px solid var(--fg, #111)', background: 'transparent', color: 'inherit' }} />
        <button disabled={busy || !password} style={{ padding: '10px 12px', background: 'var(--accent, #e11)', color: '#fff', fontWeight: 700, border: 0 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p style={{ color: 'var(--accent, #e11)' }}>{error}</p>}
      </form>
    </div>
  );
}
