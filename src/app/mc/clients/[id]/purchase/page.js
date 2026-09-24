'use client';

/**
 * /mc/clients/{id}/purchase — the owner's purchase page (SPEC §6.5):
 * the shopping list from Price Scout, then one form to paste the domain,
 * confirm auto-renew is off, and paste each inbox's email, app password and
 * display name. Submitting runs the Setup Checker; its 11 checks show below
 * and refresh while it works.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { box, btn, btnGhost, input, api, Eyebrow, Dot } from '@/app/mc/_ui/ui';

const COLORS = { pass: 'var(--success)', fail: 'var(--danger)', warn: 'var(--warning)', pending: 'var(--fg-dim)' };
const money = (n) => (Number.isFinite(Number(n)) && n !== '' ? `$${Number(n).toFixed(2)}` : '—');

export default function Purchase({ params }) {
  const id = params.id;
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({ domain: '', registrar: '', price: '', autoRenewOff: false, inboxes: [{ email: '', password: '', displayName: '' }, { email: '', password: '', displayName: '' }] });
  const [busy, setBusy] = useState(false);

  const load = () => api(`/api/mc/clients/${id}/purchase`).then((d) => {
    setData(d);
    setForm((f) => (f.domain ? f : {
      ...f,
      domain: d.shopping.domain?.name || d.shopping.autoBought?.name || d.shopping.chosenDomain || '',
      registrar: d.shopping.registrarQuotes?.[0]?.registrar || '',
      price: d.shopping.registrarQuotes?.[0]?.price ?? '',
      inboxes: f.inboxes.map((b, i) => ({ ...b, email: b.email || d.shopping.senderAddresses?.[i] || '', displayName: b.displayName || d.setup.senderName || '' })),
    }));
  }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [id]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg('Saving and checking — this takes up to 20 seconds…'); setErrors({});
    const res = await fetch(`/api/mc/clients/${id}/purchase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErrors(j.errors || {}); setMsg(j.errors?._form || j.error || 'Please fix the fields in red.'); return; }
    setForm((f) => ({ ...f, inboxes: f.inboxes.map((b) => ({ ...b, password: '' })) }));
    setMsg(j.setup?.phase === 'passed' ? 'All checks passed — the client is warming.' : j.setup?.phase === 'failed' ? 'Some checks failed — see below; the fix is in your alert too.' : 'Saved. Checks are still running (the loopback takes a few minutes).');
    load();
  }

  async function rerun() {
    setMsg('Re-running…');
    try { await api(`/api/mc/clients/${id}/intake`, { action: 'rerunSetup' }); load(); setMsg('Re-run started.'); } catch (e) { setMsg(e.message); }
  }

  if (!data) return <p>{msg || 'Loading…'}</p>;
  const s = data.shopping;
  const setInbox = (i, k) => (e) => setForm((f) => { const inboxes = f.inboxes.map((x) => ({ ...x })); inboxes[i][k] = e.target.value; return { ...f, inboxes }; });

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 900 }}>
      <div>
        <Eyebrow><Link href={`/mc/clients/${id}`}>← {data.client.name || id}</Link></Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Buy and paste</h1>
        <p className="mono" style={{ fontSize: 12 }}>{data.client.state} · main domain {data.client.mainDomain}</p>
      </div>

      <div style={{ ...box, display: 'grid', gap: 8 }}>
        <Eyebrow>Shopping list {s.sentAt ? `· sent ${new Date(s.sentAt).toLocaleString()}` : '· not built yet'}</Eyebrow>
        {s.autoBought && <p style={{ margin: 0 }}><strong>{s.autoBought.name}</strong> was bought automatically ({money(s.autoBought.price)}), auto-renew off. Only the inboxes are left.</p>}
        <p style={{ margin: 0 }}>Domain: <strong>{s.chosenDomain || '—'}</strong>{s.backups?.length ? ` · backups: ${s.backups.join(', ')}` : ''}</p>
        <p style={{ margin: 0 }}>Registrars (first year): {(s.registrarQuotes || []).map((q) => `${q.name} ${money(q.price)}${q.unconfirmed ? ' (unconfirmed)' : ''}`).join(' · ') || '—'}</p>
        <p style={{ margin: 0 }}>Inboxes: {(s.inboxQuotes || []).map((q) => `${q.name} ${money(q.pricePerMonth)}/month`).join(' · ') || '—'}</p>
        <p style={{ margin: 0 }}>Sender addresses: {(s.senderAddresses || []).join(', ') || '—'} · Total: {money(s.total)}</p>
        {s.unconfirmed?.length > 0 && <p style={{ margin: 0, color: 'var(--warning)' }}>Unconfirmed: {s.unconfirmed.join('; ')}</p>}
      </div>

      <form onSubmit={submit} style={{ ...box, display: 'grid', gap: 12 }}>
        <Eyebrow>What you bought</Eyebrow>
        {!data.encKey && <p style={{ color: 'var(--danger)', margin: 0 }}>ENC_KEY is not set on the server; passwords cannot be saved yet.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
          <input style={input} placeholder="domain.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
          <input style={input} placeholder="registrar" value={form.registrar} onChange={(e) => setForm({ ...form, registrar: e.target.value })} />
          <input style={input} placeholder="price paid" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </div>
        {errors.domain && <span style={{ color: 'var(--danger)' }}>{errors.domain}</span>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.autoRenewOff} onChange={(e) => setForm({ ...form, autoRenewOff: e.target.checked })} /> Auto-renew is OFF at the registrar</label>
        {errors.autoRenewOff && <span style={{ color: 'var(--danger)' }}>{errors.autoRenewOff}</span>}
        {form.inboxes.map((b, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 1.4fr', gap: 8 }}>
            <input style={input} placeholder={`inbox ${i + 1} email`} value={b.email} onChange={setInbox(i, 'email')} />
            <input style={input} type="password" autoComplete="off" placeholder="app password (16 letters)" value={b.password} onChange={setInbox(i, 'password')} />
            <input style={input} placeholder="display name" value={b.displayName} onChange={setInbox(i, 'displayName')} />
            {errors[`inbox${i}`] && <span style={{ color: 'var(--danger)', gridColumn: '1 / -1' }}>{errors[`inbox${i}`]}</span>}
          </div>
        ))}
        {errors.inboxes && <span style={{ color: 'var(--danger)' }}>{errors.inboxes}</span>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button type="submit" style={btn} disabled={busy || !data.encKey || !['awaiting_purchase', 'setup_check'].includes(data.client.state)}>Save and run the checks</button>
          {data.client.state === 'setup_check' && <button type="button" style={btnGhost} onClick={rerun}>Re-run checks</button>}
          <span style={{ fontSize: 13 }}>{msg}</span>
        </div>
      </form>

      <div style={{ ...box, display: 'grid', gap: 6 }}>
        <Eyebrow>Setup checks {data.setup.domain.setupPhase ? `· ${data.setup.domain.setupPhase}` : ''}</Eyebrow>
        {Object.entries(data.setup.checks).map(([k, c]) => (
          <div key={k} style={{ fontSize: 14 }}>
            <Dot color={COLORS[c?.status] || 'var(--fg-dim)'} /><strong className="mono">{k}</strong> {c?.status || 'not run'} {c?.detail ? `— ${c.detail}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
