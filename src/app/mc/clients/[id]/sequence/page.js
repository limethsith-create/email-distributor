'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow, ago } from '../../../_ui/ui';

const Tick = ({ ok }) => <span style={{ color: ok ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>{ok ? '✓' : '✗'}</span>;

export default function SequencePage({ params }) {
  const id = params.id;
  const url = `/api/mc/clients/${id}/sequence`;
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState({ A: '', B: '' });
  const [paste, setPaste] = useState('');

  const load = () => api(url).then((r) => {
    setD(r);
    setEdit({ A: r.sequence.variantA ? JSON.stringify(r.sequence.variantA, null, 2) : '', B: r.sequence.variantB ? JSON.stringify(r.sequence.variantB, null, 2) : '' });
  }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [id]);

  async function post(body, done) {
    setMsg('Working…');
    try { const r = await api(url, body); setMsg(done || JSON.stringify(r).slice(0, 300)); await load(); } catch (e) { setMsg(e.message); }
  }

  if (!d) return <p>{msg || 'Loading…'}</p>;
  const s = d.sequence;
  const a = d.approval;
  const g = d.gate?.checks;
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / {id} / Build</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>{d.client.name || id} — list, copy and approval</h1>
        <p className="mono" style={{ fontSize: 12 }}>state: {d.client.state} · niche: {s.niche || '—'} · version {s.version || '—'} · active: {s.active || '—'} · approved: {s.approvedAt ? `${ago(s.approvedAt)} (${s.approvalMode})` : 'no'}</p>
      </div>
      {msg && <div style={box}>{msg}</div>}

      {g && (
        <section style={box}>
          <Eyebrow>Day 1 gate</Eyebrow>
          <div style={{ display: 'grid', gap: 4, fontSize: 14 }}>
            <div><Tick ok={g.approval.ok} /> Copy approved {g.approval.mode ? `(${g.approval.mode})` : ''}</div>
            <div><Tick ok={g.list.ok} /> List: {g.list.unsent} unsent (start needs {g.list.startMin}, target {g.list.need}) · finder {g.list.status}</div>
            <div><Tick ok={g.inboxes.ok} /> Warm-up: {(g.inboxes.inboxes || []).map((i) => `${i.email} ${i.rate == null ? '—' : `${Math.round(i.rate * 100)}%`} streak ${i.streak}${i.ready ? ' ready' : ''}`).join(' · ') || g.inboxes.reason}</div>
            <div><Tick ok={g.canary.ok} /> Canary: {g.canary.day ? `${g.canary.day}, lowest inbox ${g.canary.min == null ? '—' : `${Math.round(g.canary.min * 100)}%`} (gate ${Math.round(g.canary.gate * 100)}%)` : 'no run yet (starts Day −3)'}</div>
          </div>
        </section>
      )}

      <section style={box}>
        <Eyebrow>Approval</Eyebrow>
        <p style={{ fontSize: 14 }}>Link sent: {a.sentAt ? ago(a.sentAt) : 'not yet'} · rounds used: {a.round || 0} · last client click: {a.lastClickAt ? ago(a.lastClickAt) : 'never'}</p>
        <p style={{ fontSize: 14 }}>Sections: {['profile', 'list', 'copy'].map((k) => `${k}: ${a.sections?.[k]?.status || 'pending'}`).join(' · ')}</p>
        {(a.changes || []).map((c, i) => <blockquote key={i} style={{ borderLeft: '3px solid var(--accent)', margin: '6px 0', padding: '4px 10px', fontSize: 14 }}><strong>{c.section}, round {c.round}:</strong> {c.text}</blockquote>)}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btnGhost} onClick={() => post({ action: 'sendLink' }, 'Approval link sent (or already sent)')}>Send approval link now</button>
          <button style={btn} onClick={() => post({ action: 'resend' }, 'Updated version re-sent to the client')}>Re-send to client after edits</button>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Copy — sample: {d.sampleLead ? `${d.sampleLead.first_name} at ${d.sampleLead.company}` : 'no lead yet'}</Eyebrow>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button style={btnGhost} onClick={() => post({ action: 'rebuild' }, 'Built (an approved sequence is kept)')}>Build copy</button>
          <button style={btnGhost} onClick={() => confirm('Rebuild from the template and discard edits?') && post({ action: 'rebuild', force: true }, 'Rebuilt from the template')}>Rebuild from template</button>
          {['both', 'A', 'B'].map((k) => <button key={k} style={s.active === k ? btn : btnGhost} onClick={() => post({ action: 'setActive', active: k })}>Send {k}</button>)}
        </div>
        {['A', 'B'].map((k) => (
          <div key={k} style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <strong>Variant {k} {s[`variant${k}`]?.variantId ? `(${s[`variant${k}`].variantId}, first-line set ${s[`variant${k}`].firstLineSet})` : ''}</strong>
            {(d.checks[k] || []).map((c) => (
              <div key={c.touch} style={{ fontSize: 13, border: '1px solid var(--border)', padding: 8 }}>
                <div><Tick ok={c.ok} /> <strong>{c.touch}</strong> {c.subject ? `— ${c.subject}` : ''} {c.failures.map((f) => <span key={f.rule} style={{ color: 'var(--danger)' }}> · {f.rule}: {f.detail}</span>)}</div>
                {c.text && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: '6px 0 0' }}>{c.text}</pre>}
              </div>
            ))}
            <textarea rows={14} className="mono" style={{ ...input, fontSize: 12 }} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
            <div><button style={btn} disabled={!edit[k]} onClick={() => post({ action: 'save', which: k, json: edit[k] }, `Variant ${k} saved`)}>Save variant {k}</button></div>
          </div>
        ))}
        <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Slots the Sender fills per lead: {'{FirstName} {Company} {City} {FirstLine}'}. Everything else is already filled from the profile.</p>
      </section>

      <section style={box}>
        <Eyebrow>Lead Finder</Eyebrow>
        <p className="mono" style={{ fontSize: 12 }}>status: {d.leadfinder.status || 'not started'} · runs: {d.leadfinder.runs || 0} · received: {d.leadfinder.received || 0} · rejected batches: {d.leadfinder.rejected || 0} · widened: {d.leadfinder.widened === '1' ? 'yes' : 'no'} · last: {ago(d.leadfinder.dispatchedAt)}{d.leadfinder.lastDispatchError ? ` · error: ${d.leadfinder.lastDispatchError}` : ''}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['initial', 'refill', 'widen'].map((m) => <button key={m} style={btnGhost} onClick={() => post({ action: 'dispatch', mode: m }, `Lead Finder (${m}) dispatched`)}>Run {m}</button>)}
        </div>
        <p style={{ fontSize: 13 }}>{d.sanityRows.length} sanity rows stored for the approval page.</p>
      </section>

      <section style={box}>
        <Eyebrow>Blocklist ({d.blocklistSize} entries)</Eyebrow>
        <textarea rows={4} style={input} placeholder="Paste customers, competitors, partners — names, domains, emails or CSV" value={paste} onChange={(e) => setPaste(e.target.value)} />
        <div style={{ marginTop: 8 }}><button style={btn} disabled={!paste.trim()} onClick={async () => { await post({ action: 'blocklist', text: paste }, 'Added to the blocklist'); setPaste(''); }}>Add to blocklist</button></div>
      </section>
    </div>
  );
}
