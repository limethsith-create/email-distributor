'use client';

import { useState, useEffect } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: 'none' };

function extractEmail(s) {
  if (!s) return '';
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim().toLowerCase();
}

function fmtDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d).slice(0, 16);
    return (
      dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' · ' +
      dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
  } catch {
    return String(d).slice(0, 16);
  }
}

function latestTs(conv) {
  if (conv.updatedAt) return String(conv.updatedAt);
  const msgs = conv.messages || [];
  let best = '';
  for (const m of msgs) {
    const t = String(m.ts || '');
    if (t > best) best = t;
  }
  return best;
}

function KPI({ idx, label, value, sub, accent }) {
  return (
    <div style={{ ...card, padding: '18px 20px' }}>
      <div className="eyebrow"><span className="idx">{idx}</span>&nbsp;&nbsp;{label}</div>
      <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 10, lineHeight: 1, color: accent ? 'var(--accent)' : 'var(--fg)' }}>{value}</div>
      {sub && <div className="mono" style={{ color: 'var(--fg-dim)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{sub}</div>}
    </div>
  );
}

function Bubble({ msg }) {
  const isOut = msg.dir === 'out';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isOut ? 'flex-end' : 'flex-start', marginBottom: 14 }}>
      <div
        style={{
          maxWidth: '78%',
          padding: '12px 14px',
          borderRadius: 3,
          boxShadow: 'none',
          background: isOut ? 'rgba(224,41,15,0.06)' : 'var(--bg-subtle)',
          border: isOut ? '1px solid rgba(224,41,15,0.25)' : '1px solid var(--border)',
          borderLeft: isOut ? '3px solid var(--accent)' : '1px solid var(--border)',
        }}
      >
        {isOut && (
          <div className="mono" style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6, fontWeight: 600 }}>
            AUTO-REPLY SENT
          </div>
        )}
        {msg.subject ? (
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-muted)', marginBottom: 5 }}>{msg.subject}</div>
        ) : null}
        <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--fg)' }}>
          {(msg.text || '').trim() || <span style={{ color: 'var(--fg-dim)' }}>No message text.</span>}
        </div>
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: 5, letterSpacing: '0.06em' }}>
        {isOut ? 'BOT · ' : 'PROSPECT · '}{fmtDate(msg.ts)}
      </div>
    </div>
  );
}

function ConversationCard({ conv }) {
  const msgs = (conv.messages || []).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const hasOut = msgs.some((m) => m.dir === 'out');
  return (
    <div style={{ ...card, padding: '18px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 15.5, letterSpacing: '-0.01em' }}>{conv.company || conv.email || 'Unknown'}</span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-dim)', wordBreak: 'break-all' }}>{conv.email}</span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>{fmtDate(latestTs(conv))}</span>
      </div>
      <div className="rule-soft" style={{ margin: '12px 0 16px' }} />
      {msgs.map((m, i) => <Bubble key={i} msg={m} />)}
      <div style={{ marginTop: 4 }}>
        {hasOut ? (
          <span className="mono" style={{ display: 'inline-block', fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', border: '1px solid rgba(224,41,15,0.4)', padding: '6px 10px', background: 'rgba(224,41,15,0.04)' }}>
            BOT REPLIED · YOUR TURN — reply from your own inbox to continue
          </span>
        ) : (
          <span className="mono" style={{ display: 'inline-block', fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-muted)', border: '1px solid var(--border-strong)', padding: '6px 10px' }}>
            AWAITING BOT / NEEDS REVIEW
          </span>
        )}
      </div>
    </div>
  );
}

export default function RepliesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/replies', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) { setData(d && typeof d === 'object' ? d : {}); setLoading(false); } })
      .catch(() => { if (alive) { setData({}); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const replies = (data && Array.isArray(data.replies)) ? data.replies : [];
  const convMap = (data && data.conversations && typeof data.conversations === 'object') ? data.conversations : {};

  // Real conversation entries from the bot store.
  const convs = Object.values(convMap).filter((c) => c && Array.isArray(c.messages));

  // Older replies with no matching conversation entry — render as single incoming message cards.
  const known = new Set(convs.map((c) => String(c.email || '').toLowerCase()));
  const orphans = replies
    .filter((r) => {
      const em = extractEmail(r.leadEmail || r.from);
      return em && !known.has(em);
    })
    .map((r) => ({
      email: extractEmail(r.leadEmail || r.from),
      company: r.company || '',
      updatedAt: r.date || '',
      status: '',
      messages: [{ dir: 'in', subject: r.subject || '', text: r.preview || '', ts: r.date || '' }],
    }));

  const all = convs.concat(orphans).sort((a, b) => latestTs(b).localeCompare(latestTs(a)));

  const total = all.length;
  const hasOut = (c) => (c.messages || []).some((m) => m.dir === 'out');
  const botReplied = all.filter(hasOut).length;
  const awaiting = all.filter((c) => (hasOut(c) && c.status === 'awaiting_human') || !hasOut(c)).length;

  return (
    <div className="fade-up">
      <div className="eyebrow" style={{ marginBottom: 10 }}><span className="idx">03</span>&nbsp;/&nbsp;REPLIES</div>
      <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>Conversations</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '14px 0 22px', maxWidth: 620 }}>
        Every prospect reply and the bot&rsquo;s automatic first response. The bot answers once — after that it&rsquo;s your turn.
      </p>

      <div className="rule" style={{ marginBottom: 22 }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 22 }}>
        <KPI idx="01" label="Total conversations" value={loading ? '—' : total} sub="prospects who wrote back" />
        <KPI idx="02" label="Bot replied" value={loading ? '—' : botReplied} sub="auto-reply sent once" />
        <KPI idx="03" label="Awaiting your reply" value={loading ? '—' : awaiting} sub="your turn to continue" accent />
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
      ) : total === 0 ? (
        <div style={{ ...card, padding: '40px 32px', textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>No replies yet</div>
          <div style={{ color: 'var(--fg-muted)', fontSize: 13.5, maxWidth: 480, margin: '0 auto', lineHeight: 1.55 }}>
            Conversations will appear here the moment a prospect writes back, along with the bot&rsquo;s automatic first response.
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 780 }}>
          {all.map((c, i) => <ConversationCard key={(c.email || '') + i} conv={c} />)}
        </div>
      )}
    </div>
  );
}
