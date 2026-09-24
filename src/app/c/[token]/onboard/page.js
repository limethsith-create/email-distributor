'use client';

/**
 * /c/{token}/onboard — the client's one onboarding page (SPEC §6.2):
 * Form A + the targeting profile (save-and-resume), then the click-to-accept
 * agreement as the last step. All reads and writes go through
 * /api/c/onboard with the token; nothing here needs an admin session.
 */

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, Eyebrow } from '@/app/mc/_ui/ui';

async function call(token, body) {
  const res = await fetch('/api/c/onboard', { method: 'POST', headers: { 'content-type': 'application/json', 'x-page-token': token }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, ...j };
}

function toText(v) { return Array.isArray(v) ? v.join('\n') : v || ''; }

function Field({ f, value, onChange, error }) {
  let control;
  if (f.type === 'dream') {
    const rows = [0, 1, 2].map((i) => (Array.isArray(value) && value[i]) || { name: '', website: '' });
    control = (
      <div style={{ display: 'grid', gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <input style={input} placeholder={`Company ${i + 1}`} value={r.name} onChange={(e) => { const n = rows.map((x) => ({ ...x })); n[i].name = e.target.value; onChange(n); }} />
            <input style={input} placeholder="website.com" value={r.website} onChange={(e) => { const n = rows.map((x) => ({ ...x })); n[i].website = e.target.value; onChange(n); }} />
          </div>
        ))}
      </div>
    );
  } else if (f.type === 'list' || f.type === 'long') {
    control = <textarea style={{ ...input, minHeight: f.type === 'list' ? 90 : 70 }} value={toText(value)} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = <input style={input} type={f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'} inputMode={f.type === 'int' ? 'numeric' : undefined} value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ fontWeight: 600 }}>{f.label}{f.required ? '' : ' (optional)'}</label>
      {control}
      {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
    </div>
  );
}

export default function Onboard({ params }) {
  const token = params.token;
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [errors, setErrors] = useState({});
  const [msg, setMsg] = useState('');
  const [sign, setSign] = useState({ name: '', title: '', agree: false });
  const [busy, setBusy] = useState(false);

  function absorb(j) {
    setData(j);
    if (j.profile) setValues(j.profile);
  }

  useEffect(() => {
    call(token, { action: 'load' }).then((j) => (j.ok ? absorb(j) : setMsg(j.error || 'This link is not valid.')));
  }, [token]);

  async function save() {
    setBusy(true); setMsg('Saving…');
    const fields = {};
    for (const k of Object.keys(dirty)) fields[k] = values[k];
    const j = await call(token, { action: 'save', fields });
    setBusy(false);
    if (!j.ok) { setMsg(j.error || 'Could not save.'); return; }
    setErrors(j.errors || {});
    const kept = {};
    for (const k of Object.keys(j.errors || {})) kept[k] = true;
    setDirty(kept);
    setData(j);
    setMsg(Object.keys(j.errors || {}).length ? 'Saved — some answers need a fix (marked in red).' : 'Saved. You can close this page and come back any time.');
  }

  async function accept() {
    setBusy(true); setMsg('Signing…');
    const j = await call(token, { action: 'accept', ...sign });
    setBusy(false);
    if (!j.ok) { setMsg(j.error || 'Could not sign.'); return; }
    absorb(j);
    setMsg('Signed — thank you. A copy is on its way to your inbox.');
  }

  if (!data) return <p>{msg || 'Loading…'}</p>;
  if (data.error) return <p>{data.error}</p>;
  const closed = data.state !== 'onboarding';
  const accepted = Boolean(data.accepted);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Aviance 30-Day Trial</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>{data.company.name} — one page</h1>
        <p style={{ color: 'var(--fg-muted)' }}>Main domain: <span className="mono">{data.company.mainDomain}</span>. Everything I'll ever ask you for is on this page. It saves as you go — press Save at any time and come back later.</p>
      </div>

      {accepted ? (
        <div style={box}>
          <p style={{ marginTop: 0 }}><strong>Signed</strong> by {data.accepted.name} on {new Date(data.accepted.at).toUTCString()}.</p>
          <p style={{ marginBottom: 0 }}>{data.market?.status === 'passed' || data.state === 'awaiting_purchase' ? 'Your market count passed — setup has started. Watch your inbox for the two dates.' : data.state === 'declined' ? 'We emailed you the result of the market count.' : 'We are counting the companies that match your profile now. You will hear from us by email.'}</p>
        </div>
      ) : closed ? (
        <div style={box}>This page is closed. Reply to our last email if you need anything.</div>
      ) : (
        <>
          <div style={{ ...box, display: 'grid', gap: 16 }}>
            {data.fields.map((f) => (
              <Field key={f.key} f={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => { setValues((s) => ({ ...s, [f.key]: v })); setDirty((d) => ({ ...d, [f.key]: true })); }} />
            ))}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button style={btn} onClick={save} disabled={busy}>Save</button>
              <span style={{ fontSize: 13 }}>{msg}</span>
            </div>
          </div>

          <div style={{ ...box, display: 'grid', gap: 12 }}>
            <Eyebrow>Last step — the agreement</Eyebrow>
            {data.missing?.length > 0 && <p style={{ margin: 0, color: 'var(--warning)' }}>Still to fill in before you can sign: {data.missing.map((k) => (data.fields.find((f) => f.key === k)?.label || k)).join('; ')}.</p>}
            {data.agreement?.blocked ? (
              <p>{data.agreement.blocked}</p>
            ) : (
              <>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.55, maxHeight: 480, overflow: 'auto', border: '1px solid var(--border)', padding: 12 }}>{data.agreement?.text}</pre>
                <input style={input} placeholder="Your full name" value={sign.name} onChange={(e) => setSign((s) => ({ ...s, name: e.target.value }))} />
                <input style={input} placeholder="Your title" value={sign.title} onChange={(e) => setSign((s) => ({ ...s, title: e.target.value }))} />
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={sign.agree} onChange={(e) => setSign((s) => ({ ...s, agree: e.target.checked }))} /> I agree to the agreement above on behalf of {data.company.name}.</label>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <button style={btn} onClick={accept} disabled={busy || data.missing?.length > 0 || Object.keys(dirty).length > 0}>Sign and submit</button>
                  {Object.keys(dirty).length > 0 && <button style={btnGhost} onClick={save} disabled={busy}>Save your changes first</button>}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {accepted && msg && <div style={box}>{msg}</div>}
    </div>
  );
}
