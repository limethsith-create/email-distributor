'use client';

import { useState, useEffect, useCallback } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };
const ACCENT = '#e0290f';

const DAY_NAMES = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday' };
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const btn = {
  base: { fontFamily: 'inherit', cursor: 'pointer', border: '1px solid #0a0a0a', background: '#fff', color: '#0a0a0a', padding: '7px 14px', fontSize: 13, borderRadius: 2 },
  solid: { fontFamily: 'inherit', cursor: 'pointer', border: '1px solid #0a0a0a', background: '#0a0a0a', color: '#fff', padding: '7px 14px', fontSize: 13, borderRadius: 2 },
  accent: { fontFamily: 'inherit', cursor: 'pointer', border: `1px solid ${ACCENT}`, background: ACCENT, color: '#fff', padding: '7px 14px', fontSize: 13, borderRadius: 2 },
  ghost: { fontFamily: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--fg-dim)', padding: '4px 8px', fontSize: 12 },
};

export default function CalendarPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [windows, setWindows] = useState({});
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [bookFor, setBookFor] = useState(null); // iso of slot being booked
  const [bookEmail, setBookEmail] = useState('');
  const [bookCompany, setBookCompany] = useState('');

  const load = useCallback(() => {
    fetch('/api/calendar', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setWindows(JSON.parse(JSON.stringify(d.availability?.windows || {})));
        setSlotMinutes(d.availability?.slotMinutes || 30);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function addWindow(day) {
    setWindows((w) => ({ ...w, [day]: [...(w[day] || []), ['09:00', '15:30']] }));
  }
  function removeWindow(day, i) {
    setWindows((w) => ({ ...w, [day]: (w[day] || []).filter((_, idx) => idx !== i) }));
  }
  function setWinTime(day, i, which, val) {
    setWindows((w) => {
      const copy = { ...w, [day]: (w[day] || []).map((pair, idx) => idx === i ? [...pair] : pair) };
      copy[day][i][which] = val;
      return copy;
    });
  }

  async function saveAvailability() {
    setSaving(true); setSavedMsg('');
    try {
      await fetch('/api/calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_availability', slotMinutes, windows }),
      });
      setSavedMsg('Saved.');
      load();
    } catch { setSavedMsg('Could not save.'); }
    setSaving(false);
    setTimeout(() => setSavedMsg(''), 2500);
  }

  async function post(action, payload) {
    await fetch('/api/calendar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    load();
  }

  async function submitBooking(iso) {
    if (!bookEmail.trim()) return;
    await post('add_booking', { iso, prospectEmail: bookEmail.trim(), company: bookCompany.trim(), status: 'confirmed' });
    setBookFor(null); setBookEmail(''); setBookCompany('');
  }

  const upcoming = data?.upcoming || [];
  const openSlots = data?.openSlots || [];

  return (
    <div className="fade-up" style={{ maxWidth: 940 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}><span className="idx">06</span>&nbsp;/&nbsp;CALENDAR</div>
      <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1, marginBottom: 8 }}>Discovery calls</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18, maxWidth: 620 }}>
        Set when you&rsquo;re free and the bot offers those times to interested prospects. Every time is shown in the
        prospect&rsquo;s <strong>US Eastern</strong> time and <strong>your Sri Lanka</strong> time, so nothing is guesswork.
      </p>

      <div style={{ ...card, padding: '10px 14px', marginBottom: 22, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12 }} className="mono">
        <span style={{ color: 'var(--fg-dim)' }}>PROSPECT&nbsp;·&nbsp;US EASTERN</span>
        <span style={{ color: ACCENT }}>YOU&nbsp;·&nbsp;SRI LANKA (UTC+5:30)</span>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading&hellip;</div>
      ) : (
        <>
          {/* ── UPCOMING CALLS ── */}
          <SectionTitle n="A" title="Upcoming discovery calls" />
          {upcoming.length === 0 ? (
            <div style={{ ...card, padding: 28, textAlign: 'center', color: 'var(--fg-dim)', marginBottom: 30 }}>
              No calls booked yet. When the bot proposes times to a prospect, or you book a slot below, it shows up here.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 30 }}>
              {upcoming.map((b) => (
                <div key={b.iso} style={{ ...card, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 220 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{b.usDate} · {b.usTime} <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>ET</span></div>
                    <div className="mono" style={{ fontSize: 12, color: ACCENT, marginTop: 2 }}>{b.slDate} · {b.slTime} your time</div>
                    <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
                      {b.prospectEmail || 'unknown'}{b.company ? ` · ${b.company}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StatusPill status={b.status} />
                    {b.status !== 'confirmed' && (
                      <button style={btn.accent} onClick={() => post('confirm', { iso: b.iso })}>Confirm</button>
                    )}
                    <button style={btn.ghost} onClick={() => post('cancel', { iso: b.iso })}>Cancel</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── WEEKLY AVAILABILITY ── */}
          <SectionTitle n="B" title="Your weekly availability" hint="Times below are US Eastern. The Sri Lanka equivalent is shown next to each." />
          <div style={{ ...card, padding: '4px 0', marginBottom: 14 }}>
            {DAY_ORDER.map((day) => {
              const wins = windows[day] || [];
              const labels = data?.availability?.windowsLabelled?.[day] || [];
              return (
                <div key={day} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ width: 96, fontWeight: 600, fontSize: 13, paddingTop: 6 }}>{DAY_NAMES[day]}</div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wins.length === 0 && <div style={{ color: 'var(--fg-dim)', fontSize: 13, paddingTop: 6 }}>Unavailable</div>}
                    {wins.map((pair, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <input type="time" value={pair[0]} onChange={(e) => setWinTime(day, i, 0, e.target.value)}
                          style={{ fontFamily: 'inherit', padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 2, fontSize: 13 }} />
                        <span style={{ color: 'var(--fg-dim)' }}>to</span>
                        <input type="time" value={pair[1]} onChange={(e) => setWinTime(day, i, 1, e.target.value)}
                          style={{ fontFamily: 'inherit', padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 2, fontSize: 13 }} />
                        <span className="mono" style={{ fontSize: 11, color: ACCENT }}>
                          {labels[i] ? `→ ${labels[i].sl} your time` : ''}
                        </span>
                        <button style={btn.ghost} onClick={() => removeWindow(day, i)}>remove</button>
                      </div>
                    ))}
                    <button style={{ ...btn.ghost, color: '#0a0a0a', alignSelf: 'flex-start' }} onClick={() => addWindow(day)}>+ add a window</button>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Call length</label>
              <select value={slotMinutes} onChange={(e) => setSlotMinutes(parseInt(e.target.value))}
                style={{ fontFamily: 'inherit', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 2, fontSize: 13 }}>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={45}>45 minutes</option>
                <option value={60}>60 minutes</option>
              </select>
              <button style={btn.solid} disabled={saving} onClick={saveAvailability}>{saving ? 'Saving…' : 'Save availability'}</button>
              {savedMsg && <span className="mono" style={{ fontSize: 12, color: ACCENT }}>{savedMsg}</span>}
            </div>
          </div>

          {/* ── OPEN SLOTS ── */}
          <SectionTitle n="C" title="Open slots — next 14 days" hint="These are the times the bot can offer. Book one manually if a prospect confirms a time directly." />
          {openSlots.length === 0 ? (
            <div style={{ ...card, padding: 28, textAlign: 'center', color: 'var(--fg-dim)' }}>
              No open slots. Add availability above (and make sure the windows are in the future).
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {openSlots.slice(0, 18).map((s) => (
                <div key={s.iso} style={{ ...card, padding: '12px 14px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{s.usDate} · {s.usTime} <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>ET</span></div>
                  <div className="mono" style={{ fontSize: 11, color: ACCENT, marginTop: 2 }}>{s.slTime} your time</div>
                  {bookFor === s.iso ? (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input placeholder="prospect email" value={bookEmail} onChange={(e) => setBookEmail(e.target.value)}
                        style={{ fontFamily: 'inherit', padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 2, fontSize: 12 }} />
                      <input placeholder="company (optional)" value={bookCompany} onChange={(e) => setBookCompany(e.target.value)}
                        style={{ fontFamily: 'inherit', padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 2, fontSize: 12 }} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button style={btn.accent} onClick={() => submitBooking(s.iso)}>Book</button>
                        <button style={btn.ghost} onClick={() => { setBookFor(null); setBookEmail(''); setBookCompany(''); }}>cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button style={{ ...btn.base, marginTop: 8, width: '100%' }} onClick={() => setBookFor(s.iso)}>Book this</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SectionTitle({ n, title, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="mono" style={{ color: ACCENT, fontSize: 12, fontWeight: 600 }}>{n}</span>
        <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</h2>
      </div>
      {hint && <p style={{ color: 'var(--fg-dim)', fontSize: 12.5, marginTop: 3, marginLeft: 22 }}>{hint}</p>}
    </div>
  );
}

function StatusPill({ status }) {
  const confirmed = status === 'confirmed';
  return (
    <span className="mono" style={{
      fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em',
      padding: '4px 9px', borderRadius: 2,
      background: confirmed ? '#0a0a0a' : '#fff',
      color: confirmed ? '#fff' : ACCENT,
      border: `1px solid ${confirmed ? '#0a0a0a' : ACCENT}`,
    }}>
      {confirmed ? 'Confirmed' : 'Proposed · needs you'}
    </span>
  );
}
