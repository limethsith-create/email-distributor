'use client';

/**
 * The client's page — the shared view (systems/clientdash.js, docs/HUB-API.md
 * "The client's page (shared view)"). What the owner and the people he gave
 * access to both look at: Overview, Conversations, Emails sent, Calls,
 * Messages. Read-only; refreshes every five minutes. Mobile first (no
 * sideways scroll at 390 px), colours from the site's CSS variables only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

const REFRESH_MS = 5 * 60 * 1000;
const TABS = [
  ['overview', 'Overview'],
  ['conversations', 'Conversations'],
  ['emails', 'Emails sent'],
  ['calls', 'Calls'],
  ['messages', 'Messages'],
];
const KIND = {
  interested: 'Interested', question: 'Question', not_now: 'Not now', out_of_office: 'Out of office', bounce: 'Bounced',
  unsubscribe: 'Unsubscribed', not_interested: 'Not interested', referral: 'Referral', unclear: 'Unclear', legal: 'Needs care', angry: 'Unhappy',
};
const HANDLED = { bot: 'We answered', owner: 'We answered', client: 'Handed to you' };
const EMAIL_STATUS = { sent: 'Sent', replied: 'Replied', bounced: 'Bounced', failed: 'Not sent yet' };
const CALL_STATUS = { booked: 'Booked', showed: 'Showed', no_show: 'No-show', cancelled: 'Cancelled', moved: 'Moved', checking: 'Being checked' };
const OUR_CALL_STATUS = { booked: 'Booked', done: 'Done', missed: 'Missed', not_needed: 'Not needed', not_booked: 'Not booked yet' };

const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const pct = (v, of = 'emails sent') => (v == null ? '' : `${Math.round(Number(v) * 1000) / 10}% of ${of}`);
const sinceDay = (day) => { try { return day ? `Since ${new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}` : ''; } catch { return ''; } };
const dayLabel = (v) => { try { return new Date(v).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return ''; } };
const when = (v) => { try { return v ? new Date(v).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; } catch { return ''; } };
const short = (v) => {
  try {
    const d = new Date(v);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
};
const nameOnly = (s) => String(s || '').replace(/\s*<[^>]*>\s*$/, '') || String(s || '');

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Could not load this. Check your connection and refresh.'), { status: r.status });
  return j;
}

const CSS = `
.cd { max-width: 920px; margin: 0 auto; display: grid; gap: 18px; min-width: 0; }
.cd * { box-sizing: border-box; }
.cd-card { border: 1px solid var(--border); background: var(--card); border-radius: var(--radius); padding: 16px; min-width: 0; }
.cd-muted { color: var(--fg-muted); }
.cd-dim { color: var(--fg-dim); }
.cd-h2 { font-size: 16px; font-weight: 700; margin: 0 0 10px; }
.cd-tabs { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--border); scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.cd-tabs::-webkit-scrollbar { display: none; }
.cd-tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 10px 9px; font: inherit; font-size: 14px; color: var(--fg-muted); cursor: pointer; white-space: nowrap; }
.cd-tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.cd-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.cd-tiles2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.cd-tile { border: 1px solid var(--border); background: var(--card); border-radius: var(--radius); padding: 12px 10px; min-width: 0; }
.cd-tile-l { font-size: 12px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd-tile-n { font-size: clamp(20px, 6vw, 30px); font-weight: 800; line-height: 1.15; margin-top: 2px; }
.cd-tile-s { font-size: 11.5px; color: var(--fg-dim); margin-top: 2px; }
.cd-tiles2 .cd-tile-n { font-size: 20px; }
.cd-steps { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; margin: 6px 0 12px; }
.cd-step { text-align: center; font-size: 12px; color: var(--fg-dim); min-width: 0; }
.cd-step-dot { position: relative; width: 14px; height: 14px; border-radius: 50%; margin: 0 auto 6px; border: 2px solid var(--border); background: var(--card); }
.cd-step.done .cd-step-dot { background: var(--fg-muted); border-color: var(--fg-muted); }
.cd-step.now { color: var(--fg); font-weight: 700; }
.cd-step.now .cd-step-dot { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.cd-bar { height: 2px; background: var(--border); position: relative; top: 14px; margin: 0 10%; }
.cd-row { display: block; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--border); padding: 12px 4px; font: inherit; color: inherit; cursor: pointer; min-width: 0; }
.cd-row:first-child { border-top: 0; }
.cd-row:hover { background: var(--card-hover); }
.cd-line { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; min-width: 0; }
.cd-trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cd-snip { font-size: 13.5px; color: var(--fg-muted); margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.cd-pill { display: inline-block; font-size: 11.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-muted); white-space: nowrap; }
.cd-pill.hot { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.cd-pill.good { border-color: var(--success); color: var(--success); background: var(--success-soft); }
.cd-pill.warn { border-color: var(--warning); color: var(--warning); background: var(--warning-soft); }
.cd-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 12.5px; color: var(--fg-muted); margin-top: 4px; }
.cd-thead { display: none; }
.cd-erow { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; }
.cd-erow .c-when { grid-column: 2; grid-row: 1; font-size: 12.5px; color: var(--fg-muted); white-space: nowrap; }
.cd-erow .c-to { grid-column: 1; grid-row: 1; font-weight: 600; }
.cd-erow .c-co { grid-column: 1 / 3; font-size: 13px; color: var(--fg-muted); }
.cd-erow .c-subj { grid-column: 1; font-size: 13.5px; }
.cd-erow .c-st { grid-column: 2; text-align: right; }
@media (min-width: 760px) {
  .cd-thead { display: grid; font-size: 12px; color: var(--fg-dim); padding: 0 4px 6px; }
  .cd-thead, .cd-erow { grid-template-columns: 130px minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.8fr) 96px; gap: 10px; align-items: baseline; }
  .cd-erow .c-when, .cd-erow .c-to, .cd-erow .c-co, .cd-erow .c-subj, .cd-erow .c-st { grid-column: auto; grid-row: auto; text-align: left; }
  .cd-erow .c-to { font-weight: 500; }
  .cd-erow .c-co { font-size: 13.5px; }
}
.cd-btn { background: var(--card); color: var(--fg); border: 1px solid var(--border-strong); padding: 9px 16px; font: inherit; font-size: 14px; cursor: pointer; border-radius: var(--radius); }
.cd-btn:disabled { opacity: .5; cursor: default; }
.cd-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 16px 8px; overflow-y: auto; }
.cd-modal { background: var(--bg); color: var(--fg); width: 100%; max-width: 760px; border-radius: var(--radius); border: 1px solid var(--border); padding: 16px; min-width: 0; }
.cd-msg { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin-top: 10px; background: var(--card); min-width: 0; }
.cd-msg.in { border-left: 3px solid var(--fg-muted); }
.cd-msg.out { border-left: 3px solid var(--accent); }
.cd-msg-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; margin-top: 8px; }
.cd-x { background: none; border: 0; font-size: 26px; line-height: 1; cursor: pointer; color: var(--fg-muted); padding: 0 4px; }
`;

function Tile({ label, value, sub }) {
  return (
    <div className="cd-tile">
      <div className="cd-tile-l" title={label}>{label}</div>
      <div className="cd-tile-n">{value}</div>
      {sub ? <div className="cd-tile-s">{sub}</div> : null}
    </div>
  );
}

function Chart({ days, sent, replies }) {
  const max = Math.max(1, ...sent.map((v) => Number(v) || 0));
  const W = 600; const H = 140; const slot = W / Math.max(1, days.length); const bw = Math.max(2, slot * 0.66);
  return (
    <svg viewBox={`0 0 ${W} ${H + 20}`} style={{ width: '100%', height: 'auto', display: 'block', color: 'var(--fg-muted)' }} role="img" aria-label="Emails sent per day, last 30 days">
      {days.map((d, i) => {
        const v = Number(sent[i]) || 0; const h = (v / max) * (H - 14); const r = Number(replies[i]) || 0;
        return (
          <g key={d}>
            <rect x={i * slot + (slot - bw) / 2} y={H - h} width={bw} height={Math.max(h, v ? 1 : 0)} fill="var(--fg)" opacity="0.8"><title>{`${dayLabel(d + 'T12:00:00Z')}: ${v} sent${r ? `, ${r} ${r === 1 ? 'reply' : 'replies'}` : ''}`}</title></rect>
            {r > 0 && <circle cx={i * slot + slot / 2} cy={Math.max(6, H - h - 8)} r="5" fill="var(--accent)"><title>{`${r} ${r === 1 ? 'reply' : 'replies'}`}</title></circle>}
          </g>
        );
      })}
      <line x1="0" x2={W} y1={H} y2={H} stroke="var(--border)" />
      <text x="0" y={H + 16} fontSize="13" fill="currentColor">{days[0] ? dayLabel(days[0] + 'T12:00:00Z') : ''}</text>
      <text x={W} y={H + 16} fontSize="13" fill="currentColor" textAnchor="end">{days.length ? dayLabel(days[days.length - 1] + 'T12:00:00Z') : ''}</text>
    </svg>
  );
}

function Overview({ d }) {
  const f = d.five || {};
  const l = d.last30;
  const j = d.journey;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {j ? (
        <div className="cd-card">
          <h2 className="cd-h2">Where you are</h2>
          <div className="cd-bar" aria-hidden />
          <div className="cd-steps">
            {j.steps.map((s, i) => (
              <div key={s.key} className={`cd-step${i < j.current ? ' done' : ''}${i === j.current ? ' now' : ''}`} aria-current={i === j.current ? 'step' : undefined}>
                <div className="cd-step-dot" />
                {s.label}
              </div>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 15 }}>{j.status}</p>
        </div>
      ) : null}
      <div className="cd-tiles">
        <Tile label="Emails sent" value={n(f.sent)} sub={sinceDay(d.sentSince)} />
        <Tile label="Opened" value={f.opened == null ? '—' : n(f.opened)} sub={f.opened == null ? 'Not tracked yet' : pct(d.rates?.opened)} />
        <Tile label="Replies" value={n(f.replies)} sub={pct(d.rates?.replies)} />
        <Tile label="Bounced" value={n(f.bounced)} sub={pct(d.rates?.bounced)} />
      </div>
      <div className="cd-tiles2">
        <Tile label="Interested" value={n(f.interested)} sub={pct(d.rates?.interested, 'replies')} />
        <Tile label="Calls booked" value={n(f.booked)} sub="Prospects who booked a call" />
      </div>
      {l && l.days?.length ? (
        <div className="cd-card">
          <h2 className="cd-h2" style={{ marginBottom: 4 }}>Emails sent per day · last 30 days</h2>
          <p className="cd-muted" style={{ margin: '0 0 10px', fontSize: 13.5 }}>{n(l.totals?.sent)} sent · {n(l.totals?.replies)} replies. A red dot marks a day with a reply.</p>
          <Chart days={l.days} sent={l.sent} replies={l.replies} />
        </div>
      ) : null}
    </div>
  );
}

function pillClass(kind) {
  if (kind === 'interested' || kind === 'question' || kind === 'referral') return 'cd-pill hot';
  if (kind === 'bounce' || kind === 'legal' || kind === 'angry') return 'cd-pill warn';
  return 'cd-pill';
}

function Conversations({ list, err, open }) {
  if (err) return <div className="cd-card"><p style={{ margin: 0 }}>{err}</p></div>;
  if (!list) return <div className="cd-card"><p className="cd-muted" style={{ margin: 0 }}>Loading…</p></div>;
  if (!list.length) return <div className="cd-card"><p className="cd-muted" style={{ margin: 0 }}>No one has written back yet. Everyone who does shows up here, with the whole conversation.</p></div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <h2 className="cd-h2" style={{ marginBottom: 2 }}>Conversations · {n(list.length)}</h2>
        <p className="cd-muted" style={{ margin: 0, fontSize: 13.5 }}>Everyone who wrote back — tap one to read it all</p>
      </div>
    <div className="cd-card" style={{ padding: '4px 12px' }}>
      {list.map((t) => (
        <button key={t.threadId} className="cd-row" onClick={() => open(t.threadId)}>
          <div className="cd-line">
            <span className="cd-trunc" style={{ fontWeight: 600 }}>{t.lead?.company || t.lead?.email}</span>
            <span className="cd-dim" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{short(t.lastAt)}</span>
          </div>
          <div className="cd-meta">
            {t.lead?.name ? <span>{t.lead.name}</span> : null}
            <span className={pillClass(t.kind)}>{KIND[t.kind] || 'Reply'}</span>
            <span>{HANDLED[t.handledBy] || 'Nothing to answer'}</span>
          </div>
          {t.snippet ? <div className="cd-snip">{t.snippet}</div> : null}
        </button>
      ))}
    </div>
    </div>
  );
}

function Emails({ page, err, more, busy, open }) {
  if (err && !page) return <div className="cd-card"><p style={{ margin: 0 }}>{err}</p></div>;
  if (!page) return <div className="cd-card"><p className="cd-muted" style={{ margin: 0 }}>Loading…</p></div>;
  if (!page.sent.length) return <div className="cd-card"><p className="cd-muted" style={{ margin: 0 }}>No emails have gone out yet. Every one will be listed here, newest first.</p></div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <h2 className="cd-h2" style={{ marginBottom: 2 }}>Every email sent · {n(page.total)}</h2>
        <p className="cd-muted" style={{ margin: 0, fontSize: 13.5 }}>Newest first — tap one to read it</p>
      </div>
      <div className="cd-card" style={{ padding: '10px 12px 4px' }}>
        <div className="cd-thead"><span>When</span><span>To</span><span>Company</span><span>Subject</span><span>Status</span></div>
        {page.sent.map((e) => (
          <button key={e.id} className="cd-row cd-erow" onClick={() => open(e.threadId)}>
            <span className="c-when">{short(e.at)}</span>
            <span className="c-to cd-trunc">{e.toName || e.to}</span>
            <span className="c-co cd-trunc">{e.company || ''}</span>
            <span className="c-subj cd-trunc">{e.subject || '(no subject)'}</span>
            <span className="c-st"><span className={`cd-pill${e.status === 'replied' ? ' good' : e.status === 'bounced' || e.status === 'failed' ? ' warn' : ''}`}>{EMAIL_STATUS[e.status] || 'Sent'}</span></span>
          </button>
        ))}
      </div>
      {page.next ? <div style={{ textAlign: 'center' }}><button className="cd-btn" disabled={busy} onClick={more}>{busy ? 'Loading…' : 'Show more'}</button></div> : null}
      {err ? <p style={{ margin: 0, textAlign: 'center' }}>{err}</p> : null}
    </div>
  );
}

function Calls({ calls }) {
  const pros = calls?.prospects || [];
  const ours = calls?.ours || [];
  const tone = (st) => (st === 'showed' ? ' good' : st === 'no_show' || st === 'cancelled' ? ' warn' : st === 'booked' ? ' hot' : '');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="cd-card" style={{ padding: '14px 12px 4px' }}>
        <h2 className="cd-h2" style={{ padding: '0 4px' }}>Calls prospects booked · {n(pros.length)}</h2>
        {pros.length ? pros.map((c, i) => (
          <div key={`${c.at}-${i}`} className="cd-row" style={{ cursor: 'default' }}>
            <div className="cd-line">
              <span className="cd-trunc" style={{ fontWeight: 600 }}>{when(c.at)}</span>
              <span className={`cd-pill${tone(c.status)}`}>{CALL_STATUS[c.status] || 'Booked'}</span>
            </div>
            <div className="cd-meta"><span>{c.name || c.email}</span>{c.company ? <span>· {c.company}</span> : null}</div>
          </div>
        )) : <p className="cd-muted" style={{ margin: '0 4px 12px' }}>No calls booked yet. When a prospect books, it shows up here.</p>}
      </div>
      {ours.length ? (
        <div className="cd-card" style={{ padding: '14px 12px 4px' }}>
          <h2 className="cd-h2" style={{ padding: '0 4px' }}>Setup calls</h2>
          {ours.map((c) => (
            <div key={c.kind} className="cd-row" style={{ cursor: 'default' }}>
              <div className="cd-line">
                <span style={{ fontWeight: 600 }}>{c.label}</span>
                <span className={`cd-pill${c.status === 'done' ? ' good' : c.status === 'missed' ? ' warn' : ''}`}>{OUR_CALL_STATUS[c.status] || c.status}</span>
              </div>
              <div className="cd-meta">{c.at ? when(c.at) : c.status === 'not_needed' ? '—' : 'No time booked yet'}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function whoIs(m, isClientThread) {
  if (isClientThread) return m.dir === 'in' ? 'You' : 'Aviance';
  if (m.by === 'prospect') return 'Their reply';
  if (m.by === 'client') return 'Your answer';
  if (m.by === 'bot' || m.by === 'owner') return 'Our answer';
  if (m.dir === 'in') return 'Bounce';
  return /^hot\b/i.test(m.subject || '') ? 'Sent to you' : 'Our email';
}

function Message({ m, isClientThread }) {
  return (
    <div className={`cd-msg ${m.dir}`}>
      <div className="cd-line">
        <span className="cd-trunc" style={{ fontWeight: 600 }}>{nameOnly(m.from) || '—'}</span>
        <span className="cd-dim" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{when(m.at)}</span>
      </div>
      <div className="cd-meta"><span className="cd-pill">{whoIs(m, isClientThread)}</span>{m.to ? <span className="cd-trunc">to {nameOnly(m.to)}</span> : null}</div>
      {m.subject ? <div style={{ fontSize: 13.5, marginTop: 6, fontWeight: 500, overflowWrap: 'anywhere' }}>{m.subject}</div> : null}
      <div className="cd-msg-text">{m.text}</div>
    </div>
  );
}

function Messages({ list }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p className="cd-muted" style={{ margin: 0, fontSize: 14 }}>Your conversation with us. Reply by email — it comes straight to us.</p>
      {list?.length ? list.map((m, i) => <Message key={`${m.at}-${i}`} m={m} isClientThread />) : <div className="cd-card"><p className="cd-muted" style={{ margin: 0 }}>No messages yet.</p></div>}
    </div>
  );
}

function ThreadModal({ token, threadId, close }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    getJson(`/api/c/thread?token=${encodeURIComponent(token)}&id=${encodeURIComponent(threadId)}`)
      .then((j) => live && setT(j)).catch((e) => live && setErr(e.message));
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { live = false; window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [token, threadId, close]);
  const isClient = threadId === 'client';
  return (
    <div className="cd-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) close(); }} role="dialog" aria-modal="true" aria-label="Conversation">
      <div className="cd-modal">
        <div className="cd-line" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, overflowWrap: 'anywhere' }}>{isClient ? 'Your conversation with us' : t?.lead?.company || t?.lead?.email || 'Conversation'}</div>
            {!isClient && t?.lead ? <div className="cd-muted" style={{ fontSize: 13.5, overflowWrap: 'anywhere' }}>{[t.lead.name, t.lead.email].filter(Boolean).join(' · ')}</div> : null}
          </div>
          <button className="cd-x" onClick={close} aria-label="Close">×</button>
        </div>
        {err ? <p>{err}</p> : !t ? <p className="cd-muted">Loading…</p> : t.messages.map((m, i) => <Message key={`${m.at}-${i}`} m={m} isClientThread={isClient} />)}
      </div>
    </div>
  );
}

export default function SharedDashboard() {
  const { token } = useParams();
  const [tab, setTab] = useState('overview');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [threads, setThreads] = useState(null);
  const [threadsErr, setThreadsErr] = useState('');
  const [emails, setEmails] = useState(null);
  const [emailsErr, setEmailsErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);
  const want = useRef({ threads: false, emails: false });
  const q = `token=${encodeURIComponent(token || '')}`;

  const loadThreads = useCallback(() => getJson(`/api/c/threads?${q}`).then((j) => { setThreads(j.threads || []); setThreadsErr(''); }).catch((e) => setThreadsErr(e.message)), [q]);
  const loadEmails = useCallback(() => getJson(`/api/c/emails?${q}&limit=200`).then((j) => {
    // A refresh keeps any further pages already open (it replaces only the first page's worth).
    setEmails((cur) => (cur && cur.pages > 1 ? cur : { ...j, pages: 1 }));
    setEmailsErr('');
  }).catch((e) => setEmailsErr(e.message)), [q]);

  useEffect(() => {
    if (!token) return undefined;
    const load = () => {
      getJson(`/api/c/dashboard?${q}`).then((j) => { setD(j); setErr(''); }).catch((e) => setErr(e.status === 404 ? e.message : e.message || 'Could not load the page.'));
      if (want.current.threads) loadThreads();
      if (want.current.emails) loadEmails();
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [token, q, loadThreads, loadEmails]);

  useEffect(() => {
    try { const h = window.location.hash.slice(1); if (TABS.some(([k]) => k === h)) setTab(h); } catch { /* no hash */ }
  }, []);
  useEffect(() => {
    try { history.replaceState(null, '', `#${tab}`); } catch { /* fine */ }
    if (tab === 'conversations' && !want.current.threads) { want.current.threads = true; loadThreads(); }
    if (tab === 'emails' && !want.current.emails) { want.current.emails = true; loadEmails(); }
  }, [tab, loadThreads, loadEmails]);

  const more = async () => {
    if (!emails?.next) return;
    setBusy(true);
    try {
      const j = await getJson(`/api/c/emails?${q}&limit=200&before=${encodeURIComponent(emails.next)}`);
      setEmails((cur) => ({ total: j.total, next: j.next, sent: [...(cur?.sent || []), ...j.sent], pages: (cur?.pages || 1) + 1 }));
      setEmailsErr('');
    } catch (e) { setEmailsErr(e.message); }
    setBusy(false);
  };
  const close = useCallback(() => setOpenId(null), []);

  if (err && !d) return <div style={{ maxWidth: 640, margin: '10vh auto', fontSize: 16 }}><style>{CSS}</style><div className="cd-card">{err}</div></div>;
  if (!d) return <div style={{ maxWidth: 640, margin: '10vh auto' }} className="cd-muted">Loading…</div>;

  return (
    <div className="cd">
      <style>{CSS}</style>
      <header style={{ minWidth: 0 }}>
        <div className="mono cd-dim" style={{ fontSize: 12, letterSpacing: '0.08em' }}>Aviance — {d.plan}{d.demo ? ' · example' : ''}</div>
        <h1 style={{ fontSize: 'clamp(22px, 6vw, 28px)', fontWeight: 800, margin: '4px 0', overflowWrap: 'anywhere' }}>{d.company}</h1>
        <p style={{ margin: 0, fontSize: 15 }}>{d.status}</p>
        <p className="cd-dim" style={{ margin: '4px 0 0', fontSize: 12.5 }}>Updated {when(d.updatedAt)} · refreshes on its own{err ? ' · could not refresh just now' : ''}</p>
      </header>

      <nav className="cd-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className="cd-tab" onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      <section role="tabpanel" style={{ minWidth: 0 }}>
        {tab === 'overview' && <Overview d={d} />}
        {tab === 'conversations' && <Conversations list={threads} err={threadsErr} open={setOpenId} />}
        {tab === 'emails' && <Emails page={emails} err={emailsErr} more={more} busy={busy} open={setOpenId} />}
        {tab === 'calls' && <Calls calls={d.calls} />}
        {tab === 'messages' && <Messages list={d.messages} />}
      </section>

      {openId ? <ThreadModal token={token} threadId={openId} close={close} /> : null}
    </div>
  );
}
