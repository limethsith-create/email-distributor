'use client';

/**
 * /mc/clients/{id}/purchase — the owner's purchase page (SPEC §6.5, Intake v2):
 * the shopping list from Price Scout — 5–8 available domains with every
 * registrar's price and the cheapest one ("Use this" fills the form), the
 * five registrars compared, and the CheapInboxes checklist with the sender
 * names filled in — then one form to paste the domain, confirm auto-renew is
 * off, and paste each inbox's email, app password and display name.
 * Submitting runs the Setup Checker; its 11 checks show below and refresh
 * while it works.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { box, btn, btnGhost, input, api, Eyebrow, Dot } from '@/app/mc/_ui/ui';

const COLORS = { pass: 'var(--success)', fail: 'var(--danger)', warn: 'var(--warning)', pending: 'var(--fg-dim)' };
const money = (n) => (n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '—');
const cell = { padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left', verticalAlign: 'top', fontSize: 13 };

export default function Purchase({ params }) {
  const id = params.id;
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({ domain: '', registrar: '', price: '', autoRenewOff: false, inboxes: [{ email: '', password: '', displayName: '' }, { email: '', password: '', displayName: '' }] });
  const [busy, setBusy] = useState(false);

  const load = () => api(`/api/mc/clients/${id}/purchase`).then((d) => {
    setData(d);
    const top = d.shopping.offers?.[0] || null;
    setForm((f) => (f.domain ? f : {
      ...f,
      domain: d.shopping.domain?.name || d.shopping.autoBought?.name || d.shopping.chosenDomain || '',
      registrar: top?.best?.registrar || d.shopping.registrarQuotes?.[0]?.name || d.shopping.registrarQuotes?.[0]?.registrar || '',
      price: top?.best?.firstYear ?? d.shopping.registrarQuotes?.[0]?.price ?? '',
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

  /** "Use this": the domain, its cheapest registrar and price go into the form; the inbox addresses follow the domain. */
  function pickOffer(o) {
    setForm((f) => ({
      ...f,
      domain: o.domain,
      registrar: o.best?.registrar || '',
      price: o.best?.firstYear ?? '',
      inboxes: f.inboxes.map((b) => ({ ...b, email: b.email && b.email.includes('@') ? `${b.email.split('@')[0]}@${o.domain}` : b.email })),
    }));
    setMsg(`${o.domain} is in the form below — buy it${o.best ? ` at ${o.best.registrar}` : ''}, then paste the inboxes.`);
  }

  if (!data) return <p>{msg || 'Loading…'}</p>;
  const s = data.shopping;
  const offers = s.offers || [];
  const registrarNames = offers[0] ? offers[0].prices.map((p) => p.registrar) : [];
  const inboxes = s.inboxes || null;
  const setInbox = (i, k) => (e) => setForm((f) => { const list = f.inboxes.map((x) => ({ ...x })); list[i][k] = e.target.value; return { ...f, inboxes: list }; });

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 1000 }}>
      <div>
        <Eyebrow><Link href={`/mc/clients/${id}`}>← {data.client.name || id}</Link></Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Buy and paste</h1>
        <p className="mono" style={{ fontSize: 12 }}>{data.client.state} · main domain {data.client.mainDomain}</p>
      </div>

      <div style={{ ...box, display: 'grid', gap: 8 }}>
        <Eyebrow>Shopping list {s.sentAt ? `· sent ${new Date(s.sentAt).toLocaleString()}` : '· not built yet'}</Eyebrow>
        {s.autoBought && <p style={{ margin: 0 }}><strong>{s.autoBought.name}</strong> was bought automatically ({money(s.autoBought.price)}), auto-renew off. Only the inboxes are left.</p>}
        {s.totals && (
          <p style={{ margin: 0 }}>
            Domain first year {money(s.totals.domainFirstYear)} + inboxes {money(s.totals.inboxesMonthly)}/month = <strong>{money(s.totals.firstMonth)}</strong> for the first month.
          </p>
        )}
        {!offers.length && (
          <>
            <p style={{ margin: 0 }}>Domain: <strong>{s.chosenDomain || '—'}</strong>{s.backups?.length ? ` · backups: ${s.backups.join(', ')}` : ''}</p>
            <p style={{ margin: 0 }}>Registrars (first year): {(s.registrarQuotes || []).map((q) => `${q.name} ${money(q.price)}${q.unconfirmed ? ' (unconfirmed)' : ''}`).join(' · ') || '—'}</p>
            <p style={{ margin: 0 }}>Inboxes: {(s.inboxQuotes || []).map((q) => `${q.name} ${money(q.pricePerMonth)}/month`).join(' · ') || '—'}</p>
            <p style={{ margin: 0 }}>Sender addresses: {(s.senderAddresses || []).join(', ') || '—'} · Total: {money(s.total)}</p>
          </>
        )}
        {s.unconfirmed?.length > 0 && <p style={{ margin: 0, color: 'var(--warning)' }}>Unconfirmed: {s.unconfirmed.join('; ')}</p>}
      </div>

      {offers.length > 0 && (
        <div style={{ ...box, display: 'grid', gap: 8, overflowX: 'auto' }}>
          <Eyebrow>Best domains · first year / renewal at each registrar · cheapest in bold</Eyebrow>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={cell}>Domain</th>
                <th style={cell}>Best price</th>
                {registrarNames.map((n) => <th key={n} style={cell}>{n}</th>)}
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.domain}>
                  <td style={cell}>
                    <strong className="mono">{o.domain}</strong>
                    <div style={{ fontSize: 11, opacity: 0.75 }}>{o.score} · {o.why}{o.available === null ? ' · availability unconfirmed' : ''}</div>
                  </td>
                  <td style={cell}>
                    {o.best ? <a href={o.best.url || '#'} target="_blank" rel="noreferrer"><strong>{o.best.registrar} {money(o.best.firstYear)}</strong></a> : '—'}
                    {o.best?.renewal != null && <div style={{ fontSize: 11, opacity: 0.75 }}>renews {money(o.best.renewal)}</div>}
                  </td>
                  {o.prices.map((p) => (
                    <td key={p.registrar} style={{ ...cell, fontWeight: o.best?.registrar === p.registrar ? 700 : 400 }}>
                      <a href={p.url} target="_blank" rel="noreferrer">{money(p.firstYear)}</a> / {money(p.renewal)}
                      <div style={{ fontSize: 11, opacity: 0.75 }}>{p.source === 'live' ? 'live' : 'table'}{p.promo ? ` · code ${p.promo.code} ${money(p.promo.firstYear)}` : ''}</div>
                    </td>
                  ))}
                  <td style={cell}><button type="button" style={btnGhost} onClick={() => pickOffer(o)}>Use this</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.registrars?.length > 0 && (
            <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <Eyebrow>The five registrars (cheapest .com first)</Eyebrow>
              {s.registrars.map((r) => <div key={r.name}><a href={r.url} target="_blank" rel="noreferrer"><strong>{r.name}</strong></a> — {r.why}</div>)}
              <div style={{ opacity: 0.75 }}>Promo codes are shown but never counted in the best price. Turn auto-renew OFF right after buying.</div>
            </div>
          )}
        </div>
      )}

      {inboxes && (
        <div style={{ ...box, display: 'grid', gap: 8 }}>
          <Eyebrow>Inboxes · <a href={inboxes.url} target="_blank" rel="noreferrer">{inboxes.provider}</a> · {inboxes.count} × {money(inboxes.perInbox)} = {money(inboxes.monthly)} a month</Eyebrow>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4, fontSize: 14 }}>
            {(inboxes.steps || []).map((step, i) => <li key={i}>{step}</li>)}
          </ol>
          {inboxes.notes && <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>{inboxes.notes}</p>}
        </div>
      )}

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
