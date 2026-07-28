const S = {
  wrap: { maxWidth: 820 },
  lead: { color: 'var(--fg-muted)', fontSize: 14, marginBottom: 20 },
  card: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', marginBottom: 16 },
  h2: { fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b3a4f5', marginBottom: 12 },
  pill: { display: 'inline-block', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 10, padding: '7px 13px', margin: '0 8px 8px 0', fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace' },
  row: { display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 14 },
  n: { color: '#b3a4f5', fontWeight: 700 },
  rule: { padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 14, color: 'var(--fg-muted)' },
  tmpl: { background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 14px', marginBottom: 8 },
  subj: { fontWeight: 600, fontSize: 14, marginBottom: 4, color: 'var(--fg)' },
  body: { color: 'var(--fg-muted)', fontSize: 13.5 },
  note: { background: 'var(--accent-soft)', border: '1px solid #6e56cf', borderRadius: 12, padding: '15px 18px', fontSize: 14, color: 'var(--fg)' },
};

const INBOXES = ['limethsith@getaviance.site', 'limethsith.weerasinghe@getaviance.site'];
const SCHEDULE = [['Day 1-3', '2 / inbox'], ['Day 4-6', '3 / inbox'], ['Day 7-9', '4 / inbox'], ['Day 10-12', '6 / inbox'], ['Day 13-14', '8 / inbox'], ['Day 15+', 'Warmed - start campaigns']];
const RULES = ['They must reply. Warmup only builds reputation when people reply. Ask helpers to reply to at least half.', 'Rescue from spam. If it lands in spam, move it to the inbox, mark Not Spam, then reply. Strongest signal there is.', 'Keep it human. Plain text only, no links or images or sales talk. Vary the wording every time.', 'Spread them out. A few in the morning, a few later. Alternate both inboxes.'];
const TEMPLATES = [['quick one', 'Hey, are you free for a quick call this week? Wanted to run something by you.'], ['random question', 'Do you still use that project tool you mentioned? Thinking of trying it, wanted your take.'], ['coffee soon?', "It's been ages! Want to grab a coffee sometime next week?"], ['checking in', 'How have you been? Feels like forever since we caught up. Anything new?'], ['help me pick', "Trying to decide between two options and can't choose. Mind giving me a gut reaction?"], ['book rec?', 'Looking for something good to read this week. Got any recommendations?']];

export default function WarmupPage() {
  return (
    <div style={S.wrap} className="fade-up">
      <h1 className="text-[26px] font-bold tracking-tight mb-1">Warmup</h1>
      <p style={S.lead}>A gentle 14-day warmup for your fresh inboxes, powered by real opens and replies. Do this before any real campaign.</p>
      <div style={S.card}>
        <div style={S.h2}>Your inboxes</div>
        {INBOXES.map((e) => <span key={e} style={S.pill}>{e}</span>)}
      </div>
      <div style={S.card}>
        <div style={S.h2}>Daily schedule</div>
        {SCHEDULE.map((r) => <div key={r[0]} style={S.row}><span>{r[0]}</span><span style={S.n}>{r[1]}</span></div>)}
      </div>
      <div style={S.card}>
        <div style={S.h2}>The rules that make it work</div>
        {RULES.map((r) => <div key={r} style={S.rule}>{r}</div>)}
      </div>
      <div style={S.card}>
        <div style={S.h2}>Ready-to-send templates</div>
        {TEMPLATES.map((t) => <div key={t[0]} style={S.tmpl}><div style={S.subj}>{t[0]}</div><div style={S.body}>{t[1]}</div></div>)}
      </div>
      <div style={S.note}>Next: add a few friendly contacts who will reply, then send each day's emails from the Compose tab. After Day 14 your inboxes are warmed and ready.</div>
    </div>
  );
}
