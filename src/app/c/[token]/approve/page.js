'use client';

/**
 * Client approval page (SPEC §7.6): profile summary, market estimate, the 20
 * sanity rows, both variants × 4 emails rendered for a sample lead with the
 * Copy Checker ticks, and Approve / Request a change per section.
 * The token stays in the path; API calls send it in the POST body.
 */

import { useEffect, useState } from 'react';

const box = { border: '1px solid var(--border)', padding: 20, borderRadius: 'var(--radius)', background: 'var(--card)' };
const btn = { padding: '10px 16px', border: '1.5px solid var(--fg)', background: 'var(--fg)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const ghost = { ...btn, background: 'transparent', color: 'var(--fg)' };

async function call(body) {
  const res = await fetch('/api/c/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Something went wrong (${res.status})`);
  return json;
}

function fmt(dayKey) {
  if (!dayKey) return '';
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const TOUCH_LABEL = { d0: 'Email 1 — first day', d3: 'Email 2 — 3 days later, same thread', d7: 'Email 3 — a week in, new thread', d10: 'Email 4 — last note, same thread' };

function Section({ id, title, state, changesLeft, onApprove, onChange, children }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const status = state?.status;
  return (
    <section style={{ ...box, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, flex: 1 }}>{title}</h2>
        {status === 'approved' && <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓ Approved</span>}
        {status === 'change' && <span style={{ color: 'var(--warning)', fontWeight: 700 }}>Change requested — we are on it</span>}
      </div>
      {children}
      {status !== 'approved' && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button style={btn} onClick={() => onApprove(id)}>Approve</button>
          {changesLeft > 0 && <button style={ghost} onClick={() => setOpen(!open)}>Request a change</button>}
        </div>
      )}
      {open && status !== 'approved' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should change?" style={{ padding: 10, border: '1px solid var(--border)', fontSize: 14, width: '100%' }} />
          <div><button style={btn} disabled={text.trim().length < 3} onClick={async () => { if (await onChange(id, text)) { setOpen(false); setText(''); } }}>Send the change request</button></div>
          <small style={{ color: 'var(--fg-muted)' }}>{changesLeft} round{changesLeft === 1 ? '' : 's'} of changes left.</small>
        </div>
      )}
    </section>
  );
}

function Email({ e }) {
  return (
    <div style={{ border: '1px solid var(--border)', padding: 14, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 700 }}>{TOUCH_LABEL[e.touch] || e.touch}</div>
      {e.subject && <div><strong>Subject:</strong> {e.subject}</div>}
      {e.text ? <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, fontSize: 14, lineHeight: 1.6 }}>{e.text}</pre> : <em>This email could not be shown yet — we are finishing it.</em>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12 }}>
        {(e.ticks || []).map((t) => (
          <li key={t.rule} title={t.detail || ''} style={{ color: t.ok ? 'var(--success)' : 'var(--danger)' }}>{t.ok ? '✓' : '✗'} {t.label}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ApprovePage({ params }) {
  const token = params.token;
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [variant, setVariant] = useState('A');

  const load = () => call({ op: 'load', token }).then(setD).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [token]);

  async function approve(section) {
    setMsg('Saving…');
    try {
      const r = await call({ op: 'approve', token, section });
      setMsg(r.approved ? 'Everything is approved — thank you. Nothing else is needed from you before the first send.' : 'Approved. Thank you.');
      await load();
    } catch (e) { setMsg(e.message); }
  }
  async function change(section, text) {
    setMsg('Sending…');
    try {
      await call({ op: 'change', token, section, text });
      setMsg('Got it. We will make the change and email you when the new version is here.');
      await load();
      return true;
    } catch (e) { setMsg(e.message); return false; }
  }

  if (!d) return <main style={{ maxWidth: 820, margin: '40px auto', padding: 16 }}><p>{msg || 'Loading…'}</p></main>;
  const p = d.profile;
  const emails = d.variants?.[variant] || null;
  return (
    <main style={{ maxWidth: 860, margin: '32px auto', padding: '0 16px 64px', display: 'grid', gap: 20 }}>
      <header>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Your 30-day trial</div>
        <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0 }}>{d.company}: the list and the emails</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: 8 }}>
          Please approve each part below, or tell us what to change.{d.day1Date ? ` First send: ${fmt(d.day1Date)}.` : ''}
        </p>
        {d.approvedAt && <p style={{ color: 'var(--success)', fontWeight: 700 }}>Approved{d.approvalMode === 'silence' ? ' (no reply, as agreed)' : ''}. Thank you.</p>}
      </header>
      {msg && <div style={{ ...box, borderColor: 'var(--fg)' }}>{msg}</div>}

      <Section id="profile" title="1. Who we will email" state={d.sections.profile} changesLeft={d.changesLeft} onApprove={approve} onChange={change}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) 1fr', gap: '6px 14px', margin: 0, fontSize: 14 }}>
          {[
            ['What you sell', p.oneLiner || p.sellsTo], ['Industry', p.industry], ['Where', [p.cities, p.states].flat().filter(Boolean).join(' · ')],
            ['Company size', p.sizeMin || p.sizeMax ? `${p.sizeMin || '?'}–${p.sizeMax || '?'} staff` : ''], ['Job titles', [].concat(p.titles || []).join(', ')],
            ['Titles to skip', [].concat(p.excludedTitles || []).join(', ')], ['Sent as', [p.senderName, p.senderTitle].filter(Boolean).join(', ')],
            ['Footer address', p.postalAddress], ['Booking link', p.calendarUrl],
          ].filter(([, v]) => v && String(v).trim()).flatMap(([k, v]) => [
            <dt key={`${k}-t`} style={{ color: 'var(--fg-muted)' }}>{k}</dt>,
            <dd key={`${k}-d`} style={{ margin: 0 }}>{String(v)}</dd>,
          ])}
        </dl>
      </Section>

      <Section id="list" title="2. The companies" state={d.sections.list} changesLeft={d.changesLeft} onApprove={approve} onChange={change}>
        {d.marketEstimate != null && <p style={{ margin: 0 }}>Estimated market that matches your profile: <strong>{Number(d.marketEstimate).toLocaleString('en-US')}</strong> companies.</p>}
        {d.rows.length === 0 ? <p style={{ margin: 0 }}>The list is still being built — the first 20 companies appear here as soon as they are checked.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <p style={{ margin: '0 0 8px' }}>20 of the companies we found for you:</p>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead><tr>{['Company', 'Contact', 'Title', 'City', 'State'].map((h) => <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid var(--fg)', padding: '6px 8px' }}>{h}</th>)}</tr></thead>
              <tbody>{d.rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{r.company}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{r.name || r.first_name || '—'}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{r.title || '—'}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{r.city}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{r.state}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="copy" title="3. The four emails" state={d.sections.copy} changesLeft={d.changesLeft} onApprove={approve} onChange={change}>
        <p style={{ margin: 0 }}>We test two openings against each other (A and B); everything after the first line is the same.{d.sampleLead ? ` Shown as it would go to ${d.sampleLead.first_name} at ${d.sampleLead.company}.` : ''}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {['A', 'B'].filter((k) => d.variants?.[k] !== undefined).map((k) => <button key={k} style={variant === k ? btn : ghost} onClick={() => setVariant(k)}>Version {k}</button>)}
        </div>
        {emails ? <div style={{ display: 'grid', gap: 12 }}>{emails.map((e) => <Email key={e.touch} e={e} />)}</div> : <p style={{ margin: 0 }}>The emails appear here as soon as the first companies are found.</p>}
      </Section>

      <footer style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Questions? Just reply to our email — a person reads every reply.</footer>
    </main>
  );
}
