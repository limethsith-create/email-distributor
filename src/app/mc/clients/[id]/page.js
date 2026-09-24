'use client';

import { useEffect, useState } from 'react';
import { box, btn, btnGhost, input, api, Eyebrow, ago, Dot } from '../../_ui/ui';

const LABELS = {
  senderName: 'Sender name (signs every email)',
  senderTitle: 'Sender title',
  senderPrefix: 'Sender address prefix',
  postalAddress: 'Postal address (legally required in every email footer)',
  calendarUrl: 'Calendar link for booked calls',
  defaultNiche: 'Default niche — fills "we book sales calls for {niche}"',
  defaultIcp: 'Default ICP — fills "a verified list of {ICP}"',
  sellsTo: 'What they sell and to whom',
  industry: 'Industry keywords',
  capacityPerWeek: 'Calls per week they can take',
  winCondition: 'Win condition',
};
const COLOUR = { green: 'var(--success)', yellow: 'var(--warning)', red: 'var(--danger)' };
const row = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 13 };
const dt = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');

function Kv({ obj }) {
  const entries = Object.entries(obj || {}).filter(([, v]) => v !== '' && v != null);
  if (!entries.length) return <p style={{ margin: 0, color: 'var(--fg-muted)' }}>Nothing recorded yet.</p>;
  return <div className="mono" style={{ fontSize: 12, display: 'grid', gap: 2 }}>{entries.map(([k, v]) => <div key={k}>{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>)}</div>;
}

export default function ClientPage({ params }) {
  const id = params.id;
  const [d, setD] = useState(null);
  const [form, setForm] = useState({});
  const [inbox, setInbox] = useState({ email: '', password: '', displayName: '', provider: 'google' });
  const [note, setNote] = useState({ text: '', dueDate: '' });
  const [minutes, setMinutes] = useState('');
  const [msg, setMsg] = useState('');
  const url = `/api/mc/clients/${id}`;

  const load = () => api(url).then((r) => { setD(r); setForm(r.profile || {}); }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [id]);

  async function post(body, done) {
    setMsg('Working…');
    try { const r = await api(url, body); setMsg(done || 'Saved'); await load(); return r; } catch (e) { setMsg(e.message); }
  }

  async function dispute(bookingId, decision) {
    // Stage C owns disputes (SPEC §8.5); this calls its Mission Control API.
    setMsg('Working…');
    try { await api(`/api/mc/clients/${id}/dispute`, { bookingId, decision }); setMsg(`Dispute ${decision}`); await load(); } catch (e) { setMsg(`Dispute API: ${e.message}`); }
  }

  if (!d) return <p>{msg || 'Loading…'}</p>;
  const t = d.trial || {};
  const inv = d.invoice;
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Mission Control / {id}</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}><Dot color={COLOUR[d.health.colour]} />{d.client.name || id}</h1>
        <p className="mono" style={{ fontSize: 12 }}>
          state: {d.client.state} · plan: {d.client.plan} · day {d.trialDay ?? '—'} · since {ago(d.client.createdAt)}{d.virtualNow ? ` · test clock ${dt(d.virtualNow)}` : ''}
        </p>
        {d.health.reasons.length > 0 && <p style={{ color: COLOUR[d.health.colour], margin: 0, fontSize: 13 }}>{d.health.reasons.join(' · ')}</p>}
      </div>
      {msg && <div style={box}>{msg}</div>}

      <section style={{ ...box, display: 'grid', gap: 10 }}>
        <Eyebrow>Actions</Eyebrow>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {d.client.state === 'retired' && !t.inboxesCancelledAt && <button style={btn} onClick={() => post({ action: 'inboxesCancelled' }, 'Inboxes marked cancelled — the daily reminder stops')}>Inboxes cancelled ✓</button>}
          {inv && inv.status !== 'paid' && inv.plan && <button style={btn} onClick={async () => { const r = await post({ action: 'markPaid' }, 'Marked paid'); if (r?.shopping) setMsg(`Paid. Plan-mode shopping list: ${JSON.stringify(r.shopping)}`); }}>Mark paid</button>}
          {d.client.legalHold && <button style={btn} onClick={() => confirm('Clear the legal hold and resume sending?') && post({ action: 'clearLegalHold' }, 'Legal hold cleared')}>Clear legal hold</button>}
          {!t.reviewCapturedAt && ['deciding', 'converted', 'not_now', 'retired'].includes(d.client.state) && <button style={btnGhost} onClick={() => post({ action: 'reviewCaptured' }, 'Review recorded')}>Review captured</button>}
          {['sending', 'paused'].includes(d.client.state) && <button style={btnGhost} onClick={() => post({ action: 'setState', to: d.client.state === 'paused' ? 'sending' : 'paused' }, 'State changed')}>{d.client.state === 'paused' ? 'Resume' : 'Pause'}</button>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...input, width: 120 }} placeholder="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <button style={btnGhost} onClick={() => post({ action: 'logTime', minutes }, 'Time logged').then(() => setMinutes(''))}>Log my time on this trial</button>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{t.ownerMinutes ? `${t.ownerMinutes} min so far` : 'nothing logged'}</span>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Numbers (stored counters)</Eyebrow>
        <Kv obj={d.counters} />
      </section>

      <section style={box}>
        <Eyebrow>Upcoming</Eyebrow>
        {d.upcoming.length === 0 && <p style={{ margin: 0 }}>Nothing dated ahead.</p>}
        {d.upcoming.map((u, i) => <div key={i} style={row}><span className="mono" style={{ minWidth: 150 }}>{u.date} {u.time}</span><span>{u.what}</span></div>)}
      </section>

      <section style={{ ...box, display: 'grid', gap: 8 }}>
        <Eyebrow>Promises</Eyebrow>
        {d.promises.length === 0 && <p style={{ margin: 0 }}>No promises.</p>}
        {d.promises.map((p) => (
          <div key={p.id} style={row}>
            <span className="mono" style={{ minWidth: 100, color: !p.doneAt && String(p.dueAt).slice(0, 10) < new Date().toISOString().slice(0, 10) ? 'var(--warning)' : 'inherit' }}>{String(p.dueAt || '').slice(0, 10)}</span>
            <span style={{ flex: 1, textDecoration: p.doneAt ? 'line-through' : 'none' }}>{p.text}</span>
            {!p.doneAt && <button style={btnGhost} onClick={() => post({ action: 'completePromise', promiseId: p.id }, 'Promise done')}>Done</button>}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input style={{ ...input, flex: 1, minWidth: 220 }} placeholder="Owner note (add a date to make it a promise)" value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
          <input style={{ ...input, width: 160 }} type="date" value={note.dueDate} onChange={(e) => setNote({ ...note, dueDate: e.target.value })} />
          <button style={btn} disabled={!note.text} onClick={() => post({ action: 'addNote', ...note }, note.dueDate ? 'Promise added' : 'Note added').then(() => setNote({ text: '', dueDate: '' }))}>Add</button>
        </div>
        {d.client.ownerNotes && <pre className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>{d.client.ownerNotes}</pre>}
      </section>

      <section style={box}>
        <Eyebrow>Bookings</Eyebrow>
        {d.bookings.length === 0 && <p style={{ margin: 0 }}>No bookings.</p>}
        {d.bookings.map((b) => (
          <div key={b.id} style={row}>
            <span className="mono" style={{ minWidth: 130 }}>{dt(b.scheduledAt)}</span>
            <span style={{ flex: 1 }}>{b.leadEmail || 'unmatched'}</span>
            <span>{b.status}{b.qualified ? ' · qualified' : ''} · {b.tapped ? 'tapped' : 'not tapped'}</span>
            {b.status === 'disputed' && <>
              <span style={{ color: 'var(--warning)' }}>{b.disputeReason}</span>
              <button style={btnGhost} onClick={() => dispute(b.id, 'uphold')}>Uphold</button>
              <button style={btnGhost} onClick={() => dispute(b.id, 'overturn')}>Overturn</button>
            </>}
          </div>
        ))}
      </section>

      <section style={{ ...box, display: 'grid', gap: 8 }}>
        <Eyebrow>Leads and replies</Eyebrow>
        <div className="mono" style={{ fontSize: 12 }}>leads: {Object.entries(d.leadsByStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}</div>
        <div className="mono" style={{ fontSize: 12 }}>replies: {Object.entries(d.repliesByKind).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}</div>
        {d.replies.slice(0, 15).map((r) => <div key={r.id} style={row}><span className="mono" style={{ minWidth: 130 }}>{dt(r.receivedAt)}</span><span style={{ minWidth: 90 }}>{r.kind}</span><span style={{ flex: 1 }}>{r.leadEmail}: {r.snippet}</span></div>)}
      </section>

      <section style={{ ...box, display: 'grid', gap: 8 }}>
        <Eyebrow>Reports rendered</Eyebrow>
        {d.reports.length === 0 && <p style={{ margin: 0 }}>None yet.</p>}
        {d.reports.map((r) => <div key={r.name} style={row}><span className="mono" style={{ minWidth: 160 }}>{r.name}</span><span>{r.renderedAt ? ago(r.renderedAt) : '—'}</span>{r.blockedReason && <span style={{ color: 'var(--danger)' }}>BLOCKED: {r.blockedReason}</span>}</div>)}
        {inv && <div style={row}><span className="mono" style={{ minWidth: 160 }}>invoice {inv.invoiceNo}</span><span>{inv.plan} · ${inv.amount} · {inv.status}{inv.paidAt ? ` · paid ${dt(inv.paidAt)}` : ''}{inv.blockedReason ? ` · ${inv.blockedReason}` : ''}</span></div>}
      </section>

      <section style={{ ...box, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div><Eyebrow>Trial</Eyebrow><Kv obj={t} /></div>
        <div><Eyebrow>Domain + DNS</Eyebrow><Kv obj={d.domain} /></div>
        <div><Eyebrow>Sequence</Eyebrow><Kv obj={d.sequence} /></div>
      </section>

      <section style={box}>
        <Eyebrow>Profile</Eyebrow>
        <div style={{ display: 'grid', gap: 10 }}>
          {d.profileFields.map((f) => (
            <label key={f} style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              {LABELS[f] || f}
              {f === 'postalAddress' || f === 'sellsTo' || f === 'winCondition'
                ? <textarea rows={2} style={input} value={form[f] || ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
                : <input style={input} value={form[f] || ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />}
            </label>
          ))}
          <button style={btn} onClick={() => post({ action: 'profile', fields: form })}>Save profile</button>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Inboxes</Eyebrow>
        {d.inboxes.length === 0 && <p>No inboxes stored in the database yet.</p>}
        {d.inboxes.map((i) => (
          <div key={i.email} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <strong style={{ flex: 1, minWidth: 220 }}>{i.email}</strong>
            <span className="mono" style={{ fontSize: 12 }}>{i.provider} · {i.hasPassword ? 'password stored' : 'NO password'} · cap {i.dailyCap ?? '—'} · inbox rate {i.inboxRate7d ?? '—'} · health {i.health ?? '—'}</span>
            <button style={i.enabled === '1' ? btn : btnGhost} onClick={() => post({ action: 'inboxEnabled', email: i.email, enabled: i.enabled !== '1' })}>{i.enabled === '1' ? 'ON' : 'OFF'}</button>
            <button style={btnGhost} onClick={() => confirm(`Remove ${i.email}?`) && post({ action: 'removeInbox', email: i.email })}>Remove</button>
          </div>
        ))}
        {!d.encKey && <p style={{ color: 'var(--warning)' }}>ENC_KEY is not set in Vercel, so new inbox passwords can’t be saved yet.</p>}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: 12 }}>
          <input style={input} placeholder="inbox email" value={inbox.email} onChange={(e) => setInbox({ ...inbox, email: e.target.value })} />
          <input style={input} placeholder="app password" type="password" value={inbox.password} onChange={(e) => setInbox({ ...inbox, password: e.target.value })} />
          <input style={input} placeholder="display name" value={inbox.displayName} onChange={(e) => setInbox({ ...inbox, displayName: e.target.value })} />
          <select style={input} value={inbox.provider} onChange={(e) => setInbox({ ...inbox, provider: e.target.value })}>
            {['google', 'outlook', 'yahoo', 'zoho', 'namecheap'].map((p) => <option key={p}>{p}</option>)}
          </select>
          <button style={btn} disabled={!inbox.email || !inbox.password} onClick={async () => { await post({ action: 'addInbox', ...inbox }, 'Inbox saved (switched OFF)'); setInbox({ email: '', password: '', displayName: '', provider: 'google' }); }}>Add inbox</button>
        </div>
      </section>

      <section style={box}>
        <Eyebrow>Jobs — force one now</Eyebrow>
        {Object.entries(d.jobs).map(([name, last]) => (
          <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', flexWrap: 'wrap' }}>
            <span className="mono" style={{ minWidth: 130 }}>{name}</span>
            <span style={{ flex: 1, fontSize: 13, color: last && !last.ok ? 'var(--danger)' : 'var(--fg-muted)' }}>
              {last ? `${last.ok ? 'ok' : `failed: ${last.error}`} · ${ago(last.at)} · ${last.ms} ms` : 'not run yet'}
            </span>
            <button style={btnGhost} onClick={() => post({ action: 'runJob', job: name }, `Ran ${name}`)}>Run now</button>
          </div>
        ))}
      </section>

      <section style={box}>
        <Eyebrow>Timeline</Eyebrow>
        {d.events.length === 0 && <p>No events yet.</p>}
        {d.events.map((e, i) => (
          <div key={i} className="mono" style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)', fontWeight: e.system === 'state' ? 700 : 400 }}>
            {dt(e.at)} · {e.system} · {e.event} {e.detail ? JSON.stringify(e.detail) : ''}
          </div>
        ))}
      </section>
    </div>
  );
}
