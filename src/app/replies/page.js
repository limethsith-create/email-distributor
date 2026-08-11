'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };

// ---- Rule-based sentiment: reads the subject + preview of each reply ----
const POS = [
  'interested', 'sounds good', 'sounds great', "let's", 'lets ', 'let us', 'happy to',
  'love to', "i'd love", 'would love', 'keen', 'definitely', 'absolutely', 'sure',
  'yes please', 'tell me more', 'more info', 'more information', 'how much', 'pricing',
  'price', 'quote', 'book a', 'schedule', 'set up a call', 'set up a time', 'jump on a call',
  'when can', 'what times', 'available', 'send me', 'looking forward', 'great', 'perfect',
  'count me in', 'works for me', 'sign me up', 'get started', 'lets talk', "let's talk",
];
const NEG = [
  'not interested', 'no thanks', 'no thank', 'unsubscribe', 'remove me', 'remove from',
  'take me off', 'opt out', 'opt-out', 'stop emailing', 'stop contacting', 'do not contact',
  "don't contact", 'not a fit', 'not a good fit', 'no thank you', 'pass on', 'already have',
  'not looking', 'leave me alone', 'this is spam', 'reported', 'do not email', "don't email",
  'wrong person', 'no interest', 'not right now', 'not at this time', 'we are all set',
  "we're all set", 'no need', 'please stop',
];

function classify(reply) {
  const t = ((reply.subject || '') + ' ' + (reply.preview || reply.snippet || '')).toLowerCase();
  let pos = 0, neg = 0;
  for (const w of POS) if (t.includes(w)) pos++;
  for (const w of NEG) if (t.includes(w)) neg++;
  // Negative auto-replies (unsubscribe/stop) are unambiguous — weight them first.
  if (neg > 0 && neg >= pos) return 'negative';
  if (pos > 0) return 'positive';
  return 'neutral';
}

function fmtDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
           dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch { return String(d).slice(0, 16); }
}

function ReplyCard({ r, tone }) {
  const bar = tone === 'positive' ? '#16a34a' : tone === 'negative' ? '#dc2626' : '#a1a1aa';
  return (
    <div style={{ ...card, padding: '14px 16px', borderLeft: `3px solid ${bar}`, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, wordBreak: 'break-all' }}>{r.from || r.leadEmail || '—'}</div>
        <div style={{ color: 'var(--fg-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(r.date || r.repliedAt)}</div>
      </div>
      {r.subject ? <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 6 }}>{r.subject}</div> : null}
      <div style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {(r.preview || r.snippet || '').trim() || <span style={{ color: 'var(--fg-dim)' }}>No preview text.</span>}
      </div>
      {r.account ? <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--fg-dim)' }}>replied to {r.account}</div> : null}
    </div>
  );
}

export default function RepliesPage() {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('all'); // all | positive | negative | neutral

  useEffect(() => {
    let alive = true;
    fetch('/api/replies', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) { setReplies((d && d.replies) || []); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const tagged = replies.map((r) => ({ ...r, _tone: classify(r) }))
    .sort((a, b) => String(b.date || b.repliedAt || '').localeCompare(String(a.date || a.repliedAt || '')));

  const pos = tagged.filter((r) => r._tone === 'positive');
  const neg = tagged.filter((r) => r._tone === 'negative');
  const neu = tagged.filter((r) => r._tone === 'neutral');

  const pill = (key, label, count, color) => (
    <button key={key} onClick={() => setView(key)}
      style={{ padding: '8px 14px', borderRadius: 9, fontSize: 13.5, fontWeight: 600,
        border: '1px solid ' + (view === key ? (color || 'var(--accent)') : 'var(--border)'),
        background: view === key ? (color ? color + '22' : 'var(--accent-soft)') : 'transparent',
        color: view === key ? (color || 'var(--accent)') : 'var(--fg-muted)', cursor: 'pointer' }}>
      {label} <span style={{ opacity: 0.7 }}>{count}</span>
    </button>
  );

  const Column = ({ title, items, tone, color }) => (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: color }} />
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <span style={{ color: 'var(--fg-dim)', fontSize: 12.5 }}>{items.length}</span>
      </div>
      {items.length === 0
        ? <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 13 }}>None yet.</div>
        : items.map((r, i) => <ReplyCard key={(r.from || '') + i} r={r} tone={tone} />)}
    </div>
  );

  return (
    <div className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Replies</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 18 }}>
        Replies from prospects, auto-sorted into positive and negative by what they wrote. Neutral ones need a human read.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 20 }}>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Total replies</div><div style={{ fontSize: 30, fontWeight: 700 }}>{loading ? '—' : tagged.length}</div></div>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Positive</div><div style={{ fontSize: 30, fontWeight: 700, color: '#16a34a' }}>{loading ? '—' : pos.length}</div></div>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Negative</div><div style={{ fontSize: 30, fontWeight: 700, color: '#dc2626' }}>{loading ? '—' : neg.length}</div></div>
        <div style={{ ...card, padding: '16px 18px' }}><div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Needs review</div><div style={{ fontSize: 30, fontWeight: 700, color: '#a1a1aa' }}>{loading ? '—' : neu.length}</div></div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {pill('all', 'Split view', tagged.length)}
        {pill('positive', 'Positive', pos.length, '#16a34a')}
        {pill('negative', 'Negative', neg.length, '#dc2626')}
        {pill('neutral', 'Needs review', neu.length, '#a1a1aa')}
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
      ) : tagged.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>
          No replies yet. They’ll appear here as prospects respond.
        </div>
      ) : view === 'all' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 20, alignItems: 'start' }}>
          <Column title="Positive" items={pos} tone="positive" color="#16a34a" />
          <Column title="Negative" items={neg} tone="negative" color="#dc2626" />
          {neu.length > 0 && <Column title="Needs review" items={neu} tone="neutral" color="#a1a1aa" />}
        </div>
      ) : (
        <div style={{ maxWidth: 640 }}>
          {(view === 'positive' ? pos : view === 'negative' ? neg : neu).map((r, i) => (
            <ReplyCard key={(r.from || '') + i} r={r} tone={r._tone} />
          ))}
        </div>
      )}
    </div>
  );
}
